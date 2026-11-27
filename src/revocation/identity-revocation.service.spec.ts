import { Logger } from '@nestjs/common';
import {
  IdentityRevocationService,
  RevocableIdentityKind,
} from './identity-revocation.service';

const { DEVICE, TECHNICIAN } = RevocableIdentityKind;

const DEVICE_A = '550e8400-e29b-41d4-a716-446655440000';
const DEVICE_B = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('IdentityRevocationService (barrera de revocacion)', () => {
  let barrier: IdentityRevocationService;

  beforeEach(() => {
    barrier = new IdentityRevocationService();
  });

  it('sin revocaciones, cualquier sello es admisible', () => {
    expect(barrier.isAdmissible(DEVICE, DEVICE_A, barrier.stamp())).toBe(true);
  });

  it('un sello tomado ANTES de la revocacion deja de ser admisible', () => {
    const before = barrier.stamp();

    barrier.revoke(DEVICE, DEVICE_A);

    expect(barrier.isAdmissible(DEVICE, DEVICE_A, before)).toBe(false);
  });

  it('un sello tomado DESPUES de la revocacion vuelve a ser admisible (handshake nuevo)', () => {
    barrier.revoke(DEVICE, DEVICE_A);

    expect(barrier.isAdmissible(DEVICE, DEVICE_A, barrier.stamp())).toBe(true);
  });

  it('una segunda revocacion invalida tambien los sellos posteriores a la primera', () => {
    barrier.revoke(DEVICE, DEVICE_A);
    const between = barrier.stamp();

    barrier.revoke(DEVICE, DEVICE_A);

    expect(barrier.isAdmissible(DEVICE, DEVICE_A, between)).toBe(false);
  });

  it('solo afecta a esa identidad: ni a otro dispositivo ni a un tecnico con el mismo id', () => {
    const stamp = barrier.stamp();

    barrier.revoke(DEVICE, DEVICE_A);

    expect(barrier.isAdmissible(DEVICE, DEVICE_B, stamp)).toBe(true);
    expect(barrier.isAdmissible(TECHNICIAN, DEVICE_A, stamp)).toBe(true);
  });

  it('avisa a los listeners de forma sincrona, con la barrera ya levantada', () => {
    const stamp = barrier.stamp();
    const seen: Array<[RevocableIdentityKind, string, boolean]> = [];

    barrier.subscribe((kind, id) =>
      seen.push([kind, id, barrier.isAdmissible(kind, id, stamp)]),
    );

    barrier.revoke(TECHNICIAN, DEVICE_A);

    expect(seen).toEqual([[TECHNICIAN, DEVICE_A, false]]);
  });

  it('un listener que falla no impide la revocacion ni a los demas', () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const stamp = barrier.stamp();
    const second = jest.fn();

    barrier.subscribe(() => {
      throw new Error('boom');
    });
    barrier.subscribe(second);

    expect(() => barrier.revoke(DEVICE, DEVICE_A)).not.toThrow();
    expect(second).toHaveBeenCalledWith(DEVICE, DEVICE_A);
    expect(barrier.isAdmissible(DEVICE, DEVICE_A, stamp)).toBe(false);
  });

  it('darse de baja deja de recibir avisos', () => {
    const listener = jest.fn();
    const unsubscribe = barrier.subscribe(listener);

    unsubscribe();
    barrier.revoke(DEVICE, DEVICE_A);

    expect(listener).not.toHaveBeenCalled();
  });
});
