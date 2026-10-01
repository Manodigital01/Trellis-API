import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SnapshotService } from './snapshot.service';
import { SnapshotController } from './snapshot.controller';

@Module({
  imports: [ConfigModule],
  providers: [SnapshotService],
  controllers: [SnapshotController],
  exports: [SnapshotService],
})
export class SnapshotModule {}
