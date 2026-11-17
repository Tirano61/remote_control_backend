import {
  DEFAULT_REMOTE_SESSION_LIFECYCLE_CONFIG,
  REMOTE_SESSION_CONNECTING_TTL_MS_ENV,
  REMOTE_SESSION_DISCONNECT_GRACE_MS_ENV,
  REMOTE_SESSION_STARTUP_RECOVERY_MS_ENV,
  resolveRemoteSessionLifecycleConfig,
} from './remote-session-lifecycle.config';

describe('resolveRemoteSessionLifecycleConfig', () => {
  it('usa los valores por defecto documentados sin variables', () => {
    expect(resolveRemoteSessionLifecycleConfig({})).toEqual({
      disconnectGraceMs: 60_000,
      connectingTtlMs: 120_000,
      startupRecoveryMs: 90_000,
    });
    expect(DEFAULT_REMOTE_SESSION_LIFECYCLE_CONFIG.disconnectGraceMs).toBe(
      60_000,
    );
  });

  it('trata las variables vacias como ausentes', () => {
    expect(
      resolveRemoteSessionLifecycleConfig({
        [REMOTE_SESSION_DISCONNECT_GRACE_MS_ENV]: '  ',
      }).disconnectGraceMs,
    ).toBe(60_000);
  });

  it('lee los tres valores del entorno', () => {
    expect(
      resolveRemoteSessionLifecycleConfig({
        [REMOTE_SESSION_DISCONNECT_GRACE_MS_ENV]: '30000',
        [REMOTE_SESSION_CONNECTING_TTL_MS_ENV]: ' 180000 ',
        [REMOTE_SESSION_STARTUP_RECOVERY_MS_ENV]: '45000',
      }),
    ).toEqual({
      disconnectGraceMs: 30_000,
      connectingTtlMs: 180_000,
      startupRecoveryMs: 45_000,
    });
  });

  it.each(['abc', '-1', '1.5', '60s', '1e5'])(
    'rechaza un valor que no es un entero de ms: %s',
    (raw) => {
      expect(() =>
        resolveRemoteSessionLifecycleConfig({
          [REMOTE_SESSION_DISCONNECT_GRACE_MS_ENV]: raw,
        }),
      ).toThrow(REMOTE_SESSION_DISCONNECT_GRACE_MS_ENV);
    },
  );

  it('rechaza valores fuera de rango, nombrando la variable', () => {
    expect(() =>
      resolveRemoteSessionLifecycleConfig({
        [REMOTE_SESSION_CONNECTING_TTL_MS_ENV]: '100',
      }),
    ).toThrow(REMOTE_SESSION_CONNECTING_TTL_MS_ENV);

    expect(() =>
      resolveRemoteSessionLifecycleConfig({
        [REMOTE_SESSION_STARTUP_RECOVERY_MS_ENV]: '86400000',
      }),
    ).toThrow(REMOTE_SESSION_STARTUP_RECOVERY_MS_ENV);
  });
});
