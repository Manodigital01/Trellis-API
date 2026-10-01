/**
 * Deterministic fault injection harness.
 *
 * Three pieces, no framework magic:
 *
 * - `FaultController` scripts what a collaborator does next. Faults are consumed
 *   in order, so a test states the failure sequence up front and the run is
 *   reproducible.
 * - `createFaultyFetch` and `createFaultyRepository` build the two collaborators
 *   that break in production: an HTTP peer and a database.
 * - `SideEffectLedger` records everything that cannot be undone by retrying, so
 *   a test can prove a retry loop did not pay twice.
 *
 * Nothing here touches a real network, a real clock or a real database. The
 * clock is injected, so retry backoff is asserted in virtual milliseconds.
 *
 * Issue: #127
 */

import {
  FaultInjectionError,
  FaultKind,
  FaultSpec,
  InjectedFault,
  SideEffect,
  SideEffectKind,
  defaultFaultMessage,
  isRetryableFaultKind,
} from "./fault-injection.types";

export * from "./fault-injection.types";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** A clock that only moves when a test moves it. */
export class ManualClock implements Clock {
  private current: number;

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  /** Resolves only once the test has advanced past `ms`. */
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.pending.push({ at: this.current + ms, resolve });
    });
  }

  /**
   * Advances the clock, releasing every sleep that comes due, in order.
   *
   * Microtasks are flushed before each scan because the code awaiting a sleep
   * may not have registered it yet when `advance` is called.
   */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (let guard = 0; guard < 1_000; guard += 1) {
      await this.flush();
      const due = this.pending
        .filter((entry) => entry.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.pending = this.pending.filter((entry) => entry !== due);
      this.current = due.at;
      due.resolve();
    }
    this.current = target;
    await this.flush();
  }

  private async flush(): Promise<void> {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  }

  private pending: Array<{ at: number; resolve: () => void }> = [];
}

/**
 * Scripts the failures of a single collaborator.
 *
 * `queue` is consumed one entry per call. A spec with `times: 2` fires twice
 * and then the collaborator behaves, which is how "the provider recovers on the
 * third attempt" is expressed.
 */
export class FaultController {
  private readonly queue: InjectedFault[] = [];
  private readonly attempts = new Map<string, number>();

  constructor(readonly target: string) {}

  /** Adds a fault to the end of the sequence. Returns `this` for chaining. */
  queueFault(spec: FaultSpec): this {
    this.queue.push({
      kind: spec.kind,
      times: spec.times ?? 1,
      fired: 0,
      spec,
    });
    return this;
  }

  queueTimeout(message?: string, times?: number): this {
    return this.queueFault({ kind: "timeout", message, times });
  }

  queueHttpStatus(status: number, times?: number): this {
    return this.queueFault({ kind: "http-status", status, times });
  }

  queueMalformedBody(body: unknown = "{ not json", times?: number): this {
    return this.queueFault({ kind: "malformed-body", body, times });
  }

  queueMalformedPayload(body: unknown = {}, times?: number): this {
    return this.queueFault({ kind: "malformed-payload", body, times });
  }

  queuePartialWrite(message?: string, times?: number): this {
    return this.queueFault({ kind: "partial-write", message, times });
  }

  queueConstraintViolation(message?: string, times?: number): this {
    return this.queueFault({ kind: "constraint-violation", message, times });
  }

  /** How many times a named operation has been attempted. */
  attemptsFor(operation: string): number {
    return this.attempts.get(operation) ?? 0;
  }

  /** Records the attempt and returns the fault that applies, if any. */
  consume(operation: string): FaultSpec | null {
    const attempt = (this.attempts.get(operation) ?? 0) + 1;
    this.attempts.set(operation, attempt);

    for (const fault of this.queue) {
      if (fault.fired >= fault.times) continue;
      if ((fault.spec.onCall ?? 1) > attempt) continue;
      fault.fired += 1;
      return fault.spec;
    }
    return null;
  }

  /** Faults that never fired, so a test cannot silently pass on a dead script. */
  unconsumed(): InjectedFault[] {
    return this.queue.filter((fault) => fault.fired < fault.times);
  }

  reset(): void {
    this.queue.length = 0;
    this.attempts.clear();
  }
}

function throwFault(
  controller: FaultController,
  spec: FaultSpec,
  operation: string,
): never {
  const attempt = controller.attemptsFor(operation);
  const message =
    spec.message ??
    defaultFaultMessage(spec.kind, {
      target: controller.target,
      status: spec.status,
      attempt,
    });
  throw new FaultInjectionError(spec.kind, message, {
    retryable: isRetryableFaultKind(spec.kind),
  });
}

/** The subset of `Response` the reconciliation code actually touches. */
export interface FaultyResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

function buildResponse(
  controller: FaultController,
  spec: FaultSpec,
  body: unknown,
): FaultyResponse {
  const serialised =
    typeof body === "string" ? body : JSON.stringify(body ?? {});
  return {
    ok: (spec.status ?? 200) < 400,
    status: spec.status ?? 200,
    statusText: spec.status === 429 ? "Too Many Requests" : "OK",
    async json() {
      if (spec.kind === "malformed-body") {
        throw new SyntaxError(
          defaultFaultMessage("malformed-body", {
            target: controller.target,
            attempt: controller.attemptsFor("fetch"),
          }),
        );
      }
      return JSON.parse(serialised);
    },
    async text() {
      return serialised;
    },
  };
}

/**
 * A `fetch` that fails exactly where the test says it should.
 *
 * `defaultBody` is returned when no fault applies, so a test only has to script
 * the interesting call.
 */
export function createFaultyFetch(
  controller: FaultController,
  options: { defaultBody?: unknown; onRequest?: (url: string) => void } = {},
): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<unknown> => {
    const url = String(input);
    options.onRequest?.(url);
    const spec = controller.consume("fetch");
    if (!spec) {
      return buildResponse(controller, { kind: "http-status", status: 200 }, options.defaultBody ?? {});
    }
    switch (spec.kind) {
      case "http-status":
        return buildResponse(controller, spec, options.defaultBody ?? {});
      case "malformed-body":
      case "malformed-payload":
        return buildResponse(controller, spec, spec.body ?? {});
      case "timeout":
      case "connection-reset":
      case "network-unreachable":
        return throwFault(controller, spec, "fetch");
      default:
        return throwFault(controller, spec, "fetch");
    }
  }) as unknown as typeof fetch;
}

/**
 * Records the things a retry must not repeat.
 *
 * `assertNoDuplicate(key)` is the assertion that matters: a payment, an
 * on-chain submission or an email that happens twice is a real incident, and no
 * amount of retrying is safe afterwards.
 */
export class SideEffectLedger {
  private readonly entries: SideEffect[] = [];

  constructor(private readonly clock: Clock = new ManualClock()) {}

  record(
    kind: SideEffectKind,
    key: string,
    detail?: Record<string, unknown>,
  ): void {
    this.entries.push({ kind, key, at: this.clock.now(), detail });
  }

  all(): readonly SideEffect[] {
    return this.entries;
  }

  count(key: string): number {
    return this.entries.filter((entry) => entry.key === key).length;
  }

  countOf(kind: SideEffectKind): number {
    return this.entries.filter((entry) => entry.kind === kind).length;
  }

  duplicates(): SideEffect[] {
    const seen = new Set<string>();
    const repeated = new Set<string>();
    for (const entry of this.entries) {
      const identity = `${entry.kind}:${entry.key}`;
      if (seen.has(identity)) repeated.add(identity);
      seen.add(identity);
    }
    return this.entries.filter((entry) =>
      repeated.has(`${entry.kind}:${entry.key}`),
    );
  }

  assertNoDuplicates(): void {
    const duplicates = this.duplicates();
    if (duplicates.length === 0) return;
    const summary = duplicates
      .map(
        (entry) =>
          `${entry.kind} "${entry.key}" was performed ${this.count(entry.key)} times`,
      )
      .join("; ");
    throw new Error(
      `A retry duplicated an irreversible side effect: ${summary}. A retried operation must be idempotent or must be guarded by a recorded transaction id.`,
    );
  }
}

export interface RepositoryLike<T> {
  create(value: Partial<T>): T;
  findOne(options: unknown): Promise<T | null>;
  find(options?: unknown): Promise<T[]>;
  save(value: T): Promise<T>;
}

/**
 * A repository double that can accept half a write before failing.
 *
 * `rows` is the live table, so a test can assert on what actually survived the
 * failure instead of on what the code hoped to save.
 */
export class FaultyRepository<T extends { id?: string }> {
  readonly rows: T[] = [];
  readonly saved: T[] = [];

  private nextId = 0;

  constructor(
    private readonly controller: FaultController,
    private readonly defaults: () => Partial<T> = () => ({}),
  ) {}

  /** Assigns a serial id the way a database would, so rows stay distinct. */
  create = (value: Partial<T>): T => {
    this.nextId += 1;
    return {
      id: `row-${this.nextId}`,
      ...this.defaults(),
      ...value,
    } as T;
  };

  findOne = async (options: {
    where?: Partial<T>;
  }): Promise<T | null> => {
    const spec = this.controller.consume("findOne");
    if (spec) throwFault(this.controller, spec, "findOne");
    const where = options?.where ?? {};
    return (
      this.rows.find((row) =>
        Object.entries(where).every(
          ([key, value]) => (row as Record<string, unknown>)[key] === value,
        ),
      ) ?? null
    );
  };

  find = async (): Promise<T[]> => {
    const spec = this.controller.consume("find");
    if (spec) throwFault(this.controller, spec, "find");
    return [...this.rows];
  };

  save = async (value: T): Promise<T> => {
    const spec = this.controller.consume("save");
    if (spec?.kind === "constraint-violation") {
      throwFault(this.controller, spec, "save");
    }
    if (spec?.kind === "partial-write") {
      // The row lands with only the keys the database managed to write before
      // the connection dropped: the classic half-applied state.
      const partial: Record<string, unknown> = {};
      for (const key of ["id", "invoiceId", "transactionId"]) {
        if ((value as Record<string, unknown>)[key] !== undefined) {
          partial[key] = (value as Record<string, unknown>)[key];
        }
      }
      const row = { ...partial } as T;
      this.rows.push(row);
      this.saved.push(row);
      throwFault(this.controller, spec, "save");
    }
    const existing = this.rows.findIndex((row) => row.id === value.id);
    if (existing >= 0) {
      this.rows[existing] = { ...this.rows[existing], ...value };
    } else {
      this.rows.push(value);
    }
    this.saved.push(value);
    return value;
  };
}

/**
 * Runs `operation` until it succeeds or the budget is spent, honouring the
 * injected clock. Returns the attempt count so a test can assert that a
 * permanent failure was not retried.
 */
export async function retryWithFaults(
  operation: (attempt: number) => Promise<void>,
  options: {
    maxAttempts: number;
    delayMs: (attempt: number) => number;
    clock: Clock;
    shouldRetry?: (error: unknown) => boolean;
  },
): Promise<{ attempts: number; lastError?: unknown }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      await operation(attempt);
      return { attempts: attempt };
    } catch (error) {
      lastError = error;
      const retryable = options.shouldRetry
        ? options.shouldRetry(error)
        : (error as FaultInjectionError)?.retryable !== false;
      const isLast = attempt === options.maxAttempts;
      if (isLast || !retryable) return { attempts: attempt, lastError };
      await options.clock.sleep(options.delayMs(attempt));
    }
  }
  return { attempts: options.maxAttempts, lastError };
}
