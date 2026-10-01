import {
  BadRequestException,
  CanActivate,
  ConflictException,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import Redis from "ioredis";
import { CACHE_REDIS_CLIENT } from "../cache/cache.constants";

/**
 * Guard to prevent replay attacks by validating nonces.
 *
 * Nonces are tracked per subject (wallet address or user id) and must be
 * strictly increasing, so a captured signed payload cannot be resubmitted.
 *
 * The tracking used to be a read-then-write against the `SubmissionNonce`
 * table. That is correct for one request and wrong for two: the read and the
 * write are separate statements, so concurrent submissions — or submissions
 * racing through different nodes of a load-balanced cluster — both observe
 * the same `lastNonce` and both succeed. Replay protection that is only
 * enforced per-row is not replay protection.
 *
 * The check is now a single atomic compare-and-set executed inside Redis
 * (issue #129). The Lua script reads the last nonce, compares it against the
 * incoming one and, only when the incoming nonce is strictly greater, writes
 * it back with `GETSET` and applies a TTL with `EXPIRE`. Redis runs the
 * script to completion without interleaving other commands, so two nodes
 * submitting the same nonce cannot both be accepted: the first one wins and
 * the second observes the update and is rejected.
 *
 * Consumed-nonce state expires after {@link DEFAULT_NONCE_TTL_SECONDS}. The
 * replay window is therefore bounded by the TTL rather than being permanent,
 * which is what keeps the key space bounded for long-lived deployments.
 *
 * Redis is optional. When no client is configured — local, single-node
 * development — the same compare-and-set runs against an in-process map and
 * the degradation is logged. It is *only* correct for a single node, which is
 * exactly the mode the fallback is for. When a Redis client *is* configured
 * the guard fails closed on a Redis error instead of silently reverting to
 * per-process state, because a quiet fallback is the failure mode that
 * produced the original bug.
 */

/** Default lifetime, in seconds, of a consumed nonce entry. */
export const DEFAULT_NONCE_TTL_SECONDS = 300;

/** Prefix for the Redis key holding the last accepted nonce of a subject. */
export const NONCE_KEY_PREFIX = "trellis:nonce:";

/** Cap on the in-process fallback map before expired entries are swept. */
const MEMORY_SWEEP_THRESHOLD = 1000;

/**
 * Atomic "consume this nonce" script.
 *
 * KEYS[1] — key holding the last accepted nonce for the subject.
 * ARGV[1] — the incoming nonce, as a normalised (no leading zeros) decimal string.
 * ARGV[2] — TTL in seconds.
 *
 * Returns `{1, '0'}` when the nonce was accepted and stored, or `{0, last}`
 * when the nonce is a replay.
 *
 * The comparison is done on decimal strings rather than with `tonumber`,
 * which parses to a double: nonces are 64-bit and two different sequence
 * numbers can share the same double. Longer string wins, equal length falls
 * back to a lexicographic compare, which is exact for normalised digits.
 */
export const CONSUME_NONCE_LUA = `
local incoming = ARGV[1]
local ttl = tonumber(ARGV[2])

local current = redis.call('GET', KEYS[1])

if current then
  local len_current = string.len(current)
  local len_incoming = string.len(incoming)
  local is_replay

  if len_incoming < len_current then
    is_replay = false
  elseif len_incoming > len_current then
    is_replay = true
  else
    is_replay = (incoming <= current)
  end

  if is_replay then
    return { 0, current }
  end
end

redis.call('GETSET', KEYS[1], incoming)
redis.call('EXPIRE', KEYS[1], ttl)

return { 1, '0' }
`;

/** Outcome of a nonce consumption attempt. */
export interface NonceConsumeResult {
  accepted: boolean;
  lastNonce: bigint;
  /** True when the decision was taken in Redis and is shared by all nodes. */
  distributed: boolean;
}

@Injectable()
export class NonceGuard implements CanActivate {
  private readonly logger = new Logger(NonceGuard.name);
  private readonly redis: Redis | null;
  private readonly ttlSeconds: number;
  private readonly memoryNonces = new Map<string, { nonce: string; expiresAt: number }>();

  constructor(
    @Optional() @Inject(CACHE_REDIS_CLIENT) redis?: Redis | null,
    ttlSeconds?: number,
  ) {
    this.redis = redis ?? null;
    this.ttlSeconds = resolveNonceTtlSeconds(ttlSeconds);

    if (!this.redis) {
      this.logger.warn(
        "No Redis client configured — nonce replay protection is limited to this process. " +
          "Set REDIS_URL before running more than one API node.",
      );
    }
  }

  /** True when nonces are tracked in shared storage. */
  isDistributed(): boolean {
    return this.redis !== null;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const body = request?.body ?? {};
    const { nonce, userId } = body;

    if (nonce === undefined || nonce === null || nonce === "" || !userId) {
      throw new BadRequestException("Nonce and userId are required");
    }

    const submittedNonce = this.parseNonce(nonce);
    const subject = String(userId);
    const result = await this.consumeNonce(subject, submittedNonce);

    if (!result.accepted) {
      throw new ConflictException(
        "Nonce already used (replay attack detected)",
      );
    }

    return true;
  }

  /**
   * Consume a nonce for a subject, rejecting it when it is not strictly
   * greater than the last accepted one. Atomic across every node that shares
   * the Redis instance.
   */
  async consumeNonce(
    subject: string,
    nonce: bigint,
  ): Promise<NonceConsumeResult> {
    if (this.redis) {
      return this.consumeNonceDistributed(subject, nonce);
    }

    return this.consumeNonceInMemory(subject, nonce);
  }

  private async consumeNonceDistributed(
    subject: string,
    nonce: bigint,
  ): Promise<NonceConsumeResult> {
    const key = `${NONCE_KEY_PREFIX}${subject}`;

    try {
      const raw = await this.redis!.eval(
        CONSUME_NONCE_LUA,
        1,
        key,
        nonce.toString(),
        this.ttlSeconds,
      );

      const [accepted, lastNonce] = normalizeLuaReply(raw);

      return {
        accepted: accepted === 1,
        lastNonce: BigInt(lastNonce || "0"),
        distributed: true,
      };
    } catch (error) {
      // Fail closed: falling back to per-process state here would let a
      // replayed payload through on any other node in the cluster.
      this.logger.error(
        `Redis nonce consume failed for ${subject}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new ServiceUnavailableException(
        "Nonce verification is temporarily unavailable",
      );
    }
  }

  private async consumeNonceInMemory(
    subject: string,
    nonce: bigint,
  ): Promise<NonceConsumeResult> {
    const now = Date.now();
    const existing = this.memoryNonces.get(subject);
    let lastNonce = 0n;

    if (existing && existing.expiresAt > now) {
      lastNonce = BigInt(existing.nonce);
      if (nonce <= lastNonce) {
        return { accepted: false, lastNonce, distributed: false };
      }
    }

    this.sweepExpired(now);
    this.memoryNonces.set(subject, {
      nonce: nonce.toString(),
      expiresAt: now + this.ttlSeconds * 1000,
    });

    return { accepted: true, lastNonce, distributed: false };
  }

  /**
   * Parse a submitted nonce into a BigInt. BigInt rather than Number because
   * nonces are 64-bit and silently rounding them would let a replayed value
   * compare equal to a different one.
   */
  private parseNonce(value: unknown): bigint {
    const raw = typeof value === "number" ? String(value) : String(value).trim();

    if (!/^\d+$/.test(raw)) {
      throw new BadRequestException("Nonce must be a non-negative integer");
    }

    try {
      return BigInt(raw);
    } catch {
      throw new BadRequestException("Nonce must be a non-negative integer");
    }
  }

  private sweepExpired(now: number): void {
    if (this.memoryNonces.size < MEMORY_SWEEP_THRESHOLD) return;

    for (const [key, entry] of this.memoryNonces) {
      if (entry.expiresAt <= now) this.memoryNonces.delete(key);
    }
  }
}

/** Redis returns multi-bulk replies as arrays of strings or numbers. */
function normalizeLuaReply(raw: unknown): [number, string] {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new Error(`Unexpected nonce script reply: ${String(raw)}`);
  }

  return [Number(raw[0]), String(raw[1] ?? "0")];
}

function resolveNonceTtlSeconds(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }

  const fromEnv = Number.parseInt(process.env.NONCE_TTL_SECONDS ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }

  return DEFAULT_NONCE_TTL_SECONDS;
}
