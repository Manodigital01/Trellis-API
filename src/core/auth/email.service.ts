import { Injectable, Logger, Optional, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bull";
import { Queue } from "bull";
import * as nodemailer from "nodemailer";
import { Transporter } from "nodemailer";

export interface EmailJobOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
}

export const AUTH_EMAIL_RETRY_DELAYS = [60000, 300000, 900000]; // 1m, 5m, 15m

@Injectable()
export class EmailService {
  private transporter: Transporter;
  private readonly logger = new Logger(EmailService.name);

  constructor(
    private readonly configService: ConfigService,
    @Optional() @InjectQueue("auth-email") private readonly emailQueue?: Queue<EmailJobOptions>,
  ) {
    this.initializeTransporter();
  }

  private async initializeTransporter() {
    const smtpUser = this.configService.get<string | undefined>("SMTP_USER");
    const smtpPassword = this.configService.get<string | undefined>(
      "SMTP_PASSWORD",
    );

    if (smtpUser && smtpPassword) {
      this.transporter = nodemailer.createTransport({
        host: this.configService.get("SMTP_HOST") || "smtp.ethereal.email",
        port: this.configService.get("SMTP_PORT") || 587,
        secure: this.configService.get("SMTP_SECURE") || false,
        auth: {
          user: smtpUser,
          pass: smtpPassword,
        },
      });
      this.logger.log("Email service initialized with configured SMTP");
    } else {
      const testAccount = await nodemailer.createTestAccount();
      this.transporter = nodemailer.createTransport({
        host: "smtp.ethereal.email",
        port: 587,
        secure: false,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass,
        },
      });
      this.logger.log(
        `Email service initialized with Ethereal test account: ${testAccount.user}`,
      );
    }
  }

  async sendVerificationEmail(
    email: string,
    token: string,
  ): Promise<{ messageId: string; previewUrl?: string }> {
    const verificationUrl = `${this.configService.get("EMAIL_VERIFICATION_URL") as string}?token=${token}`;

    const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
              .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
              .button { display: inline-block; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
              .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
              .code { background: #fff; padding: 15px; border-left: 4px solid #667eea; margin: 20px 0; font-family: monospace; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>🔐 Verify Your Email</h1>
              </div>
              <div class="content">
                <p>Hello!</p>
                <p>You've requested to link this email address to your Trellis wallet account.</p>
                <p>Click the button below to verify your email address:</p>
                <p style="text-align: center;">
                  <a href="${verificationUrl}" class="button">Verify Email Address</a>
                </p>
                <p>Or copy and paste this link into your browser:</p>
                <div class="code">${verificationUrl}</div>
                <p><strong>This link will expire in 15 minutes.</strong></p>
                <p>If you didn't request this verification, you can safely ignore this email.</p>
              </div>
              <div class="footer">
                <p>© ${new Date().getFullYear()} trellis. All rights reserved.</p>
              </div>
            </div>
          </body>
        </html>
      `;

    const text = `
        Verify Your Email - trellis
        
        You've requested to link this email address to your Trellis wallet account.
        
        Click the link below to verify your email address:
        ${verificationUrl}
        
        This link will expire in 15 minutes.
        
        If you didn't request this verification, you can safely ignore this email.
      `;

    return this.sendMail({
      from: this.configService.get("EMAIL_FROM") as string,
      to: email,
      subject: "Verify your email address - trellis",
      html,
      text,
    });
  }

  async sendRecoveryEmail(
    email: string,
    walletAddress: string,
  ): Promise<{ messageId: string; previewUrl?: string }> {
    const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
              .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
              .wallet { background: #fff; padding: 15px; border-left: 4px solid #f5576c; margin: 20px 0; font-family: monospace; word-break: break-all; }
              .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
              .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>🔑 Account Recovery</h1>
              </div>
              <div class="content">
                <p>Hello!</p>
                <p>You've requested account recovery information for your Trellis account.</p>
                <p>Your linked wallet address is:</p>
                <div class="wallet">${walletAddress}</div>
                <div class="warning">
                  <strong>⚠️ Important Security Information:</strong>
                  <ul>
                    <li>Your wallet is your primary identity</li>
                    <li>To access your account, you need your wallet's private key or seed phrase</li>
                    <li>We never store your private keys</li>
                    <li>Email is only for account recovery assistance</li>
                  </ul>
                </div>
                <p>To regain access to your account:</p>
                <ol>
                  <li>Use your wallet application (MetaMask, WalletConnect, etc.)</li>
                  <li>Import your wallet using your seed phrase or private key</li>
                  <li>Connect to Trellis with the wallet address shown above</li>
                </ol>
                <p>If you didn't request this information, please secure your email account immediately.</p>
              </div>
              <div class="footer">
                <p>© ${new Date().getFullYear()} trellis. All rights reserved.</p>
              </div>
            </div>
          </body>
        </html>
      `;

    const text = `
        Account Recovery - trellis
        
        You've requested account recovery information for your Trellis account.
        
        Your linked wallet address is:
        ${walletAddress}
        
        IMPORTANT SECURITY INFORMATION:
        - Your wallet is your primary identity
        - To access your account, you need your wallet's private key or seed phrase
        - We never store your private keys
        - Email is only for account recovery assistance
        
        To regain access to your account:
        1. Use your wallet application (MetaMask, WalletConnect, etc.)
        2. Import your wallet using your seed phrase or private key
        3. Connect to Trellis with the wallet address shown above
        
        If you didn't request this information, please secure your email account immediately.
      `;

    return this.sendMail({
      from:
        process.env.EMAIL_FROM ||
        '"Trellis" <noreply@trellis.example>',
      to: email,
      subject: "Account Recovery Information - trellis",
      html,
      text,
    });
  }

  async send2faChangeNotification(
    email: string,
    event: "enabled" | "disabled" | "backup-codes-regenerated",
  ): Promise<{ messageId: string; previewUrl?: string }> {
    const copy: Record<typeof event, { title: string; body: string }> = {
      enabled: {
        title: "🔐 Two-Factor Authentication Enabled",
        body: "Two-factor authentication (2FA) has been <strong>enabled</strong> on your StellAIverse account. Your account is now protected with an additional security layer.",
      },
      disabled: {
        title: "⚠️ Two-Factor Authentication Disabled",
        body: "Two-factor authentication (2FA) has been <strong>disabled</strong> on your StellAIverse account. If you did not perform this action, secure your account immediately.",
      },
      "backup-codes-regenerated": {
        title: "🔑 2FA Backup Codes Regenerated",
        body: "A new set of two-factor backup codes was generated for your StellAIverse account. Your previous backup codes are no longer valid. If you did not perform this action, secure your account immediately.",
      },
    };

    const { title, body } = copy[event];

    return this.sendMail({
      to: email,
      subject: `${title} - StellAIverse`,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
              .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
              .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
              .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header"><h1>${title}</h1></div>
              <div class="content">
                <p>Hello!</p>
                <p>${body}</p>
                <div class="warning">
                  <strong>⚠️ Didn't do this?</strong> Reset your password and contact support right away.
                </div>
                <p>Time: ${new Date().toISOString()}</p>
              </div>
              <div class="footer">
                <p>© ${new Date().getFullYear()} StellAIverse. All rights reserved.</p>
              </div>
            </div>
          </body>
        </html>
      `,
      text: `${title}\n\n${body.replace(/<[^>]+>/g, "")}\n\nIf you did not perform this action, secure your account immediately.\n\nTime: ${new Date().toISOString()}`,
    });
  }

  /**
   * Generic send mail method. Queues transactional email to Bull queue with backoff strategy if available.
   */
  async sendMail(options: EmailJobOptions): Promise<{ messageId: string; previewUrl?: string }> {
    if (this.emailQueue) {
      try {
        const job = await this.emailQueue.add("send-email", options, {
          attempts: 4, // 1 initial + 3 retries
          backoff: {
            type: "exponential",
            delay: 60000, // 1m, 5m, 15m exponential backoff
          },
          removeOnComplete: 100,
          removeOnFail: 500,
        });
        this.logger.log(`Queued email job ${job.id} for recipient ${options.to}`);
        return { messageId: String(job.id) };
      } catch (err) {
        this.logger.error(`Failed to queue email job: ${err.message}. Falling back to direct send.`);
      }
    }
    return this.executeSendMail(options);
  }

  /**
   * Direct mail dispatch method used by queue processor or fallback.
   */
  async executeSendMail(options: EmailJobOptions): Promise<{ messageId: string; previewUrl?: string }> {
    const info = await this.transporter.sendMail({
      from:
        options.from ||
        process.env.EMAIL_FROM ||
        '"Trellis" <noreply@trellis.example>',
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text || options.subject,
    });

    const previewUrl = nodemailer.getTestMessageUrl(info);

    if (previewUrl) {
      this.logger.log(`Email preview URL: ${previewUrl}`);
    }

    return {
      messageId: info.messageId,
      previewUrl: previewUrl || undefined,
    };
  }
}
