import { Process, Processor } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import { Job } from "bull";
import { EmailQueueService, EmailJobData } from "./email-queue.service";
import { TraceAsyncJob } from "src/observability/async-job-tracing";

@Processor("email")
export class EmailProcessor {
  private readonly logger = new Logger(EmailProcessor.name);
  constructor(private readonly queueService: EmailQueueService) {}

  @Process("send-email")
  @TraceAsyncJob("email.send")
  async handleSendEmail(job: Job<EmailJobData>) {
    this.logger.log(`Processing email job ${job.id}`);
    return this.queueService.processEmail(job);
  }
}
