import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash } from "crypto";
import {
  Between,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
} from "typeorm";
import {
  AuditActorType,
  SensitiveActionEvent,
  SensitiveActionStatus,
} from "../entities/sensitive-action-event.entity";
import { SensitiveActionChainHead } from "../entities/sensitive-action-chain-head.entity";
import { RecordSensitiveActionDto } from "./dto/record-sensitive-action.dto";
import {
  ExportSensitiveActionsDto,
  QuerySensitiveActionDto,
  SENSITIVE_ACTION_EXPORT_LIMIT,
  SENSITIVE_ACTION_MAX_LIMIT,
} from "./dto/query-sensitive-action.dto";
import { sanitizeAuditPayload } from "./audit-payload.sanitizer";
import {
  SENSITIVE_ACTION_CATALOGUE,
  SensitiveAction,
  SensitiveActionScope,
  describeSensitiveAction,
  isSensitiveAction,
} from "./sensitive-action.enum";

export interface RecordSensitiveActionInput {
  action: SensitiveAction;
  actorId: string;
  actorType?: AuditActorType;
  actorRole?: string;
  resourceType?: string;
  resourceId?: string;
  reason?: string;
  beforeState?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  status?: SensitiveActionStatus;
  ipAddress?: string;
  userAgent?: string;
  occurredAt?: Date | string;
}

export interface SensitiveActionPage {
  data: SensitiveActionEvent[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ChainVerificationResult {
  valid: boolean;
  verified: number;
  brokenAt: string | null;
  reason: string | null;
  verifiedAt: string;
}

export interface SensitiveActionExport {
  payload: string;
  count: number;
  generatedAt: string;
  chainVerified: boolean;
}

/**
 * Records and exposes the audit trail for sensitive user and maintainer actions.
 *
 * Design notes:
 *  - **Domain boundary, not HTTP only.** `recordSensitiveAction()` is the
 *    intended call site for domain services (approvals, role changes, exports),
 *    so background flows are covered too - not just API requests.
 *  - **Append-only with a hash chain.** Each event stores the previous event's
 *    hash, so `verifyChain()` detects out-of-band edits, deletions, or
 *    reordering.
 *  - **Sanitized by construction.** Payloads pass through
 *    `sanitizeAuditPayload()` before they touch the database.
 */
@Injectable()
export class SensitiveActionAuditService {
  private readonly logger = new Logger(SensitiveActionAuditService.name);

  constructor(
    @InjectRepository(SensitiveActionEvent)
    private readonly repo: Repository<SensitiveActionEvent>,
    @InjectRepository(SensitiveActionChainHead)
    private readonly headRepo: Repository<SensitiveActionChainHead>,
  ) {}

  /** The declared catalogue maintainers can review and extend. */
  catalogue() {
    return Object.values(SensitiveAction).map((action) => ({
      action,
      ...SENSITIVE_ACTION_CATALOGUE[action],
    }));
  }

  /** Records an action supplied as a DTO (HTTP/transport-facing entry point). */
  async record(dto: RecordSensitiveActionDto): Promise<SensitiveActionEvent> {
    return this.recordSensitiveAction({
      action: dto.action,
      actorId: dto.actorId,
      actorType: dto.actorType,
      actorRole: dto.actorRole,
      resourceType: dto.resourceType,
      resourceId: dto.resourceId,
      reason: dto.reason,
      beforeState: dto.beforeState,
      afterState: dto.afterState,
      metadata: dto.metadata,
      status: dto.status,
      ipAddress: dto.ipAddress,
      userAgent: dto.userAgent,
      occurredAt: dto.occurredAt,
    });
  }

  /** Records one event. Called by domain services at the moment of the action. */
  async recordSensitiveAction(
    input: RecordSensitiveActionInput
  ): Promise<SensitiveActionEvent> {
    const definition = isSensitiveAction(input.action)
      ? describeSensitiveAction(input.action)
      : null;

    if (!definition) {
      throw new BadRequestException(
        `Unknown sensitive action: ${String(input.action)}`
      );
    }
    if (!input.actorId) {
      throw new BadRequestException(
        `A sensitive action requires an actorId (${input.action})`
      );
    }

    const reason = input.reason?.trim() || null;
    if (definition.reasonRequired && !reason) {
      throw new BadRequestException(
        `A reason is required to record ${input.action}`
      );
    }

    const before = definition.capturesState
      ? sanitizeAuditPayload(input.beforeState ?? null)
      : sanitizeAuditPayload(null);
    const after = definition.capturesState
      ? sanitizeAuditPayload(input.afterState ?? null)
      : sanitizeAuditPayload(null);
    const metadata = sanitizeAuditPayload(input.metadata ?? null);

    const latest = await this.repo.findOne({
      order: { sequence: "DESC" },
    });
    let head = await this.headRepo.findOne({ where: { id: "global" } });

    if (latest && !head) {
      throw new BadRequestException(
        "Sensitive action history is missing its recorded chain head; refusing to append.",
      );
    }
    if (
      head &&
      (latest?.sequence !== head.sequence || latest?.eventHash !== head.eventHash)
    ) {
      throw new BadRequestException(
        "Sensitive action history does not match its recorded chain head; refusing to append.",
      );
    }

    const previousSequence = head?.sequence ?? latest?.sequence ?? "0";
    const previousHash = head?.eventHash ?? latest?.eventHash ?? null;

    const event = this.repo.create({
      sequence: this.nextSequence(previousSequence),
      action: input.action,
      scope: definition.scope,
      actorId: this.clip(input.actorId, 64) as string,
      actorType: input.actorType ?? AuditActorType.USER,
      actorRole: this.clip(input.actorRole, 64),
      resourceType: this.clip(input.resourceType, 100),
      resourceId: this.clip(input.resourceId, 255),
      reason: this.clip(reason, 2000),
      beforeState: before.value,
      afterState: after.value,
      metadata: metadata.value,
      status: input.status ?? SensitiveActionStatus.SUCCEEDED,
      ipAddress: this.clip(input.ipAddress, 45),
      userAgent: this.clip(input.userAgent, 512),
      redactedPaths: this.mergeRedactedPaths([
        before.redactedPaths,
        after.redactedPaths,
        metadata.redactedPaths,
      ]),
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
      previousHash,
      eventHash: "",
    });

    event.eventHash = this.computeHash(event);
    const saved = await this.repo.save(event);
    head = this.headRepo.create({
      id: "global",
      sequence: saved.sequence,
      eventHash: saved.eventHash,
      lastEventId: saved.id,
    });
    await this.headRepo.save(head);

    this.logger.log(
      `audit:${saved.action} actor=${saved.actorId}(${saved.actorType}) ` +
        `resource=${saved.resourceType ?? "-"}/${saved.resourceId ?? "-"} seq=${saved.sequence}`
    );

    return saved;
  }

  async query(dto: QuerySensitiveActionDto): Promise<SensitiveActionPage> {
    const page = dto.page ?? 1;
    const limit = Math.min(dto.limit ?? 100, SENSITIVE_ACTION_MAX_LIMIT);

    const [data, total] = await this.repo.findAndCount({
      where: this.buildWhere(dto),
      order: { sequence: "DESC" },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /** Full before/after history for one resource, oldest first. */
  async historyFor(
    resourceType: string,
    resourceId: string,
    limit = 100
  ): Promise<SensitiveActionEvent[]> {
    return this.repo.find({
      where: { resourceType, resourceId },
      order: { sequence: "ASC" },
      take: Math.min(Math.max(limit, 1), SENSITIVE_ACTION_MAX_LIMIT),
    });
  }

  /**
   * Maintainer-facing export. Returns JSON plus the chain status at export
   * time, so a reviewer can tell whether the exported slice was intact.
   */
  async exportForReview(
    dto: ExportSensitiveActionsDto
  ): Promise<SensitiveActionExport> {
    const events = await this.repo.find({
      where: this.buildWhere(dto),
      order: { sequence: "ASC" },
      take: Math.min(dto.limit ?? SENSITIVE_ACTION_EXPORT_LIMIT, SENSITIVE_ACTION_EXPORT_LIMIT),
    });
    const chain = await this.verifyChain();

    return {
      payload: JSON.stringify(events, null, 2),
      count: events.length,
      generatedAt: new Date().toISOString(),
      chainVerified: chain.valid,
    };
  }

  /**
   * Recomputes the hash chain over every stored event.
   *
   * Any deleted, reordered, or edited row breaks the link or the hash and is
   * reported through `brokenAt`.
   */
  async verifyChain(): Promise<ChainVerificationResult> {
    const events = await this.repo.find({ order: { sequence: "ASC" } });
    const head = await this.headRepo.findOne({ where: { id: "global" } });

    let previousHash: string | null = null;
    let previousSequence = "0";

    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      const expectedSequence = this.nextSequence(previousSequence);
      if (BigInt(event.sequence) !== BigInt(expectedSequence)) {
        return {
          valid: false,
          verified: index,
          brokenAt: event.id,
          reason: `Sequence gap or ordering error at sequence ${event.sequence}; expected ${expectedSequence}`,
          verifiedAt: new Date().toISOString(),
        };
      }
      const expectedPrevious = previousHash;
      if ((event.previousHash ?? null) !== expectedPrevious) {
        return {
          valid: false,
          verified: index,
          brokenAt: event.id,
          reason: `Chain link mismatch at sequence ${event.sequence}`,
          verifiedAt: new Date().toISOString(),
        };
      }
      if (this.computeHash(event) !== event.eventHash) {
        return {
          valid: false,
          verified: index,
          brokenAt: event.id,
          reason: `Event hash mismatch at sequence ${event.sequence}`,
          verifiedAt: new Date().toISOString(),
        };
      }
      previousHash = event.eventHash;
      previousSequence = event.sequence;
    }

    if (
      head &&
      (head.sequence !== previousSequence ||
        head.eventHash !== previousHash ||
        head.lastEventId !== events[events.length - 1]?.id)
    ) {
      return {
        valid: false,
        verified: events.length,
        brokenAt: head.lastEventId,
        reason: `Recorded chain head at sequence ${head.sequence} does not match the event history`,
        verifiedAt: new Date().toISOString(),
      };
    }
    if (!head && events.length > 0) {
      return {
        valid: false,
        verified: events.length,
        brokenAt: events[events.length - 1].id,
        reason: "Sensitive action chain head is missing",
        verifiedAt: new Date().toISOString(),
      };
    }

    return {
      valid: true,
      verified: events.length,
      brokenAt: null,
      reason:
        events.length === 0
          ? "No sensitive action events recorded yet"
          : `Verified ${events.length} events ending at sequence ${previousSequence}`,
      verifiedAt: new Date().toISOString(),
    };
  }

  private buildWhere(dto: QuerySensitiveActionDto): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    if (dto.actorId) where.actorId = dto.actorId;
    if (dto.action) where.action = dto.action;
    if (dto.scope) where.scope = dto.scope as SensitiveActionScope;
    if (dto.resourceType) where.resourceType = dto.resourceType;
    if (dto.resourceId) where.resourceId = dto.resourceId;
    if (dto.status) where.status = dto.status;

    const from = dto.from ? new Date(dto.from) : null;
    const to = dto.to ? new Date(dto.to) : null;
    if (from && to) where.occurredAt = Between(from, to);
    else if (from) where.occurredAt = MoreThanOrEqual(from);
    else if (to) where.occurredAt = LessThanOrEqual(to);

    return where;
  }

  private nextSequence(sequence: string): string {
    return (BigInt(sequence) + 1n).toString();
  }

  /**
   * The service is also called directly from domain code, so it cannot rely on
   * the HTTP validation pipe to respect column widths.
   */
  private clip(value: string | null | undefined, max: number): string | null {
    if (value === null || value === undefined) return null;
    const text = String(value);
    return text.length > max ? text.slice(0, max) : text;
  }

  private mergeRedactedPaths(groups: string[][]): string[] | null {
    const merged = [...new Set(groups.flat())];
    return merged.length > 0 ? merged : null;
  }

  private toIso(value: Date | string): string {
    return value instanceof Date
      ? value.toISOString()
      : new Date(value).toISOString();
  }

  /**
   * Fields covered by the chain. Kept explicit (and ordered) so the hash is
   * stable across processes and database round-trips.
   */
  private buildHashInput(event: SensitiveActionEvent): Record<string, unknown> {
    return {
      sequence: String(event.sequence),
      action: event.action,
      scope: event.scope,
      actorId: event.actorId,
      actorType: event.actorType,
      actorRole: event.actorRole ?? null,
      resourceType: event.resourceType ?? null,
      resourceId: event.resourceId ?? null,
      reason: event.reason ?? null,
      status: event.status,
      beforeState: event.beforeState ?? null,
      afterState: event.afterState ?? null,
      metadata: event.metadata ?? null,
      ipAddress: event.ipAddress ?? null,
      userAgent: event.userAgent ?? null,
      occurredAt: this.toIso(event.occurredAt),
      previousHash: event.previousHash ?? null,
    };
  }

  private computeHash(event: SensitiveActionEvent): string {
    return createHash("sha256")
      .update(JSON.stringify(this.buildHashInput(event)))
      .digest("hex");
  }
}
