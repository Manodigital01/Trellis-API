import {
  NotificationCategory,
  NotificationPriority,
} from '../entities/notification.entity';

export enum LifecycleEventType {
  CIRCUIT_BREAKER_TRIPPED = 'lifecycle.circuit_breaker.tripped',
  CIRCUIT_BREAKER_RESET = 'lifecycle.circuit_breaker.reset',
  SETTLEMENT_FAILED = 'lifecycle.settlement.failed',
  SETTLEMENT_RECOVERED = 'lifecycle.settlement.recovered',
  DISASTER_RECOVERY_ANOMALY = 'lifecycle.dr.anomaly_detected',
  PORTFOLIO_CRITICAL_DRAWDOWN = 'lifecycle.portfolio.critical_drawdown',
  PORTFOLIO_REBALANCE_FAILED = 'lifecycle.portfolio.rebalance_failed',
  SECURITY_LOCKOUT = 'lifecycle.security.lockout',
  APPROVAL_REQUIRED = 'lifecycle.workflow.approval_required',
  ACTION_COMPLETED = 'lifecycle.workflow.action_completed',
}

export interface LifecycleEventPayload {
  userId: string;
  eventType: LifecycleEventType;
  title: string;
  message: string;
  deepLink: string;
  deduplicationKey: string;
  priority?: NotificationPriority;
  category?: NotificationCategory;
  referenceId?: string;
  referenceType?: string;
  metadata?: Record<string, any>;
  timestamp?: Date;
}

export class CriticalLifecycleEvent implements LifecycleEventPayload {
  userId: string;
  eventType: LifecycleEventType;
  title: string;
  message: string;
  deepLink: string;
  deduplicationKey: string;
  priority?: NotificationPriority;
  category?: NotificationCategory;
  referenceId?: string;
  referenceType?: string;
  metadata?: Record<string, any>;
  timestamp: Date;

  constructor(payload: LifecycleEventPayload) {
    this.userId = payload.userId;
    this.eventType = payload.eventType;
    this.title = payload.title;
    this.message = payload.message;
    this.deepLink = payload.deepLink;
    this.deduplicationKey = payload.deduplicationKey;
    this.priority = payload.priority ?? NotificationPriority.HIGH;
    this.category = payload.category;
    this.referenceId = payload.referenceId;
    this.referenceType = payload.referenceType;
    this.metadata = payload.metadata;
    this.timestamp = payload.timestamp ?? new Date();
  }
}
