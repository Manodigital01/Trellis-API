import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { IsNull, Not, Repository } from "typeorm";
import { User } from "../../core/user/entities/user.entity";

/**
 * Right-to-be-forgotten erasure (issue #141).
 *
 * A soft delete leaves the row in place, which is correct for an audit trail
 * and wrong for GDPR/CCPA: a deleted user's email and username are still
 * personal data, and keeping them indefinitely is a violation regardless of how
 * carefully the rest of the row is preserved.
 *
 * The tension this service resolves is that the same row also holds data the
 * protocol is obliged to keep. A balance, a transaction count and a settlement
 * history are the record of what happened; blanking them to satisfy an erasure
 * request would destroy the accounting trail. So erasure is *anonymisation*:
 * the identifying columns are replaced with a deterministic, non-identifying
 * placeholder, and the financial columns are left untouched.
 *
 * The placeholder is derived from the user id (`deleted_user_<id>`) rather than
 * a counter or a random value, so:
 *  - two erasures of the same user produce the same placeholder, so the row
 *    stays unique and does not collide with another erased user,
 *  - it carries no information beyond the id the row already holds.
 *
 * Erasure is not a hard delete. A hard delete would cascade away the balances
 * this service is careful to preserve, and would break the invariant that
 * financial records outlive the account.
 */

export interface ErasureResult {
  userId: string;
  /** Columns that were rewritten. */
  anonymizedFields: string[];
  /** Count of related rows revoked, if a revoker was supplied. */
  revokedSessions: number;
  /** Soft-deleted after anonymisation, so the row stops appearing in listings. */
  softDeleted: boolean;
  /** Financial columns deliberately left alone. */
  preservedFields: string[];
}

@Injectable()
export class DataErasureService {
  private readonly logger = new Logger(DataErasureService.name);

  /**
   * Columns treated as personal data and rewritten on erasure.
   *
   * Kept as a list rather than derived from the column names so that adding a
   * new PII column is a deliberate act with a test, not an accident.
   */
  static readonly PII_FIELDS: ReadonlyArray<"username" | "email" | "password" | "firstName" | "lastName" | "phone" | "avatarUrl"> = [
    "username",
    "email",
    "password",
    "firstName",
    "lastName",
    "phone",
    "avatarUrl",
  ];

  /**
   * Columns deliberately preserved: the protocol's accounting record. Erasure
   * must not touch these.
   */
  static readonly PRESERVED_FIELDS: ReadonlyArray<string> = [
    "walletAddress",
    "role",
    "createdAt",
    "updatedAt",
  ];

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    /** Optional: revokes refresh tokens and sessions for the erased user. */
    private readonly sessionRevoker?: { revokeAllForUser(userId: string): Promise<number> },
  ) {}

  /**
   * The anonymised placeholder for a user.
   *
   * `.invalid` is reserved by RFC 2606 and can never resolve, so an erased
   * address cannot be delivered to or accidentally match a real mailbox.
   */
  static placeholderFor(userId: string): { username: string; email: string } {
    return {
      username: `deleted_user_${userId}`,
      email: `deleted_user_${userId}@anonymized.invalid`,
    };
  }

  /**
   * Which PII columns actually exist on this entity.
   *
   * Intersected with the real column list so the service works whether or not
   * every optional PII column has been added to the User entity yet, and so a
   * rename cannot make erasure silently write a field that does not exist.
   */
  private presentPiiFields(): string[] {
    const columns = new Set(
      this.userRepository.metadata.columns.map((column) => column.propertyName),
    );
    return DataErasureService.PII_FIELDS.filter((field) => columns.has(field));
  }

  /**
   * Erase one user.
   *
   * Order matters: the row is located by its *current* PII values first, then
   * anonymised, then soft-deleted. Re-running erasure is safe — a user already
   * anonymised matches the placeholder, so a second call is a no-op rather than
   * a second rewrite.
   */
  async eraseUser(userId: string, options: { softDelete?: boolean } = {}): Promise<ErasureResult> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`No user with id ${userId}`);
    }

    const anonymizable = this.presentPiiFields();
    const placeholders = DataErasureService.placeholderFor(userId);
    const updated: Record<string, unknown> = {};
    const anonymizedFields: string[] = [];

    for (const field of anonymizable) {
      // Null and already-anonymised values are left alone so erasure stays
      // idempotent and does not fabricate data where there was none.
      const current = (user as any)[field];
      if (current === null || current === undefined) continue;
      if (field === "username" && current === placeholders.username) continue;
      if (field === "email" && current === placeholders.email) continue;

      if (field === "username") updated[field] = placeholders.username;
      else if (field === "email") updated[field] = placeholders.email;
      else if (field === "password") {
        // A password hash is personal data and useless once the account is
        // gone; null it so it cannot be attacked offline.
        updated[field] = null;
      } else {
        // Names, phone, avatar: nothing to preserve, so clear them.
        updated[field] = null;
      }
      anonymizedFields.push(field);
    }

    if (Object.keys(updated).length > 0) {
      await this.userRepository.update({ id: userId }, updated);
    }

    // Verification state is meaningless once the address is gone.
    if ("emailVerified" in user && (user as any).emailVerified) {
      await this.userRepository.update({ id: userId }, { emailVerified: false });
    }

    let revokedSessions = 0;
    if (this.sessionRevoker) {
      revokedSessions = await this.sessionRevoker.revokeAllForUser(userId);
    }

    const softDelete = options.softDelete !== false;
    if (softDelete) {
      await this.userRepository.softDelete({ id: userId });
    }

    this.logger.log(
      `erasure for ${userId}: anonymized [${anonymizedFields.join(", ")}], revoked ${revokedSessions} session(s)`,
    );

    return {
      userId,
      anonymizedFields,
      revokedSessions,
      softDeleted: softDelete,
      preservedFields: [...DataErasureService.PRESERVED_FIELDS],
    };
  }

  /**
   * Erase every soft-deleted user.
   *
   * A scheduled catch-up for users deleted before this service existed, whose
   * PII is still sitting in the table. Bounded by `limit` so a first run over a
   * large table cannot hold a transaction open indefinitely.
   */
  async eraseAllSoftDeleted(limit = 100): Promise<ErasureResult[]> {
    const stale = await this.userRepository.find({
      where: { deletedAt: Not(IsNull()) },
      take: limit,
    });

    const results: ErasureResult[] = [];
    for (const user of stale) {
      try {
        results.push(await this.eraseUser(user.id, { softDelete: false }));
      } catch (error) {
        this.logger.error(
          `erasure failed for ${user.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return results;
  }
}
