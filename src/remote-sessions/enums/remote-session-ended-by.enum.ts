/**
 * Quien cerro la sesion remota.
 *
 * Enum explicito y no strings sueltos: es informacion de auditoria y se guarda
 * tal cual en la base de datos.
 */
export enum RemoteSessionEndedBy {
  /** El tecnico finalizo la asistencia. */
  TECHNICIAN = 'TECHNICIAN',

  /** El usuario de la tablet corto la sesion. */
  DEVICE = 'DEVICE',

  /**
   * Cierre automatico del backend (`RemoteSessionLifecycleService`):
   *
   * - una sesion `CONNECTING` supero su TTL sin llegar a `ACTIVE`;
   * - un participante de una sesion `ACTIVE` falto mas que el periodo de gracia;
   * - tras un reinicio, nadie recupero la sesion dentro de la ventana de
   *   recuperacion.
   * - uno de sus participantes perdio la autorizacion: el dispositivo se
   *   desactivo o se re-enrolo (en la misma transaccion), o una revalidacion
   *   encontro al tecnico o al dispositivo inactivo.
   */
  SYSTEM = 'SYSTEM',
}
