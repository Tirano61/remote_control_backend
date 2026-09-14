import { SignalingParticipant } from './interfaces/signaling-participant.interface';

/**
 * Room de signaling de una sesion remota.
 *
 * La resuelve siempre el servidor a partir de una `RemoteSession` validada: el
 * cliente nunca proporciona nombres de room.
 *
 * CUIDADO: los namespaces `/devices` y `/technicians` tienen rooms
 * independientes aunque el nombre coincida. Que un tecnico y una tablet esten
 * en `remote-session:<id>` NO significa que esten en la misma room: cada emision
 * tiene que dirigirse al namespace correcto, y de eso se encarga
 * `SignalingRealtimeService`.
 */
export const remoteSessionRoom = (remoteSessionId: string): string =>
  `remote-session:${remoteSessionId}`;

/** El participante pide unirse a la sesion remota antes de enviar signaling. */
export const REMOTE_SESSION_JOIN_EVENT = 'remote-session:join';

/**
 * El participante del OTRO extremo acaba de unirse a la sesion.
 *
 * Resuelve la carrera inicial de la negociacion: el que llega primero recibe
 * `peerJoined: false` en su ACK y se entera por aqui, sin repetir el join ni
 * esperar un tiempo arbitrario.
 *
 * Es readiness de signaling, no de WebRTC: significa que hay al menos un socket
 * del namespace opuesto dentro de `remote-session:<id>`, nada mas.
 */
export const REMOTE_SESSION_PEER_JOINED_EVENT = 'remote-session:peer-joined';

/** SDP offer. El backend no decide quien la crea: solo la retransmite. */
export const WEBRTC_OFFER_EVENT = 'webrtc:offer';

/** SDP answer. */
export const WEBRTC_ANSWER_EVENT = 'webrtc:answer';

/** Candidato ICE. El backend no lo interpreta. */
export const WEBRTC_ICE_CANDIDATE_EVENT = 'webrtc:ice-candidate';

/**
 * SDP retransmitida al otro extremo.
 *
 * Se reenvian unicamente los campos ya validados, nunca el objeto que llego del
 * cliente: asi no se puede colar informacion extra en el camino. `from` permite
 * al cliente saber de que extremo viene sin que el backend fije quien crea la
 * offer.
 */
export interface WebrtcSdpPayload {
  remoteSessionId: string;
  from: SignalingParticipant;
  sdp: string;
}

/** Candidato ICE retransmitido al otro extremo. */
export interface WebrtcIceCandidatePayload {
  remoteSessionId: string;
  from: SignalingParticipant;
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

/**
 * Aviso de que el otro extremo esta presente en la room de signaling.
 *
 * No lleva identidad del peer: quien lo recibe ya sabe con quien comparte la
 * sesion, y anadir `userId`, `deviceId` o `technicianId` solo expondria datos
 * que el contrato no necesita.
 */
export interface RemoteSessionPeerJoinedPayload {
  remoteSessionId: string;
}
