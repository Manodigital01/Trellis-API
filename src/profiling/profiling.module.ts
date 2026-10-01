import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ProfilingService } from "./profiling.service";
import { ProfilingController } from "./profiling.controller";

@Module({
  imports: [ConfigModule],
  providers: [ProfilingService],
  controllers: [ProfilingController],
  exports: [ProfilingService],
})
export class ProfilingModule {}
