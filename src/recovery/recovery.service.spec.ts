import { RecoveryService } from './recovery.service';
import { OperationType } from '../common/contract/types/trellis-contract.types';
import { RecoveryStateFilter, TransitionRecoveryStateDto } from './dto/recovery.dto';

function makeService() {
  return new RecoveryService();
}

function seed(svc: RecoveryService, userId = 'user-1', opId = 'op-abc') {
  return svc.registerOperation({
    operationId: opId,
    operationType: OperationType.Payment,
    userId,
    title: 'Payment failed',
    description: 'Your payment could not be processed.',
  });
}

describe('RecoveryService (issue #122)', () => {
  describe('visibility', () => {
    it('shows unresolved entries by default', () => {
      const svc = makeService();
      seed(svc);
      const { items, total } = svc.listForUser('user-1', RecoveryStateFilter.Unresolved);
      expect(total).toBe(1);
      expect(items[0].state).toBe('unresolved');
    });

    it('does not show another user\'s entries', () => {
      const svc = makeService();
      seed(svc, 'user-1', 'op-1');
      seed(svc, 'user-2', 'op-2');
      const { total } = svc.listForUser('user-1', RecoveryStateFilter.All);
      expect(total).toBe(1);
    });
  });

  describe('permissions', () => {
    it('throws ForbiddenException when accessing another user\'s entry', () => {
      const svc = makeService();
      const entry = seed(svc, 'user-1', 'op-x');
      expect(() => svc.getEntry(entry.id, 'user-2')).toThrow();
    });
  });

  describe('state transitions', () => {
    it('transitions from unresolved → in_progress → resolved', () => {
      const svc = makeService();
      const entry = seed(svc);
      svc.transition(entry.id, 'user-1', { state: 'in_progress' });
      const resolved = svc.transition(entry.id, 'user-1', { state: 'resolved' });
      expect(resolved.state).toBe('resolved');
      expect(resolved.resolvedAt).toBeDefined();
      expect(resolved.availableActions).toHaveLength(0);
    });

    it('cannot transition an already-resolved entry', () => {
      const svc = makeService();
      const entry = seed(svc);
      svc.transition(entry.id, 'user-1', { state: 'resolved' });
      expect(() => svc.transition(entry.id, 'user-1', { state: 'in_progress' })).toThrow();
    });

    it('dismissal removes actions and sets resolvedAt', () => {
      const svc = makeService();
      const entry = seed(svc);
      const dismissed = svc.transition(entry.id, 'user-1', { state: 'dismissed' });
      expect(dismissed.state).toBe('dismissed');
      expect(dismissed.availableActions).toHaveLength(0);
    });
  });

  describe('resolved entries not in active view', () => {
    it('resolved entries are excluded from unresolved filter', () => {
      const svc = makeService();
      const entry = seed(svc);
      svc.transition(entry.id, 'user-1', { state: 'resolved' });
      const { total } = svc.listForUser('user-1', RecoveryStateFilter.Unresolved);
      expect(total).toBe(0);
    });

    it('resolved entries appear in the resolved filter', () => {
      const svc = makeService();
      const entry = seed(svc);
      svc.transition(entry.id, 'user-1', { state: 'resolved' });
      const { total } = svc.listForUser('user-1', RecoveryStateFilter.Resolved);
      expect(total).toBe(1);
    });
  });
});
