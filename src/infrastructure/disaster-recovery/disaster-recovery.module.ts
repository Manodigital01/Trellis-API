import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DisasterRecoveryValidatorService } from './disaster-recovery-validator.service';

@Module({
  imports: [TypeOrmModule],
  providers: [DisasterRecoveryValidatorService],
  exports: [DisasterRecoveryValidatorService],
})
export class DisasterRecoveryModule {}
