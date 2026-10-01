import { FeatureFlag, FeatureFlagsService } from "../config/feature-flags.service";
import { HorizonPollingService } from "./horizon-polling.service";

describe("HorizonPollingService", () => {
  it("does not ingest while the rollout flag is disabled", async () => {
    const reconciliation = { pollHorizon: jest.fn() };
    const flags = { isEnabled: jest.fn().mockReturnValue(false) };
    const service = new HorizonPollingService(reconciliation as any, flags as unknown as FeatureFlagsService);

    await expect(service.poll()).resolves.toEqual({
      skipped: true,
      reason: "feature_disabled",
      ingested: 0,
    });
    expect(flags.isEnabled).toHaveBeenCalledWith(FeatureFlag.RECONCILIATION_HORIZON_POLLING);
    expect(reconciliation.pollHorizon).not.toHaveBeenCalled();
  });

  it("delegates when explicitly enabled", async () => {
    const reconciliation = { pollHorizon: jest.fn().mockResolvedValue({ ingested: 2 }) };
    const flags = { isEnabled: jest.fn().mockReturnValue(true) };
    const service = new HorizonPollingService(reconciliation as any, flags as unknown as FeatureFlagsService);

    await expect(service.poll()).resolves.toEqual({ ingested: 2 });
    expect(reconciliation.pollHorizon).toHaveBeenCalledTimes(1);
  });
});