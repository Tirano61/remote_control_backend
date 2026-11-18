import { SignalingParticipant } from '../interfaces/signaling-participant.interface';
import {
  SessionParticipationChange,
  SessionParticipationEvent,
  SessionParticipationService,
} from './session-participation.service';

const SESSION = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const OTHER_SESSION = '2c8e7cde-ccfe-4c3e-8c6e-bc9efcce5cfe';
const { DEVICE, TECHNICIAN } = SignalingParticipant;

describe('SessionParticipationService', () => {
  let service: SessionParticipationService;
  let events: SessionParticipationEvent[];

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-11-17T10:00:00.000Z') });
    service = new SessionParticipationService();
    events = [];
    service.subscribe((event) => events.push(event));
  });

  afterEach(() => jest.useRealTimers());

  it('nadie participa hasta que hay un join', () => {
    expect(service.isPresent(SESSION, TECHNICIAN)).toBe(false);
    expect(service.absentSince(SESSION, TECHNICIAN)).toBeNull();
  });

  it('el primer socket avisa PRESENT y el segundo no avisa nada', () => {
    service.join(SESSION, TECHNICIAN, 'tab-1');
    service.join(SESSION, TECHNICIAN, 'tab-2');

    expect(events).toEqual([
      expect.objectContaining({
        remoteSessionId: SESSION,
        participant: TECHNICIAN,
        change: SessionParticipationChange.PRESENT,
        episode: 0,
      }),
    ]);
    expect(service.socketCount(SESSION, TECHNICIAN)).toBe(2);
  });

  it('solo avisa ABSENT cuando se va el ultimo socket, con la hora y el episodio', () => {
    service.join(SESSION, TECHNICIAN, 'tab-1');
    service.join(SESSION, TECHNICIAN, 'tab-2');
    events = [];

    service.leave(SESSION, TECHNICIAN, 'tab-1');
    expect(events).toEqual([]);
    expect(service.isPresent(SESSION, TECHNICIAN)).toBe(true);

    jest.advanceTimersByTime(1_000);
    service.leave(SESSION, TECHNICIAN, 'tab-2');

    expect(events).toEqual([
      {
        remoteSessionId: SESSION,
        participant: TECHNICIAN,
        change: SessionParticipationChange.ABSENT,
        episode: 1,
        at: Date.now(),
      },
    ]);
    expect(service.absentSince(SESSION, TECHNICIAN)).toBe(Date.now());
  });

  it('una baja repetida o de un socket desconocido no cambia nada', () => {
    service.join(SESSION, DEVICE, 'old');
    service.leave(SESSION, DEVICE, 'old');
    events = [];

    service.leave(SESSION, DEVICE, 'old');
    service.leave(SESSION, DEVICE, 'nunca-unido');
    service.leave(OTHER_SESSION, DEVICE, 'old');

    expect(events).toEqual([]);
    expect(service.absentSince(SESSION, DEVICE)).not.toBeNull();
  });

  it('el socket viejo que se va tarde no anula al nuevo', () => {
    service.join(SESSION, DEVICE, 'old');
    service.join(SESSION, DEVICE, 'new');
    events = [];

    service.leave(SESSION, DEVICE, 'old');

    expect(service.isPresent(SESSION, DEVICE)).toBe(true);
    expect(events).toEqual([]);
  });

  it('volver a unirse recupera y limpia absentSince; los episodios crecen', () => {
    service.join(SESSION, DEVICE, 'a');
    service.leave(SESSION, DEVICE, 'a');
    service.join(SESSION, DEVICE, 'b');
    service.leave(SESSION, DEVICE, 'b');
    service.join(SESSION, DEVICE, 'c');

    expect(events.map((event) => [event.change, event.episode])).toEqual([
      [SessionParticipationChange.PRESENT, 0],
      [SessionParticipationChange.ABSENT, 1],
      [SessionParticipationChange.PRESENT, 1],
      [SessionParticipationChange.ABSENT, 2],
      [SessionParticipationChange.PRESENT, 2],
    ]);
    expect(service.absentSince(SESSION, DEVICE)).toBeNull();
  });

  it('los extremos y las sesiones son independientes', () => {
    service.join(SESSION, TECHNICIAN, 'tab');

    expect(service.isPresent(SESSION, DEVICE)).toBe(false);
    expect(service.isPresent(OTHER_SESSION, TECHNICIAN)).toBe(false);
  });

  it('forget borra la sesion y las bajas posteriores no avisan', () => {
    service.join(SESSION, TECHNICIAN, 'tab');
    service.forget(SESSION);
    events = [];

    service.leave(SESSION, TECHNICIAN, 'tab');

    expect(events).toEqual([]);
    expect(service.isPresent(SESSION, TECHNICIAN)).toBe(false);
  });

  it('un listener que falla no rompe el join ni a otros listeners', () => {
    const other = jest.fn();
    service.subscribe(() => {
      throw new Error('boom');
    });
    service.subscribe(other);

    expect(() => service.join(SESSION, DEVICE, 'a')).not.toThrow();
    expect(other).toHaveBeenCalledTimes(1);
    expect(service.isPresent(SESSION, DEVICE)).toBe(true);
  });

  it('darse de baja deja de recibir avisos', () => {
    const listener = jest.fn();
    const unsubscribe = service.subscribe(listener);

    unsubscribe();
    service.join(SESSION, DEVICE, 'a');

    expect(listener).not.toHaveBeenCalled();
  });
});
