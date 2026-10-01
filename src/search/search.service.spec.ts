import { SearchService } from "./search.service";
import {
  SearchRecord,
  SearchVisibility,
} from "./entities/search-record.entity";

const record = (overrides: Partial<SearchRecord> = {}): SearchRecord =>
  ({
    id: "record-1",
    ownerId: "owner-1",
    title: "Private title",
    content: "Searchable body",
    visibility: SearchVisibility.PRIVATE,
    revokedAt: null,
    deletedAt: null,
    ...overrides,
  }) as SearchRecord;

const makeService = (
  records: Record<string, jest.Mock>,
  es: Record<string, jest.Mock>,
) => new SearchService(es as any, records as any);

describe("SearchService", () => {
  it("indexes only the declared fields with server-owned visibility metadata", async () => {
    const saved = record({ visibility: SearchVisibility.PUBLIC });
    const records = {
      create: jest.fn().mockReturnValue(saved),
      save: jest.fn().mockResolvedValue(saved),
    };
    const es = { index: jest.fn().mockResolvedValue(undefined) };
    const service = makeService(records, es);

    await service.indexPost(
      { title: saved.title, content: saved.content },
      saved.ownerId,
    );

    expect(es.index).toHaveBeenCalledWith({
      index: "posts",
      id: saved.id,
      document: {
        title: saved.title,
        content: saved.content,
        ownerId: saved.ownerId,
        visibility: SearchVisibility.PRIVATE,
        isActive: true,
      },
    });
  });

  it("rechecks owner and public visibility in the source of truth after Elasticsearch returns hits", async () => {
    const visible = record({
      id: "public-1",
      visibility: SearchVisibility.PUBLIC,
    });
    const queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([visible]),
    };
    const records = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    const es = {
      search: jest.fn().mockResolvedValue({
        hits: { hits: [{ _id: "private-stale" }, { _id: "public-1" }] },
      }),
    };
    const service = makeService(records, es);

    await expect(service.search("query", "owner-7")).resolves.toEqual([
      { id: visible.id, title: visible.title, content: visible.content },
    ]);
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      "(record.ownerId = :ownerId OR record.visibility = :public)",
      { ownerId: "owner-7", public: SearchVisibility.PUBLIC },
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      "record.revokedAt IS NULL",
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      "record.deletedAt IS NULL",
    );
  });

  it("deletes revoked and deleted rows from the index during a full repair", async () => {
    const active = record({ id: "active" });
    const records = {
      find: jest
        .fn()
        .mockResolvedValue([
          active,
          record({ id: "revoked", revokedAt: new Date() }),
          record({ id: "deleted", deletedAt: new Date() }),
        ]),
    };
    const es = {
      deleteByQuery: jest.fn().mockResolvedValue({ deleted: 3 }),
      index: jest.fn().mockResolvedValue(undefined),
    };
    const service = makeService(records, es);

    await expect(service.repairIndex()).resolves.toEqual({
      indexed: 1,
      removed: 3,
    });
    expect(es.deleteByQuery).toHaveBeenCalledWith({
      index: "posts",
      query: { match_all: {} },
    });
    expect(es.index).toHaveBeenCalledTimes(1);
    expect(es.index.mock.calls[0][0].id).toBe("active");
  });
});
