import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Auth } from '../auth/decorators/auth.decorator';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { User } from '../auth/entities/user.entity';
import { ValidRoles } from '../auth/interfaces/valid-roles';
import { QuerySupportRequestsDto } from './dto/query-support-requests.dto';
import { SupportRequestsService } from './support-requests.service';

/**
 * Solicitudes de asistencia vistas desde la aplicacion del tecnico.
 *
 * Los tecnicos son usuarios del sistema: se protege con el mecanismo unico del
 * proyecto, `@Auth(...roles)`.
 */
@Controller('support-requests')
@Auth(ValidRoles.admin, ValidRoles.tecnico)
export class SupportRequestsController {
  constructor(
    private readonly supportRequestsService: SupportRequestsService,
  ) {}

  /**
   * Listado, opcionalmente filtrado por estado
   * (`GET /support-requests?status=WAITING`).
   *
   * Orden `createdAt ASC`: las solicitudes que llevan mas tiempo esperando
   * aparecen primero. Cada fila incluye el dispositivo y su `isOnline`.
   */
  @Get()
  findAll(@Query() query: QuerySupportRequestsDto) {
    return this.supportRequestsService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.supportRequestsService.findOne(id);
  }

  /**
   * El tecnico pulsa "Atender": `WAITING -> ASSIGNED`.
   *
   * El tecnico es el usuario autenticado; `technicianId` no se acepta en el
   * body. Si otro tecnico llego antes, o el dispositivo esta OFFLINE,
   * responde `409`.
   */
  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  assign(@Param('id', ParseUUIDPipe) id: string, @GetUser() user: User) {
    return this.supportRequestsService.assign(id, user);
  }
}
