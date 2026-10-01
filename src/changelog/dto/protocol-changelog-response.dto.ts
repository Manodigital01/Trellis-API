import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class ProtocolSurfaceDto {
  @ApiProperty({ enum: ["http", "websocket", "graphql", "event", "config", "cli", "database"] })
  kind: string;

  @ApiPropertyOptional({ example: "GET" })
  method?: string;

  @ApiPropertyOptional({ example: "/changelog/protocol" })
  path?: string;

  @ApiPropertyOptional({ example: "CHANGELOG_PATH" })
  key?: string;

  @ApiProperty()
  description: string;
}

export class ProtocolMigrationDto {
  @ApiProperty({ description: "Whether a caller or operator must act." })
  required: boolean;

  @ApiProperty({ description: "Whether tooling applies the migration." })
  automated: boolean;

  @ApiProperty({ type: [String] })
  steps: string[];

  @ApiProperty()
  notes: string;
}

export class ProtocolBreakingChangeDto {
  @ApiProperty()
  description: string;

  @ApiPropertyOptional()
  replacement?: string;

  @ApiPropertyOptional()
  issue?: number;
}

export class ProtocolDeprecationDto {
  @ApiProperty()
  surface: string;

  @ApiProperty()
  replacement: string;

  @ApiProperty({ example: "1.0.0" })
  removalVersion: string;
}

export class ProtocolChangeEntryDto {
  @ApiProperty({ example: "0.2.0" })
  version: string;

  @ApiProperty({ example: "2026-09-27", description: "Calendar date, UTC." })
  date: string;

  @ApiProperty({ enum: ["released", "unreleased"] })
  status: string;

  @ApiProperty({
    enum: ["breaking", "deprecation", "compatible", "fix", "security"],
    description: "Worst-case effect on a caller that does nothing.",
  })
  impact: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  summary: string;

  @ApiProperty({ type: [ProtocolSurfaceDto] })
  protocolSurfaces: ProtocolSurfaceDto[];

  @ApiProperty({ type: ProtocolMigrationDto })
  migration: ProtocolMigrationDto;

  @ApiPropertyOptional({ type: [ProtocolBreakingChangeDto] })
  breakingChanges?: ProtocolBreakingChangeDto[];

  @ApiPropertyOptional({ type: [ProtocolDeprecationDto] })
  deprecations?: ProtocolDeprecationDto[];

  @ApiPropertyOptional({ type: [Number] })
  relatedIssues?: number[];

  @ApiPropertyOptional({ type: [Number] })
  relatedPullRequests?: number[];

  @ApiPropertyOptional({ type: [String] })
  docs?: string[];
}

export class ProtocolChangelogResponseDto {
  @ApiProperty({ example: "1.0.0", description: "Schema version, not API version." })
  schemaVersion: string;

  @ApiProperty({ example: "trellis-api" })
  project: string;

  @ApiProperty({ description: "When this process loaded the changelog." })
  generatedAt: string;

  @ApiProperty({ type: [ProtocolChangeEntryDto] })
  entries: ProtocolChangeEntryDto[];

  @ApiProperty({ nullable: true, type: String, example: "0.2.0" })
  latestVersion: string | null;

  @ApiProperty({
    nullable: true,
    enum: ["breaking", "security", "deprecation", "compatible", "fix"],
  })
  highestImpact: string | null;

  @ApiProperty({
    description: "True when at least one entry forces the caller to act.",
  })
  migrationRequired: boolean;

  @ApiProperty({ type: [String] })
  affectedPaths: string[];
}
