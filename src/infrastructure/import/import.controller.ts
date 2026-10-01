import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import { ImportService } from './import.service';
import {
  ImportRequestDto,
  ImportResultDto,
  ImportEntityType,
  PortfolioAssetImportRowDto,
} from './dto/import.dto';
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guard/roles.guard';
import { Roles } from '../../common/guard/roles.decorator';
import { Role } from '../../common/guard/roles.enum';

@ApiTags('Import Pipeline')
@Controller('import')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth('JWT-auth')
export class ImportController {
  constructor(private readonly importService: ImportService) {}

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Dry-run preview and validate bulk import data',
    description:
      'Performs complete schema validation, foreign-key pre-checking, duplicate detection, and diff preview with ZERO persistent database writes.',
  })
  @ApiResponse({
    status: 200,
    description: 'Dry-run validation results and diff preview',
    type: ImportResultDto,
  })
  async validateImport(
    @Body() dto: ImportRequestDto,
  ): Promise<ImportResultDto> {
    return this.importService.processImport({
      ...dto,
      dryRun: true,
    });
  }

  @Post('execute')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN, Role.OPERATOR, Role.USER)
  @ApiOperation({
    summary: 'Execute bulk import (dry-run or persistent commit)',
    description:
      'Processes a bulk import batch with atomic transaction semantics, idempotent upserts for external IDs, and rollback guidance on partial failures.',
  })
  @ApiResponse({
    status: 200,
    description: 'Import execution report with action counts and rollback guidance',
    type: ImportResultDto,
  })
  async executeImport(
    @Body() dto: ImportRequestDto,
  ): Promise<ImportResultDto> {
    return this.importService.processImport(dto);
  }

  @Post('portfolio-assets')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN, Role.OPERATOR, Role.USER)
  @ApiOperation({
    summary: 'Bulk import portfolio assets',
    description:
      'Convenience endpoint to import multiple asset holdings into portfolios with dry-run support.',
  })
  @ApiBody({ type: [PortfolioAssetImportRowDto] })
  @ApiResponse({
    status: 200,
    description: 'Portfolio asset import execution report',
    type: ImportResultDto,
  })
  async importPortfolioAssets(
    @Body() rows: PortfolioAssetImportRowDto[],
  ): Promise<ImportResultDto> {
    return this.importService.processImport({
      entityType: ImportEntityType.PORTFOLIO_ASSETS,
      dryRun: false,
      rows,
      options: {
        updateExisting: true,
        allowPartial: false,
      },
    });
  }
}
