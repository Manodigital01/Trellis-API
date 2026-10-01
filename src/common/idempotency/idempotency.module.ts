import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { TypeOrmModule } from "@nestjs/typeorm";
import { IdempotencyRecord } from "./entities/idempotency-record.entity";
import { IdempotencyInterceptor } from "./idempotency.interceptor";
import { IdempotencyService } from "./idempotency.service";

/**
 * Registers the replay-protection store and enables the global
 * `IdempotencyInterceptor`. Import this module once (in `AppModule`) so every
 * controller is covered; individual routes can then opt in to stricter
 * behaviour with `@Idempotent({ required: true })`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([IdempotencyRecord])],
  providers: [
    IdempotencyService,
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
