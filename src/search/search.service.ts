import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ElasticsearchService } from "@nestjs/elasticsearch";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { IndexSearchRecordDto } from "./dto/index-search-record.dto";
import {
  SearchRecord,
  SearchVisibility,
} from "./entities/search-record.entity";

@Injectable()
export class SearchService {
  constructor(
    private readonly esService: ElasticsearchService,
    @InjectRepository(SearchRecord)
    private readonly records: Repository<SearchRecord>,
  ) {}

  async indexPost(
    input: IndexSearchRecordDto,
    ownerId: string,
  ): Promise<SearchRecord> {
    let record: SearchRecord;
    if (input.id) {
      const existing = await this.records.findOne({
        where: { id: input.id },
        withDeleted: true,
      });
      if (existing && existing.ownerId !== ownerId) {
        throw new ForbiddenException("Search record belongs to another user");
      }
      if (existing?.deletedAt) {
        throw new NotFoundException("Search record not found");
      }
      record = existing ?? this.records.create({ id: input.id, ownerId });
    } else {
      record = this.records.create({ ownerId });
    }

    record.title = input.title;
    record.content = input.content;
    record.visibility = input.visibility ?? SearchVisibility.PRIVATE;
    record.revokedAt = null;
    const saved = await this.records.save(record);

    await this.writeToIndex(saved);
    return saved;
  }

  async deletePost(id: string, ownerId: string): Promise<void> {
    const record = await this.findOwnedRecord(id, ownerId);
    await this.records.softRemove(record);
    await this.deleteFromIndex(id);
  }

  async revokePost(id: string, ownerId: string): Promise<void> {
    const record = await this.findOwnedRecord(id, ownerId);
    record.revokedAt = new Date();
    await this.records.save(record);
    await this.deleteFromIndex(id);
  }

  async search(
    query: string,
    ownerId: string,
  ): Promise<Array<Pick<SearchRecord, "id" | "title" | "content">>> {
    const result = await this.esService.search({
      index: "posts",
      query: {
        bool: {
          must: [{ multi_match: { query, fields: ["title", "content"] } }],
          filter: [
            { term: { isActive: true } },
            {
              bool: {
                should: [
                  { term: { "ownerId.keyword": ownerId } },
                  { term: { "visibility.keyword": SearchVisibility.PUBLIC } },
                ],
                minimum_should_match: 1,
              },
            },
          ],
        },
      },
    });

    const hits = result.hits.hits;
    const ids = hits.map((hit) => hit._id).filter((id): id is string => !!id);
    if (!ids.length) return [];

    const records = await this.records
      .createQueryBuilder("record")
      .where("record.id IN (:...ids)", { ids })
      .andWhere("record.deletedAt IS NULL")
      .andWhere("record.revokedAt IS NULL")
      .andWhere("(record.ownerId = :ownerId OR record.visibility = :public)", {
        ownerId,
        public: SearchVisibility.PUBLIC,
      })
      .getMany();
    const recordsById = new Map(records.map((record) => [record.id, record]));
    return ids
      .map((id) => recordsById.get(id))
      .filter((record): record is SearchRecord => !!record)
      .map(({ id, title, content }) => ({ id, title, content }));
  }

  async repairIndex(): Promise<{ indexed: number; removed: number }> {
    const records = await this.records.find({ withDeleted: true });
    const activeRecords = records.filter(
      (record) => !record.deletedAt && !record.revokedAt,
    );
    let removed = 0;

    try {
      const response = await this.esService.deleteByQuery({
        index: "posts",
        query: { match_all: {} },
      });
      removed = response.deleted ?? 0;
    } catch (error) {
      if (!this.isMissingIndex(error)) throw error;
    }

    for (const record of activeRecords) {
      await this.writeToIndex(record);
    }

    return { indexed: activeRecords.length, removed };
  }

  private async findOwnedRecord(
    id: string,
    ownerId: string,
  ): Promise<SearchRecord> {
    const record = await this.records.findOne({ where: { id, ownerId } });
    if (!record) throw new NotFoundException("Search record not found");
    return record;
  }

  private async writeToIndex(record: SearchRecord): Promise<void> {
    await this.esService.index({
      index: "posts",
      id: record.id,
      document: {
        title: record.title,
        content: record.content,
        ownerId: record.ownerId,
        visibility: record.visibility,
        isActive: true,
      },
    });
  }

  private async deleteFromIndex(id: string): Promise<void> {
    try {
      await this.esService.delete({ index: "posts", id });
    } catch (error) {
      if ((error as { statusCode?: number })?.statusCode !== 404) throw error;
    }
  }

  private isMissingIndex(error: unknown): boolean {
    const candidate = error as {
      statusCode?: number;
      meta?: { body?: { error?: { type?: string } } };
    };
    return (
      candidate?.statusCode === 404 ||
      candidate?.meta?.body?.error?.type === "index_not_found_exception"
    );
  }
}
