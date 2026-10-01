import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  SoftDeleteCascadeSubscriber,
  USER_SOFT_DELETE_CASCADE,
} from "./soft-delete-cascade.subscriber";

/**
 * Issue #141: soft-deleting a parent must soft-delete its children.
 *
 * The subscriber is tested against a fake DataSource rather than a real
 * database, because what matters here is the *decision* — which targets, which
 * column, which relation — and those are exactly the parts a real database
 * would hide behind its own constraint behaviour.
 */
describe("SoftDeleteCascadeSubscriber (#141)", () => {
  let subscriber: SoftDeleteCascadeSubscriber;
  let dataSource: { getMetadata: jest.Mock; getRepository: jest.Mock };
  let execute: jest.Mock;

  /** Minimal metadata for a child entity that supports soft delete. */
  function childMetadata(overrides: Record<string, any> = {}) {
    return {
      name: "Child",
      target: class Child {},
      deleteDateColumn: { propertyName: "deletedAt" },
      findRelationWithPropertyPath: jest.fn().mockReturnValue({
        joinColumn: { databaseName: "userId" },
      }),
      ...overrides,
    };
  }

  beforeEach(async () => {
    execute = jest.fn().mockResolvedValue({ affected: 3 });
    const metadata = childMetadata();

    dataSource = {
      getMetadata: jest.fn().mockReturnValue(metadata),
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          update: jest.fn().mockReturnValue({
            set: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({ execute }),
            }),
          }),
        }),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SoftDeleteCascadeSubscriber,
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    subscriber = module.get<SoftDeleteCascadeSubscriber>(SoftDeleteCascadeSubscriber);
  });

  describe("configuration", () => {
    // The cascade targets are declared, not inferred. Inferring them from the
    // metadata would cascade to tables a soft delete was never meant to touch,
    // and a wrong guess would be silent and destructive.
    it("declares its cascade targets explicitly", () => {
      expect(Array.isArray(USER_SOFT_DELETE_CASCADE)).toBe(true);
      expect(USER_SOFT_DELETE_CASCADE.length).toBeGreaterThan(0);
      for (const cascade of USER_SOFT_DELETE_CASCADE) {
        expect(typeof cascade.entity).toBe("function");
        expect(typeof cascade.relation).toBe("string");
        expect(cascade.relation.length).toBeGreaterThan(0);
      }
    });

    it("cascades to refresh tokens, which are bearer credentials", () => {
      // A live refresh token surviving a soft-deleted account is a credential
      // with no owner; the row also carries an IP and user agent.
      expect(
        USER_SOFT_DELETE_CASCADE.some((c) => /RefreshToken/.test(c.entity().name)),
      ).toBe(true);
    });
  });

  describe("afterSoftRemove", () => {
    it("does nothing for an entity with no configured cascade", () => {
      // A plain object is not one of the declared targets, so nothing cascades.
      subscriber.afterSoftRemove({ entity: { id: "user-1" } });

      expect(dataSource.getRepository).not.toHaveBeenCalled();
    });

    it("does nothing when there is no entity on the event", () => {
      expect(() => subscriber.afterSoftRemove({})).not.toThrow();
      expect(dataSource.getRepository).not.toHaveBeenCalled();
    });

    it("does nothing when the entity has no id", () => {
      // A cascadeless update has nothing to key children on.
      subscriber.afterSoftRemove({ entity: { notAnId: true } });
      expect(dataSource.getRepository).not.toHaveBeenCalled();
    });
  });

  describe("cascading", () => {
    beforeEach(() => {
      // Register one cascade for the entity under test.
      const target = class RefreshToken {};
      (USER_SOFT_DELETE_CASCADE as any).push({
        entity: () => target,
        relation: "user",
      });
      (global as any).__cascadeTarget = target;
    });

    afterEach(() => {
      (USER_SOFT_DELETE_CASCADE as any).length = 0;
      delete (global as any).__cascadeTarget;
    });

    it("sets deletedAt on the children of a soft-deleted parent", async () => {
      const entity = new (global as any).__cascadeTarget();
      entity.id = "user-1";

      subscriber.afterSoftRemove({ entity });

      // The cascade is fire-and-forget; let the microtask queue drain.
      await new Promise((resolve) => setImmediate(resolve));

      expect(dataSource.getRepository).toHaveBeenCalled();
      expect(execute).toHaveBeenCalled();
      const [whereClause, params] = execute.mock.calls[0];
      expect(String(whereClause)).toContain("userId");
      expect(String(whereClause)).toContain(":parentId");
      expect(params).toEqual({ parentId: "user-1" });
    });

    it("skips a child entity that has no @DeleteDateColumn", async () => {
      // A hard-delete-only child cannot be soft deleted; cascading would
      // silently do nothing and imply coverage that does not exist.
      dataSource.getMetadata.mockReturnValue(
        childMetadata({ deleteDateColumn: undefined }),
      );

      const entity = new (global as any).__cascadeTarget();
      entity.id = "user-1";
      subscriber.afterSoftRemove({ entity });

      await new Promise((resolve) => setImmediate(resolve));

      expect(execute).not.toHaveBeenCalled();
    });

    it("skips a child whose relation is not found rather than guessing", async () => {
      dataSource.getMetadata.mockReturnValue(
        childMetadata({ findRelationWithPropertyPath: jest.fn().mockReturnValue(undefined) }),
      );

      const entity = new (global as any).__cascadeTarget();
      entity.id = "user-1";
      subscriber.afterSoftRemove({ entity });

      await new Promise((resolve) => setImmediate(resolve));

      expect(execute).not.toHaveBeenCalled();
    });

    // A parent soft delete has already been written by the time the
    // subscriber fires, so throwing here would roll back a delete the caller
    // was told succeeded.
    it("logs a cascade failure instead of throwing", async () => {
      execute.mockRejectedValue(new Error("deadlock detected"));

      const entity = new (global as any).__cascadeTarget();
      entity.id = "user-1";

      expect(() => subscriber.afterSoftRemove({ entity })).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
    });
  });
});
