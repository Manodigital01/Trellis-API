/**
 * The harness is the foundation of the fault suite, so it is tested like any
 * other code: a fault that does not fire, fires twice, or leaks state between
 * tests would make every other fault test meaningless.
 *
 * Issue: #127
 */

import {
  FaultController,
  FaultInjectionError,
  FaultyRepository,
  ManualClock,
  SideEffectLedger,
  createFaultyFetch,
  defaultFaultMessage,
  isRetryableFaultKind,
  retryWithFaults,
} from "./fault-injection";

describe("fault injection harness", () => {
  describe("isolation", () => {
    it("starts every controller with an empty script", () => {
      const controller = new FaultController("peer");

      expect(controller.consume("fetch")).toBeNull();
      expect(controller.unconsumed()).toEqual([]);
    });

    it("resets without leaking faults or attempt counts", () => {
      const controller = new FaultController("peer");
      controller.queueTimeout();
      controller.consume("fetch");
      controller.consume("fetch");

      controller.reset();

      expect(controller.consume("fetch")).toBeNull();
      expect(controller.attemptsFor("fetch")).toBe(1);
    });

    it("does not share state between two controllers", () => {
      const first = new FaultController("one");
      const second = new FaultController("two");
      first.queueTimeout();

      expect(second.consume("fetch")).toBeNull();
    });
  });

  describe("scripted faults", () => {
    it("fires a fault the configured number of times, then behaves", () => {
      const controller = new FaultController("peer").queueTimeout(undefined, 2);

      expect(controller.consume("fetch")?.kind).toBe("timeout");
      expect(controller.consume("fetch")?.kind).toBe("timeout");
      expect(controller.consume("fetch")).toBeNull();
    });

    it("reports faults that never fired so a test cannot pass on a dead script", () => {
      const controller = new FaultController("peer");
      controller.consume("fetch");
      controller.queueTimeout();

      expect(controller.unconsumed().map((fault) => fault.spec.kind)).toEqual([
        "timeout",
      ]);
    });

    it("can wait for a specific attempt", () => {
      const controller = new FaultController("peer").queueFault({
        kind: "timeout",
        onCall: 3,
      });

      expect(controller.consume("fetch")).toBeNull();
      expect(controller.consume("fetch")).toBeNull();
      expect(controller.consume("fetch")?.kind).toBe("timeout");
    });

    it("counts attempts per operation independently", () => {
      const controller = new FaultController("db").queueFault({
        kind: "partial-write",
        onCall: 2,
      });

      expect(controller.consume("save")).toBeNull();
      expect(controller.consume("findOne")).toBeNull();
      expect(controller.consume("save")?.kind).toBe("partial-write");
      expect(controller.attemptsFor("findOne")).toBe(1);
    });
  });

  describe("createFaultyFetch", () => {
    it("rejects a timeout with an actionable message", async () => {
      const controller = new FaultController("Horizon").queueTimeout();
      const faultyFetch = createFaultyFetch(controller);

      await expect(faultyFetch("https://horizon/accounts")).rejects.toMatchObject({
        name: "FaultInjectionError",
        kind: "timeout",
        retryable: true,
        message: "Horizon did not answer before the timeout elapsed",
      });
    });

    it("reports the attempt number in the message", async () => {
      const controller = new FaultController("Horizon").queueTimeout(undefined, 3);
      const faultyFetch = createFaultyFetch(controller);

      await faultyFetch("https://horizon/a").catch(() => undefined);
      await expect(faultyFetch("https://horizon/b")).rejects.toThrow(
        /attempt 2/,
      );
    });

    it("returns a body that cannot be parsed for malformed-body", async () => {
      const controller = new FaultController("Horizon").queueMalformedBody();
      const faultyFetch = createFaultyFetch(controller);
      const response = (await faultyFetch(
        "https://horizon/accounts",
      )) as { json(): Promise<unknown> };

      await expect(response.json()).rejects.toThrow(/not valid JSON/);
    });

    it("returns a wrong-shaped body for malformed-payload", async () => {
      const controller = new FaultController("Horizon").queueMalformedPayload({
        _embedded: "not-an-object",
      });
      const faultyFetch = createFaultyFetch(controller);
      const response = (await faultyFetch("https://horizon/accounts")) as {
        json(): Promise<unknown>;
      };

      await expect(response.json()).resolves.toEqual({
        _embedded: "not-an-object",
      });
    });

    it("serves the default body when no fault applies", async () => {
      const controller = new FaultController("Horizon");
      const faultyFetch = createFaultyFetch(controller, {
        defaultBody: { _embedded: { records: [] } },
      });
      const response = (await faultyFetch("https://horizon/accounts")) as {
        ok: boolean;
        json(): Promise<unknown>;
      };

      expect(response.ok).toBe(true);
      await expect(response.json()).resolves.toEqual({
        _embedded: { records: [] },
      });
    });

    it("reports the requested URL so a test can assert on the endpoint", async () => {
      const requested: string[] = [];
      const faultyFetch = createFaultyFetch(new FaultController("Horizon"), {
        onRequest: (url) => requested.push(url),
      });

      await faultyFetch("https://horizon/accounts/GABC/payments");

      expect(requested).toEqual(["https://horizon/accounts/GABC/payments"]);
    });
  });

  describe("FaultyRepository", () => {
    it("stores rows so a test can assert what survived", async () => {
      const repo = new FaultyRepository<{ id?: string; status: string }>(
        new FaultController("db"),
        () => ({ status: "pending" }),
      );
      const row = repo.create({ id: "1" });

      await repo.save(row);

      expect(repo.rows).toEqual([{ id: "1", status: "pending" }]);
    });

    it("leaves a partial row behind when the write breaks mid-way", async () => {
      const controller = new FaultController("db").queuePartialWrite();
      const repo = new FaultyRepository<{ id?: string; transactionId: string }>(
        controller,
      );
      const row = repo.create({ id: "audit-1", transactionId: "tx-1" });

      await expect(repo.save(row)).rejects.toThrow(/accepted part of the write/);
      expect(repo.rows).toEqual([{ id: "audit-1", transactionId: "tx-1" }]);
    });

    it("rejects a constraint violation without writing", async () => {
      const controller = new FaultController("db").queueConstraintViolation();
      const repo = new FaultyRepository<{ id?: string }>(controller);

      await expect(
        repo.save(repo.create({ id: "1" })),
      ).rejects.toBeInstanceOf(FaultInjectionError);
      expect(repo.rows).toEqual([]);
    });

    it("finds rows by the where clause", async () => {
      const repo = new FaultyRepository<{ id?: string; status: string }>(
        new FaultController("db"),
      );
      await repo.save(repo.create({ id: "1", status: "pending" }));
      await repo.save(repo.create({ id: "2", status: "done" }));

      await expect(repo.findOne({ where: { status: "done" } })).resolves.toEqual({
        id: "2",
        status: "done",
      });
      await expect(repo.findOne({ where: { status: "absent" } })).resolves.toBeNull();
    });
  });

  describe("SideEffectLedger", () => {
    it("passes when every side effect is unique", () => {
      const ledger = new SideEffectLedger(new ManualClock());
      ledger.record("on-chain-submit", "payload-1");
      ledger.record("on-chain-submit", "payload-2");

      expect(ledger.countOf("on-chain-submit")).toBe(2);
      expect(() => ledger.assertNoDuplicates()).not.toThrow();
    });

    it("fails with an actionable message when a payment happens twice", () => {
      const ledger = new SideEffectLedger();
      ledger.record("payment", "invoice-1");
      ledger.record("payment", "invoice-1");

      expect(() => ledger.assertNoDuplicates()).toThrow(
        /payment "invoice-1" was performed 2 times.*must be idempotent/s,
      );
    });

    it("does not confuse different kinds of effect with the same key", () => {
      const ledger = new SideEffectLedger();
      ledger.record("payment", "shared-key");
      ledger.record("email", "shared-key");

      expect(() => ledger.assertNoDuplicates()).not.toThrow();
    });

    it("stamps entries with the injected clock", () => {
      const clock = new ManualClock(1_000);
      const ledger = new SideEffectLedger(clock);
      ledger.record("webhook", "w-1");

      expect(ledger.all()[0].at).toBe(1_000);
    });
  });

  describe("ManualClock", () => {
    it("only resolves a sleep once the clock is advanced", async () => {
      const clock = new ManualClock();
      let resolved = false;
      const sleeping = clock.sleep(1_000).then(() => {
        resolved = true;
      });

      await Promise.resolve();
      expect(resolved).toBe(false);

      await clock.advance(1_000);
      await sleeping;
      expect(resolved).toBe(true);
      expect(clock.now()).toBe(1_000);
    });

    it("does not release a sleep that is still in the future", async () => {
      const clock = new ManualClock();
      let resolved = false;
      const sleeping = clock.sleep(1_000).then(() => {
        resolved = true;
      });

      await clock.advance(999);
      expect(resolved).toBe(false);

      await clock.advance(1);
      await sleeping;
      expect(resolved).toBe(true);
    });
  });

  describe("retryWithFaults", () => {
    it("retries a retryable fault until it succeeds", async () => {
      const clock = new ManualClock();
      let attempts = 0;

      const retrying = retryWithFaults(
        async () => {
          attempts += 1;
          if (attempts < 3) {
            throw new FaultInjectionError("timeout", "timed out", {
              retryable: true,
            });
          }
        },
        { maxAttempts: 5, delayMs: (attempt) => attempt * 100, clock },
      );

      // The backoff sleeps only complete because the clock is driven here, so
      // the test never waits on wall-clock time.
      await clock.advance(10_000);
      const result = await retrying;

      expect(result.attempts).toBe(3);
      expect(attempts).toBe(3);
    });

    it("stops immediately on a permanent failure", async () => {
      const clock = new ManualClock();
      let attempts = 0;

      const result = await retryWithFaults(
        async () => {
          attempts += 1;
          throw new FaultInjectionError("execution-reverted", "reverted", {
            retryable: false,
          });
        },
        { maxAttempts: 5, delayMs: () => 1_000, clock },
      );

      expect(attempts).toBe(1);
      expect(result.attempts).toBe(1);
    });
  });

  describe("fault metadata", () => {
    it("marks infrastructure faults retryable and chain faults permanent", () => {
      expect(isRetryableFaultKind("timeout")).toBe(true);
      expect(isRetryableFaultKind("connection-reset")).toBe(true);
      expect(isRetryableFaultKind("partial-write")).toBe(true);
      expect(isRetryableFaultKind("execution-reverted")).toBe(false);
      expect(isRetryableFaultKind("nonce-too-low")).toBe(false);
      expect(isRetryableFaultKind("insufficient-funds")).toBe(false);
    });

    it("names the collaborator and the attempt in every message", () => {
      expect(
        defaultFaultMessage("http-status", {
          target: "Horizon",
          status: 503,
          attempt: 2,
        }),
      ).toBe("Horizon answered HTTP 503 (attempt 2)");
    });
  });
});
