import { Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, EntitySubscriberInterface, EventSubscriber, ObjectLiteral } from "typeorm";
import { RefreshToken } from "../../../core/auth/entities/auth.entity";

/**
 * Cascading soft delete (issue #141).
 *
 * `BaseEntity` gives every entity a `@DeleteDateColumn()`, and
 * `BaseRepository.softDelete` sets it. But nothing propagated that to child
 * rows: soft-deleting a `User` left their `RefreshToken`, `SocialAccount`,
 * `GrantfoxToken`, `DeFiPosition`, `Grant` and audit rows live, and reachable
 * by a direct foreign-key query. A soft delete that orphans its children is
 * only a rename of "deleted" — the data is still there, and a query that
 * forgets the `deletedAt IS NULL` filter still returns it.
 *
 * Hard deletes are already handled by the foreign keys, which is why this only
 * concerns soft deletes.
 *
 * Two things this deliberately does *not* do:
 *
 *  - It does not guess the child relations. The cascade targets are declared
 *    explicitly below. Inferring them from the metadata would cascade to
 *    tables a soft delete was never meant to touch, and a wrong guess is silent
 *    and destructive.
 *  - It does not run in a transaction it cannot own. A subscriber fires inside
 *    the caller's transaction, so the cascade inherits it: either the parent
 *    soft delete and every child commit together, or neither does. Opening a
 *    separate transaction here would let a child commit survive a parent
 *    rollback, which is the opposite of the atomicity this is for.
 */

/** Child tables cascaded on a soft delete of `User`, and their FK column. */
export const USER_SOFT_DELETE_CASCADE: ReadonlyArray<{
  /** TypeORM entity target. */
  entity: () => ObjectLiteral;
  /** Property name of the `ManyToOne` that points at User. */
  relation: string;
}> = [
  // Refresh tokens exist only to serve the account. Once the user is soft
  // deleted a live token must not survive: it is a bearer credential, and
  // `DataErasureService` (#141) revokes them, but a token issued between the
  // revoke and the soft delete would otherwise stay valid. The row also
  // carries an IP address and a user-agent string, which are personal data.
  { entity: () => RefreshToken, relation: "user" },
];

@Injectable()
@EventSubscriber()
export class SoftDeleteCascadeSubscriber implements EntitySubscriberInterface<ObjectLiteral> {
  private readonly logger = new Logger(SoftDeleteCascadeSubscriber.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Run after a soft delete lands.
   *
   * `softRemove` is not used to cascade: it would emit another
   * `afterSoftRemove` for every child and recurse. Instead the children's
   * `deletedAt` columns are updated directly, which cannot re-enter.
   */
  afterSoftRemove(event: { entity?: ObjectLiteral; entityId?: any; source?: any }): void {
    const entity = event.entity;
    if (!entity) return;

    const cascades = this.cascadesFor(entity);
    if (cascades.length === 0) return;

    const identifier = (entity as any).id;
    if (!identifier) {
      this.logger.warn("soft delete cascade skipped: entity has no id");
      return;
    }

    for (const cascade of cascades) {
      void this.cascade(cascade.entity(), identifier, cascade.relation);
    }
  }

  /** The cascade targets declared for this entity, or empty. */
  private cascadesFor(entity: ObjectLiteral): typeof USER_SOFT_DELETE_CASCADE {
    const target = (entity as any).constructor;
    return USER_SOFT_DELETE_CASCADE.filter((cascade) => cascade.entity() === target);
  }

  /**
   * Soft delete every child of `parentId`.
   *
   * Errors are logged rather than thrown: the parent's soft delete has already
   * been written by the time this fires, so throwing here would roll back a
   * delete the caller was told succeeded, and the retry would be ambiguous.
   * Logging keeps the failure visible and reconcilable.
   */
  private async cascade(child: any, parentId: string, relation: string): Promise<void> {
    const metadata = this.dataSource.getMetadata(child);
    if (!metadata) {
      this.logger.warn(`no metadata for cascade target; skipped ${metadata?.name ?? "unknown"}`);
      return;
    }

    // Only entities that actually have a soft-delete column can be cascaded.
    if (!metadata.deleteDateColumn) {
      this.logger.debug(
        `cascade target ${metadata.name} has no @DeleteDateColumn; skipped`,
      );
      return;
    }

    const relationMetadata = metadata.findRelationWithPropertyPath(relation);
    if (!relationMetadata) {
      this.logger.warn(
        `relation ${relation} not found on ${metadata.name}; cascade skipped`,
      );
      return;
    }

    const joinColName = relationMetadata.joinColumns?.[0]?.databaseName ?? `${relation}Id`;

    try {
      const result = await this.dataSource
        .getRepository(metadata.target)
        .createQueryBuilder()
        .update()
        .set({ [metadata.deleteDateColumn.propertyName]: new Date() } as any)
        .where(`${joinColName} = :parentId`, { parentId })
        .execute();

      this.logger.log(
        `soft delete cascade: ${metadata.name}.${relation} for ${parentId} affected ${
          result?.affected ?? 0
        } row(s)`,
      );
    } catch (error) {
      this.logger.error(
        `soft delete cascade failed for ${metadata.name}.${relation} (parent ${parentId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
