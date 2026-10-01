import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  DEFAULT_MAX_ORACLE_AGE_SECONDS,
  DEFAULT_MAX_SNAPSHOT_AGE_SECONDS,
  DEFAULT_WARN_SNAPSHOT_AGE_SECONDS,
  PREFLIGHT_MAX_ORACLE_AGE_ENV,
  PREFLIGHT_MAX_SNAPSHOT_AGE_ENV,
  PREFLIGHT_WARN_SNAPSHOT_AGE_ENV,
} from "./preflight.constants";
import { PreflightBlockedException } from "./preflight.errors";
import {
  evaluatePreflight,
  defaultPreflightThresholds,
} from "./preflight.rules";
import {
  PREFLIGHT_STATE_PROVIDER,
  PreflightSnapshotContext,
  PreflightStateProvider,
} from "./preflight.state";
import {
  PreflightOperation,
  PreflightResult,
  PreflightThresholds,
} from "./preflight.types";
import { PreflightRequestDto } from "./dto/preflight-request.dto";

/**
 * Application-level entry point for the deterministic preflight (issue #109).
 *
 * The service does the impure work — resolving thresholds from configuration,
 * reading the current state through the injected {@link PreflightStateProvider}
 * and stamping `asOf` when the caller does not supply one — then delegates the
 * decision to the pure {@link evaluatePreflight}. Keeping the split means the
 * rules are reproducible and testable in isolation, while the provider seam can
 * be swapped for a DB/chain-backed implementation in production.
 */
@Injectable()
export class PreflightService {
  private readonly logger = new Logger(PreflightService.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(PREFLIGHT_STATE_PROVIDER)
    private readonly stateProvider: PreflightStateProvider,
  ) {}

  /**
   * Evaluate a preflight request. `asOf` defaults to the server clock so the
   * endpoint is usable without a caller-supplied timestamp, but tests and
   * callers that need reproducibility always pass it explicitly.
   */
  async preflight(
    dto: PreflightRequestDto,
    actor?: string,
  ): Promise<PreflightResult> {
    const asOf = dto.asOf ?? new Date().toISOString();
    const result = await this.evaluateOperation(
      this.toOperation(dto),
      { version: dto.stateVersion, asOf, state: dto.state },
      this.resolveThresholds(),
    );

    this.logger.debug(
      `preflight ${result.preflightId} actor=${actor ?? "anonymous"} status=${result.status}`,
    );
    return result;
  }

  /** Evaluate an operation against a snapshot loaded from the provider. */
  async evaluateOperation(
    operation: PreflightOperation,
    context: PreflightSnapshotContext,
    thresholds: PreflightThresholds = this.resolveThresholds(),
  ): Promise<PreflightResult> {
    const snapshot = await this.stateProvider.loadSnapshot(operation, context);
    return evaluatePreflight({
      operation,
      snapshot,
      thresholds,
      asOf: context.asOf,
    });
  }

  /**
   * Refuse a blocked operation before it is submitted.
   *
   * @throws PreflightBlockedException when the result is `blocking`.
   */
  assertProceedable(result: PreflightResult): PreflightResult {
    if (result.status === "blocking") {
      throw new PreflightBlockedException(result);
    }
    return result;
  }

  /** Freshness limits resolved from configuration, with safe defaults. */
  resolveThresholds(): PreflightThresholds {
    const defaults = defaultPreflightThresholds();
    const maxSnapshotAgeSeconds = this.readSeconds(
      PREFLIGHT_MAX_SNAPSHOT_AGE_ENV,
      DEFAULT_MAX_SNAPSHOT_AGE_SECONDS,
    );
    const warnSnapshotAgeSeconds = Math.min(
      this.readSeconds(
        PREFLIGHT_WARN_SNAPSHOT_AGE_ENV,
        DEFAULT_WARN_SNAPSHOT_AGE_SECONDS,
      ),
      maxSnapshotAgeSeconds,
    );

    return {
      maxSnapshotAgeSeconds,
      warnSnapshotAgeSeconds,
      maxOracleAgeSeconds: this.readSeconds(
        PREFLIGHT_MAX_ORACLE_AGE_ENV,
        defaults.maxOracleAgeSeconds ?? DEFAULT_MAX_ORACLE_AGE_SECONDS,
      ),
    };
  }

  private toOperation(dto: PreflightRequestDto): PreflightOperation {
    return {
      kind: dto.kind,
      asset: dto.asset,
      amount: dto.amount,
      side: dto.side,
      destination: dto.destination,
      idempotencyKey: dto.idempotencyKey,
      requiresOraclePrice: dto.requiresOraclePrice,
      expectedStateVersion: dto.expectedStateVersion,
      expiresAt: dto.expiresAt,
      estimatedFee: dto.estimatedFee,
    };
  }

  private readSeconds(key: string, fallback: number): number {
    const raw = Number(this.configService.get(key));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
  }
}
