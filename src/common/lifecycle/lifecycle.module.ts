import { Module, Global } from "@nestjs/common";
import { LifecycleService } from "./lifecycle.service";
import { AuditModule } from "src/infrastructure/audit/audit.module";

@Global()
@Module({
  imports: [AuditModule],
  providers: [LifecycleService],
  exports: [LifecycleService],
})
export class LifecycleModule {}
