import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Auth } from '../auth/decorators/auth.decorator';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { User } from '../auth/entities/user.entity';
import { ValidRoles } from '../auth/interfaces/valid-roles';
import { CreateRemoteSessionDto } from './dto/create-remote-session.dto';
import { RemoteSessionsService } from './remote-sessions.service';

/**
 * Sesiones remotas vistas desde la aplicacion del tecnico.
 *
 * Los tecnicos son usuarios del sistema: se protege con el mecanismo unico del
 * proyecto, `@Auth(...roles)`. El rol solo decide quien puede llamar; la
 * pertenencia de cada sesion la comprueba el servicio, tambien para `admin`.
 */
@Controller('remote-sessions')
@Auth(ValidRoles.admin, ValidRoles.tecnico)
export class RemoteSessionsController {
  constructor(private readonly remoteSessionsService: RemoteSessionsService) {}

  /**
   * El tecnico pulsa "Iniciar asistencia" sobre una solicitud aceptada.
   *
   * El body lleva solo `supportRequestId`. El dispositivo sale de la solicitud
   * y el tecnico del token.
   */
  @Post()
  create(
    @Body() createRemoteSessionDto: CreateRemoteSessionDto,
    @GetUser() user: User,
  ) {
    return this.remoteSessionsService.create(createRemoteSessionDto, user);
  }

  /**
   * Sesion viva del propio tecnico, o `remoteSession: null` si no tiene.
   *
   * Es con lo que la Flutter Web se recupera tras un F5 o al reabrirse, sin
   * tener que confiar en un `remoteSessionId` guardado en el navegador. No
   * tener sesion es lo normal, no un error: responde `200`, no `404`.
   *
   * DECLARADA ANTES QUE `:id` A PROPOSITO: Nest resuelve las rutas en el orden
   * en que se declaran, asi que al reves `current` entraria por `:id` (y, con
   * el `ParseUUIDPipe`, acabaria en un `400`).
   */
  @Get('current')
  findCurrent(@GetUser('id') technicianId: string) {
    return this.remoteSessionsService.findCurrentForTechnician(technicianId);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @GetUser() user: User) {
    return this.remoteSessionsService.findOneForTechnician(id, user);
  }

  /**
   * El tecnico finaliza la asistencia: la sesion pasa a `CLOSED` y su solicitud
   * a `COMPLETED`, en la misma transaccion.
   *
   * Si la sesion ya estaba cerrada responde `409` y no altera el cierre que
   * llego antes.
   */
  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  close(@Param('id', ParseUUIDPipe) id: string, @GetUser() user: User) {
    return this.remoteSessionsService.closeByTechnician(id, user);
  }
}
