import { Injectable, Logger } from '@nestjs/common';

/**
 * Las dos identidades que abren sockets y que pueden perder la autorizacion.
 *
 * No es un rol: un tecnico y un `admin` son la misma clase de identidad (un
 * `User`), y un dispositivo es otra completamente distinta (`Device` +
 * `DeviceCredential`).
 */
export enum RevocableIdentityKind {
  DEVICE = 'DEVICE',
  TECHNICIAN = 'TECHNICIAN',
}

/** Aviso en proceso de que una identidad acaba de perder la autorizacion. */
export type IdentityRevokedListener = (
  kind: RevocableIdentityKind,
  id: string,
) => void;

/**
 * Barrera de revocacion en proceso.
 *
 * PROBLEMA QUE RESUELVE (auditoria Prompt 44, C1). Autenticar un socket lleva
 * varios `await`: verificar el token, leer el dispositivo, leer su credencial,
 * unirlo a su room. Si la desactivacion confirma y barre los sockets
 * registrados MIENTRAS un handshake esta en medio de esos `await`, el handshake
 * ya leyo el estado anterior (`isActive = true`) y termina registrando un
 * socket que el barrido no vio. Ese socket queda autorizado para siempre: nadie
 * vuelve a mirarlo.
 *
 * Comprobar `isActive` otra vez justo antes de registrar no lo arregla: esa
 * lectura tambien es un `await`, y la desactivacion puede confirmar despues de
 * ella y antes del registro.
 *
 * MECANISMO. Un reloj logico monotono del proceso:
 *
 * - `stamp()` lo lee. Cada operacion que pueda conceder acceso (un handshake)
 *   toma su sello ANTES de leer nada de PostgreSQL.
 * - `revoke(kind, id)` avanza el reloj y anota en que tick quedo revocada esa
 *   identidad. Lo llama quien retira la autorizacion, DESPUES de confirmar su
 *   transaccion.
 * - `isAdmissible(kind, id, stamp)` es `false` si la identidad fue revocada
 *   despues de que se tomara ese sello.
 *
 * Todo es sincrono y Node ejecuta un solo hilo de JavaScript: entre la
 * comprobacion y el registro de un socket no puede colarse un `revoke`, y entre
 * el `revoke` y el barrido de los sockets registrados tampoco puede colarse un
 * registro. Por tanto, para un handshake que leyo `isActive = true`:
 *
 * - si registro su socket antes del `revoke`, el barrido lo cierra;
 * - si llega a registrarlo despues, su sello es anterior a la revocacion y la
 *   barrera lo rechaza;
 * - y si su lectura de PostgreSQL fue posterior al commit, ya leyo
 *   `isActive = false`.
 *
 * No hay un cuarto caso: el sello se toma antes de la lectura y el `revoke`
 * ocurre despues del commit.
 *
 * Lo mismo vale para una operacion en vuelo de un socket ya autorizado (un
 * `remote-session:join`, un `webrtc:*`): su ultimo paso sincrono comprueba la
 * barrera con el sello del socket, asi que un resultado que llega despues de la
 * revocacion no concede nada.
 *
 * NO ES UNA CACHE DE AUTORIZACION. Solo puede quitar permisos, nunca darlos:
 * `isAdmissible` en `true` no autoriza nada por si solo, la autorizacion la
 * siguen decidiendo PostgreSQL (estado del dispositivo, la credencial, el
 * usuario y la sesion) y las reglas de siempre. Que la barrera olvidara algo
 * solo podria dejar pasar lo que PostgreSQL ya autorizo.
 *
 * VARIAS INSTANCIAS. El reloj y las revocaciones viven en la memoria de ESTE
 * proceso, igual que la presencia. Con varias instancias, una revocacion hecha
 * en la instancia A no levanta la barrera de la instancia B: los sockets de B
 * se cortarian en su siguiente `remote-session:join` o `webrtc:*` (que revalidan
 * contra PostgreSQL) pero un handshake en vuelo en B podria completarse. Hara
 * falta difundir `revoke` entre instancias (adaptador compartido o
 * `LISTEN/NOTIFY` de PostgreSQL) cuando exista mas de una; hoy el backend es
 * una sola instancia.
 *
 * Tras reiniciar el proceso no queda nada que recordar: todos los sockets
 * anteriores murieron con el proceso y cualquier handshake nuevo lee el estado
 * ya confirmado.
 */
@Injectable()
export class IdentityRevocationService {
  private readonly logger = new Logger(IdentityRevocationService.name);

  /** Tick actual. Solo avanza. */
  private clock = 0;

  /**
   * `kind:id` -> tick de su ultima revocacion.
   *
   * Crece solo con identidades revocadas (desactivaciones y re-enrolamientos),
   * no con conexiones: una entrada por dispositivo o tecnico revocado.
   */
  private readonly revokedAt = new Map<string, number>();

  private readonly listeners = new Set<IdentityRevokedListener>();

  /** Sello que se toma antes de leer el estado de PostgreSQL. */
  stamp(): number {
    return this.clock;
  }

  /**
   * La identidad perdio la autorizacion, YA CONFIRMADA en PostgreSQL (o
   * detectada al releerla).
   *
   * Todo sello tomado hasta ahora queda inutil para esa identidad. Los listeners
   * corren despues, de forma sincrona, y uno que falle no impide al resto.
   */
  revoke(kind: RevocableIdentityKind, id: string): void {
    this.clock += 1;
    this.revokedAt.set(this.keyOf(kind, id), this.clock);

    for (const listener of this.listeners) {
      try {
        listener(kind, id);
      } catch (error) {
        this.logger.error(
          `Revocation listener failed for ${kind} ${id}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  /**
   * `false` si la identidad fue revocada despues de tomarse `stamp`.
   *
   * `true` NO autoriza: solo dice que la barrera no tiene nada en contra.
   */
  isAdmissible(
    kind: RevocableIdentityKind,
    id: string,
    stamp: number,
  ): boolean {
    const revokedAt = this.revokedAt.get(this.keyOf(kind, id));

    return revokedAt === undefined || revokedAt <= stamp;
  }

  /** Suscripcion a las revocaciones. Devuelve como darse de baja. */
  subscribe(listener: IdentityRevokedListener): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  private keyOf(kind: RevocableIdentityKind, id: string): string {
    return `${kind}:${id}`;
  }
}
