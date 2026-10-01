import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { SnapshotService } from './snapshot.service';
import { RequestSnapshotDto, VerifySnapshotDto } from './dto/snapshot.dto';

@ApiTags('Snapshots')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/snapshots')
export class SnapshotController {
  constructor(private readonly snapshotService: SnapshotService) {}

  @Post()
  @ApiOperation({ summary: 'Create a signed state snapshot for debugging or audits (issue #119)' })
  @ApiResponse({ status: 201, description: 'Snapshot created and signed' })
  async createSnapshot(@Body() dto: RequestSnapshotDto, @Req() req: Request) {
    const requesterId = (req as any).user?.id ?? 'anonymous';
    return this.snapshotService.createSnapshot(dto, requesterId);
  }

  @Get()
  @ApiOperation({ summary: 'List all available snapshots (metadata only, payload excluded)' })
  @ApiResponse({ status: 200 })
  listSnapshots() {
    return this.snapshotService.listSnapshots();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Retrieve a snapshot by ID' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404 })
  getSnapshot(@Param('id') id: string) {
    const snap = this.snapshotService.getSnapshot(id);
    if (!snap) throw new NotFoundException(`Snapshot ${id} not found`);
    return snap;
  }

  @Post('verify')
  @ApiOperation({ summary: 'Verify snapshot integrity — detects payload tampering' })
  @ApiResponse({ status: 200 })
  verifySnapshot(@Body() dto: VerifySnapshotDto) {
    return this.snapshotService.verifySnapshot(dto);
  }
}
