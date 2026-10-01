import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PolicyModule } from "src/policy/policy.module";
import { PreflightController } from "./preflight.controller";
import { PreflightService } from "./preflight.service";
import {
  DefaultPreflightStateProvider,
  PREFLIGHT_STATE_PROVIDER,
} from "./preflight.state";

/**
 * Deterministic transaction simulation preflight (issue #109).
 *
 * Imports `PolicyModule` so `trade` operations reuse the existing
 * {@link PolicyService} decision instead of duplicating trading rules. The
 * state provider is bound to a token, so a deployment (or a test) can override
 * it with a DB/chain-backed snapshot source without touching the core.
 */
@Module({
  imports: [ConfigModule, PolicyModule],
  controllers: [PreflightController],
  providers: [
    PreflightService,
    {
      provide: PREFLIGHT_STATE_PROVIDER,
      useClass: DefaultPreflightStateProvider,
    },
  ],
  exports: [PreflightService, PREFLIGHT_STATE_PROVIDER],
})
export class PreflightModule {}
