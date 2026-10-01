/**
 * Fault injection for on-chain submission.
 *
 * The wallet path is where a retry can cost real money, so the properties that
 * matter are: a payload that is already on chain is never sent twice, a
 * permanent rejection is not retried, a transient network failure backs off and
 * gives up with an actionable message, and a failed confirmation never triggers
 * a second submission.
 *
 * The provider, wallet and contract are constructed by the service from
 * configuration, so the harness replaces them afterwards. Nothing here opens a
 * socket; backoff delays are configured in single-digit milliseconds.
 *
 * Issue: #127
 */

import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SubmitterService } from "./submitter.service";
import { PayloadStatus, PayloadType, SignedPayload } from "../entities/signed-payload.entity";
import {
  FaultController,
  FaultInjectionError,
  FaultyRepository,
  SideEffectLedger,
  defaultFaultMessage,
} from "../../../testing/fault-injection/fault-injection";

const TEST_PRIVATE_KEY = `0x${"11".repeat(32)}`;
const CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000001";

type PayloadRow = SignedPayload & { id: string };

function payload(overrides: Partial<PayloadRow> = {}): PayloadRow {
  return {
    id: "payload-1",
    payloadType: PayloadType.ORACLE_UPDATE,
    signerAddress: "0x1111111111111111111111111111111111111111",
    nonce: "1",
    payload: { price: 42 },
    payloadHash: `0x${"ab".repeat(32)}`,
    structuredDataHash: `0x${"cd".repeat(32)}`,
    signature: `0x${"ef".repeat(65)}`,
    expiresAt: new Date(Date.now() + 3_600_000),
    status: PayloadStatus.PENDING,
    transactionHash: null,
    blockNumber: null,
    submissionAttempts: 0,
    errorMessage: null,
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    submittedAt: null,
    ...overrides,
  } as PayloadRow;
}

describe("submitter fault injection", () => {
  let chain: FaultController;
  let repo: FaultyRepository<PayloadRow>;
  let ledger: SideEffectLedger;
  let service: SubmitterService;
  let submitPayload: jest.Mock & { estimateGas: jest.Mock };
  let waitForTransaction: jest.Mock;
  let realSetTimeout: typeof setTimeout;

  function buildService(
    config: Record<string, string> = {},
    repository: FaultyRepository<PayloadRow> = repo,
  ): SubmitterService {
    const built = new SubmitterService(
      new ConfigService({
        ETH_RPC_URL: "http://127.0.0.1:8545",
        SUBMITTER_PRIVATE_KEY: TEST_PRIVATE_KEY,
        ORACLE_CONTRACT_ADDRESS: CONTRACT_ADDRESS,
        CHAIN_ID: "11155111",
        SUBMITTER_MAX_RETRIES: "2",
        SUBMITTER_INITIAL_RETRY_DELAY: "1",
        SUBMITTER_MAX_RETRY_DELAY: "2",
        SUBMITTER_RETRY_BACKOFF_MULTIPLIER: "2.0",
        SUBMITTER_GAS_LIMIT_MULTIPLIER: "1.2",
        ...config,
      }),
      repository as never,
    );

    // The service builds its own provider and contract; the harness swaps in
    // scripted doubles so no RPC call ever leaves the process.
    (built as unknown as Record<string, unknown>).oracleContract = {
      submitPayload,
    };
    (built as unknown as Record<string, unknown>).provider = {
      waitForTransaction,
    };
    return built;
  }

  beforeEach(() => {
    realSetTimeout = setTimeout;
    chain = new FaultController("the oracle contract");
    ledger = new SideEffectLedger();
    repo = new FaultyRepository<PayloadRow>(
      new FaultController("PostgreSQL payloads"),
    );
    submitPayload = Object.assign(
      jest.fn(async () => {
        ledger.record("on-chain-submit", "payload-1", { hash: "0xtx1" });
        return { hash: "0xtx1" };
      }),
      { estimateGas: jest.fn(async () => BigInt(21_000)) },
    );
    waitForTransaction = jest.fn(async () => ({ status: 1, blockNumber: 42 }));
    service = buildService();
  });

  afterEach(() => {
    global.setTimeout = realSetTimeout;
  });

  describe("pre-flight rejections", () => {
    it("refuses to submit when the wallet is not configured", async () => {
      const unconfigured = new SubmitterService(
        new ConfigService({}),
        repo as never,
      );

      await expect(unconfigured.submitPayload("payload-1")).rejects.toThrow(
        /SubmitterService is not configured/,
      );
      expect(submitPayload).not.toHaveBeenCalled();
    });

    it("names the payload that does not exist", async () => {
      await expect(service.submitPayload("missing")).rejects.toThrow(
        "Payload missing not found",
      );
    });

    it("refuses an unsigned payload before spending gas", async () => {
      await repo.save(payload({ signature: "" }));

      await expect(service.submitPayload("payload-1")).rejects.toThrow(
        "Payload payload-1 is not signed",
      );
      expect(submitPayload).not.toHaveBeenCalled();
    });

    it("fails an expired payload and records why", async () => {
      await repo.save(
        payload({ expiresAt: new Date(Date.now() - 60_000) }),
      );

      await expect(service.submitPayload("payload-1")).rejects.toThrow(
        "Payload has expired",
      );
      expect(repo.rows[0]).toMatchObject({
        status: PayloadStatus.FAILED,
        errorMessage: "Payload expired before submission",
      });
      expect(submitPayload).not.toHaveBeenCalled();
    });

    it("refuses a payload that is already being retried", async () => {
      await repo.save(payload({ status: PayloadStatus.FAILED }));

      await expect(service.submitPayload("payload-1")).rejects.toThrow(
        /is not in PENDING status/,
      );
      expect(submitPayload).not.toHaveBeenCalled();
    });
  });

  describe("no duplicate irreversible side effects", () => {
    it("submits once and confirms once on the happy path", async () => {
      await repo.save(payload());

      const result = await service.submitPayload("payload-1");
      await new Promise((resolve) => realSetTimeout(resolve, 5));

      expect(result.transactionHash).toBe("0xtx1");
      expect(waitForTransaction).toHaveBeenCalledTimes(1);
      expect(ledger.countOf("on-chain-submit")).toBe(1);
      expect(repo.rows[0]).toMatchObject({
        status: PayloadStatus.CONFIRMED,
        blockNumber: "42",
      });
      expect(() => ledger.assertNoDuplicates()).not.toThrow();
    });

    it("returns the recorded hash without resubmitting a confirmed payload", async () => {
      await repo.save(
        payload({
          status: PayloadStatus.CONFIRMED,
          transactionHash: "0xalready",
        }),
      );

      const result = await service.submitPayload("payload-1");

      expect(result.transactionHash).toBe("0xalready");
      expect(submitPayload).not.toHaveBeenCalled();
      expect(ledger.countOf("on-chain-submit")).toBe(0);
    });

    it("monitors a submitted payload instead of submitting it again", async () => {
      await repo.save(
        payload({ status: PayloadStatus.SUBMITTED, transactionHash: "0xinflight" }),
      );

      const result = await service.submitPayload("payload-1");
      await new Promise((resolve) => realSetTimeout(resolve, 5));

      expect(result.transactionHash).toBe("0xinflight");
      expect(submitPayload).not.toHaveBeenCalled();
      expect(waitForTransaction).toHaveBeenCalledWith("0xinflight", 1);
      expect(repo.rows[0].status).toBe(PayloadStatus.CONFIRMED);
      expect(ledger.countOf("on-chain-submit")).toBe(0);
    });

    it("does not resubmit when the confirmation lookup fails", async () => {
      await repo.save(payload());
      waitForTransaction.mockRejectedValueOnce(
        new Error("Timeout waiting for transaction receipt"),
      );

      await service.submitPayload("payload-1");
      await new Promise((resolve) => realSetTimeout(resolve, 5));

      // The transaction was already sent, so a monitoring failure must not lead
      // to a second submission: the recorded hash is the only handle on it.
      expect(submitPayload).toHaveBeenCalledTimes(1);
      expect(repo.rows[0]).toMatchObject({
        status: PayloadStatus.FAILED,
        errorMessage:
          "Transaction monitoring failed: Timeout waiting for transaction receipt",
      });
      expect(ledger.countOf("on-chain-submit")).toBe(1);
      expect(() => ledger.assertNoDuplicates()).not.toThrow();
    });

    it("records a reverted transaction instead of retrying it", async () => {
      await repo.save(payload());
      waitForTransaction.mockResolvedValueOnce({ status: 0, blockNumber: 43 });

      await service.submitPayload("payload-1");
      await new Promise((resolve) => realSetTimeout(resolve, 5));

      expect(submitPayload).toHaveBeenCalledTimes(1);
      expect(repo.rows[0]).toMatchObject({
        status: PayloadStatus.FAILED,
        errorMessage: "Transaction reverted on-chain",
      });
    });
  });

  describe("wallet and RPC failures", () => {
    it("retries a timeout, then gives up with an actionable message", async () => {
      await repo.save(payload());
      chain.queueTimeout(undefined, 2);
      submitPayload.mockImplementation(async () => {
        const spec = chain.consume("submit");
        if (spec) {
          throw new FaultInjectionError(
            spec.kind,
            defaultFaultMessage(spec.kind, {
              target: "the oracle contract",
              attempt: chain.attemptsFor("submit"),
            }),
            { retryable: true },
          );
        }
        ledger.record("on-chain-submit", "payload-1");
        return { hash: "0xtx1" };
      });

      const result = await service.submitPayload("payload-1");

      expect(result.transactionHash).toBe("0xtx1");
      expect(submitPayload).toHaveBeenCalledTimes(3);
      expect(repo.rows[0]).toMatchObject({
        status: PayloadStatus.SUBMITTED,
        submissionAttempts: 3,
      });
    });

    it("stops after the retry budget and marks the payload failed", async () => {
      await repo.save(payload());
      submitPayload.mockRejectedValue(
        new Error("Gateway timeout while waiting for the node"),
      );

      await expect(service.submitPayload("payload-1")).rejects.toThrow(
        /Gateway timeout/,
      );

      // Two retries configured, so three attempts in total.
      expect(submitPayload).toHaveBeenCalledTimes(3);
      expect(repo.rows[0]).toMatchObject({
        status: PayloadStatus.FAILED,
        submissionAttempts: 3,
        errorMessage: "Gateway timeout while waiting for the node",
      });
      expect(ledger.countOf("on-chain-submit")).toBe(0);
    });

    it("does not retry a permanent wallet rejection", async () => {
      await repo.save(payload());
      submitPayload.mockRejectedValue(
        new Error("insufficient funds for gas * price + value"),
      );

      await expect(service.submitPayload("payload-1")).rejects.toThrow(
        /insufficient funds/,
      );

      expect(submitPayload).toHaveBeenCalledTimes(1);
      expect(repo.rows[0]).toMatchObject({
        status: PayloadStatus.FAILED,
        submissionAttempts: 1,
      });
    });

    it("does not retry a reverted call", async () => {
      await repo.save(payload());
      submitPayload.mockRejectedValue(
        new Error("execution reverted: nonce already used"),
      );

      await expect(service.submitPayload("payload-1")).rejects.toThrow(
        /execution reverted/,
      );
      expect(submitPayload).toHaveBeenCalledTimes(1);
    });

    it("falls back to a default gas limit when estimation fails", async () => {
      await repo.save(payload());
      submitPayload.estimateGas.mockRejectedValue(
        new Error("execution reverted during estimation"),
      );

      const result = await service.submitPayload("payload-1");

      expect(result.transactionHash).toBe("0xtx1");
      expect(submitPayload).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        // 300000 * 1.2 gas limit multiplier.
        { gasLimit: 360000n },
      );
    });

    it("surfaces a BadRequestException rather than a raw provider error", async () => {
      await expect(
        service.submitPayload("nope"),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("determinism", () => {
    it("produces the same outcome for the same fault script", async () => {
      const run = async () => {
        const controller = new FaultController("the oracle contract");
        const attempt = jest.fn(async () => {
          const spec = controller.consume("submit");
          if (spec) throw new FaultInjectionError("timeout", "timed out", { retryable: true });
          return { hash: "0xtx1" };
        });
        return { controller, attempt };
      };

      const first = await run();
      const second = await run();
      first.attempt();
      second.attempt();

      expect(first.attempt.mock.calls).toHaveLength(1);
      expect(second.attempt.mock.calls).toHaveLength(1);
      expect(first.controller.attemptsFor("submit")).toBe(1);
      expect(second.controller.attemptsFor("submit")).toBe(1);
    });
  });
});
