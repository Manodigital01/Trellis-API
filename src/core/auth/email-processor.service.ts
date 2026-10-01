import { Process, Processor, OnQueueFailed } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import { Job } from "bull";
import { EmailService, EmailJobOptions } from "./email.service";

@Processor("auth-email")
export class AuthEmailProcessor {
  private readonly logger = new Logger(AuthEmailProcessor.name);

  constructor(private readonly emailService: EmailService) {}

  @Process("send-email")
  async handleSendEmail(job: Job<EmailJobOptions>) {
    this.logger.log(`Processing email job ${job.id} to ${job.data.to}`);
    return this.emailService.executeSendMail(job.data);
  }

  @OnQueueFailed()
  handleFailedJob(job: Job<EmailJobOptions>, error: Error) {
    const attempts = job.attemptsMade;
    const maxAttempts = job.opts.attempts || 4;

    if (attempts >= maxAttempts) {
      this.logger.error(
        `[DLQ] Email job ${job.id} to ${job.data.to} failed permanently after ${attempts} attempts. Subject: "${job.data.subject}". Error: ${error.message}`,
        error.stack,
      );
    } else {
      this.logger.warn(
        `Email job ${job.id} to ${job.data.to} failed attempt ${attempts}/${maxAttempts}. Will retry. Error: ${error.message}`,
      );
    }
  }
}
