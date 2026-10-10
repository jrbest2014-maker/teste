import { describe, it, expect, beforeEach } from 'vitest';
import { getOrCreateDeviceId } from './deviceId';

describe('getOrCreateDeviceId', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('cria um device id persistido na primeira chamada', () => {
    const id = getOrCreateDeviceId();
    expect(id).toMatch(/^vone-studio-/);
    expect(localStorage.getItem('vone-device-id')).toBe(id);
  });

  it('devolve o mesmo id em chamadas seguintes (estável entre reloads)', () => {
    const first = getOrCreateDeviceId();
    const second = getOrCreateDeviceId();
    expect(second).toBe(first);
  });

  it('cai pra um id efêmero se localStorage lançar erro', () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('blocked');
    };
    try {
      const id = getOrCreateDeviceId();
      expect(id).toMatch(/^vone-studio-ephemeral-/);
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});
