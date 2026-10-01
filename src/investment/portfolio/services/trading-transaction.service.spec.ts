import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { Keypair, Account } from "@stellar/stellar-sdk";
import {
  TradingTransactionService,
  TradeRequest,
  calculateMinAcceptableOutput,
} from "./trading-transaction.service";

describe("TradingTransactionService", () => {
  let service: TradingTransactionService;
  const validSecretKey = Keypair.random().secret();
  const mockAccount = new Account(
    Keypair.fromSecret(validSecretKey).publicKey(),
    "100",
  );

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TradingTransactionService],
    }).compile();

    service = module.get<TradingTransactionService>(TradingTransactionService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("trade execution success & persistence", () => {
    it("should execute trade successfully and persist transaction hash", async () => {
      const request: TradeRequest = {
        portfolioId: "p-1",
        ticker: "XLM",
        action: "buy",
        quantity: 100,
        price: 0.12,
        clientRequestId: "req-001",
      };

      const result = await service.processTrade(request);

      expect(result.success).toBe(true);
      expect(result.status).toBe("CONFIRMED");
      expect(result.transactionHash).toBeDefined();
      expect(result.executedQuantity).toBe(100);
      expect(result.executedPrice).toBe(0.12);

      const persisted = service.getTradeByHash(result.transactionHash!);
      expect(persisted).toEqual(result);
    });
  });

  describe("idempotency", () => {
    it("should return identical result for duplicate clientRequestId without double execution", async () => {
      const request: TradeRequest = {
        portfolioId: "p-1",
        ticker: "BTC",
        action: "sell",
        quantity: 1,
        price: 50000,
        clientRequestId: "idempotency-key-123",
      };

      const firstCall = await service.processTrade(request);
      const secondCall = await service.processTrade(request);

      expect(firstCall).toBe(secondCall);
      expect(service.getAllTrades()).toHaveLength(1);
    });
  });

  describe("failure modes", () => {
    it("should handle INSUFFICIENT_BALANCE distinctly", async () => {
      const request: TradeRequest = {
        portfolioId: "p-1",
        ticker: "ETH",
        action: "buy",
        quantity: 10,
        price: 3000,
        accountBalance: 500, // less than required 30,000
      };

      const result = await service.processTrade(request);

      expect(result.success).toBe(false);
      expect(result.status).toBe("FAILED");
      expect(result.errorReason).toBe("INSUFFICIENT_BALANCE");
    });

    it("should handle TRUSTLINE_MISSING distinctly", async () => {
      const request: TradeRequest = {
        portfolioId: "p-1",
        ticker: "USDC",
        action: "buy",
        quantity: 500,
        price: 1,
        hasTrustline: false,
      };

      const result = await service.processTrade(request);

      expect(result.success).toBe(false);
      expect(result.status).toBe("FAILED");
      expect(result.errorReason).toBe("TRUSTLINE_MISSING");
    });

    it("should handle price moving beyond SLIPPAGE_EXCEEDED tolerance distinctly", async () => {
      const request: TradeRequest = {
        portfolioId: "p-1",
        ticker: "XLM",
        action: "buy",
        quantity: 1000,
        price: 0.1,
        actualPrice: 0.15, // 50% price change > 2% slippage tolerance
        slippageTolerance: 0.02,
      };

      const result = await service.processTrade(request);

      expect(result.success).toBe(false);
      expect(result.status).toBe("FAILED");
      expect(result.errorReason).toBe("SLIPPAGE_EXCEEDED");
    });

    it("should distinguish network error failure mode", async () => {
      const mockHorizonServer: any = {
        loadAccount: jest
          .fn()
          .mockRejectedValue(new Error("Network connection refused")),
      };
      service.setHorizonServer(mockHorizonServer);

      const request: TradeRequest = {
        portfolioId: "p-1",
        ticker: "XLM",
        action: "buy",
        quantity: 100,
        price: 0.1,
        sourceSecret: validSecretKey,
      };

      const result = await service.processTrade(request);

      expect(result.success).toBe(false);
      expect(result.status).toBe("FAILED");
      expect(result.errorReason).toBe("NETWORK_ERROR");
    });
  });

  describe("slippage protection (issue #166)", () => {
    it("calculateMinAcceptableOutput implements minOutput = expectedOutput * (1 - slippage)", () => {
      expect(calculateMinAcceptableOutput(1000, 0.005)).toBeCloseTo(995);
      expect(calculateMinAcceptableOutput(1000, 0)).toBe(1000);
      expect(calculateMinAcceptableOutput(0.1, 0.02)).toBeCloseTo(0.098);
    });

    it("honours maxSlippagePercent expressed in percent (0.5 = 0.5%)", async () => {
      const request: TradeRequest = {
        portfolioId: "p-166",
        ticker: "XLM",
        action: "buy",
        quantity: 1000,
        price: 0.1,
        actualPrice: 0.1006, // 0.6% drift > 0.5% tolerance
        maxSlippagePercent: 0.5,
      };

      const result = await service.processTrade(request);

      expect(result.success).toBe(false);
      expect(result.status).toBe("FAILED");
      expect(result.errorReason).toBe("SLIPPAGE_EXCEEDED");
    });

    it("accepts drift inside the maxSlippagePercent tolerance and reports minOutput", async () => {
      const request: TradeRequest = {
        portfolioId: "p-166",
        ticker: "XLM",
        action: "buy",
        quantity: 1000,
        price: 0.1,
        actualPrice: 0.1004, // 0.4% drift < 0.5% tolerance
        maxSlippagePercent: 0.5,
        clientRequestId: "slip-ok-1",
      };

      const result = await service.processTrade(request);

      expect(result.success).toBe(true);
      // expectedOutput = 1000 * 0.1004 = 100.4; minOutput = 100.4 * (1 - 0.005)
      expect(result.minAcceptableOutput).toBeCloseTo(100.4 * 0.995, 6);
    });

    it("maxSlippagePercent takes precedence over slippageTolerance when both are set", async () => {
      const request: TradeRequest = {
        portfolioId: "p-166",
        ticker: "XLM",
        action: "buy",
        quantity: 100,
        price: 0.1,
        actualPrice: 0.105, // 5% drift: inside 10% legacy tolerance, outside 1% new one
        slippageTolerance: 0.1,
        maxSlippagePercent: 1,
      };

      const result = await service.processTrade(request);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("SLIPPAGE_EXCEEDED");
    });

    it("rejects invalid maxSlippagePercent values", async () => {
      for (const bad of [-1, 100, 150, Number.NaN]) {
        await expect(
          service.processTrade({
            portfolioId: "p-166",
            ticker: "XLM",
            action: "buy",
            quantity: 1,
            price: 0.1,
            maxSlippagePercent: bad,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    });
  });

  describe("transaction deadline enforcement (issue #166)", () => {
    it("rejects a trade whose execution time is past the deadline before submission", async () => {
      const mockHorizonServer: any = {
        loadAccount: jest.fn(),
        submitTransaction: jest.fn(),
      };
      service.setHorizonServer(mockHorizonServer);

      const result = await service.processTrade({
        portfolioId: "p-166",
        ticker: "XLM",
        action: "buy",
        quantity: 10,
        price: 0.1,
        sourceSecret: validSecretKey,
        deadlineTimestamp: Date.now() - 1000, // expired one second ago
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe("FAILED");
      expect(result.errorReason).toBe("DEADLINE_EXCEEDED");
      // No side effect may have happened.
      expect(mockHorizonServer.loadAccount).not.toHaveBeenCalled();
      expect(mockHorizonServer.submitTransaction).not.toHaveBeenCalled();
    });

    it("accepts ISO deadline strings that are still in the future", async () => {
      const result = await service.processTrade({
        portfolioId: "p-166",
        ticker: "XLM",
        action: "buy",
        quantity: 10,
        price: 0.1,
        deadlineTimestamp: new Date(Date.now() + 60_000).toISOString(),
        clientRequestId: "deadline-ok-1",
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe("CONFIRMED");
    });

    it("rejects unparseable deadline values with a clear error", async () => {
      await expect(
        service.processTrade({
          portfolioId: "p-166",
          ticker: "XLM",
          action: "buy",
          quantity: 10,
          price: 0.1,
          deadlineTimestamp: "not-a-timestamp",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("tightens the on-chain timeout so the transaction cannot outlive the deadline", async () => {
      const captured: any[] = [];
      const mockHorizonServer: any = {
        loadAccount: jest.fn().mockResolvedValue(mockAccount),
        submitTransaction: jest.fn().mockImplementation(async (tx: any) => {
          captured.push(tx);
          return { hash: "deadline-tx-hash", successful: true };
        }),
      };
      service.setHorizonServer(mockHorizonServer);

      const now = Date.now();
      service.setClock(() => now);
      const deadline = now + 10_000; // 10s window

      const result = await service.processTrade({
        portfolioId: "p-166",
        ticker: "XLM",
        action: "buy",
        quantity: 10,
        price: 0.1,
        sourceSecret: validSecretKey,
        deadlineTimestamp: deadline,
      });

      expect(result.success).toBe(true);
      expect(captured).toHaveLength(1);
      // maxTime is the on-chain deadline in epoch seconds; it must not exceed
      // the caller's deadline, and must still be in the future.
      const maxTimeSeconds = Number(captured[0].timeBounds.maxTime);
      expect(maxTimeSeconds).toBeGreaterThan(0);
      expect(maxTimeSeconds).toBeLessThanOrEqual(Math.floor(deadline / 1000));
    });

    it("caches the DEADLINE_EXCEEDED failure per clientRequestId like other failure modes", async () => {
      const request: TradeRequest = {
        portfolioId: "p-166",
        ticker: "XLM",
        action: "buy",
        quantity: 10,
        price: 0.1,
        clientRequestId: "deadline-dup-1",
        deadlineTimestamp: Date.now() - 5000,
      };

      const first = await service.processTrade(request);
      const second = await service.processTrade(request);

      expect(first.errorReason).toBe("DEADLINE_EXCEEDED");
      expect(second).toBe(first);
    });
  });

  describe("timed out submission ledger verification", () => {
    it("should check ledger on timeout and confirm if transaction exists on chain", async () => {
      const mockHorizonServer: any = {
        loadAccount: jest.fn().mockResolvedValue(mockAccount),
        submitTransaction: jest
          .fn()
          .mockRejectedValue({ message: "timeout error" }),
        transactions: jest.fn().mockReturnValue({
          transaction: jest.fn().mockReturnValue({
            call: jest.fn().mockResolvedValue({
              successful: true,
              hash: "ledger-confirmed-hash-123",
            }),
          }),
        }),
      };

      service.setHorizonServer(mockHorizonServer);

      const request: TradeRequest = {
        portfolioId: "p-1",
        ticker: "XLM",
        action: "buy",
        quantity: 50,
        price: 0.1,
        sourceSecret: validSecretKey,
      };

      const result = await service.processTrade(request);

      expect(result.success).toBe(true);
      expect(result.status).toBe("CONFIRMED");
      expect(result.transactionHash).toBe("ledger-confirmed-hash-123");
    });

    it("should report TIMED_OUT if transaction is not found on ledger after timeout", async () => {
      const mockHorizonServer: any = {
        loadAccount: jest.fn().mockResolvedValue(mockAccount),
        submitTransaction: jest
          .fn()
          .mockRejectedValue({ message: "timeout error" }),
        transactions: jest.fn().mockReturnValue({
          transaction: jest.fn().mockReturnValue({
            call: jest.fn().mockRejectedValue(new Error("404 Not Found")),
          }),
        }),
      };

      service.setHorizonServer(mockHorizonServer);

      const request: TradeRequest = {
        portfolioId: "p-1",
        ticker: "XLM",
        action: "buy",
        quantity: 50,
        price: 0.1,
        sourceSecret: validSecretKey,
      };

      const result = await service.processTrade(request);

      expect(result.success).toBe(false);
      expect(result.status).toBe("TIMED_OUT");
      expect(result.errorReason).toBe("NETWORK_TIMEOUT");
    });
  });
});
