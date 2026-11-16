import { describe, expect, it, vi } from 'vitest';
import { createMicPermissionStore } from './mic-permission';

class FakeStatus extends EventTarget {
  state: string;
  constructor(state: string) {
    super();
    this.state = state;
  }
  set(state: string) {
    this.state = state;
    this.dispatchEvent(new Event('change'));
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createMicPermissionStore', () => {
  it('is unsupported when navigator.permissions is missing', () => {
    const store = createMicPermissionStore({});
    expect(store.getState()).toBe('unsupported');
  });

  it('is unsupported when the microphone query is rejected', async () => {
    const query = vi.fn().mockRejectedValue(new TypeError('unknown permission'));
    const store = createMicPermissionStore({ permissions: { query } });
    store.subscribe(() => undefined);
    await flush();
    expect(store.getState()).toBe('unsupported');
  });

  it('follows the permission status, including a change from granted to denied', async () => {
    const status = new FakeStatus('granted');
    const query = vi.fn().mockResolvedValue(status);
    const store = createMicPermissionStore({ permissions: { query } });
    const listener = vi.fn();
    store.subscribe(listener);
    await flush();
    expect(query).toHaveBeenCalledWith({ name: 'microphone' });
    expect(store.getState()).toBe('granted');
    status.set('denied');
    expect(store.getState()).toBe('denied');
    expect(listener).toHaveBeenCalled();
  });

  it('stops listening once the last subscriber leaves', async () => {
    const status = new FakeStatus('prompt');
    const store = createMicPermissionStore({
      permissions: { query: vi.fn().mockResolvedValue(status) },
    });
    const unsubscribe = store.subscribe(() => undefined);
    await flush();
    unsubscribe();
    status.set('granted');
    expect(store.getState()).toBe('prompt');
  });

  describe('request', () => {
    it('stops the probe tracks and reports granted', async () => {
      const stop = vi.fn();
      const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }, { stop }] });
      const store = createMicPermissionStore({ mediaDevices: { getUserMedia } });
      await expect(store.request()).resolves.toBe('granted');
      expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
      expect(stop).toHaveBeenCalledTimes(2);
    });

    it('reports denied when the browser refuses', async () => {
      const getUserMedia = vi
        .fn()
        .mockRejectedValue(new DOMException('blocked', 'NotAllowedError'));
      const store = createMicPermissionStore({ mediaDevices: { getUserMedia } });
      await expect(store.request()).resolves.toBe('denied');
      expect(store.getState()).toBe('denied');
    });

    it('reports denied when there is no media API', async () => {
      const store = createMicPermissionStore({});
      await expect(store.request()).resolves.toBe('denied');
    });
  });
});
