import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  DisasterRecoveryValidationReport,
  InvariantCategory,
  InvariantCheckResult,
  InvariantSeverity,
  InvariantViolation,
} from './disaster-recovery.types';

@Injectable()
export class DisasterRecoveryValidatorService {
  private readonly logger = new Logger(DisasterRecoveryValidatorService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Run full disaster recovery validation across all domain invariants.
   * Execution is strictly read-only.
   */
  async validateAllInvariants(): Promise<DisasterRecoveryValidationReport> {
    const startTime = Date.now();
    this.logger.log('Starting disaster recovery domain invariant validation...');

    const checks: Promise<InvariantCheckResult>[] = [
      // Auth & Identity Invariants
      this.checkOrphanedWallets(),
      this.checkStellarPublicKeyFormat(),
      this.checkDuplicateActiveWallets(),
      this.checkOrphanedUserProfiles(),

      // Portfolio & Investment Invariants
      this.checkOrphanedPortfolioAssets(),
      this.checkOrphanedPortfolioTransactions(),
      this.checkPortfolioValuationConsistency(),
      this.checkPortfolioAllocationRange(),
      this.checkPortfolioTargetOversubscription(),

      // Blockchain & Oracle Invariants
      this.checkDuplicateOraclePriceRecords(),
      this.checkMalformedSignedPayloads(),
      this.checkOracleSubmissionIntegrity(),

      // Reconciliation & Settlement Invariants
      this.checkOrphanedReconciliationAudits(),
      this.checkSettledInvoiceConsistency(),
      this.checkStellarTransactionHashFormat(),

      // DeFi & Positions Invariants
      this.checkOrphanedDeFiPositions(),

      // Growth & Notifications Invariants
      this.checkOrphanedAlerts(),
      this.checkOrphanedNotifications(),

      // Audit & Provenance Invariants
      this.checkAuditProvenanceHashIntegrity(),
    ];

    const results = await Promise.all(checks);
    const executionTimeMs = Date.now() - startTime;

    const criticalFailures = results.filter(
      (r) => !r.passed && r.severity === InvariantSeverity.CRITICAL,
    ).length;
    const errorFailures = results.filter(
      (r) => !r.passed && r.severity === InvariantSeverity.ERROR,
    ).length;
    const warningFailures = results.filter(
      (r) => !r.passed && r.severity === InvariantSeverity.WARNING,
    ).length;
    const failedChecks = criticalFailures + errorFailures + warningFailures;
    const passedChecks = results.length - failedChecks;
    const isConsistent = criticalFailures === 0 && errorFailures === 0;

    const report: DisasterRecoveryValidationReport = {
      timestamp: new Date(),
      isConsistent,
      totalChecks: results.length,
      passedChecks,
      failedChecks,
      criticalFailures,
      errorFailures,
      warningFailures,
      executionTimeMs,
      results,
    };

    this.logger.log(
      `Disaster recovery validation completed in ${executionTimeMs}ms. Status: ${
        isConsistent ? 'CONSISTENT (PASS)' : 'INCONSISTENT (FAIL)'
      } [Passed: ${passedChecks}/${results.length}, Critical: ${criticalFailures}, Errors: ${errorFailures}, Warnings: ${warningFailures}]`,
    );

    return report;
  }

  // ==========================================
  // Auth & Identity Invariants
  // ==========================================

  async checkOrphanedWallets(): Promise<InvariantCheckResult> {
    const query = `
      SELECT w.id, w."userId", w.address
      FROM wallets w
      LEFT JOIN users u ON w."userId" = u.id
      WHERE u.id IS NULL
      LIMIT 10
    `;
    const countQuery = `
      SELECT COUNT(*)::int AS count
      FROM wallets w
      LEFT JOIN users u ON w."userId" = u.id
      WHERE u.id IS NULL
    `;
    return this.runReadQuery({
      code: 'AUTH_ORPHANED_WALLETS',
      name: 'No Orphaned Wallets',
      category: InvariantCategory.AUTH_AND_IDENTITY,
      severity: InvariantSeverity.CRITICAL,
      description: 'Every wallet record must belong to an existing user in the users table.',
      remediation: 'Purge orphaned wallets or re-associate them with the correct restored user record.',
      countQuery,
      sampleQuery: query,
      entity: 'wallets',
    });
  }

  async checkStellarPublicKeyFormat(): Promise<InvariantCheckResult> {
    const query = `
      SELECT id, address, "userId"
      FROM wallets
      WHERE (network = 'stellar' OR network IS NULL)
        AND address !~ '^G[A-Z2-7]{55}$'
      LIMIT 10
    `;
    const countQuery = `
      SELECT COUNT(*)::int AS count
      FROM wallets
      WHERE (network = 'stellar' OR network IS NULL)
        AND address !~ '^G[A-Z2-7]{55}$'
    `;
    return this.runReadQuery({
      code: 'AUTH_STELLAR_KEY_FORMAT',
      name: 'Valid Stellar Public Key Format on Wallets',
      category: InvariantCategory.AUTH_AND_IDENTITY,
      severity: InvariantSeverity.ERROR,
      description: 'Stellar wallet addresses must conform to ed25519 public key encoding (G + 55 base32 chars).',
      remediation: 'Audit corrupt address strings or check if EVM 0x addresses were inserted under stellar network.',
      countQuery,
      sampleQuery: query,
      entity: 'wallets',
    });
  }

  async checkDuplicateActiveWallets(): Promise<InvariantCheckResult> {
    const query = `
      SELECT address, COUNT(*) as count
      FROM wallets
      WHERE address IS NOT NULL
      GROUP BY address, COALESCE(network, 'stellar')
      HAVING COUNT(*) > 1
      LIMIT 10
    `;
    const countQuery = `
      SELECT COUNT(*)::int AS count
      FROM (
        SELECT address
        FROM wallets
        WHERE address IS NOT NULL
        GROUP BY address, COALESCE(network, 'stellar')
        HAVING COUNT(*) > 1
      ) dupes
    `;
    return this.runReadQuery({
      code: 'AUTH_DUPLICATE_WALLETS',
      name: 'No Duplicate Active Wallets Across Distinct Users',
      category: InvariantCategory.AUTH_AND_IDENTITY,
      severity: InvariantSeverity.ERROR,
      description: 'The same wallet public key must not be concurrently active across multiple user records.',
      remediation: 'De-duplicate wallet records and merge user accounts or revoke stale wallet links.',
      countQuery,
      sampleQuery: query,
      entity: 'wallets',
    });
  }

  async checkOrphanedUserProfiles(): Promise<InvariantCheckResult> {
    const query = `
      SELECT p.id, p."userId"
      FROM profiles p
      LEFT JOIN users u ON p."userId" = u.id
      WHERE u.id IS NULL
      LIMIT 10
    `;
    const countQuery = `
      SELECT COUNT(*)::int AS count
      FROM profiles p
      LEFT JOIN users u ON p."userId" = u.id
      WHERE u.id IS NULL
    `;
    return this.runReadQuery({
      code: 'AUTH_ORPHANED_PROFILES',
      name: 'No Orphaned User Profiles',
      category: InvariantCategory.AUTH_AND_IDENTITY,
      severity: InvariantSeverity.WARNING,
      description: 'Every user profile must link to a valid user record.',
      remediation: 'Remove orphaned profile records or restore corresponding user records.',
      countQuery,
      sampleQuery: query,
      entity: 'profiles',
    });
  }

  // ==========================================
  // Portfolio & Investment Invariants
  // ==========================================

  async checkOrphanedPortfolioAssets(): Promise<InvariantCheckResult> {
    const query = `
      SELECT pa.id, pa."portfolioId", pa.symbol
      FROM portfolio_assets pa
      LEFT JOIN portfolios p ON pa."portfolioId" = p.id
      WHERE p.id IS NULL
      LIMIT 10
    `;
    const countQuery = `
      SELECT COUNT(*)::int AS count
      FROM portfolio_assets pa
      LEFT JOIN portfolios p ON pa."portfolioId" = p.id
      WHERE p.id IS NULL
    `;
    return this.runReadQuery({
      code: 'PORTFOLIO_ORPHANED_ASSETS',
      name: 'No Orphaned Portfolio Assets',
      category: InvariantCategory.PORTFOLIO_AND_INVESTMENT,
      severity: InvariantSeverity.CRITICAL,
      description: 'All portfolio assets must link to an existing portfolio in the portfolios table.',
      remediation: 'Remove dangling asset records or reassign them to the appropriate restored portfolio.',
      countQuery,
      sampleQuery: query,
      entity: 'portfolio_assets',
    });
  }

  async checkOrphanedPortfolioTransactions(): Promise<InvariantCheckResult> {
    const query = `
      SELECT t.id, t."portfolioId", t."userId"
      FROM transactions t
      LEFT JOIN portfolios p ON t."portfolioId" = p.id
      WHERE t."portfolioId" IS NOT NULL AND p.id IS NULL
      LIMIT 10
    `;
    const countQuery = `
      SELECT COUNT(*)::int AS count
      FROM transactions t
      LEFT JOIN portfolios p ON t."portfolioId" = p.id
      WHERE t."portfolioId" IS NOT NULL AND p.id IS NULL
    `;
    return this.runReadQuery({
      code: 'PORTFOLIO_ORPHANED_TRANSACTIONS',
      name: 'No Orphaned Portfolio Transactions',
      category: InvariantCategory.PORTFOLIO_AND_INVESTMENT,
      severity: InvariantSeverity.ERROR,
      description: 'Transactions referencing a portfolioId must have a matching portfolio record.',
      remediation: 'Re-link transactions to the restored portfolio or archive invalid records.',
      countQuery,
      sampleQuery: query,
      entity: 'transactions',
    });
  }

  async checkPortfolioValuationConsistency(): Promise<InvariantCheckResult> {
    const query = `
      SELECT p.id, p."totalValue" AS stored_value, COALESCE(SUM(pa.amount * pa."currentPrice"), 0) AS calculated_value
      FROM portfolios p
      JOIN portfolio_assets pa ON pa."portfolioId" = p.id
      WHERE p."deletedAt" IS NULL
      GROUP BY p.id, p."totalValue"
      HAVING ABS(p."totalValue" - COALESCE(SUM(pa.amount * pa."currentPrice"), 0)) > 0.05
      LIMIT 10
    `;
    const countQuery = `
      SELECT COUNT(*)::int AS count
      FROM (
        SELECT p.id
        FROM portfolios p
        JOIN portfolio_assets pa ON pa."portfolioId" = p.id
        WHERE p."deletedAt" IS NULL
        GROUP BY p.id, p."totalValue"
        HAVING ABS(p."totalValue" - COALESCE(SUM(pa.amount * pa."currentPrice"), 0)) > 0.05
      ) discrepancies
    `;
    return this.runReadQuery({
      code: 'PORTFOLIO_VALUATION_CONSISTENCY',
      name: 'Portfolio Total Value Matches Asset Holdings Sum',
      category: InvariantCategory.PORTFOLIO_AND_INVESTMENT,
      severity: InvariantSeverity.WARNING,
      description: 'Stored portfolio totalValue should match the sum of asset (amount * currentPrice) within precision threshold.',
      remediation: 'Trigger a portfolio re-valuation job to recalculate total values against latest oracle prices.',
      countQuery,
      sampleQuery: query,
      entity: 'portfolios',
    });
  }

  async checkPortfolioAllocationRange(): Promise<InvariantCheckResult> {
    const query = `
      SELECT pa.id, pa."portfolioId", pa.symbol, pa.amount, pa."targetAllocation"
      FROM portfolio_assets pa
      WHERE pa.amount < 0 
         OR pa."targetAllocation" < 0 
         OR pa."targetAllocation" > 100
      LIMIT 10
    `;
    const countQuery = `
      SELECT COUNT(*)::int AS count
      FROM portfolio_assets pa
      WHERE pa.amount < 0 
         OR pa."targetAllocation" < 0 
         OR pa."targetAllocation" > 100
    `;
    return this.runReadQuery({
      code: 'PORTFOLIO_ALLOCATION_RANGE',
      name: 'Portfolio Asset Amounts and Allocations Within Valid Bounds',
      category: InvariantCategory.PORTFOLIO_AND_INVESTMENT,
      severity: InvariantSeverity.ERROR,
      description: 'Asset holdings amounts must be non-negative and target allocations must be between 0% and 100%.',
      remediation: 'Correct corrupted negative amounts or out-of-range target percentages.',
      countQuery,
      sampleQuery: query,
      entity: 'portfolio_assets',
    });
  }

  async checkPortfolioTargetOversubscription(): Promise<InvariantCheckResult> {
    const query = `
      SELECT pa."portfolioId", SUM(pa."targetAllocation") as total_target
      FROM portfolio_assets pa
      JOIN portfolios p ON pa."portfolioId" = p.id
      WHERE p."deletedAt" IS NULL
      GROUP BY pa."portfolioId"
      HAVING SUM(pa."targetAllocation") > 100.01
      LIMIT 10
    `;
    const countQuery = `
      SELECT COUNT(*)::int AS count
      FROM (
        SELECT pa."portfolioId"
        FROM portfolio_assets pa
        JOIN portfolios p ON pa."portfolioId" = p.id
        WHERE p."deletedAt" IS NULL
        GROUP BY pa."portfolioId"
        HAVING SUM(pa."targetAllocation") > 100.01
      ) oversubscribed
    `;
    return this.runReadQuery({
      code: 'PORTFOLIO_TARGET_OVERSUBSCRIPTION',
      name: 'Sum of Asset Target Allocations <= 100%',
      category: InvariantCategory.PORTFOLIO_AND_INVESTMENT,
      severity: InvariantSeverity.WARNING,
      description: 'The sum of target allocation percentages across assets in a portfolio must not exceed 100%.',
      remediation: 'Normalize target allocation weights for affected portfolios.',
      countQuery,
      sampleQuery: query,
      entity: 'portfolio_assets',
    });
  }

  // ==========================================
  // Blockchain & Oracle Invariants
  // ==========================================

  async checkDuplicateOraclePriceRecords(): Promise<InvariantCheckResult> {
    const query = `
      SELECT symbol, "sourceAccount", timestamp, COUNT(*) as count
      FROM price_records
      GROUP BY symbol, "sourceAccount", timestamp
      HAVING COUNT(*) > 1
      LIMIT 10
    `;
    const countQuery = `
      SELECT COUNT(*)::int AS count
      FROM (
        SELECT symbol, "sourceAccount", timestamp
        FROM price_records
        GROUP BY symbol, "sourceAccount", timestamp
        HAVING COUNT(*) > 1
      ) dupes
    `;
    return this.runReadQuery({
      code: 'ORACLE_DUPLICATE_PRICE_RECORDS',
      name: 'No Duplicate Oracle Price Records for Same Timestamp/Source',
      category: InvariantCategory.BLOCKCHAIN_AND_ORACLE,
      severity: InvariantSeverity.WARNING,
      description: 'Price feed records should be unique per symbol, source, and timestamp.',
      remediation: 'Deduplicate price records keeping the earliest verified record.',
      countQuery,
      sampleQuery: query,
      entity: 'price_records',
    });
  }

  async checkMalformedSignedPayloads(): Promise<InvariantCheckResult> {
    const query = `
      SELECT id, "payloadHash", signature, signer
      FROM signed_payloads
      WHERE "payloadHash" IS NULL 
         OR signature IS NULL 
         OR LENGTH(signature) < 32
      LIMIT 10
    `;
    const countQuery = `
      SELECT COUNT(*)::int AS count
      FROM signed_payloads
      WHERE "payloadHash" IS NULL 
         OR signature IS NULL 
         OR LENGTH(signature) < 32
    `;
    return this.runReadQuery({
      code: 'ORACLE_MALFORMED_SIGNED_PAYLOADS',
      name: 'Valid Cryptographic Payload Signatures',
      category: InvariantCategory.BLOCKCHAIN_AND_ORACLE,
      severity: InvariantSeverity.CRITICAL,
      description: 'Signed payloads must contain valid non-null payload hashes and cryptographic signatures.',
      remediation: 'Invalidate or re-sign unverified oracle payloads.',
      countQuery,
      sampleQuery: query,
      entity: 'signed_payloads',
    });
  }

  async checkOracleSubmissionIntegrity(): Promise<InvariantCheckResult> {
    const query = `
      SELECT id, "nonceId", status
      FROM oracle_submissions
      WHERE "nonceId" IS NOT NULL AND status = 'submitted' AND "txHash" IS NULL
      LIMIT 10
    `;
    const countQuery = `
      SELECT COUNT(*)::int AS count
      FROM oracle_submissions
      WHERE "nonceId" IS NOT NULL AND status = 'submitted' AND "txHash" IS NULL
    `;
    return this.runReadQuery({
      code: 'ORACLE_SUBMISSION_INTEGRITY',
      name: 'Submitted Oracle Transactions Have Settlement Hashes',
      category: InvariantCategory.BLOCKCHAIN_AND_ORACLE,
      severity: InvariantSeverity.ERROR,
      description: 'Oracle submissions marked as submitted must contain a valid on-chain transaction hash.',
      remediation: 'Reconcile pending oracle submissions against Stellar horizon ledger.',
      countQuery,
      sampleQuery: query,
      entity: 'oracle_submissions',
    });
  }

  // ==========================================
  // Reconciliation & Settlement Invariants
  // ==========================================

  async checkOrphanedReconciliationAudits(): Promise<InvariantCheckResult> {
    const query = `
      SELECT ra.id, ra."transactionId"
      FROM reconciliation_audits ra
      LEFT JOIN stellar_transactions st ON ra."transactionId" = st."transactionId"
      WHERE st."transactionId" IS NULL
      LIMIT 10
    `;
    const countQuery = `
      SELECT COUNT(*)::int AS count
      FROM reconciliation_audits ra
      LEFT JOIN stellar_transactions st ON ra."transactionId" = st."transactionId"
      WHERE st."transactionId" IS NULL
    `;
    return this.runReadQuery({
      code: 'RECONCILIATION_ORPHANED_AUDITS',
      name: 'No Orphaned Reconciliation Audit Logs',
      category: InvariantCategory.RECONCILIATION_AND_SETTLEMENT,
      severity: InvariantSeverity.ERROR,
      description: 'Reconciliation audit trails must reference an existing Stellar transaction record.',
      remediation: 'Ingest missing Stellar transactions or archive dangling audit records.',
      countQuery,
      sampleQuery: query,
      entity: 'reconciliation_audits',
    });
  }

  async checkSettledInvoiceConsistency(): Promise<InvariantCheckResult> {
    const query = `
      SELECT ri.id, ri."invoiceId", ri."expectedAmount", ri."paidAmount", ri.status
      FROM reconciliation_invoices ri
      WHERE ri.status = 'SETTLED' 
        AND (ri."paidAmount"::numeric < ri."expectedAmount"::numeric OR ri."paidAmount" IS NULL)
      LIMIT 10
    `;
    const countQuery = `
      SELECT COUNT(*)::int AS count
      FROM reconciliation_invoices ri
      WHERE ri.status = 'SETTLED' 
        AND (ri."paidAmount"::numeric < ri."expectedAmount"::numeric OR ri."paidAmount" IS NULL)
    `;
    return this.runReadQuery({
      code: 'RECONCILIATION_INVOICE_SETTLEMENT_CONSISTENCY',
      name: 'Settled Invoices Meet Expected Amount Threshold',
      category: InvariantCategory.RECONCILIATION_AND_SETTLEMENT,
      severity: InvariantSeverity.CRITICAL,
      description: 'Invoices marked SETTLED must have paidAmount equal to or greater than expectedAmount.',
      remediation: 'Re-evaluate invoice status using reconciliation engine to correct premature SETTLED states.',
      countQuery,
      sampleQuery: query,
      entity: 'reconciliation_invoices',
    });
  }

  async checkStellarTransactionHashFormat(): Promise<InvariantCheckResult> {
    const query = `
      SELECT id, "transactionId", "sourceAccount"
      FROM stellar_transactions
      WHERE "transactionId" !~ '^[a-fA-F0-9]{64}$'
      LIMIT 10
    `;
    const countQuery = `
      SELECT COUNT(*)::int AS count
      FROM stellar_transactions
      WHERE "transactionId" !~ '^[a-fA-F0-9]{64}$'
    `;
    return this.runReadQuery({
      code: 'RECONCILIATION_STELLAR_TX_HASH_FORMAT',
      name: 'Valid 64-Character Hex Stellar Transaction Hashes',
      category: InvariantCategory.RECONCILIATION_AND_SETTLEMENT,
      severity: InvariantSeverity.ERROR,
      description: 'Stellar transaction IDs must be valid 32-byte (64 hexadecimal character) SHA-256 hashes.',
      remediation: 'Audit transaction ingestion pipeline for truncated or malformed transaction identifiers.',
      countQuery,
      sampleQuery: query,
      entity: 'stellar_transactions',
    });
  }

  // ==========================================
  // DeFi & Positions Invariants
  // ==========================================

  async checkOrphanedDeFiPositions(): Promise<InvariantCheckResult> {
    const query = `
      SELECT dp.id, dp."userId", dp.protocol
      FROM defi_positions dp
      LEFT JOIN users u ON dp."userId" = u.id
      WHERE u.id IS NULL
      LIMIT 10
    `;
    const countQuery = `
      SELECT COUNT(*)::int AS count
      FROM defi_positions dp
      LEFT JOIN users u ON dp."userId" = u.id
      WHERE u.id IS NULL
    `;
    return this.runReadQuery({
      code: 'DEFI_ORPHANED_POSITIONS',
      name: 'No Orphaned DeFi Positions',
      category: InvariantCategory.DEFI_AND_POSITIONS,
      severity: InvariantSeverity.CRITICAL,
      description: 'All DeFi positions must belong to an existing user record.',
      remediation: 'Reassign DeFi positions to restored user or execute emergency position closure.',
      countQuery,
      sampleQuery: query,
      entity: 'defi_positions',
    });
  }

  // ==========================================
  // Growth & Notifications Invariants
  // ==========================================

  async checkOrphanedAlerts(): Promise<InvariantCheckResult> {
    const query = `
      SELECT a.id, a."userId", a.name
      FROM alerts a
      LEFT JOIN users u ON a."userId" = u.id
      WHERE u.id IS NULL
      LIMIT 10
    `;
    const countQuery = `
      SELECT COUNT(*)::int AS count
      FROM alerts a
      LEFT JOIN users u ON a."userId" = u.id
      WHERE u.id IS NULL
    `;
    return this.runReadQuery({
      code: 'GROWTH_ORPHANED_ALERTS',
      name: 'No Orphaned Alert Configurations',
      category: InvariantCategory.NOTIFICATIONS_AND_ALERTS,
      severity: InvariantSeverity.WARNING,
      description: 'Alert configurations must reference an existing user.',
      remediation: 'Purge dangling alert records.',
      countQuery,
      sampleQuery: query,
      entity: 'alerts',
    });
  }

  async checkOrphanedNotifications(): Promise<InvariantCheckResult> {
    const query = `
      SELECT n.id, n."userId", n.title
      FROM notifications n
      LEFT JOIN users u ON n."userId" = u.id
      WHERE u.id IS NULL
      LIMIT 10
    `;
    const countQuery = `
      SELECT COUNT(*)::int AS count
      FROM notifications n
      LEFT JOIN users u ON n."userId" = u.id
      WHERE u.id IS NULL
    `;
    return this.runReadQuery({
      code: 'NOTIFICATIONS_ORPHANED_RECORDS',
      name: 'No Orphaned Notification Logs',
      category: InvariantCategory.NOTIFICATIONS_AND_ALERTS,
      severity: InvariantSeverity.WARNING,
      description: 'Notification records must reference an existing user.',
      remediation: 'Archive or remove orphaned notifications.',
      countQuery,
      sampleQuery: query,
      entity: 'notifications',
    });
  }

  // ==========================================
  // Audit & Provenance Invariants
  // ==========================================

  async checkAuditProvenanceHashIntegrity(): Promise<InvariantCheckResult> {
    const query = `
      SELECT id, "agentId", "inputHash", "outputHash"
      FROM provenance_records
      WHERE "inputHash" IS NULL OR "outputHash" IS NULL
      LIMIT 10
    `;
    const countQuery = `
      SELECT COUNT(*)::int AS count
      FROM provenance_records
      WHERE "inputHash" IS NULL OR "outputHash" IS NULL
    `;
    return this.runReadQuery({
      code: 'AUDIT_PROVENANCE_HASH_INTEGRITY',
      name: 'Audit Provenance Hashes Present and Non-Null',
      category: InvariantCategory.AUDIT_AND_PROVENANCE,
      severity: InvariantSeverity.ERROR,
      description: 'Every AI agent provenance record must have immutable input and output hashes.',
      remediation: 'Audit provenance ingestion logs to regenerate or flag unverified agent steps.',
      countQuery,
      sampleQuery: query,
      entity: 'provenance_records',
    });
  }

  // ==========================================
  // Helper for Read-Only Invariant Execution
  // ==========================================

  private async runReadQuery(params: {
    code: string;
    name: string;
    category: InvariantCategory;
    severity: InvariantSeverity;
    description: string;
    remediation: string;
    countQuery: string;
    sampleQuery: string;
    entity: string;
  }): Promise<InvariantCheckResult> {
    try {
      const countRes = await this.dataSource.query(params.countQuery);
      const violationCount = parseInt(countRes[0]?.count ?? '0', 10);
      const passed = violationCount === 0;

      let violations: InvariantViolation[] | undefined;
      if (!passed) {
        const samples = await this.dataSource.query(params.sampleQuery);
        violations = samples.map((row: any) => ({
          id: row.id,
          entity: params.entity,
          description: `Invariant violation in ${params.entity}: ${JSON.stringify(row)}`,
          sampleData: row,
        }));
      }

      return {
        code: params.code,
        name: params.name,
        category: params.category,
        severity: params.severity,
        passed,
        violationCount,
        description: params.description,
        remediation: params.remediation,
        violations,
      };
    } catch (err: any) {
      // If table doesn't exist or SQL error occurs (e.g. fresh DB before full schema setup), report failure gracefully
      this.logger.warn(`Invariant check "${params.code}" query failed: ${err.message}`);
      return {
        code: params.code,
        name: params.name,
        category: params.category,
        severity: params.severity,
        passed: false,
        violationCount: 1,
        description: `${params.description} (Check execution failed: ${err.message})`,
        remediation: params.remediation,
        violations: [
          {
            entity: params.entity,
            description: `Query error: ${err.message}`,
          },
        ],
      };
    }
  }
}
