/**
 * Proration arithmetic for mid-cycle subscription plan changes (issue #82).
 *
 * `BillingService.setPlan()` used to swap the subscription tier immediately and
 * stop there, so an upgrade on the 16th of a 31-day cycle billed the customer a
 * full month of the new tier on top of the month already paid for the old one,
 * and a downgrade simply took the revenue with no credit for the unused days.
 *
 * The rule implemented here is the one every mainstream billing provider uses:
 * both sides of the transition are valued over the *same* remaining slice of
 * the active billing cycle, so the net is a difference of two numbers computed
 * over an identical window and cannot drift by a rounding step.
 *
 *   unusedCredit  = round(price of the tier being left  x remaining fraction)
 *   newCharge     = round(price of the tier being entered x remaining fraction)
 *   net           = newCharge - unusedCredit   (>0 charge, <0 credit)
 *
 * Two deliberate scoping decisions:
 *
 *  1. Only the recurring subscription fee is prorated. Metered overage is billed
 *     in arrears at cycle close from recorded usage, so it is not a prepaid
 *     amount and there is nothing to credit back mid-cycle.
 *  2. A plan change is never back-dated past the cycle. `remaining fraction`
 *     is clamped to [0, 1], so a change effective after the cycle closed is
 *     worth nothing against that cycle and the caller is expected to roll the
 *     cycle over first (see `BillingService.rolloverBillingCycle`).
 */

export const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * `upgrade`/`downgrade` are decided on price, not on catalogue position, so
 * re-pricing a tier automatically keeps the direction honest. `lateral` is a
 * real tier change at an identical price (no money either way), `unchanged` is
 * the same tier re-submitted, and `activation` is the first subscription on an
 * account — there is no prepaid period to prorate, so the whole cycle is
 * charged and nothing is credited.
 */
export type ProrationDirection =
  | "activation"
  | "upgrade"
  | "downgrade"
  | "lateral"
  | "unchanged";

export type ProrationLineItemKind = "unused_credit" | "new_plan_charge";

export interface ProrationLineItem {
  kind: ProrationLineItemKind;
  description: string;
  planId: string;
  /** Signed, in cents. Credits are always negative. */
  amountCents: number;
  cycleStart: string;
  cycleEnd: string;
  effectiveAt: string;
  totalCycleDays: number;
  remainingDays: number;
  /** Unrounded share of the cycle still ahead of `effectiveAt`, in [0, 1]. */
  remainingFraction: number;
}

export interface ProrationWindow {
  cycleStart: Date;
  cycleEnd: Date;
  effectiveAt: Date;
}

export interface ProrationWindowMeasurement extends ProrationWindow {
  totalCycleMs: number;
  remainingMs: number;
  totalCycleDays: number;
  remainingDays: number;
  remainingFraction: number;
}

export interface ProrationQuote {
  fromPlanId: string;
  toPlanId: string;
  direction: ProrationDirection;
  effectiveAt: string;
  cycleStart: string;
  cycleEnd: string;
  totalCycleDays: number;
  remainingDays: number;
  remainingFraction: number;
  /** Positive magnitude of the unused prepaid value on the old tier. */
  unusedCreditCents: number;
  /** Positive magnitude owed for the remainder of the new tier. */
  newPlanChargeCents: number;
  /** `newPlanChargeCents - unusedCreditCents`. Negative means customer credit. */
  netAmountCents: number;
  lineItems: ProrationLineItem[];
}

export interface PlanChangeInput extends ProrationWindow {
  fromPlanId: string;
  toPlanId: string;
  fromPriceCents: number;
  toPriceCents: number;
  fromPlanName: string;
  toPlanName: string;
  /** True when the account had no subscription before this change. */
  isFirstSubscription?: boolean;
}

/**
 * Add one calendar month, clamping to the last day of the target month so a
 * cycle that starts on the 31st still ends at a real calendar boundary
 * (Jan 31 -> Feb 28/29) instead of drifting into March.
 */
export function addBillingMonth(from: Date): Date {
  const year = from.getUTCMonth() === 11 ? from.getUTCFullYear() + 1 : from.getUTCFullYear();
  const month = (from.getUTCMonth() + 1) % 12;
  const lastDayOfTargetMonth = new Date(
    Date.UTC(year, month + 1, 0),
  ).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(from.getUTCDate(), lastDayOfTargetMonth),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

/**
 * Measure the unused slice of a billing cycle.
 *
 * The fraction is derived from elapsed milliseconds rather than from calendar
 * day boundaries so a 28-day February and a 31-day March are both handled
 * exactly, and a change made at 12:00 is charged for precisely half of what a
 * change made at 00:00 would be.
 */
export function measureRemainingCycle(
  window: ProrationWindow,
): ProrationWindowMeasurement {
  const totalCycleMs = window.cycleEnd.getTime() - window.cycleStart.getTime();
  if (!Number.isFinite(totalCycleMs) || totalCycleMs <= 0) {
    // A zero/negative-length cycle is treated as fully spent: there is no
    // unused value to hand back and nothing left to charge.
    return {
      ...window,
      totalCycleMs: 0,
      remainingMs: 0,
      totalCycleDays: 0,
      remainingDays: 0,
      remainingFraction: 0,
    };
  }

  const elapsedMs = window.effectiveAt.getTime() - window.cycleStart.getTime();
  const remainingMs = Math.min(
    Math.max(window.cycleEnd.getTime() - window.effectiveAt.getTime(), 0),
    totalCycleMs,
  );
  const remainingFraction = Math.min(
    Math.max((totalCycleMs - Math.min(Math.max(elapsedMs, 0), totalCycleMs)) / totalCycleMs, 0),
    1,
  );

  return {
    ...window,
    totalCycleMs,
    remainingMs,
    totalCycleDays: totalCycleMs / MILLISECONDS_PER_DAY,
    remainingDays: remainingMs / MILLISECONDS_PER_DAY,
    remainingFraction,
  };
}

export function resolveProrationDirection(
  fromPlanId: string,
  toPlanId: string,
  fromPriceCents: number,
  toPriceCents: number,
  isFirstSubscription = false,
): ProrationDirection {
  if (isFirstSubscription) return "activation";
  if (fromPlanId === toPlanId) return "unchanged";
  if (toPriceCents > fromPriceCents) return "upgrade";
  if (toPriceCents < fromPriceCents) return "downgrade";
  return "lateral";
}

/**
 * Value a plan transition against the unused part of the active cycle.
 *
 * Each side is rounded to whole cents from the *same* fractional window, so
 * `netAmountCents` is exact to the cent and an upgrade on the very last day of a
 * cycle still nets to a positive charge rather than to a rounding artefact.
 */
export function quotePlanChange(input: PlanChangeInput): ProrationQuote {
  const measured = measureRemainingCycle(input);
  const direction = resolveProrationDirection(
    input.fromPlanId,
    input.toPlanId,
    input.fromPriceCents,
    input.toPriceCents,
    input.isFirstSubscription,
  );

  const unusedCreditCents =
    direction === "unchanged"
      ? 0
      : Math.round(input.fromPriceCents * measured.remainingFraction);
  const newPlanChargeCents =
    direction === "unchanged"
      ? 0
      : Math.round(input.toPriceCents * measured.remainingFraction);

  const base = {
    fromPlanId: input.fromPlanId,
    toPlanId: input.toPlanId,
    direction,
    effectiveAt: input.effectiveAt.toISOString(),
    cycleStart: input.cycleStart.toISOString(),
    cycleEnd: input.cycleEnd.toISOString(),
    totalCycleDays: measured.totalCycleDays,
    remainingDays: measured.remainingDays,
    remainingFraction: measured.remainingFraction,
    unusedCreditCents,
    newPlanChargeCents,
    netAmountCents: newPlanChargeCents - unusedCreditCents,
  };

  const lineItems: ProrationLineItem[] = [];
  // Zero-amount lines are dropped: a $0 plan that is downgraded from has no
  // credit to return, and recording "credit: 0 cents" would only add noise to
  // the audit trail.
  if (unusedCreditCents !== 0) {
    lineItems.push({
      kind: "unused_credit",
      description: `Unused ${input.fromPlanName} plan time (${measured.remainingDays.toFixed(2)} of ${measured.totalCycleDays.toFixed(2)} days)`,
      planId: input.fromPlanId,
      amountCents: -unusedCreditCents,
      ...lineItemWindow(measured),
    });
  }
  if (newPlanChargeCents !== 0) {
    lineItems.push({
      kind: "new_plan_charge",
      description: `Remaining ${input.toPlanName} plan time (${measured.remainingDays.toFixed(2)} of ${measured.totalCycleDays.toFixed(2)} days)`,
      planId: input.toPlanId,
      amountCents: newPlanChargeCents,
      ...lineItemWindow(measured),
    });
  }

  return { ...base, lineItems };
}

function lineItemWindow(
  measured: ProrationWindowMeasurement,
): Pick<
  ProrationLineItem,
  "cycleStart" | "cycleEnd" | "effectiveAt" | "totalCycleDays" | "remainingDays" | "remainingFraction"
> {
  return {
    cycleStart: measured.cycleStart.toISOString(),
    cycleEnd: measured.cycleEnd.toISOString(),
    effectiveAt: measured.effectiveAt.toISOString(),
    totalCycleDays: measured.totalCycleDays,
    remainingDays: measured.remainingDays,
    remainingFraction: measured.remainingFraction,
  };
}
