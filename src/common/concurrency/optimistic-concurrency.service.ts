import { ConflictException, Injectable } from "@nestjs/common";

export interface VersionedRecord {
  version: number;
}

export interface ConflictDetails {
  expectedVersion: number;
  actualVersion: number;
  action: "refresh" | "retry";
}

/**
 * Small, storage-agnostic optimistic concurrency helper. Callers read a
 * record's version, then pass that version to update. A stale write fails
 * explicitly instead of silently replacing a newer update.
 */
@Injectable()
export class OptimisticConcurrencyService {
  assertCurrent(record: VersionedRecord, expectedVersion: number): void {
    if (record.version !== expectedVersion) {
      const details: ConflictDetails = {
        expectedVersion,
        actualVersion: record.version,
        action: "refresh",
      };
      throw new ConflictException(
        `The record changed while you were editing it. Refresh before retrying.`,
        details as any,
      );
    }
  }

  nextVersion(version: number): number {
    if (!Number.isInteger(version) || version < 0) {
      throw new ConflictException("Invalid record version; refresh and retry.");
    }
    return version + 1;
  }
}
