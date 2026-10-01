import { ConflictException } from "@nestjs/common";
import { OptimisticConcurrencyService } from "./optimistic-concurrency.service";

describe("OptimisticConcurrencyService", () => {
  it("rejects a stale write with refresh guidance", () => {
    const service = new OptimisticConcurrencyService();
    expect(() => service.assertCurrent({ version: 3 }, 2)).toThrow(
      ConflictException,
    );
  });

  it("allows the version read by the client and advances it", () => {
    const service = new OptimisticConcurrencyService();
    expect(() => service.assertCurrent({ version: 2 }, 2)).not.toThrow();
    expect(service.nextVersion(2)).toBe(3);
  });
});
