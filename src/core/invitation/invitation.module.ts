import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { InvitationService } from "./invitation.service";
import { InvitationController } from "./invitation.controller";
import { Invitation } from "./entities/invitation.entity";

@Module({
  imports: [TypeOrmModule.forFeature([Invitation])],
  controllers: [InvitationController],
  providers: [InvitationService],
  exports: [InvitationService],
})
export class InvitationModule {}
