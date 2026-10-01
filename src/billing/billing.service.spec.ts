import { register } from "../config/metrics";
import { BillingService } from "./billing.service";

describe("BillingService", () => {
  let service: BillingService;

  beforeEach(() => {
    service = new BillingService();
  });

  it("records usage once for an idempotency key and creates a mock invoice", () => {
    service.setPlan("acct-1", "starter");
    service.recordUsage("acct-1", {
      metric: "api_request",
      quantity: 10001,
      idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
    });
    service.recordUsage("acct-1", {
      metric: "api_request",
      quantity: 10001,
      idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
    });

    const invoice = service.createInvoicePreview("acct-1");
    expect(service.getUsage("acct-1")).toHaveLength(1);
    expect(invoice.subtotalCents).toBe(1901);
  });

  it("exports CSV and Stripe-compatible usage payloads", () => {
    service.recordUsage("acct-2", {
      metric: "compute",
      quantity: 3,
      tokenizedAccessId: "token-1",
    });
    expect(service.exportUsage("acct-2", "csv")).toContain(
      "account_id,metric,quantity",
    );
    expect(service.exportUsage("acct-2", "stripe").items[0]).toMatchObject({
      price: "metered_compute",
      quantity: 3,
    });
  });

  it("registers billing telemetry in the shared Prometheus registry", async () => {
    const output = await register.metrics();
    expect(output).toContain("trellis_billing_usage_units_total");
    expect(output).toContain("trellis_billing_estimated_charges_cents");
  });
});

/**
 * Issue #82: `setPlan()` used to swap the tier with no money movement at all, so
 * a mid-cycle upgrade double-charged the customer for the rest of the month and
 * a mid-cycle downgrade left them paying for days they had already paid to give
 * up. These tests pin the arithmetic to whole cents against a fixed clock.
 */
describe("BillingService plan proration (#82)", () => {
  // A 31-day January anchored cycle. Switching on the 16th leaves exactly
  // 16/31 of the cycle unused, which makes every expected figure a hand
  // calculation rather than something read back off the implementation.
  const CYCLE_START = new Date("2026-01-01T00:00:00.000Z");
  const MID_CYCLE = new Date("2026-01-16T00:00:00.000Z");
  const CYCLE_END = new Date("2026-02-01T00:00:00.000Z");

  let now: Date;
  let service: BillingService;

  const activate = (accountId: string, planId: string) =>
    service.setPlan(accountId, planId, { at: CYCLE_START, cycleStart: CYCLE_START });

  beforeEach(() => {
    now = MID_CYCLE;
    service = new BillingService(() => now);
  });

  describe("first activation", () => {
    it("opens a one-month cycle anchored on activation", () => {
      activate("acct-new", "starter");

      expect(service.getBillingCycle("acct-new")).toEqual({
        cycleStart: "2026-01-01T00:00:00.000Z",
        cycleEnd: "2026-02-01T00:00:00.000Z",
      });
    });

    // A first subscription is not an upgrade: there is no prepaid period to
    // hand back, so the full period is charged and the "free tier it left" is
    // never shown as a credit worth $0.
    it("charges the whole first period instead of crediting the implicit free tier", () => {
      const result = service.setPlan("acct-new", "starter", { at: CYCLE_START });

      expect(result.previousPlan.id).toBe("free");
      expect(result.proration.direction).toBe("activation");
      expect(result.proration.unusedCreditCents).toBe(0);
      expect(result.proration.newPlanChargeCents).toBe(1900);
      expect(result.proration.netAmountCents).toBe(1900);
      expect(result.proration.remainingFraction).toBe(1);
      expect(result.proration.lineItems).toHaveLength(1);
      expect(result.proration.lineItems[0].kind).toBe("new_plan_charge");
    });

    it("clamps a cycle that starts at the end of a short month", () => {
      service.setPlan("acct-feb", "starter", {
        at: new Date("2026-01-31T00:00:00.000Z"),
        cycleStart: new Date("2026-01-31T00:00:00.000Z"),
      });

      // 2026 is not a leap year, so January 31 + one month is February 28.
      expect(service.getBillingCycle("acct-feb")?.cycleEnd).toBe(
        "2026-02-28T00:00:00.000Z",
      );
    });
  });

  describe("mid-cycle upgrade", () => {
    it("credits the unused old tier and charges the remaining new tier", () => {
      activate("acct-up", "starter");

      const result = service.setPlan("acct-up", "growth", { at: MID_CYCLE });

      // 1900 x 16/31 = 980.6 -> 981 credit; 9900 x 16/31 = 5109.7 -> 5110 charge.
      expect(result.proration.direction).toBe("upgrade");
      expect(result.proration.unusedCreditCents).toBe(981);
      expect(result.proration.newPlanChargeCents).toBe(5110);
      expect(result.proration.netAmountCents).toBe(4129);
      expect(result.plan.id).toBe("growth");
    });

    it("records one credit and one charge line item against the same window", () => {
      activate("acct-up", "starter");
      const { lineItems } = service.setPlan("acct-up", "growth", {
        at: MID_CYCLE,
      }).proration;

      expect(lineItems).toHaveLength(2);
      expect(lineItems[0]).toMatchObject({
        kind: "unused_credit",
        planId: "starter",
        amountCents: -981,
      });
      expect(lineItems[1]).toMatchObject({
        kind: "new_plan_charge",
        planId: "growth",
        amountCents: 5110,
      });
      // Both sides must be measured over the identical remaining slice, or the
      // net is an artefact of two different denominators.
      expect(lineItems[0].remainingFraction).toBeCloseTo(16 / 31, 10);
      expect(lineItems[0].cycleStart).toBe(lineItems[1].cycleStart);
      expect(lineItems[0].cycleEnd).toBe(lineItems[1].cycleEnd);
      expect(lineItems[0].remainingDays).toBeCloseTo(16, 10);
      expect(lineItems[0].totalCycleDays).toBeCloseTo(31, 10);
    });

    it("charges nothing to credit a $0 tier and skips the empty credit line", () => {
      service.setPlan("acct-up", "free", { at: CYCLE_START, cycleStart: CYCLE_START });
      const { lineItems, netAmountCents } = service.setPlan("acct-up", "growth", {
        at: MID_CYCLE,
      }).proration;

      expect(lineItems).toHaveLength(1);
      expect(lineItems[0].kind).toBe("new_plan_charge");
      expect(netAmountCents).toBe(5110);
    });

    it("still charges a fraction of a cent on the last day of the cycle", () => {
      activate("acct-edge", "free");
      const result = service.setPlan("acct-edge", "starter", {
        at: new Date(CYCLE_END.getTime() - 60 * 60 * 1000),
      });

      // One hour of a 744-hour cycle is 0.13%, i.e. 2.55 cents of $19.
      expect(result.proration.remainingDays).toBeCloseTo(1 / 24, 10);
      expect(result.proration.netAmountCents).toBe(3);
      expect(result.proration.newPlanChargeCents).toBeGreaterThan(0);
    });
  });

  describe("mid-cycle downgrade", () => {
    it("credits the unused value of the tier being left", () => {
      activate("acct-down", "growth");

      const result = service.setPlan("acct-down", "starter", { at: MID_CYCLE });

      expect(result.proration.direction).toBe("downgrade");
      expect(result.proration.unusedCreditCents).toBe(5110);
      expect(result.proration.newPlanChargeCents).toBe(981);
      expect(result.proration.netAmountCents).toBe(-4129);
    });

    it("banks the credit on the account instead of losing it", () => {
      activate("acct-down", "growth");
      const result = service.setPlan("acct-down", "starter", { at: MID_CYCLE });

      expect(result.creditBalanceCents).toBe(4129);
      expect(service.getCreditBalanceCents("acct-down")).toBe(4129);
    });

    it("offsets the credit against the next invoice", () => {
      activate("acct-down", "growth");
      service.setPlan("acct-down", "starter", { at: MID_CYCLE });

      const preview = service.createInvoicePreview(
        "acct-down",
        new Date("2026-01-01T00:00:00.000Z"),
        new Date("2026-01-20T00:00:00.000Z"),
      );

      // The banked 4129 credit is larger than the 1900 owed, so the invoice
      // floors at zero and the applied portion is the 1900 that was due.
      expect(preview.subtotalCents).toBe(0);
      expect(preview.lineItems).toContainEqual({
        description: "Prorated plan credit",
        quantity: 1,
        unitPriceCents: -1900,
        amountCents: -1900,
      });
      // The unused remainder stays on the account rather than being written off.
      expect(service.getCreditBalanceCents("acct-down")).toBe(4129);
    });

    it("keeps a $0 invoice at zero instead of carrying it negative", () => {
      activate("acct-down", "growth");
      service.setPlan("acct-down", "free", { at: MID_CYCLE });

      const preview = service.createInvoicePreview(
        "acct-down",
        new Date("2026-01-01T00:00:00.000Z"),
        new Date("2026-01-20T00:00:00.000Z"),
      );

      expect(preview.subtotalCents).toBe(0);
      expect(
        preview.lineItems.filter((item) => item.amountCents < 0),
      ).toEqual([]);
    });
  });

  describe("same-tier renewal", () => {
    it("moves no money and adds no audit entry", () => {
      activate("acct-same", "starter");
      const before = service.getProrationHistory("acct-same").length;

      const result = service.setPlan("acct-same", "starter", { at: MID_CYCLE });

      expect(result.proration.direction).toBe("unchanged");
      expect(result.proration.netAmountCents).toBe(0);
      expect(result.proration.lineItems).toEqual([]);
      expect(service.getProrationHistory("acct-same")).toHaveLength(before);
      expect(service.getCreditBalanceCents("acct-same")).toBe(0);
    });

    it("still returns the plan and cycle so the response stays complete", () => {
      activate("acct-same", "growth");
      const result = service.setPlan("acct-same", "growth", { at: MID_CYCLE });

      expect(result.plan.id).toBe("growth");
      expect(result.billingCycle.cycleEnd).toBe("2026-02-01T00:00:00.000Z");
    });

    it("is idempotent however often the same tier is re-submitted", () => {
      activate("acct-same", "growth");
      service.setPlan("acct-same", "growth", { at: MID_CYCLE });
      service.setPlan("acct-same", "growth", { at: MID_CYCLE });
      service.setPlan("acct-same", "growth", { at: MID_CYCLE });

      expect(service.getProrationHistory("acct-same")).toHaveLength(1);
      expect(service.getPlan("acct-same").id).toBe("growth");
    });
  });

  describe("audit trail", () => {
    it("appends one entry per plan change with its line items", () => {
      activate("acct-audit", "starter");
      service.setPlan("acct-audit", "growth", { at: MID_CYCLE });
      now = new Date("2026-01-20T00:00:00.000Z");
      service.setPlan("acct-audit", "starter", { at: now });

      const history = service.getProrationHistory("acct-audit");
      // Activation, upgrade, downgrade — one row each, oldest first.
      expect(history.map((entry) => entry.direction)).toEqual([
        "activation",
        "upgrade",
        "downgrade",
      ]);

      const upgrade = history[1];
      expect(upgrade).toMatchObject({
        accountId: "acct-audit",
        fromPlanId: "starter",
        toPlanId: "growth",
        direction: "upgrade",
        netAmountCents: 4129,
        currency: "usd",
      });
      expect(upgrade.lineItems).toHaveLength(2);
      expect(upgrade.lineItems.map((item) => item.amountCents)).toEqual([
        -981, 5110,
      ]);

      const downgrade = history[2];
      expect(downgrade).toMatchObject({
        fromPlanId: "growth",
        toPlanId: "starter",
        direction: "downgrade",
      });
      expect(downgrade.effectiveAt).toBe("2026-01-20T00:00:00.000Z");
      // Entries are distinguishable, so neither can overwrite the other.
      expect(new Set(history.map((entry) => entry.id)).size).toBe(3);
    });

    it("keeps accounts isolated", () => {
      activate("acct-1", "starter");
      service.setPlan("acct-1", "growth", { at: MID_CYCLE });
      activate("acct-2", "starter");

      expect(service.getProrationHistory("acct-1")).toHaveLength(2);
      expect(service.getProrationHistory("acct-2")).toHaveLength(1);
      expect(
        service.getProrationHistory("acct-2").every((e) => e.accountId === "acct-2"),
      ).toBe(true);
    });

    it("returns a copy so callers cannot mutate the ledger", () => {
      activate("acct-copy", "starter");
      service.setPlan("acct-copy", "growth", { at: MID_CYCLE });

      const history = service.getProrationHistory("acct-copy");
      history.pop();
      expect(service.getProrationHistory("acct-copy")).toHaveLength(2);
    });
  });

  describe("billing cycle rollover", () => {
    it("does nothing while the cycle is still running", () => {
      activate("acct-roll", "starter");

      expect(service.rolloverBillingCycle("acct-roll", MID_CYCLE)).toBeNull();
      expect(service.getBillingCycle("acct-roll")?.cycleStart).toBe(
        "2026-01-01T00:00:00.000Z",
      );
    });

    it("opens the next calendar month", () => {
      activate("acct-roll", "growth");

      const rollover = service.rolloverBillingCycle(
        "acct-roll",
        new Date("2026-02-01T00:00:00.000Z"),
      );

      expect(rollover).toMatchObject({
        closedCycle: {
          cycleStart: "2026-01-01T00:00:00.000Z",
          cycleEnd: "2026-02-01T00:00:00.000Z",
        },
        nextCycle: {
          cycleStart: "2026-02-01T00:00:00.000Z",
          cycleEnd: "2026-03-01T00:00:00.000Z",
        },
        plan: { id: "growth" },
      });
    });

    // A proration credit is the unused part of the tier the customer gave up.
    // It applies to the cycle it was issued in; an unspent remainder dies with
    // that cycle instead of silently discounting a later invoice.
    it("writes off a credit left unspent when its cycle closes", () => {
      activate("acct-roll", "growth");
      service.setPlan("acct-roll", "starter", { at: MID_CYCLE });

      const rollover = service.rolloverBillingCycle(
        "acct-roll",
        new Date("2026-02-01T00:00:00.000Z"),
      );

      expect(rollover?.writtenOffCreditCents).toBe(4129);
      expect(rollover?.creditBalanceCents).toBe(0);
      expect(service.getCreditBalanceCents("acct-roll")).toBe(0);
    });

    it("does not let an invoice preview consume the credit balance", () => {
      activate("acct-keep", "growth");
      service.setPlan("acct-keep", "starter", { at: MID_CYCLE });
      service.createInvoicePreview(
        "acct-keep",
        new Date("2026-01-01T00:00:00.000Z"),
        new Date("2026-01-20T00:00:00.000Z"),
      );

      // A preview is a quote, not a settlement: the balance is only changed by
      // the cycle close.
      expect(service.getCreditBalanceCents("acct-keep")).toBe(4129);
      service.rolloverBillingCycle("acct-keep", new Date("2026-02-01T00:00:00.000Z"));
      expect(service.getCreditBalanceCents("acct-keep")).toBe(0);
    });

    it("stops applying a credit to invoices rendered after its cycle closed", () => {
      activate("acct-late", "growth");
      service.setPlan("acct-late", "starter", { at: MID_CYCLE });

      const preview = service.createInvoicePreview(
        "acct-late",
        new Date("2026-02-01T00:00:00.000Z"),
        new Date("2026-02-15T00:00:00.000Z"),
      );

      expect(preview.subtotalCents).toBe(1900);
      expect(
        preview.lineItems.some((item) => item.description === "Prorated plan credit"),
      ).toBe(false);
    });

    it("prorates the next change against the new cycle, not the closed one", () => {
      activate("acct-roll", "starter");
      service.rolloverBillingCycle("acct-roll", new Date("2026-02-01T00:00:00.000Z"));
      service.setPlan("acct-roll", "growth", {
        at: new Date("2026-02-15T00:00:00.000Z"),
      });

      const latest = service.getProrationHistory("acct-roll").pop();
      expect(latest).toMatchObject({
        cycleStart: "2026-02-01T00:00:00.000Z",
        cycleEnd: "2026-03-01T00:00:00.000Z",
      });
      expect(latest.remainingDays).toBeCloseTo(14, 10);
      // 14 of 28 days on $99: 4950 charged, 950 credited.
      expect(latest.netAmountCents).toBe(4000);
    });

    it("does not add an expired credit to the next one", () => {
      activate("acct-next", "growth");
      service.setPlan("acct-next", "starter", { at: MID_CYCLE });
      service.rolloverBillingCycle("acct-next", new Date("2026-02-01T00:00:00.000Z"));

      // Downgrading again in February banks February's credit only: 1900 x
      // 21/28 unused on Starter, and nothing carried over from January.
      service.setPlan("acct-next", "free", {
        at: new Date("2026-02-08T00:00:00.000Z"),
      });

      expect(service.getCreditBalanceCents("acct-next")).toBe(1425);
    });

    it("returns null for an account that was never activated", () => {
      expect(service.rolloverBillingCycle("acct-none")).toBeNull();
      expect(service.getBillingCycle("acct-none")).toBeNull();
      expect(service.getCreditBalanceCents("acct-none")).toBe(0);
    });
  });

  describe("telemetry", () => {
    // The series is a shared counter, so the assertion is on the delta this
    // one plan change contributes rather than on an absolute total that any
    // earlier test in the file would have moved.
    async function upgradeCents(): Promise<number> {
      const body = await register.metrics();
      const line = body
        .split("\n")
        .find((sample) =>
          sample.startsWith(
            'trellis_billing_proration_cents_total{direction="upgrade"}',
          ),
        );
      return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : 0;
    }

    it("counts the absolute cents moved, labelled by direction", async () => {
      const before = await upgradeCents();

      activate("acct-metrics", "starter");
      service.setPlan("acct-metrics", "growth", { at: MID_CYCLE });

      expect((await upgradeCents()) - before).toBe(4129);
      expect(await register.metrics()).toContain(
        'trellis_billing_proration_cents_total{direction="upgrade"}',
      );
    });

    it("counts a credit as magnitude, since a counter cannot go negative", async () => {
      const body = await register.metrics();
      const line = body
        .split("\n")
        .find((sample) =>
          sample.startsWith(
            'trellis_billing_proration_cents_total{direction="downgrade"}',
          ),
        );

      activate("acct-metrics-2", "growth");
      service.setPlan("acct-metrics-2", "starter", { at: MID_CYCLE });

      const after = await register.metrics();
      const updated = after
        .split("\n")
        .find((sample) =>
          sample.startsWith(
            'trellis_billing_proration_cents_total{direction="downgrade"}',
          ),
        );

      const beforeValue = line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : 0;
      const afterValue = Number(updated.slice(updated.lastIndexOf(" ") + 1));
      expect(afterValue - beforeValue).toBe(4129);
    });
  });
});
