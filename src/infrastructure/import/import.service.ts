import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { v4 as uuid } from 'uuid';
import {
  ImportEntityType,
  ImportAction,
  ImportRequestDto,
  ImportResultDto,
  ImportDiffPreview,
  ImportErrorDetail,
  ImportRollbackGuidance,
  PortfolioAssetImportRowDto,
  TransactionImportRowDto,
  ReconciliationInvoiceImportRowDto,
} from './dto/import.dto';
import { Portfolio } from '../../investment/portfolio/entities/portfolio.entity';
import { PortfolioAsset, Chain } from '../../investment/portfolio/entities/portfolio-asset.entity';
import { Transaction, TransactionType } from '../../investment/portfolio/entities/transaction.entity';
import {
  ReconciliationInvoice,
  ReconciliationInvoiceStatus,
} from '../../reconciliation/entities/reconciliation-invoice.entity';

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Process a batch import with dry-run support, schema validation,
   * duplicate detection, idempotent upserts, and rollback guidance.
   */
  async processImport(dto: ImportRequestDto): Promise<ImportResultDto> {
    const startTime = Date.now();
    const dryRun = dto.dryRun ?? true;
    const options = dto.options ?? {};
    const allowPartial = options.allowPartial ?? false;
    const updateExisting = options.updateExisting ?? true;
    const stopOnError = options.stopOnError ?? false;

    this.logger.log(
      `Starting import batch [entity=${dto.entityType}, rows=${dto.rows.length}, dryRun=${dryRun}, allowPartial=${allowPartial}]`,
    );

    const previews: ImportDiffPreview[] = [];
    const errors: ImportErrorDetail[] = [];
    let createCount = 0;
    let updateCount = 0;
    let skipCount = 0;
    const affectedRecordIds: string[] = [];

    // Internal batch duplicate tracking (O(1) Map lookup)
    const seenExternalIdsInBatch = new Map<string, number>();

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      if (dto.entityType === ImportEntityType.PORTFOLIO_ASSETS) {
        // =========================================================
        // 1. PORTFOLIO ASSETS IMPORT
        // =========================================================
        const portfolioIds = [
          ...new Set(
            dto.rows
              .map((r) => r.portfolioId)
              .filter((id) => typeof id === 'string' && id.trim().length > 0),
          ),
        ];

        const existingPortfolios =
          portfolioIds.length > 0
            ? await queryRunner.manager
                .getRepository(Portfolio)
                .createQueryBuilder('p')
                .select(['p.id'])
                .where('p.id IN (:...ids)', { ids: portfolioIds })
                .getMany()
            : [];
        const validPortfolioIdSet = new Set(existingPortfolios.map((p) => p.id));

        const externalIds = dto.rows
          .map((r) => r.externalId)
          .filter((id) => typeof id === 'string' && id.trim().length > 0);

        const existingAssets =
          externalIds.length > 0
            ? await queryRunner.manager
                .getRepository(PortfolioAsset)
                .createQueryBuilder('pa')
                .where("pa.metadata->>'externalId' IN (:...ids)", {
                  ids: externalIds,
                })
                .getMany()
            : [];

        const existingAssetMap = new Map<string, PortfolioAsset>();
        for (const asset of existingAssets) {
          const extId = asset.metadata?.externalId;
          if (extId) existingAssetMap.set(extId, asset);
        }

        for (let i = 0; i < dto.rows.length; i++) {
          const rawRow = dto.rows[i];
          const rowIndex = i + 1;

          if (rawRow.externalId) {
            if (seenExternalIdsInBatch.has(rawRow.externalId)) {
              const previousRow = seenExternalIdsInBatch.get(rawRow.externalId);
              errors.push({
                rowIndex,
                externalId: rawRow.externalId,
                field: 'externalId',
                rejectedValue: rawRow.externalId,
                errorMessage: `Duplicate externalId "${rawRow.externalId}" detected in current import batch (previously seen at row ${previousRow}).`,
                remediation: `Ensure external IDs are unique across the import batch or consolidate duplicate rows.`,
              });
              if (stopOnError) break;
              continue;
            }
            seenExternalIdsInBatch.set(rawRow.externalId, rowIndex);
          }

          const rowDto = plainToInstance(PortfolioAssetImportRowDto, rawRow);
          const validationErrors = await validate(rowDto);

          if (validationErrors.length > 0) {
            for (const vErr of validationErrors) {
              const constraints = Object.values(vErr.constraints || {}).join(', ');
              errors.push({
                rowIndex,
                externalId: rawRow.externalId,
                field: vErr.property,
                rejectedValue: rawRow[vErr.property],
                errorMessage: `Validation failed for ${vErr.property}: ${constraints}`,
                remediation: `Correct field "${vErr.property}" to satisfy constraint (${constraints}).`,
              });
            }
            if (stopOnError) break;
            continue;
          }

          if (!validPortfolioIdSet.has(rowDto.portfolioId)) {
            errors.push({
              rowIndex,
              externalId: rawRow.externalId,
              field: 'portfolioId',
              rejectedValue: rowDto.portfolioId,
              errorMessage: `Referenced portfolioId "${rowDto.portfolioId}" does not exist in the database.`,
              remediation: `Verify that the portfolio has been created before importing assets, or correct the portfolio ID.`,
            });
            if (stopOnError) break;
            continue;
          }

          const existingAsset = rowDto.externalId
            ? existingAssetMap.get(rowDto.externalId)
            : undefined;

          if (existingAsset) {
            if (!updateExisting) {
              skipCount++;
              previews.push({
                rowIndex,
                externalId: rowDto.externalId,
                action: ImportAction.SKIP,
                summary: `Asset for externalId "${rowDto.externalId}" already exists and updateExisting is false.`,
                before: {
                  id: existingAsset.id,
                  ticker: existingAsset.ticker,
                  quantity: existingAsset.quantity,
                  currentPrice: existingAsset.currentPrice,
                },
              });
              continue;
            }

            updateCount++;
            previews.push({
              rowIndex,
              externalId: rowDto.externalId,
              action: ImportAction.UPDATE,
              summary: `Update existing asset "${existingAsset.ticker}" (ID: ${existingAsset.id})`,
              before: {
                id: existingAsset.id,
                ticker: existingAsset.ticker,
                quantity: existingAsset.quantity,
                currentPrice: existingAsset.currentPrice,
                allocationPercentage: existingAsset.allocationPercentage,
              },
              after: {
                id: existingAsset.id,
                ticker: rowDto.symbol,
                quantity: rowDto.amount,
                currentPrice: rowDto.currentPrice,
                allocationPercentage: rowDto.targetAllocation ?? existingAsset.allocationPercentage,
              },
            });

            if (!dryRun) {
              existingAsset.ticker = rowDto.symbol;
              existingAsset.quantity = rowDto.amount;
              existingAsset.currentPrice = rowDto.currentPrice;
              existingAsset.value = rowDto.amount * rowDto.currentPrice;
              if (rowDto.targetAllocation !== undefined) {
                existingAsset.allocationPercentage = rowDto.targetAllocation;
              }
              await queryRunner.manager.save(PortfolioAsset, existingAsset);
              affectedRecordIds.push(existingAsset.id);
            }
          } else {
            createCount++;
            const newId = uuid();
            previews.push({
              rowIndex,
              externalId: rowDto.externalId,
              action: ImportAction.CREATE,
              summary: `Create new asset "${rowDto.symbol}" under portfolio ${rowDto.portfolioId}`,
              after: {
                id: newId,
                portfolioId: rowDto.portfolioId,
                ticker: rowDto.symbol,
                quantity: rowDto.amount,
                currentPrice: rowDto.currentPrice,
                allocationPercentage: rowDto.targetAllocation ?? 0,
                externalId: rowDto.externalId,
              },
            });

            if (!dryRun) {
              const newAsset = queryRunner.manager.create(PortfolioAsset, {
                id: newId,
                portfolio: { id: rowDto.portfolioId } as Portfolio,
                ticker: rowDto.symbol,
                name: rowDto.symbol,
                quantity: rowDto.amount,
                currentPrice: rowDto.currentPrice,
                value: rowDto.amount * rowDto.currentPrice,
                allocationPercentage: rowDto.targetAllocation ?? 0,
                metadata: rowDto.externalId ? { externalId: rowDto.externalId } : {},
              });
              await queryRunner.manager.save(PortfolioAsset, newAsset);
              affectedRecordIds.push(newId);
            }
          }
        }
      } else if (dto.entityType === ImportEntityType.TRANSACTIONS) {
        // =========================================================
        // 2. TRANSACTIONS IMPORT
        // =========================================================
        const portfolioIds = [
          ...new Set(
            dto.rows
              .map((r) => r.portfolioId)
              .filter((id) => typeof id === 'string' && id.trim().length > 0),
          ),
        ];

        const existingPortfolios =
          portfolioIds.length > 0
            ? await queryRunner.manager
                .getRepository(Portfolio)
                .createQueryBuilder('p')
                .select(['p.id'])
                .where('p.id IN (:...ids)', { ids: portfolioIds })
                .getMany()
            : [];
        const validPortfolioIdSet = new Set(existingPortfolios.map((p) => p.id));

        const externalIds = dto.rows
          .map((r) => r.externalId)
          .filter((id) => typeof id === 'string' && id.trim().length > 0);

        const existingTransactions =
          externalIds.length > 0
            ? await queryRunner.manager
                .getRepository(Transaction)
                .createQueryBuilder('t')
                .where("t.metadata->>'externalId' IN (:...ids)", {
                  ids: externalIds,
                })
                .getMany()
            : [];

        const existingTxMap = new Map<string, Transaction>();
        for (const tx of existingTransactions) {
          const extId = tx.metadata?.externalId;
          if (extId) existingTxMap.set(extId, tx);
        }

        for (let i = 0; i < dto.rows.length; i++) {
          const rawRow = dto.rows[i];
          const rowIndex = i + 1;

          if (rawRow.externalId) {
            if (seenExternalIdsInBatch.has(rawRow.externalId)) {
              const prev = seenExternalIdsInBatch.get(rawRow.externalId);
              errors.push({
                rowIndex,
                externalId: rawRow.externalId,
                field: 'externalId',
                rejectedValue: rawRow.externalId,
                errorMessage: `Duplicate transaction externalId "${rawRow.externalId}" at row ${rowIndex} (previous row ${prev}).`,
                remediation: `Ensure transaction external IDs are unique across batch.`,
              });
              if (stopOnError) break;
              continue;
            }
            seenExternalIdsInBatch.set(rawRow.externalId, rowIndex);
          }

          const rowDto = plainToInstance(TransactionImportRowDto, rawRow);
          const validationErrors = await validate(rowDto);

          if (validationErrors.length > 0) {
            for (const vErr of validationErrors) {
              const constraints = Object.values(vErr.constraints || {}).join(', ');
              errors.push({
                rowIndex,
                externalId: rawRow.externalId,
                field: vErr.property,
                rejectedValue: rawRow[vErr.property],
                errorMessage: `Validation failed: ${constraints}`,
                remediation: `Correct field "${vErr.property}".`,
              });
            }
            if (stopOnError) break;
            continue;
          }

          if (!validPortfolioIdSet.has(rowDto.portfolioId)) {
            errors.push({
              rowIndex,
              externalId: rawRow.externalId,
              field: 'portfolioId',
              rejectedValue: rowDto.portfolioId,
              errorMessage: `Referenced portfolioId "${rowDto.portfolioId}" does not exist.`,
              remediation: `Verify target portfolio ID.`,
            });
            if (stopOnError) break;
            continue;
          }

          const existingTx = rowDto.externalId
            ? existingTxMap.get(rowDto.externalId)
            : undefined;

          if (existingTx) {
            if (!updateExisting) {
              skipCount++;
              previews.push({
                rowIndex,
                externalId: rowDto.externalId,
                action: ImportAction.SKIP,
                summary: `Transaction with externalId "${rowDto.externalId}" already exists.`,
                before: { id: existingTx.id, amount: existingTx.amount, price: existingTx.price },
              });
              continue;
            }

            updateCount++;
            previews.push({
              rowIndex,
              externalId: rowDto.externalId,
              action: ImportAction.UPDATE,
              summary: `Update existing transaction (ID: ${existingTx.id})`,
              before: { id: existingTx.id, amount: existingTx.amount, price: existingTx.price },
              after: { id: existingTx.id, amount: rowDto.amount, price: rowDto.price },
            });

            if (!dryRun) {
              existingTx.amount = rowDto.amount;
              if (rowDto.price !== undefined) existingTx.price = rowDto.price;
              if (rowDto.fees !== undefined) existingTx.fees = rowDto.fees;
              await queryRunner.manager.save(Transaction, existingTx);
              affectedRecordIds.push(existingTx.id);
            }
          } else {
            createCount++;
            const newId = uuid();
            previews.push({
              rowIndex,
              externalId: rowDto.externalId,
              action: ImportAction.CREATE,
              summary: `Create new transaction (${rowDto.type} ${rowDto.amount}) under portfolio ${rowDto.portfolioId}`,
              after: {
                id: newId,
                portfolioId: rowDto.portfolioId,
                type: rowDto.type,
                amount: rowDto.amount,
                price: rowDto.price,
              },
            });

            if (!dryRun) {
              const newTx = queryRunner.manager.create(Transaction, {
                id: newId,
                portfolio: { id: rowDto.portfolioId } as Portfolio,
                type: (rowDto.type.toLowerCase() as TransactionType) || TransactionType.BUY,
                amount: rowDto.amount,
                price: rowDto.price ?? 0,
                fees: rowDto.fees ?? 0,
                chain: (rowDto.chain as Chain) || Chain.OTHER,
                portfolioAssetId: rowDto.portfolioAssetId || null,
                metadata: rowDto.externalId ? { externalId: rowDto.externalId } : {},
              });
              await queryRunner.manager.save(Transaction, newTx);
              affectedRecordIds.push(newId);
            }
          }
        }
      } else if (dto.entityType === ImportEntityType.RECONCILIATION_INVOICES) {
        // =========================================================
        // 3. RECONCILIATION INVOICES IMPORT (STELLAR)
        // =========================================================
        const invoiceIds = dto.rows
          .map((r) => r.invoiceId)
          .filter((id) => typeof id === 'string' && id.trim().length > 0);

        const existingInvoices =
          invoiceIds.length > 0
            ? await queryRunner.manager
                .getRepository(ReconciliationInvoice)
                .createQueryBuilder('ri')
                .where('ri.invoiceId IN (:...ids)', { ids: invoiceIds })
                .getMany()
            : [];

        const existingInvoiceMap = new Map<string, ReconciliationInvoice>();
        for (const inv of existingInvoices) {
          existingInvoiceMap.set(inv.invoiceId, inv);
        }

        for (let i = 0; i < dto.rows.length; i++) {
          const rawRow = dto.rows[i];
          const rowIndex = i + 1;

          if (rawRow.invoiceId) {
            if (seenExternalIdsInBatch.has(rawRow.invoiceId)) {
              const prev = seenExternalIdsInBatch.get(rawRow.invoiceId);
              errors.push({
                rowIndex,
                externalId: rawRow.invoiceId,
                field: 'invoiceId',
                rejectedValue: rawRow.invoiceId,
                errorMessage: `Duplicate invoiceId "${rawRow.invoiceId}" at row ${rowIndex} (previous row ${prev}).`,
                remediation: `Ensure invoiceId is unique across the batch.`,
              });
              if (stopOnError) break;
              continue;
            }
            seenExternalIdsInBatch.set(rawRow.invoiceId, rowIndex);
          }

          const rowDto = plainToInstance(ReconciliationInvoiceImportRowDto, rawRow);
          const validationErrors = await validate(rowDto);

          if (validationErrors.length > 0) {
            for (const vErr of validationErrors) {
              const constraints = Object.values(vErr.constraints || {}).join(', ');
              errors.push({
                rowIndex,
                externalId: rowDto.invoiceId,
                field: vErr.property,
                rejectedValue: rawRow[vErr.property],
                errorMessage: `Validation failed: ${constraints}`,
                remediation: `Correct field "${vErr.property}".`,
              });
            }
            if (stopOnError) break;
            continue;
          }

          // Stellar Public Key validation: ^G[A-Z2-7]{55}$
          if (!/^G[A-Z2-7]{55}$/.test(rowDto.destinationAccount)) {
            errors.push({
              rowIndex,
              externalId: rowDto.invoiceId,
              field: 'destinationAccount',
              rejectedValue: rowDto.destinationAccount,
              errorMessage: `Invalid Stellar destination account format. Must be an ed25519 public key starting with 'G' (56 chars Base32).`,
              remediation: `Verify and supply a valid Stellar account address.`,
            });
            if (stopOnError) break;
            continue;
          }

          const existingInv = existingInvoiceMap.get(rowDto.invoiceId);

          if (existingInv) {
            if (!updateExisting) {
              skipCount++;
              previews.push({
                rowIndex,
                externalId: rowDto.invoiceId,
                action: ImportAction.SKIP,
                summary: `Invoice "${rowDto.invoiceId}" already exists.`,
                before: {
                  invoiceId: existingInv.invoiceId,
                  expectedAmount: existingInv.expectedAmount,
                  status: existingInv.status,
                },
              });
              continue;
            }

            updateCount++;
            previews.push({
              rowIndex,
              externalId: rowDto.invoiceId,
              action: ImportAction.UPDATE,
              summary: `Update existing invoice "${existingInv.invoiceId}"`,
              before: {
                invoiceId: existingInv.invoiceId,
                expectedAmount: existingInv.expectedAmount,
                destinationAccount: existingInv.destinationAccount,
              },
              after: {
                invoiceId: rowDto.invoiceId,
                expectedAmount: rowDto.expectedAmount,
                destinationAccount: rowDto.destinationAccount,
              },
            });

            if (!dryRun) {
              existingInv.expectedAmount = rowDto.expectedAmount;
              existingInv.destinationAccount = rowDto.destinationAccount;
              if (rowDto.assetCode) existingInv.assetCode = rowDto.assetCode.toUpperCase();
              if (rowDto.paymentReference) existingInv.paymentReference = rowDto.paymentReference;
              await queryRunner.manager.save(ReconciliationInvoice, existingInv);
              affectedRecordIds.push(existingInv.id);
            }
          } else {
            createCount++;
            previews.push({
              rowIndex,
              externalId: rowDto.invoiceId,
              action: ImportAction.CREATE,
              summary: `Create reconciliation invoice "${rowDto.invoiceId}" (expected ${rowDto.expectedAmount} ${rowDto.assetCode || 'XLM'})`,
              after: {
                invoiceId: rowDto.invoiceId,
                expectedAmount: rowDto.expectedAmount,
                assetCode: (rowDto.assetCode || 'XLM').toUpperCase(),
                destinationAccount: rowDto.destinationAccount,
                status: ReconciliationInvoiceStatus.OPEN,
              },
            });

            if (!dryRun) {
              const newInvoice = queryRunner.manager.create(ReconciliationInvoice, {
                invoiceId: rowDto.invoiceId,
                expectedAmount: rowDto.expectedAmount,
                paidAmount: '0.0000000',
                assetCode: (rowDto.assetCode || 'XLM').toUpperCase(),
                destinationAccount: rowDto.destinationAccount,
                paymentReference: rowDto.paymentReference || '',
                status: ReconciliationInvoiceStatus.OPEN,
                metadata: rowDto.externalId ? { externalId: rowDto.externalId } : {},
              });
              const saved = await queryRunner.manager.save(ReconciliationInvoice, newInvoice);
              affectedRecordIds.push(saved.id);
            }
          }
        }
      } else {
        throw new BadRequestException(
          `Import entity type "${dto.entityType}" is not currently supported.`,
        );
      }

      // Check if partial errors violate non-partial mode
      const hasErrors = errors.length > 0;
      const shouldRollback =
        dryRun || (hasErrors && !allowPartial);

      if (shouldRollback) {
        await queryRunner.rollbackTransaction();
      } else {
        await queryRunner.commitTransaction();
      }

      const isSuccess = !hasErrors || (allowPartial && (createCount > 0 || updateCount > 0));

      const rollbackGuidance: ImportRollbackGuidance | undefined =
        !dryRun && affectedRecordIds.length > 0
          ? {
              transactionId: uuid(),
              snapshotTimestamp: new Date(),
              affectedRecordIds,
              remediationSteps: [
                `To revert created records, execute compensation queries targeting IDs: ${affectedRecordIds
                  .map((id) => `'${id}'`)
                  .join(', ')}`,
                `Review error log entries for ${errors.length} failed rows.`,
              ],
              rollbackInstructions:
                'If this live batch needs to be rolled back manually, utilize the affected record IDs listed above with database administrative privileges.',
            }
          : undefined;

      const executionTimeMs = Date.now() - startTime;

      return {
        dryRun,
        entityType: dto.entityType,
        totalRows: dto.rows.length,
        createCount,
        updateCount,
        skipCount,
        errorCount: errors.length,
        isSuccess,
        preview: previews,
        errors,
        rollbackGuidance,
        executionTimeMs,
      };
    } catch (err: any) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Import pipeline failure: ${err.message}`, err.stack);
      throw err;
    } finally {
      await queryRunner.release();
    }
  }
}
