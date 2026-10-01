import { ExpensiveOpsRateLimiterService } from './expensive-ops-rate-limiter.service';
import { ConfigService } from '@nestjs/config';

function makeService(): ExpensiveOpsRateLimiterService {
  return new ExpensiveOpsRateLimiterService({ get: () => undefined } as unknown as ConfigService);
}

describe('ExpensiveOpsRateLimiterService (issue #121)', () => {
  describe('under-limit', () => {
    it('allows requests within limit', () => {
      const svc = makeService();
      const d = svc.check('ai:compute', 'user-1', ['user']);
      expect(d.allowed).toBe(true);
      expect(d.remaining).toBe(9); // limit=10, used=1
    });
  });

  describe('over-limit', () => {
    it('blocks once limit is exhausted', () => {
      const svc = makeService();
      for (let i = 0; i < 10; i++) svc.check('ai:compute', 'user-2', ['user']);
      const over = svc.check('ai:compute', 'user-2', ['user']);
      expect(over.allowed).toBe(false);
      expect(over.remaining).toBe(0);
      expect(over.retryAfterMs).toBeGreaterThan(0);
    });
  });

  describe('privileged bypass', () => {
    it('gives admin a higher limit', () => {
      const svc = makeService();
      // ai:compute limit=10, privilegedMultiplier=10 → admin limit=100
      for (let i = 0; i < 100; i++) {
        const d = svc.check('ai:compute', 'admin-1', ['admin']);
        expect(d.allowed).toBe(true);
        expect(d.privileged).toBe(true);
      }
      const over = svc.check('ai:compute', 'admin-1', ['admin']);
      expect(over.allowed).toBe(false);
    });
  });

  describe('reset', () => {
    it('clears the bucket after resetBucket()', () => {
      const svc = makeService();
      for (let i = 0; i < 10; i++) svc.check('ai:compute', 'user-3', ['user']);
      svc.resetBucket('ai:compute', 'user-3');
      const d = svc.check('ai:compute', 'user-3', ['user']);
      expect(d.allowed).toBe(true);
    });
  });

  describe('different users are isolated', () => {
    it('user-A limit does not affect user-B', () => {
      const svc = makeService();
      for (let i = 0; i < 10; i++) svc.check('ai:compute', 'user-A', ['user']);
      const d = svc.check('ai:compute', 'user-B', ['user']);
      expect(d.allowed).toBe(true);
    });
  });

  describe('unknown operation key', () => {
    it('allows through without error', () => {
      const svc = makeService();
      const d = svc.check('unknown:op', 'user-1', ['user']);
      expect(d.allowed).toBe(true);
    });
  });
});
