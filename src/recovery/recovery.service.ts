import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { RecoveryStateFilter, TransitionRecoveryStateDto } from './dto/recovery.dto';
import {
  RecoveryEntry,
  RecoveryState,
  OperationType,
  OperationStatus,
  RecoveryAction,
} from '../common/contract/types/trellis-contract.types';

export type { RecoveryEntry };

interface RecoveryEntryInternal extends RecoveryEntry {
  userId: string;
}

/** Builds safe recovery actions for a given operation type. */
function buildRecoveryActions(type: OperationType, operationId: string): RecoveryAction[] {
  const base: RecoveryAction[] = [
    {
      actionId: 'retry',
      label: 'Retry',
      description: 'Attempt the operation again from the last checkpoint.',
      endpoint: `/api/v1/recovery/${operationId}/retry`,
      method: 'POST',
      requiresConfirmation: false,
    },
    {
      actionId: 'cancel',
      label: 'Cancel',
      description: 'Cancel this operation and release any held resources.',
      endpoint: `/api/v1/recovery/${operationId}/cancel`,
      method: 'DELETE',
      requiresConfirmation: true,
    },
  ];

  if ([OperationType.Payment, OperationType.Submission, OperationType.Staking].includes(type)) {
    base.push({
      actionId: 'view-on-chain',
      label: 'View on-chain',
      description: 'Inspect the Stellar transaction on the network explorer.',
      endpoint: `/api/v1/recovery/${operationId}/chain-link`,
      method: 'POST',
      requiresConfirmation: false,
    });
  }

  return base;
}

@Injectable()
export class RecoveryService {
  private readonly logger = new Logger(RecoveryService.name);
  private readonly entries = new Map<string, RecoveryEntryInternal>();

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  listForUser(
    userId: string,
    stateFilter: RecoveryStateFilter = RecoveryStateFilter.Unresolved,
    limit = 20,
    offset = 0,
  ): { items: RecoveryEntry[]; total: number } {
    const activeStates: RecoveryState[] = ['unresolved', 'in_progress'];

    const all = [...this.entries.values()]
      .filter(e => e.userId === userId)
      .filter(e => {
        if (stateFilter === RecoveryStateFilter.All) return true;
        if (stateFilter === RecoveryStateFilter.Unresolved) return activeStates.includes(e.state);
        return e.state === stateFilter;
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return { items: all.slice(offset, offset + limit), total: all.length };
  }

  getEntry(id: string, userId: string): RecoveryEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new NotFoundException(`Recovery entry ${id} not found`);
    if (entry.userId !== userId) throw new ForbiddenException('Access denied');
    return entry;
  }

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------

  /** Register a new failed/pending operation so it appears in the recovery center. */
  registerOperation(params: {
    operationId: string;
    operationType: OperationType;
    userId: string;
    title: string;
    description: string;
    initialState?: RecoveryState;
  }): RecoveryEntry {
    const id = `rec-${params.operationId}`;
    const entry: RecoveryEntryInternal = {
      id,
      operationId: params.operationId,
      operationType: params.operationType,
      userId: params.userId,
      state: params.initialState ?? 'unresolved',
      title: params.title,
      description: params.description,
      availableActions: buildRecoveryActions(params.operationType, params.operationId),
      createdAt: new Date().toISOString(),
    };
    this.entries.set(id, entry);
    this.logger.log(`Recovery entry registered: ${id} for user ${params.userId}`);
    return entry;
  }

  /** Transition a recovery entry to a new state. Resolved/dismissed entries drop their actions. */
  transition(
    id: string,
    userId: string,
    dto: TransitionRecoveryStateDto,
  ): RecoveryEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new NotFoundException(`Recovery entry ${id} not found`);
    if (entry.userId !== userId) throw new ForbiddenException('Access denied');

    const terminal: RecoveryState[] = ['resolved', 'dismissed'];
    if (terminal.includes(entry.state)) {
      throw new ForbiddenException(`Entry is already ${entry.state} and cannot be transitioned further`);
    }

    const prev = entry.state;
    entry.state = dto.state;

    if (terminal.includes(dto.state)) {
      entry.availableActions = [];
      entry.resolvedAt = new Date().toISOString();
    }

    this.logger.log(`Recovery entry ${id}: ${prev} → ${dto.state}${dto.note ? ` (${dto.note})` : ''}`);
    return entry;
  }

  /** Execute a named recovery action (retry / cancel). */
  executeAction(
    entryId: string,
    actionId: string,
    userId: string,
  ): { executed: boolean; actionId: string; message: string } {
    const entry = this.entries.get(entryId);
    if (!entry) throw new NotFoundException(`Recovery entry ${entryId} not found`);
    if (entry.userId !== userId) throw new ForbiddenException('Access denied');

    const action = entry.availableActions.find(a => a.actionId === actionId);
    if (!action) throw new NotFoundException(`Action "${actionId}" not available for entry ${entryId}`);

    this.logger.log(`Recovery action "${actionId}" executed on entry ${entryId} by user ${userId}`);

    // Transition to in_progress on retry
    if (actionId === 'retry' && entry.state === 'unresolved') {
      entry.state = 'in_progress';
    }

    return { executed: true, actionId, message: `Action "${action.label}" dispatched successfully` };
  }
}
