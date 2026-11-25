import { createServer, connect, Server, Socket } from 'net';

/**
 * Sentido del trafico a traves del relay.
 *
 * - `toServer`: lo que el cliente envia (sus PONG, sus eventos).
 * - `toClient`: lo que el servidor envia (sus PING, sus eventos, su cierre).
 */
export type RelayDirection = 'toServer' | 'toClient';

export const BOTH_DIRECTIONS: readonly RelayDirection[] = [
  'toServer',
  'toClient',
];

/**
 * Relay TCP local que simula una conexion medio abierta.
 *
 * Mientras un sentido esta cortado, todo lo que entra por el se RETIENE: datos,
 * FIN y RST. Ningun extremo recibe un error ni un cierre; para TCP la conexion
 * sigue viva y solo el heartbeat de Engine.IO puede notar que no pasa nada. Es
 * lo que ocurre cuando la red deja de entregar paquetes (Wi-Fi que se va sin
 * avisar, NAT que olvida la conexion, firewall que descarta).
 *
 * Al restaurar se entrega lo retenido, en orden, igual que haria TCP al
 * retransmitir cuando la red vuelve: un corte breve no pierde ni corrompe nada.
 * Si durante el corte un extremo cerro su socket, el cierre llega al otro al
 * restaurar, como el RST que recibiria al volver la red.
 *
 * Las conexiones nuevas que llegan durante un corte tambien quedan retenidas en
 * los sentidos cortados: un cliente que intenta reconectar sin red no lo logra
 * hasta que la red vuelve.
 *
 * Solo escucha en 127.0.0.1 y solo reenvia al puerto local indicado.
 */
export class HalfOpenRelay {
  private readonly pairs = new Set<RelayPair>();
  private readonly blocked: Record<RelayDirection, boolean> = {
    toServer: false,
    toClient: false,
  };

  private constructor(
    private readonly server: Server,
    readonly port: number,
  ) {}

  static start(targetPort: number): Promise<HalfOpenRelay> {
    return new Promise((resolve, reject) => {
      // Se asigna al empezar a escuchar, antes de aceptar ninguna conexion.
      let relay: HalfOpenRelay;

      const server = createServer({ allowHalfOpen: true }, (client) => {
        const upstream = connect({
          host: '127.0.0.1',
          port: targetPort,
          allowHalfOpen: true,
        });

        relay.adopt(new RelayPair(client, upstream, relay.blocked));
      });

      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();

        if (!address || typeof address === 'string') {
          reject(new Error('Relay sin puerto'));
          return;
        }

        relay = new HalfOpenRelay(server, address.port);
        resolve(relay);
      });
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Conexiones TCP vivas a traves del relay. */
  get openConnections(): number {
    return this.pairs.size;
  }

  /** Corta uno o los dos sentidos, para las conexiones vivas y las nuevas. */
  cut(directions: readonly RelayDirection[] = BOTH_DIRECTIONS): void {
    for (const direction of directions) this.blocked[direction] = true;
  }

  /** Vuelve la red: entrega lo retenido, cierres incluidos. */
  restore(): void {
    this.blocked.toServer = false;
    this.blocked.toClient = false;

    for (const pair of this.pairs) pair.flush();
  }

  /**
   * Cierre limpio de la red: destruye todas las conexiones en los dos extremos
   * (los dos reciben el cierre de inmediato). Es el caso que NO necesita
   * heartbeat para detectarse.
   */
  resetAll(): void {
    for (const pair of this.pairs) pair.destroy();
  }

  async close(): Promise<void> {
    this.restore();
    this.resetAll();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private adopt(pair: RelayPair): void {
    this.pairs.add(pair);
    pair.onDone(() => this.pairs.delete(pair));
  }
}

/** Una conexion cliente <-> servidor con un sentido de retencion por lado. */
class RelayPair {
  private readonly toServer: HeldStream;
  private readonly toClient: HeldStream;
  private done = false;
  private doneListener?: () => void;

  constructor(
    private readonly client: Socket,
    private readonly upstream: Socket,
    blocked: Record<RelayDirection, boolean>,
  ) {
    this.toServer = new HeldStream(client, upstream, () => blocked.toServer);
    this.toClient = new HeldStream(upstream, client, () => blocked.toClient);

    const settle = () => {
      if (
        !this.done &&
        this.client.destroyed &&
        this.upstream.destroyed &&
        this.toServer.idle &&
        this.toClient.idle
      ) {
        this.done = true;
        this.doneListener?.();
      }
    };

    client.on('close', settle);
    upstream.on('close', settle);
    this.toServer.onIdle(settle);
    this.toClient.onIdle(settle);
  }

  onDone(listener: () => void): void {
    this.doneListener = listener;
  }

  flush(): void {
    this.toServer.flush();
    this.toClient.flush();
  }

  destroy(): void {
    this.client.destroy();
    this.upstream.destroy();
    this.toServer.discard();
    this.toClient.discard();
  }
}

/**
 * Un sentido de la conexion: copia `from` en `to`, salvo mientras esta cortado,
 * en cuyo caso retiene los datos y el final (FIN o cierre abrupto) hasta
 * `flush()`.
 */
class HeldStream {
  private readonly queue: Buffer[] = [];
  private pendingEnd: 'end' | 'destroy' | null = null;
  private ended = false;
  private idleListener?: () => void;

  constructor(
    private readonly from: Socket,
    private readonly to: Socket,
    private readonly isBlocked: () => boolean,
  ) {
    // Un error de un extremo equivale a su cierre abrupto: se trata en 'close'.
    from.on('error', () => undefined);

    from.on('data', (chunk: Buffer) => {
      if (this.isBlocked() || this.queue.length > 0) this.queue.push(chunk);
      else this.write(chunk);
    });

    from.on('end', () => this.finish('end'));
    from.on('close', (hadError: boolean) =>
      this.finish(hadError ? 'destroy' : 'end'),
    );
  }

  get idle(): boolean {
    return this.queue.length === 0 && this.pendingEnd === null;
  }

  onIdle(listener: () => void): void {
    this.idleListener = listener;
  }

  flush(): void {
    if (this.isBlocked()) return;

    while (this.queue.length > 0) this.write(this.queue.shift() as Buffer);

    const end = this.pendingEnd;
    this.pendingEnd = null;

    if (end) this.applyEnd(end);

    this.idleListener?.();
  }

  discard(): void {
    this.queue.length = 0;
    this.pendingEnd = null;
    this.idleListener?.();
  }

  private finish(kind: 'end' | 'destroy'): void {
    // 'end' y luego 'close': el primero que llega decide, salvo que el segundo
    // sea un cierre abrupto.
    if (this.pendingEnd === 'destroy') return;

    if (this.isBlocked() || this.queue.length > 0) {
      this.pendingEnd = kind;
      return;
    }

    this.applyEnd(kind);
  }

  private write(chunk: Buffer): void {
    if (!this.to.destroyed && this.to.writable) this.to.write(chunk);
  }

  private applyEnd(kind: 'end' | 'destroy'): void {
    if (this.to.destroyed || (this.ended && kind === 'end')) return;

    this.ended = true;

    if (kind === 'destroy') this.to.destroy();
    else this.to.end();
  }
}
