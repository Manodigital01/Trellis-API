import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { getQueueToken } from "@nestjs/bull";
import { EmailService } from "./email.service";
import { AuthEmailProcessor } from "./email-processor.service";
import { Job } from "bull";

describe("EmailService (core/auth)", () => {
  let service: EmailService;
  let processor: AuthEmailProcessor;
  let mockQueue: any;
  let mockConfigService: any;

  beforeEach(async () => {
    mockQueue = {
      add: jest.fn().mockResolvedValue({ id: "job-123" }),
    };

    mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          EMAIL_VERIFICATION_URL: "http://example.com/verify",
          EMAIL_FROM: "no-reply@example.com",
          SMTP_HOST: "localhost",
          SMTP_PORT: 587,
        };
        return config[key] !== undefined ? config[key] : defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        AuthEmailProcessor,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: getQueueToken("auth-email"), useValue: mockQueue },
      ],
    }).compile();

    service = module.get<EmailService>(EmailService);
    processor = module.get<AuthEmailProcessor>(AuthEmailProcessor);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
    expect(processor).toBeDefined();
  });

  describe("queue integration & exponential backoff", () => {
    it("should queue verification email with exponential backoff strategy", async () => {
      const result = await service.sendVerificationEmail("user@example.com", "token-xyz");

      expect(result.messageId).toBe("job-123");
      expect(mockQueue.add).toHaveBeenCalledWith(
        "send-email",
        expect.objectContaining({
          to: "user@example.com",
          subject: "Verify your email address - trellis",
        }),
        expect.objectContaining({
          attempts: 4,
          backoff: expect.objectContaining({
            type: "exponential",
            delay: 60000,
          }),
        }),
      );
    });

    it("should queue recovery email successfully without throwing HTTP exceptions", async () => {
      const result = await service.sendRecoveryEmail("user@example.com", "0x1234567890abcdef");
      expect(result.messageId).toBe("job-123");
      expect(mockQueue.add).toHaveBeenCalledWith(
        "send-email",
        expect.objectContaining({
          to: "user@example.com",
          subject: "Account Recovery Information - trellis",
        }),
        expect.any(Object),
      );
    });

    it("should queue 2FA notification email successfully", async () => {
      const result = await service.send2faChangeNotification("user@example.com", "enabled");
      expect(result.messageId).toBe("job-123");
      expect(mockQueue.add).toHaveBeenCalledWith(
        "send-email",
        expect.objectContaining({
          to: "user@example.com",
        }),
        expect.any(Object),
      );
    });
  });

  describe("DLQ logging on permanent job failure", () => {
    it("should route to DLQ with detailed error logs when max retries are exceeded", async () => {
      const error = new Error("SMTP connection timeout");
      const mockJob: Partial<Job> = {
        id: "job-123",
        data: {
          to: "user@example.com",
          subject: "Test Email",
          html: "<p>Test</p>",
        },
        attemptsMade: 4,
        opts: { attempts: 4 },
        failedReason: "SMTP connection timeout",
      };

      const loggerErrorSpy = jest.spyOn((processor as any).logger, "error");
      processor.handleFailedJob(mockJob as Job, error);

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[DLQ] Email job job-123 to user@example.com failed permanently after 4 attempts"),
        expect.any(String),
      );
    });

    it("should log retry warning when job fails before reaching max attempts", async () => {
      const error = new Error("Transient network blip");
      const mockJob: Partial<Job> = {
        id: "job-456",
        data: {
          to: "user@example.com",
          subject: "Test Email",
          html: "<p>Test</p>",
        },
        attemptsMade: 1,
        opts: { attempts: 4 },
      };

      const loggerWarnSpy = jest.spyOn((processor as any).logger, "warn");
      processor.handleFailedJob(mockJob as Job, error);

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Email job job-456 to user@example.com failed attempt 1/4. Will retry."),
      );
    });
  });

  describe("processor execution", () => {
    it("should delegate execution to emailService.executeSendMail", async () => {
      const executeSpy = jest
        .spyOn(service, "executeSendMail")
        .mockResolvedValue({ messageId: "msg-999" });

      const mockJob: Partial<Job> = {
        id: "job-123",
        data: {
          to: "user@example.com",
          subject: "Test Email",
          html: "<p>Test</p>",
        },
      };

      const res = await processor.handleSendEmail(mockJob as Job);
      expect(executeSpy).toHaveBeenCalledWith(mockJob.data);
      expect(res).toEqual({ messageId: "msg-999" });
    });
  });
});
