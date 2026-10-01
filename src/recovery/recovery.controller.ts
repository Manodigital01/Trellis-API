import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { RecoveryService } from './recovery.service';
import { ListRecoveryEntriesDto, TransitionRecoveryStateDto } from './dto/recovery.dto';
import { OperationType } from '../common/contract/types/trellis-contract.types';

@ApiTags('Recovery Center')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/recovery')
export class RecoveryController {
  constructor(private readonly recoveryService: RecoveryService) {}

  private userId(req: Request): string {
    return (req as any).user?.id ?? 'anonymous';
  }

  @Get()
  @ApiOperation({
    summary: 'List recovery entries for the authenticated user (issue #122)',
    description:
      'Returns pending, failed, and recoverable operations that require attention. ' +
      'Resolved and dismissed entries are excluded from the default view.',
  })
  @ApiResponse({ status: 200 })
  listEntries(@Query() query: ListRecoveryEntriesDto, @Req() req: Request) {
    return this.recoveryService.listForUser(
      this.userId(req),
      query.state,
      query.limit,
      query.offset,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single recovery entry by ID' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404 })
  getEntry(@Param('id') id: string, @Req() req: Request) {
    return this.recoveryService.getEntry(id, this.userId(req));
  }

  @Patch(':id/state')
  @ApiOperation({ summary: 'Transition the state of a recovery entry (resolved / dismissed / in_progress)' })
  @ApiResponse({ status: 200 })
  transitionState(
    @Param('id') id: string,
    @Body() dto: TransitionRecoveryStateDto,
    @Req() req: Request,
  ) {
    return this.recoveryService.transition(id, this.userId(req), dto);
  }

  @Post(':id/actions/:actionId')
  @ApiOperation({ summary: 'Execute a recovery action (retry, cancel, view-on-chain)' })
  @ApiResponse({ status: 200 })
  executeAction(
    @Param('id') id: string,
    @Param('actionId') actionId: string,
    @Req() req: Request,
  ) {
    return this.recoveryService.executeAction(id, actionId, this.userId(req));
  }

  // Internal/admin — seed a recovery entry (normally emitted by services internally)
  @Post('_seed')
  @ApiOperation({ summary: '[Internal] Register a failed operation in the recovery center' })
  seedEntry(
    @Body() body: { operationId: string; operationType: OperationType; title: string; description: string },
    @Req() req: Request,
  ) {
    return this.recoveryService.registerOperation({ ...body, userId: this.userId(req) });
  }
}
