import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Un candidato ICE real ocupa unos cientos de caracteres. */
export const MAX_ICE_CANDIDATE_LENGTH = 1_024;

export const MAX_SDP_MID_LENGTH = 64;

/** Ninguna sesion razonable tiene tantas lineas `m=`. */
export const MAX_SDP_M_LINE_INDEX = 255;

/**
 * Payload de `webrtc:ice-candidate`.
 *
 * El backend valida tipos y tamanos, pero NO interpreta el candidato: se limita
 * a retransmitirlo al otro extremo.
 *
 * `sdpMid` y `sdpMLineIndex` admiten `null` porque WebRTC los produce asi de
 * verdad (basta con que uno de los dos venga informado), y `candidate` admite
 * la cadena vacia, que es como algunas implementaciones senalan el fin de
 * candidatos.
 */
export class WebrtcIceCandidateDto {
  @IsUUID()
  remoteSessionId: string;

  @IsString()
  @MaxLength(MAX_ICE_CANDIDATE_LENGTH)
  candidate: string;

  // @IsOptional() acepta tanto el campo ausente como el valor null explicito.
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SDP_MID_LENGTH)
  sdpMid?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_SDP_M_LINE_INDEX)
  sdpMLineIndex?: number | null;
}
