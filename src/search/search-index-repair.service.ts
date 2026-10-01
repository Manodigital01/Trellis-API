import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { SearchService } from "./search.service";
import { DistributedLock } from "../infrastructure/distributed-lock/distributed-lock.decorator";

@Injectable()
export class SearchIndexRepairService {
  private readonly logger = new Logger(SearchIndexRepairService.name);

  constructor(private readonly searchService: SearchService) {}

  @Cron(CronExpression.EVERY_HOUR)
  @DistributedLock("search:index-repair", 10 * 60_000)
  async repair(): Promise<void> {
    try {
      const result = await this.searchService.repairIndex();
      this.logger.log(
        `Search index repaired: ${result.indexed} indexed, ${result.removed} stale entries removed`,
      );
    } catch (error) {
      this.logger.error(
        "Search index repair failed",
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
