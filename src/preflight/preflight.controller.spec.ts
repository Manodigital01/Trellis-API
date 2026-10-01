import { Test } from "@nestjs/testing";
import { PreflightBlockedException } from "./preflight.errors";
import { PreflightController } from "./preflight.controller";
import { PreflightService } from "./preflight.service";
import { PreflightRequestDto } from "./dto/preflight-request.dto";
import { PreflightResult } from "./preflight.types";

function result(over: Partial<PreflightResult> = {}): PreflightResult {
  return {
    preflightId: "pf:payment_transfer:abc",
    status: "success",
    evaluationVersion: "preflight/1",
    operationDigest: "digest",
    stateVersion: "v1",
    asOf: "2026-09-28T12:00:00.000Z",
    snapshotObservedAt: "2026-09-28T12:00:00.000Z",
    blockingCount: 0,
    warningCount: 0,
    findings: [],
    digest: "result-digest",
    ...over,
  };
}

function request(): PreflightRequestDto {
  return {
    kind: "payment_transfer",
    asset: "XLM",
    amount: "10",
    requiresOraclePrice: false,
    stateVersion: "v1",
    asOf: "2026-09-28T12:00:00.000Z",
  } as PreflightRequestDto;
}

describe("PreflightController", () => {
  let controller: PreflightController;
  let service: { preflight: jest.Mock; assertProceedable: jest.Mock };

  beforeEach(async () => {
    service = {
      preflight: jest.fn(),
      assertProceedable: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [PreflightController],
      providers: [{ provide: PreflightService, useValue: service }],
    }).compile();

    controller = moduleRef.get(PreflightController);
  });

  it("delegates evaluation to the service and returns the result", async () => {
    const evaluation = result();
    service.preflight.mockResolvedValue(evaluation);

    await expect(controller.evaluate(request(), { user: { sub: "user-1" } })).resolves.toBe(
      evaluation,
    );
    expect(service.preflight).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "payment_transfer" }),
      "user-1",
    );
  });

  it("gates the assert route on the service assertion", async () => {
    const evaluation = result({ status: "warning" });
    service.preflight.mockResolvedValue(evaluation);
    service.assertProceedable.mockReturnValue(evaluation);

    await expect(controller.assertProceedable(request())).resolves.toBe(evaluation);
    expect(service.assertProceedable).toHaveBeenCalledWith(evaluation);
  });

  it("propagates the blocking exception from the assert route", async () => {
    const blocked = result({ status: "blocking" });
    service.preflight.mockResolvedValue(blocked);
    service.assertProceedable.mockImplementation(() => {
      throw new PreflightBlockedException(blocked);
    });

    await expect(controller.assertProceedable(request())).rejects.toBeInstanceOf(
      PreflightBlockedException,
    );
  });
});
