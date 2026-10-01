// import pino from "pino";
import pino from "pino";

const isDevelopment = process.env.NODE_ENV === "development";

const SENSITIVE_KEY = /(password|passwd|token|secret|private.?key|access.?token|authorization|bearer|credit.?card|cookie|api.?key)/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?<!\w)(?:\+?\d[\d\s().-]{7,}\d)(?!\w)/g;

/** Recursively remove credentials and direct contact identifiers from logs. */
export function sanitizeLogValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value.replace(EMAIL, "[REDACTED]").replace(PHONE, "[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeLogValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        sanitizeLogValue(v, k),
      ]),
    );
  }
  return value;
}

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: isDevelopment
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss Z",
          ignore: "pid,hostname",
        },
      }
    : undefined,
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  base: {
    env: process.env.NODE_ENV,
    service: "trellis-api",
  },
  redact: {
    paths: [
      "*.password", "*.token", "*.secret", "*.privateKey", "*.accessToken",
      "*.authorization", "*.cookie", "req.headers.authorization",
    ],
    censor: "[REDACTED]",
  },
  hooks: {
    logMethod(inputArgs, method) {
      if (inputArgs.length > 0) inputArgs[0] = sanitizeLogValue(inputArgs[0]);
      method.apply(this, inputArgs as never);
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// Helper function to create child loggers with context
export const createLogger = (context: Record<string, any>) => {
  return logger.child(context);
};
