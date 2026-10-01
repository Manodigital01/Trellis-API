# Policy engine

The policy engine centralizes configurable business decisions. It currently
governs `POST /trading/execute`; future business rules should be added as typed
inputs and decisions to `src/policy`, rather than embedded in controllers.

## Trading policy configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `TRADING_ENABLED` | `true` | Set to `false` to reject trade execution safely. |
| `TRADING_MAX_ORDER_AMOUNT` | `100000` | Inclusive maximum per trade request. |
| `TRADING_ALLOWED_ASSETS` | empty | Optional comma-separated asset allow-list. |
| `TRADING_ALLOWED_SIDES` | `buy,sell` | Comma-separated sides permitted for execution. |

Policy failures are returned as HTTP 400 responses with a stable `code`, the
relevant `field`, and a user-safe message. Amount-limit failures also include
the configured `limit`; restriction failures include `allowedValues`. Do not
use policy error details to expose account, authorization, or internal state.

## Boundary behavior

- An amount exactly equal to `TRADING_MAX_ORDER_AMOUNT` is accepted.
- Amounts above the maximum, zero, negative, non-finite values, and disabled
  trading are rejected.
- Asset allow-list comparisons are case-insensitive.

Run the focused checks with:

```bash
npx jest src/policy/policy.service.spec.ts --runInBand
```
