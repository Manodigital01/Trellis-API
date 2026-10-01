import { Module } from "@nestjs/common";
import { PermissionMatrixController } from "./permission-matrix.controller";
import { PermissionMatrixGuard } from "./permission-matrix.guard";

@Module({
  controllers: [PermissionMatrixController],
  providers: [PermissionMatrixGuard],
  exports: [PermissionMatrixGuard],
})
export class PermissionMatrixModule {}
