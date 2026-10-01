import { BadRequestException } from "@nestjs/common";
import {
  AuditActorType,
  SensitiveActionEvent,
  SensitiveActionStatus,
} from "../entities/sensitive-action-event.entity";
import { SensitiveActionChainHead } from "../entities/sensitive-action-chain-head.entity";
import { REDACTED } from "./audit-payload.sanitizer";
import { SensitiveActionAuditService } from "./sensitive-action-audit.service";
import { SensitiveAction, SensitiveActionScope } from "./sensitive-action.enum";

/**
 * Structural in-memory stand-in for `Repository<SensitiveActionEvent>`: enough
 * filtering, ordering, and counting to exercise the service's real behaviour
 * without a database.
 */
class FakeSensitiveActionRepository {
  rows: SensitiveActionEvent[] = [];

  create(partial: Partial<SensitiveActionEvent>): SensitiveActionEvent {
    return { ...partial } as SensitiveActionEvent;
  }

  async save(event: SensitiveActionEvent): Promise<SensitiveActionEvent> {
    const record = event as SensitiveActionEvent & { id?: string };
    if (!record.id) record.id = `evt-${record.sequence}`;
    const index = this.rows.findIndex((row) => row.sequence === event.sequence);
    if (index >= 0) this.rows[index] = event;
    else this.rows.push(event);
    return event;
  }

  async findOne(options?: {
    order?: { sequence?: "ASC" | "DESC" };
  }): Promise<SensitiveActionEvent | null> {
    if (this.rows.length === 0) return null;
    const ordered = this.sorted(options?.order?.sequence ?? "DESC");
    return ordered[0];
  }

  async find(options?: {
    where?: Record<string, unknown>;
    order?: { sequence?: "ASC" | "DESC" };
    take?: number;
  }): Promise<SensitiveActionEvent[]> {
    const filtered = this.rows.filter((row) => this.matches(row, options?.where));
    const ordered = this.sorted(
      options?.order?.sequence ?? "ASC",
      filtered
    );
    return options?.take ? ordered.slice(0, options.take) : ordered;
  }

  async findAndCount(options?: {
    where?: Record<string, unknown>;
    order?: { sequence?: "ASC" | "DESC" };
    skip?: number;
    take?: number;
  }): Promise<[SensitiveActionEvent[], number]> {
    const filtered = this.rows.filter((row) => this.matches(row, options?.where));
    const ordered = this.sorted(
      options?.order?.sequence ?? "ASC",
      filtered
    );
    const skip = options?.skip ?? 0;
    const take = options?.take ?? ordered.length;
    return [ordered.slice(skip, skip + take), filtered.length];
  }

  private sorted(
    direction: "ASC" | "DESC",
    rows: SensitiveActionEvent[] = this.rows
  ): SensitiveActionEvent[] {
    const copy = [...rows];
    copy.sort((a, b) => {
      const left = BigInt(a.sequence);
      const right = BigInt(b.sequence);
      if (left === right) return 0;
      const ascending = left < right ? -1 : 1;
      return direction === "ASC" ? ascending : -ascending;
    });
    return copy;
  }

  private matches(
    row: SensitiveActionEvent,
    where?: Record<string, unknown>
  ): boolean {
    if (!where) return true;

    for (const [key, expected] of Object.entries(where)) {
      const actual = (row as unknown as Record<string, unknown>)[key];

      // TypeORM operators (`Between`, `MoreThanOrEqual`, ...) are plain
      // objects carrying a `type` and `value`; handle them without a DB.
      const operator = expected as { type?: string; value?: unknown };
      if (operator && typeof operator.type === "string") {
        if (operator.type === "between") {
          const [low, high] = operator.value as [Date, Date];
          if (!(actual >= low && actual <= high)) return false;
        } else if (operator.type === "moreThanOrEqual") {
          if (!(actual >= (operator.value as Date))) return false;
        } else if (operator.type === "lessThanOrEqual") {
          if (!(actual <= (operator.value as Date))) return false;
        }
        continue;
      }

      if (actual !== expected) return false;
    }

    return true;
  }
}

function buildHarness() {
  const repo = new FakeSensitiveActionRepository();
  const headRepo = {
    head: null as SensitiveActionChainHead | null,
    create(partial: Partial<SensitiveActionChainHead>) {
      return { ...partial } as SensitiveActionChainHead;
    },
    async findOne() {
      return this.head;
    },
    async save(head: SensitiveActionChainHead) {
      this.head = head;
      return head;
    },
  };
  const service = new SensitiveActionAuditService(repo as any, headRepo as any);
  return { service, repo, headRepo };
}

describe("SensitiveActionAuditService", () => {
  let service: SensitiveActionAuditService;
  let repo: FakeSensitiveActionRepository;
  let headRepo: ReturnType<typeof buildHarness>["headRepo"];

  beforeEach(() => {
    ({ service, repo, headRepo } = buildHarness());
  });

  it("records actor attribution and a catalogue-derived event shape", async () => {
    const event = await service.recordSensitiveAction({
      action: SensitiveAction.ROLE_ASSIGNED,
      actorId: "maintainer-7",
      actorType: AuditActorType.MAINTAINER,
      actorRole: "admin",
      resourceType: "user",
      resourceId: "usr_01H",
      reason: "Support escalation #4471",
      beforeState: { roles: ["viewer"] },
      afterState: { roles: ["viewer", "operator"] },
      ipAddress: "203.0.113.7",
      userAgent: "jest",
    });

    expect(event.sequence).toBe("1");
    expect(event.action).toBe(SensitiveAction.ROLE_ASSIGNED);
    expect(event.scope).toBe(SensitiveActionScope.ACCESS_CONTROL);
    expect(event.actorId).toBe("maintainer-7");
    expect(event.actorType).toBe("maintainer");
    expect(event.actorRole).toBe("admin");
    expect(event.reason).toBe("Support escalation #4471");
    expect(event.beforeState).toEqual({ roles: ["viewer"] });
    expect(event.afterState).toEqual({ roles: ["viewer", "operator"] });
    expect(event.status).toBe("succeeded");
    expect(event.occurredAt).toBeInstanceOf(Date);
    expect(event.eventHash).toMatch(/^[0-9a-f]{64}$/);
    expect(event.previousHash).toBeNull();
  });

  it("requires a reason for actions the catalogue marks as needing one", async () => {
    await expect(
      service.recordSensitiveAction({
        action: SensitiveAction.WITHDRAWAL_APPROVED,
        actorId: "maintainer-1",
      })
    ).rejects.toBeInstanceOf(BadRequestException);

    // The same action succeeds with a reason.
    await expect(
      service.recordSensitiveAction({
        action: SensitiveAction.WITHDRAWAL_APPROVED,
        actorId: "maintainer-1",
        reason: "Verified against treasury ledger",
      })
    ).resolves.toMatchObject({ action: SensitiveAction.WITHDRAWAL_APPROVED });
  });

  it("rejects actions that are not in the catalogue", async () => {
    await expect(
      service.recordSensitiveAction({
        action: "totally.made.up" as SensitiveAction,
        actorId: "actor-1",
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.rows).toHaveLength(0);
  });

  it("requires an actor", async () => {
    await expect(
      service.recordSensitiveAction({
        action: SensitiveAction.LOGIN_SUCCEEDED,
        actorId: "",
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("sanitizes before/after state and records the redacted paths", async () => {
    const event = await service.recordSensitiveAction({
      action: SensitiveAction.API_KEY_REVOKED,
      actorId: "maintainer-2",
      reason: "key leaked in a public gist",
      beforeState: { apiKey: "sk_live_123", label: "prod" },
      metadata: { ticket: "SEC-91", authorization: "Bearer xyz" },
    });

    expect(event.beforeState).toEqual({ apiKey: REDACTED, label: "prod" });
    expect(event.metadata).toEqual({
      ticket: "SEC-91",
      authorization: REDACTED,
    });
    expect(event.redactedPaths?.sort()).toEqual([
      "beforeState.apiKey",
      "metadata.authorization",
    ]);
    expect(JSON.stringify(event)).not.toContain("sk_live_123");
    expect(JSON.stringify(event)).not.toContain("Bearer xyz");
  });

  it("does not capture state for actions that are not declared as stateful", async () => {
    const event = await service.recordSensitiveAction({
      action: SensitiveAction.LOGIN_SUCCEEDED,
      actorId: "user-9",
      beforeState: { whatever: 1 },
      afterState: { whatever: 2 },
    });

    expect(event.beforeState).toBeNull();
    expect(event.afterState).toBeNull();
  });

  it("chains events and verifies the chain", async () => {
    await service.recordSensitiveAction({
      action: SensitiveAction.LOGIN_SUCCEEDED,
      actorId: "user-1",
    });
    await service.recordSensitiveAction({
      action: SensitiveAction.API_KEY_CREATED,
      actorId: "user-1",
    });
    const third = await service.recordSensitiveAction({
      action: SensitiveAction.LOGIN_FAILED,
      actorId: "user-1",
    });

    expect(third.sequence).toBe("3");
    expect(third.previousHash).toBe(repo.rows[1].eventHash);

    const verification = await service.verifyChain();
    expect(verification.valid).toBe(true);
    expect(verification.verified).toBe(3);
    expect(verification.brokenAt).toBeNull();
  });

  it("detects an edited event", async () => {
    await service.recordSensitiveAction({
      action: SensitiveAction.LOGIN_SUCCEEDED,
      actorId: "user-1",
    });
    await service.recordSensitiveAction({
      action: SensitiveAction.USER_SUSPENDED,
      actorId: "maintainer-1",
      reason: "abuse",
    });

    // Tamper directly with the stored row, as an out-of-band edit would.
    repo.rows[1].actorId = "somebody-else";

    const verification = await service.verifyChain();
    expect(verification.valid).toBe(false);
    expect(verification.brokenAt).toBe("evt-2");
    expect(verification.reason).toMatch(/Event hash mismatch/);
  });

  it("detects a deleted event", async () => {
    await service.recordSensitiveAction({
      action: SensitiveAction.LOGIN_SUCCEEDED,
      actorId: "user-1",
    });
    await service.recordSensitiveAction({
      action: SensitiveAction.API_KEY_CREATED,
      actorId: "user-1",
    });
    await service.recordSensitiveAction({
      action: SensitiveAction.LOGIN_FAILED,
      actorId: "user-1",
    });

    repo.rows.splice(1, 1);

    const verification = await service.verifyChain();
    expect(verification.valid).toBe(false);
    expect(verification.reason).toMatch(/Chain link mismatch/);
  });

  it("detects deletion of the newest event using the saved chain head", async () => {
    await service.recordSensitiveAction({
      action: SensitiveAction.LOGIN_SUCCEEDED,
      actorId: "user-1",
    });
    await service.recordSensitiveAction({
      action: SensitiveAction.API_KEY_CREATED,
      actorId: "user-1",
    });
    const lastEventId = repo.rows[1].id;

    repo.rows.pop();

    const verification = await service.verifyChain();
    expect(verification.valid).toBe(false);
    expect(verification.brokenAt).toBe(lastEventId);
    expect(verification.reason).toMatch(/chain head/);
  });

  it("refuses to append when existing history has lost its chain head", async () => {
    await service.recordSensitiveAction({
      action: SensitiveAction.LOGIN_SUCCEEDED,
      actorId: "user-1",
    });
    const eventCount = repo.rows.length;
    headRepo.head = null;

    await expect(
      service.recordSensitiveAction({
        action: SensitiveAction.LOGIN_SUCCEEDED,
        actorId: "user-1",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.rows).toHaveLength(eventCount);
  });

  it("detects a sequence gap even when rows are returned in sequence order", async () => {
    await service.recordSensitiveAction({
      action: SensitiveAction.LOGIN_SUCCEEDED,
      actorId: "user-1",
    });
    await service.recordSensitiveAction({
      action: SensitiveAction.API_KEY_CREATED,
      actorId: "user-1",
    });
    repo.rows[1].sequence = "3";

    const verification = await service.verifyChain();
    expect(verification.valid).toBe(false);
    expect(verification.reason).toMatch(/Sequence gap or ordering error/);
  });

  it("filters queries by actor, action, resource, and status", async () => {
    await service.recordSensitiveAction({
      action: SensitiveAction.ROLE_ASSIGNED,
      actorId: "maintainer-1",
      reason: "onboarding",
      resourceType: "user",
      resourceId: "usr_1",
    });
    await service.recordSensitiveAction({
      action: SensitiveAction.ROLE_ASSIGNED,
      actorId: "maintainer-2",
      reason: "onboarding",
      resourceType: "user",
      resourceId: "usr_2",
    });
    await service.recordSensitiveAction({
      action: SensitiveAction.LOGIN_FAILED,
      actorId: "maintainer-1",
      status: SensitiveActionStatus.FAILED,
    });

    await expect(service.query({ actorId: "maintainer-1" })).resolves.toMatchObject({
      total: 2,
    });
    await expect(
      service.query({ action: SensitiveAction.ROLE_ASSIGNED })
    ).resolves.toMatchObject({ total: 2 });
    await expect(
      service.query({ resourceType: "user", resourceId: "usr_2" })
    ).resolves.toMatchObject({ total: 1 });
    await expect(
      service.query({ status: SensitiveActionStatus.FAILED })
    ).resolves.toMatchObject({ total: 1 });

    const page = await service.query({ page: 2, limit: 1 });
    expect(page.total).toBe(3);
    expect(page.totalPages).toBe(3);
    // Newest first, so page 2 is the middle event.
    expect(page.data[0].actorId).toBe("maintainer-2");
  });

  it("returns resource history oldest first", async () => {
    await service.recordSensitiveAction({
      action: SensitiveAction.ROLE_ASSIGNED,
      actorId: "maintainer-1",
      reason: "first",
      resourceType: "user",
      resourceId: "usr_1",
    });
    await service.recordSensitiveAction({
      action: SensitiveAction.ROLE_REVOKED,
      actorId: "maintainer-1",
      reason: "second",
      resourceType: "user",
      resourceId: "usr_1",
    });

    const history = await service.historyFor("user", "usr_1");
    expect(history.map((event) => event.reason)).toEqual(["first", "second"]);
  });

  it("exports events with the chain status", async () => {
    await service.recordSensitiveAction({
      action: SensitiveAction.LOGIN_SUCCEEDED,
      actorId: "user-1",
    });

    const exported = await service.exportForReview({});

    expect(exported.count).toBe(1);
    expect(exported.chainVerified).toBe(true);
    expect(JSON.parse(exported.payload)).toHaveLength(1);
    expect(exported.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("publishes the catalogue with scopes and requirements", () => {
    const catalogue = service.catalogue();
    const withdrawal = catalogue.find(
      (entry) => entry.action === SensitiveAction.WITHDRAWAL_APPROVED
    );
    const login = catalogue.find(
      (entry) => entry.action === SensitiveAction.LOGIN_SUCCEEDED
    );

    expect(withdrawal).toMatchObject({
      scope: SensitiveActionScope.TREASURY,
      reasonRequired: true,
      capturesState: true,
    });
    expect(login).toMatchObject({
      scope: SensitiveActionScope.AUTHENTICATION,
      reasonRequired: false,
      capturesState: false,
    });
    expect(catalogue.length).toBeGreaterThanOrEqual(30);
  });
});
