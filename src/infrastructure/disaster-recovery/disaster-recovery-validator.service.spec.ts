import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { DisasterRecoveryValidatorService } from './disaster-recovery-validator.service';
import {
  InvariantCategory,
  InvariantSeverity,
} from './disaster-recovery.types';

describe('DisasterRecoveryValidatorService', () => {
  let service: DisasterRecoveryValidatorService;
  let dataSource: { query: jest.Mock };

  beforeEach(async () => {
    dataSource = {
      query: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisasterRecoveryValidatorService,
        {
          provide: DataSource,
          useValue: dataSource,
        },
      ],
    }).compile();

    service = module.get<DisasterRecoveryValidatorService>(
      DisasterRecoveryValidatorService,
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('validateAllInvariants', () => {
    it('should report consistent status when all invariants pass with 0 violations', async () => {
      // Mock all count queries returning 0
      dataSource.query.mockResolvedValue([{ count: '0' }]);

      const report = await service.validateAllInvariants();

      expect(report.isConsistent).toBe(true);
      expect(report.totalChecks).toBeGreaterThan(10);
      expect(report.passedChecks).toBe(report.totalChecks);
      expect(report.failedChecks).toBe(0);
      expect(report.criticalFailures).toBe(0);
      expect(report.errorFailures).toBe(0);
    });

    it('should detect orphaned wallets and report critical failure', async () => {
      dataSource.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM wallets w') && sql.includes('COUNT(*)')) {
          return [{ count: '2' }];
        }
        if (sql.includes('FROM wallets w') && sql.includes('LIMIT 10')) {
          return [
            { id: 'w-1', userId: 'deleted-u1', address: 'GAAAA' },
            { id: 'w-2', userId: 'deleted-u2', address: 'GBBBB' },
          ];
        }
        return [{ count: '0' }];
      });

      const checkResult = await service.checkOrphanedWallets();

      expect(checkResult.passed).toBe(false);
      expect(checkResult.violationCount).toBe(2);
      expect(checkResult.severity).toBe(InvariantSeverity.CRITICAL);
      expect(checkResult.violations?.length).toBe(2);
      expect(checkResult.violations?.[0].id).toBe('w-1');
    });

    it('should detect invalid Stellar public keys', async () => {
      dataSource.query.mockImplementation(async (sql: string) => {
        if (sql.includes('COUNT(*)') && sql.includes("address !~ '^G[A-Z2-7]{55}$'")) {
          return [{ count: '1' }];
        }
        if (sql.includes("address !~ '^G[A-Z2-7]{55}$'") && sql.includes('LIMIT 10')) {
          return [{ id: 'w-bad', address: '0x1234567890abcdef', userId: 'u-1' }];
        }
        return [{ count: '0' }];
      });

      const checkResult = await service.checkStellarPublicKeyFormat();

      expect(checkResult.passed).toBe(false);
      expect(checkResult.violationCount).toBe(1);
      expect(checkResult.severity).toBe(InvariantSeverity.ERROR);
    });

    it('should detect settled invoices with inconsistent paid amounts', async () => {
      dataSource.query.mockImplementation(async (sql: string) => {
        if (sql.includes('reconciliation_invoices') && sql.includes('COUNT(*)')) {
          return [{ count: '3' }];
        }
        if (sql.includes('reconciliation_invoices') && sql.includes('LIMIT 10')) {
          return [
            {
              id: 'inv-1',
              invoiceId: 'INV-100',
              expectedAmount: '100.00',
              paidAmount: '50.00',
              status: 'SETTLED',
            },
          ];
        }
        return [{ count: '0' }];
      });

      const checkResult = await service.checkSettledInvoiceConsistency();

      expect(checkResult.passed).toBe(false);
      expect(checkResult.severity).toBe(InvariantSeverity.CRITICAL);
      expect(checkResult.violationCount).toBe(3);
    });

    it('should handle SQL errors gracefully during invariant query execution', async () => {
      dataSource.query.mockRejectedValue(new Error('relation "unknown_table" does not exist'));

      const checkResult = await service.checkOrphanedDeFiPositions();

      expect(checkResult.passed).toBe(false);
      expect(checkResult.violationCount).toBe(1);
      expect(checkResult.description).toContain('Check execution failed');
    });
  });
});
