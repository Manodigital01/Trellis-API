import {
  Injectable,
  Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import {
  SNAPSHOT_REDACTED_FIELDS,
  REDACTED_PLACEHOLDER,
  SNAPSHOT_HASH_ALGORITHM,
  SNAPSHOT_HMAC_ALGORITHM,
  SNAPSHOT_MAX_RECORDS,
} from './snapshot.constants';
import { RequestSnapshotDto, VerifySnapshotDto } from './dto/snapshot.dto';

export interface SnapshotRecord {
  id: string;
  label?: string;
  scope: string;
  createdAt: string;
  payload: Record<string, unknown>;
  integrityHash: string;
  signature: string;
  redactedFields: string[];
  recordCount: number;
}

export interface SnapshotVerificationResult {
  snapshotId: string;
  valid: boolean;
  hashMatch: boolean;
  signatureMatch: boolean;
  reason?: string;
}

@Injectable()
export class SnapshotService {
  private readonly logger = new Logger(SnapshotService.name);
  private readonly snapshots = new Map<string, SnapshotRecord>();
  private readonly signingKey: string;

  constructor(private readonly config: ConfigService) {
    this.signingKey =
      this.config.get<string>('SNAPSHOT_SIGNING_KEY') ??
      'trellis-snapshot-dev-key-change-in-production';
  }

  /**
   * Generate a signed state snapshot.
   * Secrets are redacted before hashing to prevent leakage.
   */
  async createSnapshot(dto: RequestSnapshotDto, requesterId: string): Promise<SnapshotRecord> {
    const limit = Math.min(dto.limit ?? 500, SNAPSHOT_MAX_RECORDS);
    const rawPayload = await this.collectPayload(dto.scope, dto.resourceIds, limit);
    const { redacted, removedFields } = this.redactPayload(rawPayload);

    // Canonical JSON (sorted keys) so hash is deterministic regardless of insertion order
    const canonical = this.canonicalise(redacted);
    const integrityHash = this.hash(canonical);
    const signature = this.sign(integrityHash);

    const record: SnapshotRecord = {
      id: crypto.randomUUID(),
      label: dto.label,
      scope: dto.scope,
      createdAt: new Date().toISOString(),
      payload: redacted,
      integrityHash,
      signature,
      redactedFields: removedFields,
      recordCount: this.countRecords(redacted),
    };

    this.snapshots.set(record.id, record);
    this.logger.log(`Snapshot ${record.id} created by ${requesterId} — scope=${dto.scope} records=${record.recordCount}`);
    return record;
  }

  /** Verify a stored snapshot hasn't been tampered with. */
  async verifySnapshot(dto: VerifySnapshotDto): Promise<SnapshotVerificationResult> {
    const record = this.snapshots.get(dto.snapshotId);
    if (!record) {
      return { snapshotId: dto.snapshotId, valid: false, hashMatch: false, signatureMatch: false, reason: 'Snapshot not found' };
    }

    const canonical = this.canonicalise(record.payload);
    const recomputed = this.hash(canonical);
    const hashMatch = recomputed === record.integrityHash;
    const expectedSig = this.sign(recomputed);
    const signatureMatch =
      dto.expectedSignature
        ? this.timingSafeCompare(dto.expectedSignature, record.signature)
        : this.timingSafeCompare(expectedSig, record.signature);

    return {
      snapshotId: dto.snapshotId,
      valid: hashMatch && signatureMatch,
      hashMatch,
      signatureMatch,
      reason: !hashMatch ? 'Integrity hash mismatch — payload was modified after export' :
              !signatureMatch ? 'Signature mismatch — snapshot may have been tampered with' :
              undefined,
    };
  }

  getSnapshot(id: string): SnapshotRecord | undefined {
    return this.snapshots.get(id);
  }

  listSnapshots(): Omit<SnapshotRecord, 'payload'>[] {
    return [...this.snapshots.values()].map(({ payload: _p, ...rest }) => rest);
  }

  // --- Private helpers ---

  private async collectPayload(
    scope: string,
    resourceIds?: string[],
    limit = 500,
  ): Promise<Record<string, unknown>> {
    // In production this would query real repositories.
    // This stub returns an envelope that is deterministic and safe to hash.
    const base: Record<string, unknown> = {
      scope,
      capturedAt: new Date().toISOString(),
      environment: process.env.NODE_ENV ?? 'unknown',
    };

    if (resourceIds?.length) {
      base.resourceIds = resourceIds;
    }

    base.meta = { limit, note: 'live data injected by repository layer in production' };
    return base;
  }

  /** Deep-clone and strip any key whose name is on the redact list. */
  private redactPayload(obj: unknown, removedFields: Set<string> = new Set()): { redacted: Record<string, unknown>; removedFields: string[] } {
    const redacted = this.deepRedact(obj, removedFields) as Record<string, unknown>;
    return { redacted, removedFields: [...removedFields] };
  }

  private deepRedact(value: unknown, removed: Set<string>): unknown {
    if (Array.isArray(value)) return value.map(v => this.deepRedact(v, removed));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (SNAPSHOT_REDACTED_FIELDS.includes(k.toLowerCase()) || SNAPSHOT_REDACTED_FIELDS.includes(k)) {
          out[k] = REDACTED_PLACEHOLDER;
          removed.add(k);
        } else {
          out[k] = this.deepRedact(v, removed);
        }
      }
      return out;
    }
    return value;
  }

  /** Sort all object keys recursively so JSON serialisation is canonical. */
  private canonicalise(obj: unknown): string {
    return JSON.stringify(obj, (_, v) =>
      v !== null && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)))
        : v,
    );
  }

  private hash(data: string): string {
    return crypto.createHash(SNAPSHOT_HASH_ALGORITHM).update(data, 'utf8').digest('hex');
  }

  private sign(hash: string): string {
    return crypto.createHmac(SNAPSHOT_HMAC_ALGORITHM, this.signingKey).update(hash).digest('hex');
  }

  private timingSafeCompare(a: string, b: string): boolean {
    try {
      const ba = Buffer.from(a);
      const bb = Buffer.from(b);
      if (ba.length !== bb.length) return false;
      return crypto.timingSafeEqual(ba, bb);
    } catch {
      return false;
    }
  }

  private countRecords(obj: unknown): number {
    if (Array.isArray(obj)) return obj.length;
    if (obj !== null && typeof obj === 'object') {
      return Object.values(obj as object).reduce((sum: number, v) => sum + this.countRecords(v), 0);
    }
    return 1;
  }
}
