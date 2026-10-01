import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { ImportService } from './import.service';
import {
  ImportEntityType,
  ImportAction,
  ImportRequestDto,
} from './dto/import.dto';

describe('ImportService', () => {
  let service: ImportService;
  let mockQueryRunner: any;
  let mockDataSource: any;

  beforeEach(async () => {
    mockQueryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      manager: {
        getRepository: jest.fn().mockReturnValue({
          createQueryBuilder: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            getMany: jest.fn().mockResolvedValue([
              { id: 'valid-portfolio-1' },
            ]),
          }),
        }),
        create: jest.fn().mockImplementation((entity, data) => ({
          id: 'new-record-id',
          ...data,
        })),
        save: jest.fn().mockImplementation((entity, data) => Promise.resolve(data)),
      },
    };

    mockDataSource = {
      createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImportService,
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
      ],
    }).compile();

    service = module.get<ImportService>(ImportService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('Portfolio Assets Import', () => {
    it('should validate and preview changes in dry-run mode with rollbackTransaction', async () => {
      const dto: ImportRequestDto = {
        entityType: ImportEntityType.PORTFOLIO_ASSETS,
        dryRun: true,
        rows: [
          {
            portfolioId: 'valid-portfolio-1',
            symbol: 'XLM',
            amount: 1000,
            currentPrice: 0.15,
            targetAllocation: 50,
            externalId: 'ext-asset-1',
          },
          {
            portfolioId: 'valid-portfolio-1',
            symbol: 'USDC',
            amount: 500,
            currentPrice: 1.0,
            targetAllocation: 50,
            externalId: 'ext-asset-2',
          },
        ],
      };

      const result = await service.processImport(dto);

      expect(result.dryRun).toBe(true);
      expect(result.totalRows).toBe(2);
      expect(result.createCount).toBe(2);
      expect(result.errorCount).toBe(0);
      expect(result.isSuccess).toBe(true);
      expect(result.preview.length).toBe(2);
      expect(result.preview[0].action).toBe(ImportAction.CREATE);

      // Verify zero persistent writes
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
    });

    it('should detect duplicate externalId within the import batch', async () => {
      const dto: ImportRequestDto = {
        entityType: ImportEntityType.PORTFOLIO_ASSETS,
        dryRun: true,
        rows: [
          {
            portfolioId: 'valid-portfolio-1',
            symbol: 'XLM',
            amount: 1000,
            currentPrice: 0.15,
            externalId: 'duplicate-ext-id',
          },
          {
            portfolioId: 'valid-portfolio-1',
            symbol: 'XLM',
            amount: 2000,
            currentPrice: 0.15,
            externalId: 'duplicate-ext-id',
          },
        ],
      };

      const result = await service.processImport(dto);

      expect(result.errorCount).toBe(1);
      expect(result.errors[0].field).toBe('externalId');
      expect(result.errors[0].errorMessage).toContain('Duplicate externalId "duplicate-ext-id"');
      expect(result.errors[0].rowIndex).toBe(2);
    });

    it('should reject rows with missing portfolioId', async () => {
      const dto: ImportRequestDto = {
        entityType: ImportEntityType.PORTFOLIO_ASSETS,
        dryRun: true,
        rows: [
          {
            portfolioId: 'non-existent-portfolio',
            symbol: 'XLM',
            amount: 1000,
            currentPrice: 0.15,
          },
        ],
      };

      const result = await service.processImport(dto);

      expect(result.errorCount).toBe(1);
      expect(result.errors[0].field).toBe('portfolioId');
      expect(result.errors[0].errorMessage).toContain('does not exist');
      expect(result.errors[0].remediation).toBeDefined();
    });
  });

  describe('Reconciliation Invoices Import (Stellar Invariants)', () => {
    it('should validate and import valid Stellar invoices with ed25519 addresses', async () => {
      const dto: ImportRequestDto = {
        entityType: ImportEntityType.RECONCILIATION_INVOICES,
        dryRun: false,
        rows: [
          {
            invoiceId: 'INV-2026-001',
            expectedAmount: '100.0000000',
            assetCode: 'XLM',
            destinationAccount: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
            paymentReference: 'MEMO-123',
          },
        ],
      };

      const result = await service.processImport(dto);

      expect(result.isSuccess).toBe(true);
      expect(result.createCount).toBe(1);
      expect(result.errorCount).toBe(0);
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });

    it('should reject invalid Stellar destination account formats', async () => {
      const dto: ImportRequestDto = {
        entityType: ImportEntityType.RECONCILIATION_INVOICES,
        dryRun: true,
        rows: [
          {
            invoiceId: 'INV-2026-BAD',
            expectedAmount: '100.0000000',
            assetCode: 'XLM',
            destinationAccount: '0x1234567890abcdef', // Invalid EVM format
          },
        ],
      };

      const result = await service.processImport(dto);

      expect(result.errorCount).toBe(1);
      expect(result.errors[0].field).toBe('destinationAccount');
      expect(result.errors[0].errorMessage).toContain('Invalid Stellar destination account format');
    });
  });

  describe('Transactions Import', () => {
    it('should import transactions with external IDs and commit transaction in live mode', async () => {
      const dto: ImportRequestDto = {
        entityType: ImportEntityType.TRANSACTIONS,
        dryRun: false,
        rows: [
          {
            portfolioId: 'valid-portfolio-1',
            type: 'buy',
            amount: 250,
            price: 0.15,
            chain: 'stellar',
            externalId: 'tx-ext-001',
          },
        ],
      };

      const result = await service.processImport(dto);

      expect(result.isSuccess).toBe(true);
      expect(result.createCount).toBe(1);
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(result.rollbackGuidance).toBeDefined();
    });
  });
});
