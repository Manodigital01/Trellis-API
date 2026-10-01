/**
 * Expensive-operation rate-limit rules (issue #121).
 *
 * Each entry defines a named "expensive" operation and its per-user quota
 * within a sliding window. Admins/operators get a privileged bypass multiplier.
 */

export interface ExpensiveOpRule {
  /** Unique key used as the rate-limit bucket suffix */
  operationKey: string;
  /** Human-readable description shown in error messages */
  label: string;
  /** Max requests allowed per user per window */
  limit: number;
  /** Window duration in milliseconds */
  windowMs: number;
  /** Multiplier applied to `limit` for privileged roles (admin/operator) */
  privilegedMultiplier: number;
}

export const EXPENSIVE_OPERATION_RULES: ExpensiveOpRule[] = [
  {
    operationKey: 'ai:compute',
    label: 'AI agent compute',
    limit: 10,
    windowMs: 60_000,       // 10 req/min per user
    privilegedMultiplier: 10,
  },
  {
    operationKey: 'portfolio:optimize',
    label: 'Portfolio optimisation',
    limit: 5,
    windowMs: 60_000,       // 5 req/min per user
    privilegedMultiplier: 20,
  },
  {
    operationKey: 'import:execute',
    label: 'Data import execution',
    limit: 3,
    windowMs: 300_000,      // 3 req/5 min per user
    privilegedMultiplier: 10,
  },
  {
    operationKey: 'export:request',
    label: 'Data export request',
    limit: 5,
    windowMs: 3_600_000,    // 5 req/hour per user
    privilegedMultiplier: 10,
  },
  {
    operationKey: 'oracle:submit',
    label: 'Oracle on-chain submission',
    limit: 20,
    windowMs: 60_000,
    privilegedMultiplier: 5,
  },
  {
    operationKey: 'snapshot:create',
    label: 'State snapshot creation',
    limit: 5,
    windowMs: 3_600_000,    // 5 per hour
    privilegedMultiplier: 10,
  },
  {
    operationKey: 'staking:stake',
    label: 'Staking operation',
    limit: 10,
    windowMs: 60_000,
    privilegedMultiplier: 5,
  },
  {
    operationKey: 'rebalancing:trigger',
    label: 'Portfolio rebalancing trigger',
    limit: 3,
    windowMs: 300_000,
    privilegedMultiplier: 10,
  },
];

/** Roles that receive the privileged multiplier */
export const PRIVILEGED_ROLES = ['admin', 'operator', 'maintainer'];

/** HTTP header set on every response for rate-limited operations */
export const RATE_LIMIT_HEADERS = {
  LIMIT:      'X-RateLimit-Limit',
  REMAINING:  'X-RateLimit-Remaining',
  RESET:      'X-RateLimit-Reset',
  RETRY_AFTER:'Retry-After',
  SCOPE:      'X-RateLimit-Scope',
} as const;
