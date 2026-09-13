import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/**
 * Limite defensivo para la SDP.
 *
 * Una oferta real ronda unos pocos KB, incluso con los candidatos incluidos.
 * No se busca ajustar el maximo al milimetro, solo evitar que un cliente
 * autenticado mande cadenas arbitrariamente grandes.
 */
export const MAX_SDP_LENGTH = 32_768;

/**
 * Payload de `webrtc:offer` y `webrtc:answer`.
 *
 * Comparten forma: el backend no interpreta la SDP y el tipo ya viaja en el
 * nombre del evento. Tampoco se persiste ni se loguea su contenido.
 */
export class WebrtcSdpDto {
  @IsUUID()
  remoteSessionId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_SDP_LENGTH)
  sdp: string;
}
