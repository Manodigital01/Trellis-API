import { AuditLogService } from "./audit-log.service";

describe("AuditLogService retention", () => {
  it("reports and deletes eligible records while protecting active evidence", async () => {
    const oldDate = new Date("2010-01-01");
    const eligible = { id: "eligible", createdAt: oldDate, metadata: null };
    const protectedRecord = {
      id: "protected",
      createdAt: oldDate,
      metadata: { activeDisputeId: "dispute-1" },
    };
    const repo = {
      find: jest.fn().mockResolvedValue([eligible, protectedRecord]),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AuditLogService(repo as any, {} as any, {} as any);

    const preview = await service.previewRetention(new Date("2020-01-01"));
    expect(preview).toMatchObject({ scanned: 2, eligible: 1, protected: 1 });
    expect(preview.affectedIds).toEqual(["eligible"]);
    expect(preview.protectedIds).toEqual(["protected"]);

    const result = await service.enforceRetention();
    expect(repo.remove).toHaveBeenCalledWith([eligible]);
    expect(result.protectedIds).toEqual(["protected"]);
  });
});

describe("AuditLogService timeline", () => {
  it("should return only public logs for a specific user", async () => {
    const qbMock = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[{ id: "log-1" }], 1]),
    };

    const repo = {
      createQueryBuilder: jest.fn().mockReturnValue(qbMock),
    };

    const paginationService = {
      applyDescendingKeyset: jest.fn(),
      encode: jest.fn(),
    };

    const service = new AuditLogService(repo as any, {} as any, paginationService as any);

    const result = await service.getTimeline("user-123");

    expect(repo.createQueryBuilder).toHaveBeenCalledWith("log");
    expect(qbMock.where).toHaveBeenCalledWith("log.userId = :userId", { userId: "user-123" });
    expect(qbMock.andWhere).toHaveBeenCalledWith("log.visibility = :visibility", { visibility: "PUBLIC" });
    expect(result.total).toBe(1);
    expect(result.data).toEqual([{ id: "log-1" }]);
  });
});