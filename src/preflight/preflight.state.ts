import { Injectable } from "@nestjs/common";
import { PolicyService } from "src/policy/policy.service";
import {
  PreflightIdempotencyRecord,
  PreflightOperation,
  PreflightOraclePrice,
  PreflightStateSnapshot,
} from "./preflight.types";

/**
 * Current-state values supplied with a preflight request.
 *
 * These are the read-side inputs the preflight reasons about (balances,
 * allowances, already-consumed operation digests, idempotency records,
 * verified destinations and oracle observations). A deployment that can read
 * them from a database or chain node supplies them through a custom
 * {@link PreflightStateProvider} instead of trusting the client.
 */
export interface PreflightStateInput {
  observedAt?: string;
  balances?: Record<string, string>;
  allowances?: Record<string, string>;
  consumedDigests?: string[];
  idempotencyRecords?: PreflightIdempotencyRecord[];
  verifiedDestinations?: string[];
  oracle?: PreflightOraclePrice[];
}

/** Context handed to a {@link PreflightStateProvider} for one evaluation. */
export interface PreflightSnapshotContext {
  /** Opaque state version the caller read the snapshot at. */
  version: string;
  /** Evaluation instant (ISO). Supplied by the caller so results reproduce. */
  asOf: string;
  /** Client/caller-supplied state values. */
  state?: PreflightStateInput;
}

/**
 * Seam that assembles the state snapshot. The default provider is
 * deterministic and in-memory; production wires a DB/chain-backed provider by
 * overriding the {@link PREFLIGHT_STATE_PROVIDER} token. Keeping this an
 * interface is what lets the service be unit-tested with a mock and lets the
 * pure core stay free of I/O.
 */
export interface PreflightStateProvider {
  loadSnapshot(
    operation: PreflightOperation,
    context: PreflightSnapshotContext,
  ): Promise<PreflightStateSnapshot> | PreflightStateSnapshot;
}

/** DI token for the active {@link PreflightStateProvider}. */
export const PREFLIGHT_STATE_PROVIDER = "PREFLIGHT_STATE_PROVIDER";

/**
 * Deterministic, I/O-free provider used by default.
 *
 * It normalises the caller-supplied state and asks the existing
 * {@link PolicyService} for the trading decision of `trade` operations — so the
 * preflight and the policy engine can never disagree about what is allowed.
 */
@Injectable()
export class DefaultPreflightStateProvider implements PreflightStateProvider {
  constructor(private readonly policyService: PolicyService) {}

  loadSnapshot(
    operation: PreflightOperation,
    context: PreflightSnapshotContext,
  ): PreflightStateSnapshot {
    const state = context.state ?? {};
    const snapshot: PreflightStateSnapshot = {
      version: context.version,
      observedAt: state.observedAt ?? context.asOf,
      balances: state.balances ?? {},
      allowances: state.allowances ?? {},
      consumedDigests: state.consumedDigests ?? [],
      idempotencyRecords: state.idempotencyRecords ?? [],
      verifiedDestinations: state.verifiedDestinations ?? [],
      oracle: state.oracle ?? [],
    };

    if (operation.kind === "trade") {
      snapshot.policyDecision = this.policyService.evaluateTrade({
        asset: operation.asset,
        amount: Number(operation.amount),
        side: operation.side ?? "",
      });
    }

    return snapshot;
  }
}
