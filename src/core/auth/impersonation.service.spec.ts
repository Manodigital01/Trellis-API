import { Test, TestingModule } from '@nestjs/testing';
import { ImpersonationService } from './impersonation.service';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { User } from '../user/entities/user.entity';
import { AuditLogService } from '../../infrastructure/audit/audit-log.service';
import { Role } from '../../common/guard/roles.enum';
import { UnauthorizedException, ForbiddenException, NotFoundException } from '@nestjs/common';

describe('ImpersonationService', () => {
  let service: ImpersonationService;
  let jwtService: jest.Mocked<JwtService>;
  let auditLogService: jest.Mocked<AuditLogService>;
  let mockUserRepository: any;

  beforeEach(async () => {
    mockUserRepository = {
      findOne: jest.fn(),
    };
    jwtService = {
      sign: jest.fn(),
    } as any;
    auditLogService = {
      record: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        {
          provide: getRepositoryToken(User),
          useValue: mockUserRepository,
        },
        {
          provide: JwtService,
          useValue: jwtService,
        },
        {
          provide: AuditLogService,
          useValue: auditLogService,
        },
      ],
    }).compile();

    service = module.get<ImpersonationService>(ImpersonationService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('startImpersonation', () => {
    it('should throw UnauthorizedException if admin not found', async () => {
      mockUserRepository.findOne.mockResolvedValueOnce(null);
      await expect(
        service.startImpersonation('admin1', 'target1', '127.0.0.1')
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw ForbiddenException if user is not admin', async () => {
      mockUserRepository.findOne.mockResolvedValueOnce({ role: Role.USER });
      await expect(
        service.startImpersonation('admin1', 'target1', '127.0.0.1')
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException if target not found', async () => {
      mockUserRepository.findOne.mockResolvedValueOnce({ id: 'admin1', role: Role.ADMIN });
      mockUserRepository.findOne.mockResolvedValueOnce(null);
      await expect(
        service.startImpersonation('admin1', 'target1', '127.0.0.1')
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException if target is admin', async () => {
      mockUserRepository.findOne.mockResolvedValueOnce({ id: 'admin1', role: Role.ADMIN });
      mockUserRepository.findOne.mockResolvedValueOnce({ id: 'target1', role: Role.ADMIN });
      await expect(
        service.startImpersonation('admin1', 'target1', '127.0.0.1')
      ).rejects.toThrow(ForbiddenException);
    });

    it('should start impersonation successfully', async () => {
      const admin = { id: 'admin1', email: 'admin@t.com', role: Role.ADMIN };
      const target = { id: 'target1', email: 'target@t.com', username: 'target', role: Role.USER };
      
      mockUserRepository.findOne.mockResolvedValueOnce(admin);
      mockUserRepository.findOne.mockResolvedValueOnce(target);
      jwtService.sign.mockReturnValue('test-token');

      const result = await service.startImpersonation('admin1', 'target1', '127.0.0.1');

      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: target.id,
          impersonatorId: admin.id,
        }),
        { expiresIn: '1h' }
      );
      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'IMPERSONATION_STARTED',
          resourceId: target.id,
        })
      );
      expect(result.accessToken).toBe('test-token');
      expect(result.user.isImpersonated).toBe(true);
    });
  });
});
