import { Injectable, NotFoundException, Optional } from "@nestjs/common";
import {
  billingEstimatedChargesCents,
  billingProrationNetCents,
  billingUsageUnits,
} from "../config/metrics";
import {
  addBillingMonth,
  ProrationDirection,
  ProrationLineItem,
  ProrationQuote,
  quotePlanChange,
} from "./billing-proration";

export interface BillingPlan {
  id: string;
  name: string;
  monthlyPriceCents: number;
  includedUnits: number;
  unitPriceCents: number;
}

export interface UsageRecord {
  accountId: string;
  metric: string;
  quantity: number;
  tokenizedAccessId?: string;
  idempotencyKey?: string;
  recordedAt: string;
}

export interface InvoicePreview {
  accountId: string;
  planId: string;
  periodStart: string;
  periodEnd: string;
  subtotalCents: number;
  currency: "usd";
  lineItems: Array<{
    description: string;
    quantity: number;
    unitPriceCents: number;
    amountCents: number;
  }>;
}

export interface BillingCycle {
  cycleStart: string;
  cycleEnd: string;
}

export interface BillingAuditEntry {
  id: string;
  accountId: string;
  fromPlanId: string;
  toPlanId: string;
  direction: ProrationDirection;
  effectiveAt: string;
  cycleStart: string;
  cycleEnd: string;
  totalCycleDays: number;
  remainingDays: number;
  remainingFraction: number;
  unusedCreditCents: number;
  newPlanChargeCents: number;
  netAmountCents: number;
  currency: "usd";
  lineItems: ProrationLineItem[];
  recordedAt: string;
}

export interface PlanChangeResult {
  accountId: string;
  plan: BillingPlan;
  previousPlan: BillingPlan;
  proration: ProrationQuote;
  billingCycle: BillingCycle;
  /** Credit carried on the account and offset against the next invoice. */
  creditBalanceCents: number;
}

export interface BillingRolloverResult {
  accountId: string;
  closedCycle: BillingCycle;
  nextCycle: BillingCycle;
  creditBalanceCents: number;
  /** Credit that expired with the cycle it was issued in. */
  writtenOffCreditCents: number;
  plan: BillingPlan;
}

export interface SetPlanOptions {
  /** Instant the tier takes effect; defaults to the service clock. */
  at?: Date;
  /** Anchors the first billing cycle, e.g. to align to a calendar month. */
  cycleStart?: Date;
}

export interface StripeUsageExport {
  customer: string;
  items: Array<{
    price: string;
    quantity: number;
    timestamp: string;
    metadata?: { tokenizedAccessId: string };
  }>;
}

const PLANS: BillingPlan[] = [
  {
    id: "free",
    name: "Free",
    monthlyPriceCents: 0,
    includedUnits: 100,
    unitPriceCents: 0,
  },
  {
    id: "starter",
    name: "Starter",
    monthlyPriceCents: 1900,
    includedUnits: 10000,
    unitPriceCents: 1,
  },
  {
    id: "growth",
    name: "Growth",
    monthlyPriceCents: 9900,
    includedUnits: 100000,
    unitPriceCents: 1,
  },
];

/**
 * Per-account subscription state. The billing cycle is anchored on first
 * activation (or on the caller-supplied anchor) and only ever moves forward in
 * whole calendar months, so the same window is used for every proration
 * decision taken inside that cycle.
 */
interface AccountSubscription {
  planId: string;
  cycleStart: Date;
  cycleEnd: Date;
  /** Unspent credit from mid-cycle downgrades, in cents. */
  creditBalanceCents: number;
  /** Cycle the outstanding credit was issued in; credits do not outlive it. */
  creditCycleStart: Date | null;
  creditCycleEnd: Date | null;
}

@Injectable()
export class BillingService {
  private readonly accountPlans = new Map<string, string>();
  private readonly subscriptions = new Map<string, AccountSubscription>();
  private readonly auditTrail = new Map<string, BillingAuditEntry[]>();
  private readonly usage = new Map<string, UsageRecord[]>();
  private readonly idempotencyKeys = new Map<string, UsageRecord>();

  constructor(@Optional() private readonly clock: () => Date = () => new Date()) {}

  getPlans(): BillingPlan[] {
    return PLANS.map((plan) => ({ ...plan }));
  }

  /**
   * Switch an account's tier, valuing the transition against the unused part of
   * the active billing cycle (issue #82).
   *
   * The tier always changes immediately — the account gets the new plan's
   * entitlements — but the money is settled by proration: the unused prepaid
   * value on the old tier is credited, the remaining time on the new tier is
   * charged, and both land in the audit trail with their own line items.
   */
  setPlan(
    accountId: string,
    planId: string,
    options: SetPlanOptions = {},
  ): PlanChangeResult {
    const plan = this.findPlan(planId);
    const at = options.at ?? this.clock();
    const previousPlan = this.getPlan(accountId);
    const isFirstSubscription = !this.subscriptions.has(accountId);
    const subscription = this.ensureSubscription(
      accountId,
      at,
      options.cycleStart,
    );

    const proration = quotePlanChange({
      fromPlanId: previousPlan.id,
      toPlanId: plan.id,
      fromPriceCents: previousPlan.monthlyPriceCents,
      toPriceCents: plan.monthlyPriceCents,
      fromPlanName: previousPlan.name,
      toPlanName: plan.name,
      cycleStart: subscription.cycleStart,
      cycleEnd: subscription.cycleEnd,
      effectiveAt: at,
      isFirstSubscription,
    });

    this.accountPlans.set(accountId, plan.id);
    subscription.planId = plan.id;
    this.applyProrationToSubscription(subscription, proration);

    // Every plan change is written to the ledger — an activation included,
    // since that is the first money the account is charged — but re-submitting
    // the tier an account is already on moves no money and is not recorded, so
    // a client retry cannot pad the trail with no-op entries.
    if (proration.direction !== "unchanged") {
      this.recordAuditEntry(accountId, proration);
    }

    billingProrationNetCents.inc(
      { direction: proration.direction },
      Math.abs(proration.netAmountCents),
    );

    return {
      accountId,
      plan: { ...plan },
      previousPlan: { ...previousPlan },
      proration,
      billingCycle: this.toBillingCycle(subscription),
      creditBalanceCents: subscription.creditBalanceCents,
    };
  }

  getPlan(accountId: string): BillingPlan {
    return this.findPlan(this.accountPlans.get(accountId) ?? "free");
  }

  getBillingCycle(accountId: string): BillingCycle | null {
    const subscription = this.subscriptions.get(accountId);
    return subscription ? this.toBillingCycle(subscription) : null;
  }

  /** Unspent proration credit available to offset the next invoice. */
  getCreditBalanceCents(accountId: string): number {
    return this.subscriptions.get(accountId)?.creditBalanceCents ?? 0;
  }

  /** Plan-change audit entries, oldest first. */
  getProrationHistory(accountId: string): BillingAuditEntry[] {
    return [...(this.auditTrail.get(accountId) ?? [])];
  }

  /**
   * Close a lapsed billing cycle and open the next one. Credit that the account
   * never spent is written off, because a proration credit only ever applies to
   * the cycle it was issued in — the unused part of the tier the customer gave
   * up. Returns `null` while the current cycle is still running, so a scheduler
   * can call this freely.
   */
  rolloverBillingCycle(
    accountId: string,
    at = this.clock(),
  ): BillingRolloverResult | null {
    const subscription = this.subscriptions.get(accountId);
    if (!subscription || at.getTime() < subscription.cycleEnd.getTime()) {
      return null;
    }

    const writtenOffCreditCents = subscription.creditBalanceCents;
    subscription.creditBalanceCents = 0;
    subscription.creditCycleStart = null;
    subscription.creditCycleEnd = null;

    const closedCycle = this.toBillingCycle(subscription);
    subscription.cycleStart = subscription.cycleEnd;
    subscription.cycleEnd = addBillingMonth(subscription.cycleStart);

    return {
      accountId,
      closedCycle,
      nextCycle: this.toBillingCycle(subscription),
      creditBalanceCents: subscription.creditBalanceCents,
      writtenOffCreditCents,
      plan: { ...this.getPlan(accountId) },
    };
  }

  recordUsage(
    accountId: string,
    input: Omit<UsageRecord, "accountId" | "recordedAt">,
  ): UsageRecord {
    const idempotencyKey = input.idempotencyKey
      ? `${accountId}:${input.idempotencyKey}`
      : undefined;
    if (idempotencyKey && this.idempotencyKeys.has(idempotencyKey)) {
      return this.idempotencyKeys.get(idempotencyKey);
    }

    const record: UsageRecord = {
      ...input,
      accountId,
      recordedAt: new Date().toISOString(),
    };
    const records = this.usage.get(accountId) ?? [];
    records.push(record);
    this.usage.set(accountId, records);
    if (idempotencyKey) this.idempotencyKeys.set(idempotencyKey, record);

    billingUsageUnits.inc(
      { plan: this.getPlan(accountId).id, metric: input.metric },
      input.quantity,
    );
    return record;
  }

  getUsage(accountId: string): UsageRecord[] {
    return [...(this.usage.get(accountId) ?? [])];
  }

  createInvoicePreview(
    accountId: string,
    periodStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    periodEnd = new Date(),
  ): InvoicePreview {
    const plan = this.getPlan(accountId);
    const units = this.getUsage(accountId)
      .filter((record) => {
        const timestamp = new Date(record.recordedAt).getTime();
        return (
          timestamp >= periodStart.getTime() && timestamp <= periodEnd.getTime()
        );
      })
      .reduce((total, record) => total + record.quantity, 0);
    const overage = Math.max(0, units - plan.includedUnits);
    const overageCents = overage * plan.unitPriceCents;
    const chargeCents = plan.monthlyPriceCents + overageCents;
    const lineItems = [
      {
        description: `${plan.name} monthly plan`,
        quantity: 1,
        unitPriceCents: plan.monthlyPriceCents,
        amountCents: plan.monthlyPriceCents,
      },
      ...(overage > 0
        ? [
            {
              description: "Metered usage overage",
              quantity: overage,
              unitPriceCents: plan.unitPriceCents,
              amountCents: overageCents,
            },
          ]
        : []),
    ];

    // A downgrade issued mid-cycle leaves credit on the account. Show it as a
    // negative line item, capped at the amount owed, so a preview can never
    // total below zero and never promises credit the customer has not earned.
    const applicableCreditCents = Math.min(
      this.applicableCreditCents(accountId, periodEnd),
      Math.max(chargeCents, 0),
    );
    if (applicableCreditCents > 0) {
      lineItems.push({
        description: "Prorated plan credit",
        quantity: 1,
        unitPriceCents: -applicableCreditCents,
        amountCents: -applicableCreditCents,
      });
    }

    const subtotalCents = lineItems.reduce(
      (total, item) => total + item.amountCents,
      0,
    );
    billingEstimatedChargesCents.set({ plan: plan.id }, subtotalCents);
    return {
      accountId,
      planId: plan.id,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      subtotalCents,
      currency: "usd",
      lineItems,
    };
  }

  exportUsage(accountId: string, format: "stripe"): StripeUsageExport;
  exportUsage(accountId: string, format: "csv"): string;
  exportUsage(
    accountId: string,
    format: "csv" | "stripe",
  ): StripeUsageExport | string;
  exportUsage(
    accountId: string,
    format: "csv" | "stripe",
  ): StripeUsageExport | string {
    const records = this.getUsage(accountId);
    if (format === "stripe") {
      return {
        customer: accountId,
        items: records.map((record) => ({
          price: `metered_${record.metric}`,
          quantity: record.quantity,
          timestamp: record.recordedAt,
          metadata: record.tokenizedAccessId
            ? { tokenizedAccessId: record.tokenizedAccessId }
            : undefined,
        })),
      };
    }

    const rows = ["account_id,metric,quantity,recorded_at,tokenized_access_id"];
    rows.push(
      ...records.map((record) =>
        [
          accountId,
          record.metric,
          record.quantity,
          record.recordedAt,
          record.tokenizedAccessId ?? "",
        ]
          .map((value) => this.csv(value))
          .join(","),
      ),
    );
    return rows.join("\n");
  }

  private findPlan(planId: string): BillingPlan {
    const plan = PLANS.find((candidate) => candidate.id === planId);
    if (!plan) throw new NotFoundException(`Unknown billing plan: ${planId}`);
    return plan;
  }

  private ensureSubscription(
    accountId: string,
    at: Date,
    cycleStart?: Date,
  ): AccountSubscription {
    const existing = this.subscriptions.get(accountId);
    if (existing) return existing;

    // A first activation opens the first cycle. The anchor is either supplied by
    // the caller (to line cycles up with calendar months) or is the activation
    // instant itself.
    const start = cycleStart ?? at;
    const subscription: AccountSubscription = {
      planId: this.accountPlans.get(accountId) ?? "free",
      cycleStart: start,
      cycleEnd: addBillingMonth(start),
      creditBalanceCents: 0,
      creditCycleStart: null,
      creditCycleEnd: null,
    };
    this.subscriptions.set(accountId, subscription);
    return subscription;
  }

  /**
   * Fold a proration quote into the account: a net charge is simply what the
   * customer owes, while a net credit is banked against the next invoice. The
   * credit is tagged with the cycle it was issued in so `rolloverBillingCycle`
   * can expire it instead of paying it out twice.
   */
  private applyProrationToSubscription(
    subscription: AccountSubscription,
    proration: ProrationQuote,
  ): void {
    if (proration.netAmountCents >= 0) return;

    const creditCents = Math.abs(proration.netAmountCents);
    const issuedInCurrentCycle =
      subscription.creditCycleStart &&
      subscription.creditCycleStart.getTime() ===
        subscription.cycleStart.getTime();

    // A credit carried in from an earlier cycle is replaced, not summed: the
    // old one expired when its cycle closed, so only the credit that belongs to
    // the live cycle may still be applied.
    subscription.creditBalanceCents = issuedInCurrentCycle
      ? subscription.creditBalanceCents + creditCents
      : creditCents;
    subscription.creditCycleStart = subscription.cycleStart;
    subscription.creditCycleEnd = subscription.cycleEnd;
  }

  /**
   * Credit still usable at `periodEnd`. Expired credit is dropped here rather
   * than silently offsetting an invoice it was never issued against.
   */
  private applicableCreditCents(accountId: string, periodEnd: Date): number {
    const subscription = this.subscriptions.get(accountId);
    if (!subscription || subscription.creditBalanceCents <= 0) return 0;
    if (
      subscription.creditCycleEnd &&
      periodEnd.getTime() > subscription.creditCycleEnd.getTime()
    ) {
      return 0;
    }
    return subscription.creditBalanceCents;
  }

  private recordAuditEntry(
    accountId: string,
    proration: ProrationQuote,
  ): BillingAuditEntry {
    const entry: BillingAuditEntry = {
      id: `${accountId}:${proration.effectiveAt}:${proration.toPlanId}:${this.auditTrail.get(accountId)?.length ?? 0}`,
      accountId,
      fromPlanId: proration.fromPlanId,
      toPlanId: proration.toPlanId,
      direction: proration.direction,
      effectiveAt: proration.effectiveAt,
      cycleStart: proration.cycleStart,
      cycleEnd: proration.cycleEnd,
      totalCycleDays: proration.totalCycleDays,
      remainingDays: proration.remainingDays,
      remainingFraction: proration.remainingFraction,
      unusedCreditCents: proration.unusedCreditCents,
      newPlanChargeCents: proration.newPlanChargeCents,
      netAmountCents: proration.netAmountCents,
      currency: "usd",
      lineItems: proration.lineItems,
      recordedAt: this.clock().toISOString(),
    };
    const entries = this.auditTrail.get(accountId) ?? [];
    entries.push(entry);
    this.auditTrail.set(accountId, entries);
    return entry;
  }

  private toBillingCycle(subscription: AccountSubscription): BillingCycle {
    return {
      cycleStart: subscription.cycleStart.toISOString(),
      cycleEnd: subscription.cycleEnd.toISOString(),
    };
  }

  private csv(value: string | number): string {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }
}
