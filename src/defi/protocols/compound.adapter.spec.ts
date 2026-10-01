import { convertCTokenBalanceToUnderlying } from "./compound.adapter";

describe("convertCTokenBalanceToUnderlying", () => {
  it("reflects accrued interest in the underlying balance", () => {
    const cTokenBalance = 100_000_000n;
    const initialExchangeRate = 2n * 10n ** 26n;
    const accruedExchangeRate = 25n * 10n ** 25n;

    expect(
      convertCTokenBalanceToUnderlying(cTokenBalance, initialExchangeRate),
    ).toBe(20_000_000_000_000_000n);
    expect(
      convertCTokenBalanceToUnderlying(cTokenBalance, accruedExchangeRate),
    ).toBe(25_000_000_000_000_000n);
  });

  it("returns underlying base units for tokens with fewer than 18 decimals", () => {
    const cTokenBalance = 100_000_000n;
    const exchangeRate = 2n * 10n ** 14n;

    expect(
      convertCTokenBalanceToUnderlying(cTokenBalance, exchangeRate),
    ).toBe(20_000n);
  });
});
