import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { PauseScope } from "./entities/pause-scope.entity";
import { PauseAuditLog } from "./entities/pause-audit-log.entity";
import { PauseControlService } from "./pause-control.service";
import { PauseControlController } from "./pause-control.controller";
import { PauseControlGuard } from "./pause-control.guard";

@Module({
  imports: [TypeOrmModule.forFeature([PauseScope, PauseAuditLog])],
  controllers: [PauseControlController],
  providers: [PauseControlService, PauseControlGuard],
  exports: [PauseControlService, PauseControlGuard],
})
export class PauseControlModule {}
