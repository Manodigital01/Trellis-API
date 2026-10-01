import { Module } from '@nestjs/common';
import { RecoveryService } from './recovery.service';
import { RecoveryController } from './recovery.controller';

@Module({
  providers: [RecoveryService],
  controllers: [RecoveryController],
  exports: [RecoveryService],
})
export class RecoveryModule {}
