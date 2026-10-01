import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { RetryOperation } from "./entities/retry-operation.entity";
import { RetrySchedulerService } from "./retry-scheduler.service";
import { RetrySchedulerController } from "./retry-scheduler.controller";

@Module({
  imports: [TypeOrmModule.forFeature([RetryOperation])],
  controllers: [RetrySchedulerController],
  providers: [RetrySchedulerService],
  exports: [RetrySchedulerService],
})
export class RetrySchedulerModule {}
