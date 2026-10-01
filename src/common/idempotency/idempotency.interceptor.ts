import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { EMPTY, firstValueFrom, Observable, of } from "rxjs";
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_OPTIONS,
  IDEMPOTENCY_REPLAYED_HEADER,
} from "./idempotency.constants";
import { IdempotentOptions } from "./idempotency.decorator";
import { IdempotencyService } from "./idempotency.service";

interface IdempotentRequest {
  method: string;
  url: string;
  route?: { path?: string };
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  params?: unknown;
  query?: unknown;
  ip?: string;
  user?: { id?: string; userId?: string; sub?: string };
}

interface IdempotentResponse {
  statusCode?: number;
  setHeader: (name: string, value: string) => void;
  status: (code: number) => IdempotentResponse;
  json: (body: unknown) => void;
}

/**
 * Global interceptor that turns the `Idempotency-Key` header into a
 * server-side replay guard.
 *
 * - Only mutating methods (`POST`/`PUT`/`PATCH`/`DELETE`) are affected.
 * - Without a key the request passes through untouched unless the route is
 *   marked `@Idempotent({ required: true })`, in which case it is rejected.
 * - With a key the handler runs once; the response is stored and replayed for
 *   the TTL, and reusing the key with a different payload returns 409.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly reflector: Reflector
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler
  ): Promise<Observable<unknown>> {
    if (context.getType() !== "http") return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<IdempotentRequest>();
    const response = http.getResponse<IdempotentResponse>();

    if (!this.idempotency.isIdempotentMethod(request.method)) {
      return next.handle();
    }

    const options =
      this.reflector.getAllAndOverride<IdempotentOptions>(IDEMPOTENCY_OPTIONS, [
        context.getHandler(),
        context.getClass(),
      ]) ?? {};

    const rawKey = request.headers?.[IDEMPOTENCY_KEY_HEADER];
    const headerKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;

    if (!headerKey) {
      if (options.required) {
        throw new BadRequestException(
          `Missing ${IDEMPOTENCY_KEY_HEADER} header for ${
            options.scope ?? request.route?.path ?? request.url
          }`
        );
      }
      return next.handle();
    }

    const actor =
      request.user?.id ?? request.user?.userId ?? request.user?.sub ?? request.ip;

    const scope =
      options.scope ??
      this.idempotency.buildScope(
        request.method,
        request.route?.path ?? request.url,
        actor
      );

    const requestHash = this.idempotency.hashRequest({
      params: request.params ?? null,
      query: request.query ?? null,
      body: request.body ?? null,
    });

    const outcome = await this.idempotency.execute({
      key: headerKey,
      scope,
      requestHash,
      ttlSeconds: options.ttlSeconds,
      handler: async () => {
        const body = await firstValueFrom(next.handle());
        return { statusCode: response.statusCode ?? 200, body };
      },
    });

    response.setHeader(
      IDEMPOTENCY_REPLAYED_HEADER,
      outcome.replayed ? "true" : "false"
    );

    if (outcome.replayed) {
      // The handler was skipped entirely - serve the stored response.
      response.status(outcome.statusCode ?? 200);
      response.json(outcome.body ?? null);
      return EMPTY;
    }

    return of(outcome.body);
  }
}
