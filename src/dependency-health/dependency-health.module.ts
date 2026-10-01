import { Module } from "@nestjs/common";
import { DependencyHealthController } from "./dependency-health.controller";
import { DependencyHealthService } from "./dependency-health.service";
import { AuthModule } from "../core/auth/auth.module";
import { HealthModule } from "../health/health.module";

/**
 * Dependency health checks for the external services, networks and
 * configuration assumptions Trellis relies on.
 *
 * Issue: #124
 */
@Module({
  imports: [AuthModule, HealthModule],
  controllers: [DependencyHealthController],
  providers: [DependencyHealthService],
  exports: [DependencyHealthService],
})
export class DependencyHealthModule {}
