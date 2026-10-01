import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "./entities/user.entity";
import { UserService } from "./user.service";
import { UserController } from "./user.controller";
import { AdminRoleController } from "./admin-role.controller";
import { RoleSeederService } from "./role-seeder.service";
import { AuthModule } from "src/core/auth/auth.module";
import { AdminTwoFactorGuard } from "src/core/auth/guards/admin-two-factor.guard";
import { SensitiveActionAuditModule } from "src/infrastructure/audit/sensitive-actions/sensitive-action-audit.module";

@Module({
  imports: [TypeOrmModule.forFeature([User]), AuthModule, SensitiveActionAuditModule],
  controllers: [UserController, AdminRoleController],
  providers: [UserService, RoleSeederService, AdminTwoFactorGuard],
  exports: [UserService, TypeOrmModule],
})
export class UserModule {}
