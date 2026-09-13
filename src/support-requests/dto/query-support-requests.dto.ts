import { IsEnum, IsOptional } from 'class-validator';
import { SupportRequestStatus } from '../enums/support-request-status.enum';

/** Filtros del listado de solicitudes para tecnicos/admin. */
export class QuerySupportRequestsDto {
  /**
   * Estado exacto. Sin filtro se devuelven todas.
   * Un valor fuera del enum es `400`, no un listado vacio.
   */
  @IsOptional()
  @IsEnum(SupportRequestStatus)
  status?: SupportRequestStatus;
}
