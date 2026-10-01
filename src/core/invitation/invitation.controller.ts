import {
  Controller,
  Post,
  Body,
  Param,
  UseGuards,
  Patch,
} from "@nestjs/common";
import { InvitationService } from "./invitation.service";
import { CreateInvitationDto } from "./dto/create-invitation.dto";
import { AcceptInvitationDto } from "./dto/accept-invitation.dto";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guard/roles.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../../common/guard/roles.decorator";
import { Role } from "../../common/guard/roles.enum";
import { SkipThrottle, Throttle } from "@nestjs/throttler";
import { DistributedRateLimitGuard } from "../../rate-limiting/rate-limiting.guard";

@Controller("invitations")
@UseGuards(DistributedRateLimitGuard)
export class InvitationController {
  constructor(private readonly invitationService: InvitationService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.MAINTAINER, Role.ADMIN)
  @Throttle({ default: { limit: 5, ttl: 60 } }) // Rate limit: max 5 invites per minute
  create(
    @Body() createDto: CreateInvitationDto,
    @CurrentUser() user: any,
  ) {
    return this.invitationService.create(createDto, user.id, user.role);
  }

  @Post("accept")
  @Throttle({ default: { limit: 10, ttl: 60 } }) // Rate limit: max 10 accepts per minute
  accept(@Body() acceptDto: AcceptInvitationDto) {
    return this.invitationService.accept(acceptDto.token);
  }

  @Patch(":id/revoke")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.MAINTAINER, Role.ADMIN)
  revoke(
    @Param("id") id: string,
    @CurrentUser() user: any,
  ) {
    return this.invitationService.revoke(id, user.id, user.role);
  }
}
