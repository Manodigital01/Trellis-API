import {
  AsyncHooksContextManager,
  AsyncLocalStorageContextManager,
} from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  ROOT_CONTEXT,
  context,
  propagation,
  trace,
  Span,
  SpanStatusCode,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

/**
 * Metadata key under which the W3C trace context (traceparent / tracestate)
 * is stored inside a background-job payload or an emitted event payload.
 *
 * Jobs enqueued with `withTraceContext` (or `captureTraceContext`) carry this
 * field across the process boundary; worker-side helpers extract it so the
 * processing span is nested under the originating HTTP request span.
 */
export const TRACE_CONTEXT_FIELD = "__trace";

/**
 * A carrier for W3C trace context. Used both for job metadata
 * (`{ [TRACE_CONTEXT_FIELD]: { traceparent, tracestate } }`) and for plain
 * header maps.
 */
export type TraceContextCarrier = Record<string, unknown>;

/** The `traceparent` / `tracestate` pair captured from an active context. */
export interface CapturedTraceContext {
  traceparent: string;
  tracestate?: string;
}

/**
 * Capture the W3C trace context of the currently active span as a plain
 * serializable object. Returns an empty object when no span is active, so
 * dispatching outside of a traced request stays safe.
 */
export function captureTraceContext(): CapturedTraceContext {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  if (!carrier.traceparent) return {} as CapturedTraceContext;
  const captured: CapturedTraceContext = { traceparent: carrier.traceparent };
  if (carrier.tracestate) captured.tracestate = carrier.tracestate;
  return captured;
}

/**
 * Attach the current (or explicitly given) trace context to a job payload or
 * event payload under {@link TRACE_CONTEXT_FIELD}. Mutating and returning the
 * same object keeps enqueue call-sites concise:
 *
 *   queue.add("send-email", withTraceContext({ emailLogId }));
 */
export function withTraceContext<T extends Record<string, unknown>>(
  payload: T,
  captured: CapturedTraceContext = captureTraceContext(),
): T & { [TRACE_CONTEXT_FIELD]?: CapturedTraceContext } {
  if (!captured.traceparent) return { ...payload };
  return { ...payload, [TRACE_CONTEXT_FIELD]: captured };
}

/**
 * Extract a parent context from a job/event payload previously produced by
 * {@link withTraceContext}. Falls back to the current propagation defaults
 * (ROOT_CONTEXT) when the payload carries no trace context.
 */
export function extractJobContext(
  payload?: TraceContextCarrier | null,
): ReturnType<typeof propagation.extract> {
  const stored = payload?.[TRACE_CONTEXT_FIELD];
  if (stored && typeof stored === "object") {
    return propagation.extract(ROOT_CONTEXT, stored as Record<string, string>);
  }
  return ROOT_CONTEXT;
}

/**
 * Run `fn` inside a span named after the job, parented to the trace context
 * extracted from the job payload. Used by worker entry points that need
 * manual wiring (e.g. Bull `@Process` handlers calling through a service).
 */
export async function runTracedJob<T>(
  jobName: string,
  payload: TraceContextCarrier | null | undefined,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const parentContext = extractJobContext(payload);
  const tracer = trace.getTracer("trellis.background-jobs");

  return tracer.startActiveSpan(`job ${jobName}`, {}, parentContext, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      if (error instanceof Error) span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Decorator for background-worker methods (Bull `@Process` handlers,
 * event-emitter listeners, cron jobs).
 *
 * The first argument is expected to carry the job payload (a Bull `Job` with
 * `data`, or a plain payload object). The decorator:
 *   1. extracts the W3C parent context from the payload (producer side must
 *      have enqueued with {@link withTraceContext}),
 *   2. opens a `job <name>` span parented to that context, and
 *   3. executes the method inside it, recording status and ending the span.
 *
 * Usage:
 *   @Process("send-email")
 *   @TraceAsyncJob("email.send")
 *   async handleSendEmail(job: Job<EmailJobData>) { ... }
 */
export function TraceAsyncJob(jobName: string): MethodDecorator {
  return (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const original = descriptor.value;
    if (typeof original !== "function") return descriptor;

    descriptor.value = async function (this: unknown, ...args: unknown[]) {
      const payloadArg = args[0] as
        | (TraceContextCarrier & { data?: TraceContextCarrier })
        | undefined;
      const payload = payloadArg?.data ?? payloadArg;

      return runTracedJob(jobName, payload, async () =>
        original.apply(this, args),
      );
    };

    return descriptor;
  };
}

/**
 * Test/bootstrap helper: registers a functioning tracer provider, context
 * manager and W3C propagator so trace propagation works outside of
 * `startTracing()` (NodeSDK). Guards against double registration; safe to
 * call repeatedly.
 */
export function ensureTraceInstrumentation(): void {
  try {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager());
  } catch {
    // Already registered — keep the existing manager.
  }
  try {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  } catch {
    // Already registered.
  }
  if (!trace.getTracerProvider()) {
    trace.setGlobalTracerProvider(new BasicTracerProvider());
  }
}

/** Test helper: provider + in-memory exporter for asserting exported spans. */
export function createInMemoryTraceHarness(): {
  provider: BasicTracerProvider;
  exporter: InMemorySpanExporter;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { provider, exporter };
}

// Re-exported so callers of this module do not need the raw SDK imports.
export { AsyncHooksContextManager, AsyncLocalStorageContextManager };
