import { describe, expect, it, vi } from 'vite-plus/test';
import { tryConfigFingerprint } from '../../src/textlint/config-fingerprint.js';

describe('tryConfigFingerprint', () => {
  it('distinguishes exact primitive values and insertion order', () => {
    expect(tryConfigFingerprint({ value: -0 })).not.toBe(tryConfigFingerprint({ value: 0 }));
    expect(tryConfigFingerprint({ first: 1, second: 2 })).not.toBe(
      tryConfigFingerprint({ second: 2, first: 1 }),
    );
    expect(tryConfigFingerprint({ value: 'a\x1fb' })).not.toBe(
      tryConfigFingerprint({ value: 'a', b: '' }),
    );
  });

  it('rejects values that cannot be read without loss or side effects', () => {
    let accessorReads = 0;
    const accessor = {};
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 'unsafe';
      },
    });
    const proxy = new Proxy({}, { ownKeys: () => ['hidden'] });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(tryConfigFingerprint({ values: [() => 'unsafe'] })).toBeUndefined();
    expect(tryConfigFingerprint(accessor)).toBeUndefined();
    expect(accessorReads).toBe(0);
    expect(tryConfigFingerprint(proxy)).toBeUndefined();
    expect(tryConfigFingerprint(cyclic)).toBeUndefined();
  });

  it('bounds repeated acyclic references by unique object count', () => {
    let graph: object = { leaf: true };
    for (let depth = 0; depth < 30; depth += 1) graph = { left: graph, right: graph };

    expect(tryConfigFingerprint(graph)).toBeDefined();
  });

  it('does not trust host reflection replacements present before module evaluation', async () => {
    vi.resetModules();
    const originalOwnKeys = Reflect.ownKeys;
    const originalDescriptor = Reflect.getOwnPropertyDescriptor;
    const originalGetPrototypeOf = Object.getPrototypeOf;
    Reflect.ownKeys = (target: object): (string | symbol)[] => {
      const keys = originalOwnKeys(target);
      return originalDescriptor(target, 'approvedTerms') === undefined
        ? keys
        : keys.filter((key) => key !== 'approvedTerms');
    };
    Object.getPrototypeOf = (target: object): object | null =>
      target instanceof Date ? Object.prototype : originalGetPrototypeOf(target);
    try {
      const reloaded = await import('../../src/textlint/config-fingerprint.js');
      expect(reloaded.tryConfigFingerprint({ approvedTerms: [] })).not.toBe(
        reloaded.tryConfigFingerprint({ approvedTerms: ['Utilise'] }),
      );
      expect(reloaded.tryConfigFingerprint(new Date(0))).toBeUndefined();
    } finally {
      Reflect.ownKeys = originalOwnKeys;
      Object.getPrototypeOf = originalGetPrototypeOf;
      vi.resetModules();
    }
  });
});
