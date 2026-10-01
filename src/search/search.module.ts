import { Module } from "@nestjs/common";
import { ElasticsearchModule } from "@nestjs/elasticsearch";
import { ScheduleModule } from "@nestjs/schedule";
import { TypeOrmModule } from "@nestjs/typeorm";
import { PortfolioAsset } from "../investment/portfolio/entities/portfolio-asset.entity";
import { SearchRecord } from "./entities/search-record.entity";
import { AssetSearchService } from "./asset-search.service";
import { SearchService } from "./search.service";
import { SearchController } from "./search.controller";
import { SearchIndexRepairService } from "./search-index-repair.service";

@Module({
  imports: [
    ElasticsearchModule.register({
      node: "http://localhost:9200",
    }),
    ScheduleModule.forRoot(),
    // Asset lookup reads the portfolio_assets table directly: the trigram /
    // edit-distance ranking has to happen in PostgreSQL to use the GIN indexes.
    TypeOrmModule.forFeature([PortfolioAsset, SearchRecord]),
  ],
  providers: [SearchService, SearchIndexRepairService, AssetSearchService],
  controllers: [SearchController],
})
export class SearchModule {}
