import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { PauseScope } from "./entities/pause-scope.entity";
import { PauseAuditLog } from "./entities/pause-audit-log.entity";
import { PausableScope } from "./dto/activate-pause.dto";

export interface ActivatePauseOpts {
  scope: PausableScope;
  reason: string;
  actorId: string;
  actorRole: string;
  environment?: string;
  expiresAt?: Date;
}

@Injectable()
export class PauseControlService {
  private readonly logger = new Logger(PauseControlService.name);

  constructor(
    @InjectRepository(PauseScope)
    private readonly pauseRepo: Repository<PauseScope>,
    @InjectRepository(PauseAuditLog)
    private readonly auditRepo: Repository<PauseAuditLog>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async activatePause(opts: ActivatePauseOpts): Promise<PauseScope> {
    // Check if already paused - update if so
    const existing = await this.pauseRepo.findOne({
      where: { scope: opts.scope, active: true },
    });

    if (existing) {
      existing.reason = opts.reason;
      existing.activatedBy = opts.actorId;
      existing.activatedByRole = opts.actorRole;
      existing.expiresAt = opts.expiresAt ?? null;
      existing.environment = opts.environment ?? null;
      const updated = await this.pauseRepo.save(existing);

      await this.createAuditEntry(
        updated.id,
        "activate",
        opts.actorId,
        opts.actorRole,
        opts.reason,
        { updated: true },
      );

      this.eventEmitter.emit("pause.activated", {
        scope: opts.scope,
        reason: opts.reason,
        actorId: opts.actorId,
      });

      this.logger.warn(`Pause scope '${opts.scope}' updated by ${opts.actorId}`);
      return updated;
    }

    const pause = this.pauseRepo.create({
      scope: opts.scope,
      reason: opts.reason,
      activatedBy: opts.actorId,
      activatedByRole: opts.actorRole,
      environment: opts.environment ?? null,
      expiresAt: opts.expiresAt ?? null,
      active: true,
    });
    const saved = await this.pauseRepo.save(pause);

    await this.createAuditEntry(
      saved.id,
      "activate",
      opts.actorId,
      opts.actorRole,
      opts.reason,
    );

    this.eventEmitter.emit("pause.activated", {
      scope: opts.scope,
      reason: opts.reason,
      actorId: opts.actorId,
    });

    this.logger.warn(
      `Pause activated: scope=${opts.scope} by=${opts.actorId} reason="${opts.reason}"`,
    );
    return saved;
  }

  async resumePause(
    scope: PausableScope,
    reason: string,
    actorId: string,
    actorRole: string,
  ): Promise<PauseScope | null> {
    const pause = await this.pauseRepo.findOne({
      where: { scope, active: true },
    });
    if (!pause) return null;

    pause.active = false;
    pause.resumedBy = actorId;
    pause.resumedByRole = actorRole;
    pause.resumeReason = reason;
    pause.resumedAt = new Date();
    const saved = await this.pauseRepo.save(pause);

    await this.createAuditEntry(
      saved.id,
      "resume",
      actorId,
      actorRole,
      reason,
    );

    this.eventEmitter.emit("pause.resumed", {
      scope,
      reason,
      actorId,
    });

    this.logger.log(
      `Pause resumed: scope=${scope} by=${actorId} reason="${reason}"`,
    );
    return saved;
  }

  async isOperationPaused(scope: string): Promise<{
    paused: boolean;
    reason?: string;
    expiresAt?: Date;
  }> {
    // Check for exact scope or 'all' scope
    const pauses = await this.pauseRepo.find({
      where: [
        { scope, active: true },
        { scope: PausableScope.ALL, active: true },
      ],
    });

    for (const pause of pauses) {
      // Handle auto-expiry
      if (pause.expiresAt && pause.expiresAt <= new Date()) {
        pause.active = false;
        pause.resumeReason = "Auto-expired";
        pause.resumedAt = new Date();
        await this.pauseRepo.save(pause);
        await this.createAuditEntry(
          pause.id,
          "expire",
          "system",
          "system",
          "Auto-expired",
        );
        this.eventEmitter.emit("pause.expired", { scope: pause.scope });
        continue;
      }

      return {
        paused: true,
        reason: pause.reason,
        expiresAt: pause.expiresAt ?? undefined,
      };
    }

    return { paused: false };
  }

  async getActivePauses(): Promise<PauseScope[]> {
    const pauses = await this.pauseRepo.find({ where: { active: true } });

    // Filter out expired ones
    const active: PauseScope[] = [];
    for (const pause of pauses) {
      if (pause.expiresAt && pause.expiresAt <= new Date()) {
        pause.active = false;
        pause.resumeReason = "Auto-expired";
        pause.resumedAt = new Date();
        await this.pauseRepo.save(pause);
        await this.createAuditEntry(
          pause.id,
          "expire",
          "system",
          "system",
          "Auto-expired",
        );
      } else {
        active.push(pause);
      }
    }
    return active;
  }

  async getPauseHistory(
    scope?: string,
    limit = 50,
  ): Promise<PauseScope[]> {
    const qb = this.pauseRepo
      .createQueryBuilder("p")
      .orderBy("p.activatedAt", "DESC")
      .take(limit);

    if (scope) {
      qb.where("p.scope = :scope", { scope });
    }

    return qb.getMany();
  }

  async getAuditLog(
    pauseScopeId?: string,
    limit = 100,
  ): Promise<PauseAuditLog[]> {
    const qb = this.auditRepo
      .createQueryBuilder("a")
      .orderBy("a.createdAt", "DESC")
      .take(limit);

    if (pauseScopeId) {
      qb.where("a.pauseScopeId = :pauseScopeId", { pauseScopeId });
    }

    return qb.getMany();
  }

  private async createAuditEntry(
    pauseScopeId: string,
    action: string,
    actorId: string,
    actorRole: string,
    reason: string,
    metadata?: Record<string, any>,
  ): Promise<PauseAuditLog> {
    const entry = this.auditRepo.create({
      pauseScopeId,
      action,
      actorId,
      actorRole,
      reason,
      metadata: metadata ?? null,
    });
    return this.auditRepo.save(entry);
  }
}
