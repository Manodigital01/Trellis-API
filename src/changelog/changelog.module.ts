import { Module } from "@nestjs/common";
import { ChangelogController } from "./changelog.controller";
import { ProtocolChangelogService } from "./protocol-changelog.service";

/**
 * Serves the machine-readable protocol changelog.
 *
 * Issue: #126
 */
@Module({
  controllers: [ChangelogController],
  providers: [ProtocolChangelogService],
  exports: [ProtocolChangelogService],
})
export class ChangelogModule {}
