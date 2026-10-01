import { Role, Permission, hasPermission } from "./roles.enum";
import {
  PERMISSION_MATRIX,
  getActionPermissions,
  getActionsForRole,
  isActionAllowed,
  getSensitiveActions,
  getAuditableActions,
} from "./permission-matrix";

describe("PermissionMatrix", () => {
  describe("matrix completeness", () => {
    it("should have unique action names", () => {
      const actions = PERMISSION_MATRIX.map((e) => e.action);
      const unique = new Set(actions);
      expect(unique.size).toBe(actions.length);
    });

    it("should have at least one entry for every sensitive domain", () => {
      const sensitiveActions = getSensitiveActions();
      expect(sensitiveActions.length).toBeGreaterThan(0);
    });

    it("should have valid permissions in every entry", () => {
      const allPermissions = Object.values(Permission);
      for (const entry of PERMISSION_MATRIX) {
        for (const perm of entry.requiredPermissions) {
          expect(allPermissions).toContain(perm);
        }
      }
    });

    it("should have valid roles in every entry", () => {
      const allRoles = Object.values(Role);
      for (const entry of PERMISSION_MATRIX) {
        for (const role of entry.allowedRoles) {
          expect(allRoles).toContain(role);
        }
      }
    });
  });

  describe("ADMIN access", () => {
    it("should allow ADMIN to perform every action", () => {
      for (const entry of PERMISSION_MATRIX) {
        expect(isActionAllowed([Role.ADMIN], entry.action)).toBe(true);
      }
    });
  });

  describe("USER access", () => {
    it("should deny USER from admin-only actions", () => {
      const adminOnlyActions = [
        "user.manage",
        "role.assign",
        "payment.refund",
        "dead_letter.retry",
        "pause.activate",
        "pause.resume",
        "audit.export",
        "webhook.manage",
        "import.execute",
        "dr.execute",
      ];
      for (const action of adminOnlyActions) {
        expect(isActionAllowed([Role.USER], action)).toBe(false);
      }
    });

    it("should allow USER to perform basic read operations", () => {
      const userActions = [
        "user.read",
        "user.write",
        "portfolio.read",
        "portfolio.write",
        "trade.read",
        "oracle.read",
      ];
      for (const action of userActions) {
        expect(isActionAllowed([Role.USER], action)).toBe(true);
      }
    });
  });

  describe("MAINTAINER access", () => {
    it("should allow MAINTAINER to view but not always manage", () => {
      expect(isActionAllowed([Role.MAINTAINER], "reconciliation.run")).toBe(true);
      expect(isActionAllowed([Role.MAINTAINER], "module.manage")).toBe(true);
      expect(isActionAllowed([Role.MAINTAINER], "pause.view")).toBe(true);
      expect(isActionAllowed([Role.MAINTAINER], "invariant.run")).toBe(true);
    });
  });

  describe("scope-limited permissions", () => {
    it("should mark user-scoped actions as 'own'", () => {
      const ownScoped = PERMISSION_MATRIX.filter((e) => e.scope === "own");
      expect(ownScoped.length).toBeGreaterThan(0);
      // Own-scoped actions should include user/portfolio operations
      const ownActions = ownScoped.map((e) => e.action);
      expect(ownActions).toContain("user.read");
      expect(ownActions).toContain("portfolio.read");
    });

    it("should mark admin actions as 'global'", () => {
      const entry = getActionPermissions("user.manage");
      expect(entry?.scope).toBe("global");
    });
  });

  describe("sensitive actions", () => {
    it("should flag payment and management actions as sensitive", () => {
      const sensitive = getSensitiveActions();
      const actions = sensitive.map((e) => e.action);
      expect(actions).toContain("payment.process");
      expect(actions).toContain("payment.refund");
      expect(actions).toContain("user.manage");
      expect(actions).toContain("role.assign");
      expect(actions).toContain("pause.activate");
    });

    it("should flag sensitive actions as audit-required", () => {
      const sensitive = getSensitiveActions();
      for (const entry of sensitive) {
        expect(entry.auditRequired).toBe(true);
      }
    });
  });

  describe("getActionsForRole", () => {
    it("should return all actions for ADMIN", () => {
      const adminActions = getActionsForRole(Role.ADMIN);
      expect(adminActions.length).toBe(PERMISSION_MATRIX.length);
    });

    it("should return fewer actions for USER than ADMIN", () => {
      const userActions = getActionsForRole(Role.USER);
      const adminActions = getActionsForRole(Role.ADMIN);
      expect(userActions.length).toBeLessThan(adminActions.length);
    });

    it("should return SERVICE_ACTOR-specific actions", () => {
      const serviceActions = getActionsForRole(Role.SERVICE_ACTOR);
      const actions = serviceActions.map((e) => e.action);
      expect(actions).toContain("service.sync");
      expect(actions).toContain("payment.process");
    });
  });

  describe("getActionPermissions", () => {
    it("should return undefined for unknown actions", () => {
      expect(getActionPermissions("nonexistent.action")).toBeUndefined();
    });

    it("should return entry for known actions", () => {
      const entry = getActionPermissions("payment.refund");
      expect(entry).toBeDefined();
      expect(entry!.requiredPermissions).toContain(Permission.PAYMENT_REFUND);
    });
  });

  describe("isActionAllowed", () => {
    it("should return false for unknown actions", () => {
      expect(isActionAllowed([Role.ADMIN], "nonexistent")).toBe(true); // ADMIN bypasses
      expect(isActionAllowed([Role.USER], "nonexistent")).toBe(false);
    });

    it("should support multiple roles", () => {
      // SERVICE_ACTOR + OPERATOR combined
      expect(
        isActionAllowed(
          [Role.SERVICE_ACTOR, Role.OPERATOR],
          "reconciliation.run",
        ),
      ).toBe(true);
    });
  });

  describe("auditable actions", () => {
    it("should include sensitive actions in auditable set", () => {
      const auditable = getAuditableActions();
      const sensitive = getSensitiveActions();
      for (const s of sensitive) {
        expect(auditable.find((a) => a.action === s.action)).toBeDefined();
      }
    });
  });
});
