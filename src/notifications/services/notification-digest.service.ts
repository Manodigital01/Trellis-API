import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Not, Repository } from 'typeorm';
import { Notification, NotificationPriority, NotificationStatus, NotificationChannel } from '../entities/notification.entity';
import { NotificationPreference, NotificationChannelPreference, NotificationDeliveryMode } from '../entities/notification-preference.entity';
import { NotificationQueueService } from './notification-queue.service';
import { DistributedLock } from "../../infrastructure/distributed-lock/distributed-lock.decorator";

@Injectable()
export class NotificationDigestService {
  private readonly logger = new Logger(NotificationDigestService.name);

  constructor(
    @InjectRepository(Notification) private readonly notificationRepo: Repository<Notification>,
    @InjectRepository(NotificationPreference) private readonly preferenceRepo: Repository<NotificationPreference>,
    private readonly queueService: NotificationQueueService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  @DistributedLock("notifications:dispatch-digests", 10 * 60_000)
  async dispatchDueDigests(): Promise<number> {
    const now = new Date();
    const routine = await this.notificationRepo.find({
      where: {
        status: NotificationStatus.SCHEDULED,
        priority: Not(NotificationPriority.CRITICAL),
        createdAt: MoreThan(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)),
      },
      order: { createdAt: 'ASC' },
      take: 500,
    });
    const byUser = new Map<string, Notification[]>();
    for (const notification of routine) {
      if (notification.metadata?.isDigest) continue;
      const list = byUser.get(notification.userId) ?? [];
      list.push(notification);
      byUser.set(notification.userId, list);
    }
    let created = 0;
    for (const [userId, notifications] of byUser) {
      const prefs = await this.preferenceRepo.find({ where: { userId, active: true } });
      const digestPref = prefs.find((p) =>
        p.deliveryMode === NotificationDeliveryMode.DAILY_DIGEST ||
        p.deliveryMode === NotificationDeliveryMode.WEEKLY_SUMMARY ||
        p.preference === NotificationChannelPreference.DIGEST,
      );
      if (!digestPref || notifications.length === 0) continue;
      const digest = await this.notificationRepo.save(this.notificationRepo.create({
        userId,
        title: `${notifications.length} notification${notifications.length === 1 ? '' : 's'} summary`,
        body: notifications.map((n) => `• ${n.title}: ${n.body}`).join('\n'),
        category: notifications[0].category,
        priority: NotificationPriority.NORMAL,
        primaryChannel: (digestPref.channel as NotificationChannel) || NotificationChannel.EMAIL,
        channels: [(digestPref.channel as NotificationChannel) || NotificationChannel.EMAIL],
        status: NotificationStatus.QUEUED,
        metadata: { isDigest: true, notificationIds: notifications.map((n) => n.id) },
      }));
      await this.notificationRepo.update(notifications.map((n) => n.id), { status: NotificationStatus.CANCELLED });
      await this.queueService.enqueueNotification(digest.id);
      created++;
    }
    if (created) this.logger.log(`Dispatched ${created} notification digests`);
    return created;
  }
}
