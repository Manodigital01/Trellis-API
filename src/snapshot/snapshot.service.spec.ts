import { SnapshotService } from './snapshot.service';
import { ConfigService } from '@nestjs/config';

function makeService() {
  const config = { get: (key: string) => undefined } as unknown as ConfigService;
  return new SnapshotService(config);
}

describe('SnapshotService', () => {
  describe('createSnapshot', () => {
    it('produces a non-empty integrityHash and signature', async () => {
      const svc = makeService();
      const snap = await svc.createSnapshot({ scope: 'agents', limit: 10 }, 'user-1');
      expect(snap.integrityHash).toMatch(/^[a-f0-9]{64}$/);
      expect(snap.signature).toMatch(/^[a-f0-9]{64}$/);
      expect(snap.id).toBeDefined();
    });

    it('redacts secret fields from the payload', async () => {
      const svc = makeService();
      // Reach into private method via any-cast for unit coverage
      const { redacted, removedFields } = (svc as any).redactPayload({
        username: 'alice',
        password: 'hunter2',
        apiKey: 'sk-abc123',
        nested: { secret: 'top-secret', safe: 'ok' },
      });
      expect(redacted.password).toBe('[REDACTED]');
      expect(redacted.apiKey).toBe('[REDACTED]');
      expect((redacted.nested as any).secret).toBe('[REDACTED]');
      expect((redacted.nested as any).safe).toBe('ok');
      expect(redacted.username).toBe('alice');
      expect(removedFields).toContain('password');
      expect(removedFields).toContain('apiKey');
    });

    it('canonical JSON is deterministic regardless of key insertion order', () => {
      const svc = makeService();
      const a = (svc as any).canonicalise({ z: 1, a: 2, m: 3 });
      const b = (svc as any).canonicalise({ m: 3, z: 1, a: 2 });
      expect(a).toBe(b);
    });
  });

  describe('verifySnapshot', () => {
    it('returns valid=true for an untampered snapshot', async () => {
      const svc = makeService();
      const snap = await svc.createSnapshot({ scope: 'audit' }, 'user-1');
      const result = await svc.verifySnapshot({ snapshotId: snap.id });
      expect(result.valid).toBe(true);
      expect(result.hashMatch).toBe(true);
      expect(result.signatureMatch).toBe(true);
    });

    it('returns valid=false when the snapshot does not exist', async () => {
      const svc = makeService();
      const result = await svc.verifySnapshot({ snapshotId: 'nonexistent-id' });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('not found');
    });

    it('detects verification failure when expected signature is wrong', async () => {
      const svc = makeService();
      const snap = await svc.createSnapshot({ scope: 'full' }, 'user-1');
      const result = await svc.verifySnapshot({ snapshotId: snap.id, expectedSignature: 'badsig' });
      expect(result.valid).toBe(false);
      expect(result.signatureMatch).toBe(false);
    });
  });
});
