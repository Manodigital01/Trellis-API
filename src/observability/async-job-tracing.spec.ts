import {
  SpanStatusCode,
  context,
  trace,
  ROOT_CONTEXT,
} from "@opentelemetry/api";
import { InMemorySpanExporter, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  TRACE_CONTEXT_FIELD,
  captureTraceContext,
  createInMemoryTraceHarness,
  ensureTraceInstrumentation,
  extractJobContext,
  runTracedJob,
  withTraceContext,
  TraceAsyncJob,
} from "./async-job-tracing";

/**
 * End-to-end propagation test: an "HTTP request" span is opened, its context
 * is captured into a job payload (the producer side of a queue dispatch), and
 * a worker-side decorator executes the job. The traceId must remain constant
 * across the asynchronous process boundary, with the job span nested under
 * the request span.
 */
describe("async job trace context propagation", () => {
  let harness: ReturnType<typeof createInMemoryTraceHarness>;

  beforeAll(() => {
    ensureTraceInstrumentation();
    harness = createInMemoryTraceHarness();
    trace.setGlobalTracerProvider(harness.provider);
  });

  afterEach(async () => {
    await harness.provider.forceFlush();
    harness.exporter.reset();
  });

  /** Simulates the HTTP layer: opens a request span and runs a handler inside it. */
  async function withHttpRequestSpan<T>(
    fn: () => Promise<T>,
  ): Promise<{ result: T; span: ReadableSpan }> {
    let requestSpan!: ReadableSpan;
    const result = await harness.provider
      .getTracer("test.http")
      .startActiveSpan("POST /auth/register", async (span) => {
        const captured = await fn();
        span.end();
        requestSpan = span as unknown as ReadableSpan;
        return captured;
      });
    return { result, span: requestSpan };
  }

  /** Simulates the queue producer: captures the active context into job metadata. */
  function enqueueJob(payload: Record<string, unknown>) {
    return withTraceContext(payload);
  }

  /** Simulates the worker consumer: processes an enqueued job payload. */
  function processJob(jobPayload: Record<string, unknown>) {
    return runTracedJob("email.send", jobPayload, async (span) => {
      span.setAttribute("job.emailLogId", jobPayload.emailLogId as string);
      return "processed";
    });
  }

  it("keeps the traceId constant from HTTP request to job completion", async () => {
    let jobPayload: Record<string, unknown> | undefined;

    const { result } = await withHttpRequestSpan(async () => {
      // Producer runs inside the HTTP request span context.
      jobPayload = enqueueJob({ emailLogId: "log-1" });
      return enqueueJob({ emailLogId: "log-1" });
    });

    expect(result[TRACE_CONTEXT_FIELD]).toBeDefined();
    expect(jobPayload).toBeDefined();

    // Consumer runs in a fresh async context (as a worker process would).
    const workerTraceId = await processJob(jobPayload!);
    void workerTraceId;

    await harness.provider.forceFlush();
    const spans = harness.exporter.getFinishedSpans();

    const requestSpan = spans.find((s) => s.name === "POST /auth/register");
    const jobSpan = spans.find((s) => s.name === "job email.send");

    expect(requestSpan).toBeDefined();
    expect(jobSpan).toBeDefined();

    // Same trace, job span is a child of the request span.
    expect(jobSpan!.spanContext().traceId).toBe(
      requestSpan!.spanContext().traceId,
    );
    expect(jobSpan!.parentSpanContext?.spanId).toBe(
      requestSpan!.spanContext().spanId,
    );
  });

  it("propagates context through the @TraceAsyncJob decorator", async () => {
    class FakeWorker {
      processed = false;

      @TraceAsyncJob("email.send")
      async handle(job: { data?: Record<string, unknown> }) {
        this.processed = true;
        // The decorator must have activated the extracted parent context.
        const span = trace.getSpan(context.active());
        expect(span).toBeDefined();
        return span!.spanContext().traceId;
      }
    }

    let captured: { [key: string]: unknown } = {};
    await withHttpRequestSpan(async () => {
      captured = enqueueJob({ emailLogId: "log-2" });
      return captured;
    });

    const worker = new FakeWorker();
    const traceId = await worker.handle({ data: captured });
    expect(worker.processed).toBe(true);

    await harness.provider.forceFlush();
    const spans = harness.exporter.getFinishedSpans();
    const requestSpan = spans.find((s) => s.name === "POST /auth/register");
    const jobSpan = spans.find((s) => s.name === "job email.send");

    expect(requestSpan).toBeDefined();
    expect(jobSpan).toBeDefined();
    expect(traceId).toBe(requestSpan!.spanContext().traceId);
    expect(jobSpan!.parentSpanContext?.spanId).toBe(
      requestSpan!.spanContext().spanId,
    );
  });

  it("serializes trace context as a W3C traceparent carrier", async () => {
    await withHttpRequestSpan(async () => {
      const payload = enqueueJob({ emailLogId: "log-3" });
      const stored = payload[TRACE_CONTEXT_FIELD] as {
        traceparent: string;
      };
      expect(stored.traceparent).toMatch(
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/,
      );
      return payload;
    });
  });

  it("extractJobContext falls back to ROOT_CONTEXT for untraced payloads", () => {
    expect(extractJobContext({})).toBe(ROOT_CONTEXT);
    expect(extractJobContext(null)).toBe(ROOT_CONTEXT);
    expect(extractJobContext(undefined)).toBe(ROOT_CONTEXT);
  });

  it("captureTraceContext returns an empty capture with no active span", async () => {
    let captured: ReturnType<typeof captureTraceContext> | undefined;
    await context.with(ROOT_CONTEXT, async () => {
      captured = captureTraceContext();
    });
    expect(captured).toEqual({});
    // withTraceContext must not stamp an empty capture onto the payload.
    expect(withTraceContext({ emailLogId: "x" }, captured)).toEqual({
      emailLogId: "x",
    });
  });

  it("records an error status on the job span when the worker throws", async () => {
    let payload: Record<string, unknown> | undefined;
    await withHttpRequestSpan(async () => {
      payload = enqueueJob({ emailLogId: "log-4" });
      return payload;
    });

    await expect(
      runTracedJob("email.send", payload, async () => {
        throw new Error("provider unavailable");
      }),
    ).rejects.toThrow("provider unavailable");

    await harness.provider.forceFlush();
    const jobSpan = harness.exporter
      .getFinishedSpans()
      .find((s) => s.name === "job email.send");
    expect(jobSpan).toBeDefined();
    expect(jobSpan!.status.code).toBe(SpanStatusCode.ERROR);
  });
});
