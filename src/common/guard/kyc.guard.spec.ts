import { Test, TestingModule } from "@nestjs/testing";
import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  AML_RISK_SERVICE,
  DEFAULT_MAX_AML_RISK_SCORE,
  DEFAULT_RESTRICTED_JURISDICTIONS,
  JURISDICTION_RESOLVER,
  KycGuard,
  isRestrictedJurisdiction,
  normalizeCountryCode,
} from "./kyc.guard";

function makeContext(request: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => "http",
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function mockReflector(metadata: { isPublic?: boolean; skipKyc?: boolean }) {
  return {
    getAllAndOverride: (key: string) => {
      if (key === "isPublic") return metadata.isPublic ?? false;
      if (key === "skipKyc") return metadata.skipKyc ?? false;
      return undefined;
    },
  } as unknown as Reflector;
}

async function makeGuard(
  options: {
    isPublic?: boolean;
    skipKyc?: boolean;
    jurisdictionResolver?: { resolveCountryCode: jest.Mock };
    amlRiskService?: { getRiskScore: jest.Mock };
  } = {},
): Promise<KycGuard> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      KycGuard,
      { provide: Reflector, useValue: mockReflector(options) },
      {
        provide: JURISDICTION_RESOLVER,
        useValue: options.jurisdictionResolver ?? null,
      },
      { provide: AML_RISK_SERVICE, useValue: options.amlRiskService ?? null },
    ],
  }).compile();

  return module.get<KycGuard>(KycGuard);
}

const VERIFIED_USER = { id: "u1", address: "0xabc", kycVerified: true };

describe("KycGuard", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  describe("country code helpers", () => {
    it("normalises lower case and mixed case codes", () => {
      expect(normalizeCountryCode("kp")).toBe("KP");
      expect(normalizeCountryCode(" ir ")).toBe("IR");
    });

    it("treats provider placeholder codes as unknown", () => {
      expect(normalizeCountryCode("XX")).toBeNull();
      expect(normalizeCountryCode("T1")).toBeNull();
      expect(normalizeCountryCode("")).toBeNull();
      expect(normalizeCountryCode(undefined)).toBeNull();
      expect(normalizeCountryCode("USA")).toBeNull();
    });

    it("matches the default restricted list case-insensitively", () => {
      expect(isRestrictedJurisdiction("kp")).toBe(true);
      expect(isRestrictedJurisdiction("IR")).toBe(true);
      expect(isRestrictedJurisdiction("DE")).toBe(false);
      expect(isRestrictedJurisdiction(null)).toBe(false);
    });

    it("honours an operator-supplied restricted list", () => {
      process.env.KYC_RESTRICTED_JURISDICTIONS = "de, fr";
      expect(isRestrictedJurisdiction("DE")).toBe(true);
      expect(isRestrictedJurisdiction("IR")).toBe(false);
    });
  });

  describe("existing behaviour", () => {
    it("passes non-http contexts through", async () => {
      const guard = await makeGuard();
      const context = { getType: () => "ws" } as unknown as ExecutionContext;

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it("passes public routes through", async () => {
      const guard = await makeGuard({ isPublic: true });

      await expect(guard.canActivate(makeContext({ body: {} }))).resolves.toBe(
        true,
      );
    });

    it("passes @SkipKyc() routes through, even from a sanctioned geo", async () => {
      const guard = await makeGuard({ skipKyc: true });

      await expect(
        guard.canActivate(
          makeContext({
            headers: { "cf-ipcountry": "KP" },
            user: VERIFIED_USER,
          }),
        ),
      ).resolves.toBe(true);
    });

    it("allows a verified user from a permitted jurisdiction", async () => {
      const guard = await makeGuard();

      await expect(
        guard.canActivate(
          makeContext({
            headers: { "cf-ipcountry": "DE" },
            user: VERIFIED_USER,
          }),
        ),
      ).resolves.toBe(true);
    });

    it("still denies an unverified user", async () => {
      const guard = await makeGuard();

      await expect(
        guard.canActivate(
          makeContext({ headers: {}, user: { id: "u1", kycVerified: false } }),
        ),
      ).resolves.toBe(false);
    });
  });

  describe("jurisdiction restrictions", () => {
    it("blocks a request from a sanctioned country with 403", async () => {
      const guard = await makeGuard();

      const error = await guard
        .canActivate(
          makeContext({
            headers: { "cf-ipcountry": "KP" },
            ip: "203.0.113.10",
            user: VERIFIED_USER,
          }),
        )
        .catch((e) => e);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.getStatus()).toBe(403);
      expect(error.getResponse()).toMatchObject({
        reason: "restricted_jurisdiction",
        countryCode: "KP",
      });
    });

    it("blocks every default restricted jurisdiction", async () => {
      const guard = await makeGuard();

      for (const code of DEFAULT_RESTRICTED_JURISDICTIONS) {
        await expect(
          guard.canActivate(
            makeContext({
              headers: { "cf-ipcountry": code },
              user: VERIFIED_USER,
            }),
          ),
        ).rejects.toThrow(ForbiddenException);
      }
    });

    it("accepts the country code from any trusted proxy header", async () => {
      const guard = await makeGuard();

      for (const header of [
        "cf-ipcountry",
        "x-vercel-ip-country",
        "x-geo-country",
        "x-country-code",
      ]) {
        await expect(
          guard.canActivate(
            makeContext({
              headers: { [header]: "IR" },
              user: VERIFIED_USER,
            }),
          ),
        ).rejects.toThrow(ForbiddenException);
      }
    });

    it("prefers an injected MaxMind-backed resolver over the headers", async () => {
      const jurisdictionResolver = {
        resolveCountryCode: jest.fn().mockResolvedValue("SY"),
      };
      const guard = await makeGuard({ jurisdictionResolver });

      await expect(
        guard.canActivate(
          makeContext({
            headers: { "cf-ipcountry": "DE" },
            ip: "198.51.100.5",
            user: VERIFIED_USER,
          }),
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(jurisdictionResolver.resolveCountryCode).toHaveBeenCalledWith(
        "198.51.100.5",
      );
    });

    it("resolves the client IP from the left-most x-forwarded-for entry", async () => {
      const jurisdictionResolver = {
        resolveCountryCode: jest.fn().mockResolvedValue("BY"),
      };
      const guard = await makeGuard({ jurisdictionResolver });

      await expect(
        guard.canActivate(
          makeContext({
            headers: { "x-forwarded-for": "192.0.2.7, 10.0.0.1" },
            user: VERIFIED_USER,
          }),
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(jurisdictionResolver.resolveCountryCode).toHaveBeenCalledWith(
        "192.0.2.7",
      );
    });

    it("fails open when the client cannot be geolocated", async () => {
      const jurisdictionResolver = {
        resolveCountryCode: jest.fn().mockResolvedValue(null),
      };
      const guard = await makeGuard({ jurisdictionResolver });

      await expect(
        guard.canActivate(makeContext({ headers: {}, user: VERIFIED_USER })),
      ).resolves.toBe(true);
    });

    it("fails open when the lookup itself fails", async () => {
      const jurisdictionResolver = {
        resolveCountryCode: jest.fn().mockRejectedValue(new Error("timeout")),
      };
      const guard = await makeGuard({ jurisdictionResolver });

      await expect(
        guard.canActivate(makeContext({ headers: {}, user: VERIFIED_USER })),
      ).resolves.toBe(true);
    });
  });

  describe("AML risk score", () => {
    it("blocks a principal above the threshold with 403", async () => {
      const guard = await makeGuard();

      const error = await guard
        .canActivate(
          makeContext({
            headers: {},
            user: { ...VERIFIED_USER, amlRiskScore: 91 },
          }),
        )
        .catch((e) => e);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.getStatus()).toBe(403);
      expect(error.getResponse()).toMatchObject({
        reason: "aml_risk_score",
        riskScore: 91,
        threshold: DEFAULT_MAX_AML_RISK_SCORE,
      });
    });

    it("allows a principal exactly at the threshold", async () => {
      const guard = await makeGuard();

      await expect(
        guard.canActivate(
          makeContext({
            headers: {},
            user: { ...VERIFIED_USER, amlRiskScore: 80 },
          }),
        ),
      ).resolves.toBe(true);
    });

    it("reads a nested aml.riskScore", async () => {
      const guard = await makeGuard();

      await expect(
        guard.canActivate(
          makeContext({
            headers: {},
            user: { ...VERIFIED_USER, aml: { riskScore: 99 } },
          }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it("queries the risk-rating service and blocks on its verdict", async () => {
      const amlRiskService = { getRiskScore: jest.fn().mockResolvedValue(95) };
      const guard = await makeGuard({ amlRiskService });

      await expect(
        guard.canActivate(makeContext({ headers: {}, user: VERIFIED_USER })),
      ).rejects.toThrow(ForbiddenException);

      expect(amlRiskService.getRiskScore).toHaveBeenCalledWith({
        id: "u1",
        address: "0xabc",
        walletAddress: undefined,
      });
    });

    it("honours a configured threshold", async () => {
      process.env.KYC_MAX_AML_RISK_SCORE = "40";
      const guard = await makeGuard();

      await expect(
        guard.canActivate(
          makeContext({
            headers: {},
            user: { ...VERIFIED_USER, amlRiskScore: 55 },
          }),
        ),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        guard.canActivate(
          makeContext({
            headers: {},
            user: { ...VERIFIED_USER, amlRiskScore: 10 },
          }),
        ),
      ).resolves.toBe(true);
    });

    it("allows principals with no recorded risk score", async () => {
      const guard = await makeGuard();

      await expect(
        guard.canActivate(makeContext({ headers: {}, user: VERIFIED_USER })),
      ).resolves.toBe(true);
    });

    it("falls back to the cached score when the risk service errors", async () => {
      const amlRiskService = {
        getRiskScore: jest.fn().mockRejectedValue(new Error("down")),
      };
      const guard = await makeGuard({ amlRiskService });

      await expect(
        guard.canActivate(
          makeContext({
            headers: {},
            user: { ...VERIFIED_USER, amlRiskScore: 97 },
          }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
