import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationService } from './notification.service';
import {
  CriticalLifecycleEvent,
  LifecycleEventType,
  LifecycleEventPayload,
} from '../events/lifecycle-events';
import {
  NotificationChannel,
  NotificationPriority,
  NotificationCategory,
} from '../entities/notification.entity';

@Injectable()
export class LifecycleNotificationListener {
  private readonly logger = new Logger(LifecycleNotificationListener.name);

  constructor(private readonly notificationService: NotificationService) {}

  @OnEvent('lifecycle.*', { async: true })
  async handleLifecycleEvent(event: LifecycleEventPayload): Promise<void> {
    if (!event.userId) {
      this.logger.warn(
        `Lifecycle event "${event.eventType}" dropped: missing recipient userId`,
      );
      return;
    }

    this.logger.log(
      `Processing lifecycle event "${event.eventType}" for user "${event.userId}" [dedupKey=${event.deduplicationKey}]`,
    );

    try {
      await this.notificationService.send({
        userId: event.userId,
        title: event.title,
        body: event.message,
        deepLink: event.deepLink,
        deduplicationKey: event.deduplicationKey,
        priority: event.priority || NotificationPriority.HIGH,
        category: event.category || this.mapCategoryFromEventType(event.eventType),
        primaryChannel: NotificationChannel.IN_APP,
        channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
        referenceId: event.referenceId,
        referenceType: event.referenceType || 'lifecycle_event',
        metadata: {
          eventType: event.eventType,
          timestamp: event.timestamp || new Date(),
          ...event.metadata,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to handle lifecycle event "${event.eventType}" for user "${event.userId}": ${error.message}`,
        error.stack,
      );
    }
  }

  private mapCategoryFromEventType(eventType: LifecycleEventType): NotificationCategory {
    switch (eventType) {
      case LifecycleEventType.SECURITY_LOCKOUT:
        return NotificationCategory.SECURITY;
      case LifecycleEventType.PORTFOLIO_CRITICAL_DRAWDOWN:
      case LifecycleEventType.PORTFOLIO_REBALANCE_FAILED:
        return NotificationCategory.PORTFOLIO;
      case LifecycleEventType.SETTLEMENT_FAILED:
      case LifecycleEventType.SETTLEMENT_RECOVERED:
        return NotificationCategory.TRANSACTION;
      case LifecycleEventType.CIRCUIT_BREAKER_TRIPPED:
      case LifecycleEventType.CIRCUIT_BREAKER_RESET:
      case LifecycleEventType.DISASTER_RECOVERY_ANOMALY:
      case LifecycleEventType.APPROVAL_REQUIRED:
      case LifecycleEventType.ACTION_COMPLETED:
      default:
        return NotificationCategory.SYSTEM;
    }
  }
}
