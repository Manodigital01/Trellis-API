import { Test, TestingModule } from '@nestjs/testing';
import { LifecycleNotificationListener } from '../services/lifecycle-notification.listener';
import { NotificationService } from '../services/notification.service';
import {
  LifecycleEventType,
  CriticalLifecycleEvent,
} from '../events/lifecycle-events';
import {
  NotificationCategory,
  NotificationPriority,
  NotificationChannel,
} from '../entities/notification.entity';

describe('LifecycleNotificationListener', () => {
  let listener: LifecycleNotificationListener;
  let notificationService: jest.Mocked<NotificationService>;

  beforeEach(async () => {
    const mockNotificationService = {
      send: jest.fn().mockResolvedValue({
        id: 'notif-123',
        userId: 'user-abc',
        title: 'Circuit Breaker Tripped',
        body: 'Alert',
        read: false,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LifecycleNotificationListener,
        {
          provide: NotificationService,
          useValue: mockNotificationService,
        },
      ],
    }).compile();

    listener = module.get<LifecycleNotificationListener>(
      LifecycleNotificationListener,
    );
    notificationService = module.get(NotificationService);
  });

  it('should be defined', () => {
    expect(listener).toBeDefined();
  });

  describe('handleLifecycleEvent', () => {
    it('should process circuit breaker tripped event with targeting, deep links, and deduplicationKey', async () => {
      const event = new CriticalLifecycleEvent({
        userId: 'user-target-1',
        eventType: LifecycleEventType.CIRCUIT_BREAKER_TRIPPED,
        title: 'Circuit Breaker Tripped: High Volatility',
        message: 'Trading paused for Portfolio #42 due to a 15% drop in 1 hour.',
        deepLink: '/portfolios/42/circuit-breaker',
        deduplicationKey: 'circuit-breaker-42-2026-09-26',
        priority: NotificationPriority.CRITICAL,
        category: NotificationCategory.SYSTEM,
        referenceId: 'port-42',
        referenceType: 'portfolio',
      });

      await listener.handleLifecycleEvent(event);

      expect(notificationService.send).toHaveBeenCalledTimes(1);
      expect(notificationService.send).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-target-1',
          title: 'Circuit Breaker Tripped: High Volatility',
          body: 'Trading paused for Portfolio #42 due to a 15% drop in 1 hour.',
          deepLink: '/portfolios/42/circuit-breaker',
          deduplicationKey: 'circuit-breaker-42-2026-09-26',
          priority: NotificationPriority.CRITICAL,
          category: NotificationCategory.SYSTEM,
          referenceId: 'port-42',
          referenceType: 'portfolio',
        }),
      );
    });

    it('should drop event if recipient userId is missing (prevent data leakage)', async () => {
      const event = {
        userId: '',
        eventType: LifecycleEventType.SECURITY_LOCKOUT,
        title: 'Unauthorized Access',
        message: 'Multiple failed attempts',
        deepLink: '/security/audit',
        deduplicationKey: 'lockout-anon-1',
      };

      await listener.handleLifecycleEvent(event as any);

      expect(notificationService.send).not.toHaveBeenCalled();
    });

    it('should correctly map categories based on lifecycle event type', async () => {
      const securityEvent = new CriticalLifecycleEvent({
        userId: 'user-target-2',
        eventType: LifecycleEventType.SECURITY_LOCKOUT,
        title: 'Account Locked Out',
        message: 'Your account was locked out due to 5 consecutive failed 2FA attempts.',
        deepLink: '/auth/recover',
        deduplicationKey: 'lockout-user-target-2',
      });

      await listener.handleLifecycleEvent(securityEvent);

      expect(notificationService.send).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-target-2',
          category: NotificationCategory.SECURITY,
          deepLink: '/auth/recover',
          deduplicationKey: 'lockout-user-target-2',
        }),
      );
    });

    it('should handle settlement failed recovery events', async () => {
      const settlementEvent = new CriticalLifecycleEvent({
        userId: 'user-target-3',
        eventType: LifecycleEventType.SETTLEMENT_FAILED,
        title: 'Stellar Settlement Failed',
        message: 'Invoice inv-8899 could not be matched with on-chain ledger.',
        deepLink: '/reconciliation/invoices/inv-8899',
        deduplicationKey: 'settlement-failed-inv-8899',
      });

      await listener.handleLifecycleEvent(settlementEvent);

      expect(notificationService.send).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-target-3',
          category: NotificationCategory.TRANSACTION,
          deepLink: '/reconciliation/invoices/inv-8899',
          deduplicationKey: 'settlement-failed-inv-8899',
        }),
      );
    });
  });
});
