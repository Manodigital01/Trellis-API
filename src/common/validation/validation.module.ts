import { Module, Global } from "@nestjs/common";
import { SemanticValidatorService } from "./semantic-validator.service";

/**
 * Global validation module providing semantic validation services and decorators.
 *
 * Exports:
 * - SemanticValidatorService: Service for semantic business-rule validation
 * - SemanticValidate: Decorator for controller method validation
 *
 * @example
 *   // In app.module.ts
 *   import { ValidationModule } from './common/validation/validation.module';
 *
 *   @Module({ imports: [ValidationModule] })
 *   export class AppModule {}
 *
 *   // In a service
 *   @Injectable()
 *   export class MyService {
 *     constructor(private readonly validator: SemanticValidatorService) {}
 *
 *     async process(dto: MyDto) {
 *       this.validator.validateDateRange(dto.startDate, dto.endDate);
 *       // ... rest of logic
 *     }
 *   }
 */
@Global()
@Module({
  providers: [SemanticValidatorService],
  exports: [SemanticValidatorService],
})
export class ValidationModule {}
