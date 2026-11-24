import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android', Version: 34, constants: { Model: 'Pixel 8', Manufacturer: 'Google' } } }));

describe('React Native SDK', () => {
  it('reports fatal JS errors, saves them, then calls the previous handler', async () => {
    (globalThis as any).__DEV__ = false;
    let handler: (e: unknown, fatal?: boolean) => void = () => {};
    const previous = vi.fn();
    (globalThis as any).ErrorUtils = { getGlobalHandler: () => previous, setGlobalHandler: (h: typeof handler) => (handler = h) };
    const saved: Record<string, string> = {};
    const storage = { getItem: async (k: string) => saved[k] ?? null, setItem: async (k: string, v: string) => void (saved[k] = v), removeItem: async () => {} };
    const sent: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: 503 }); // offline backend: crash must stay saved
    }) as typeof fetch;

    const { ApiStudio, trackNavigation } = await import('../src/index');
    ApiStudio.init({ apiKey: 'rn-key', storage, captureNetwork: false, flushIntervalMs: 60_000 });

    await new Promise((r) => setTimeout(r, 5)); // install id is read from storage at startup
    let route = 'Cart';
    const onStateChange = trackNavigation({ getCurrentRoute: () => ({ name: route }) });
    onStateChange();
    route = 'Checkout';
    onStateChange();

    handler(new TypeError("Cannot read properties of undefined (reading 'total')"), true);
    await vi.waitFor(() => expect(previous).toHaveBeenCalledTimes(1));

    const queued = JSON.parse(saved['apistudio.errors']!);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      exception_type: 'TypeError',
      fatal: true,
      handled: false,
      device: { os: 'android', os_version: '34', model: 'Pixel 8' },
      sdk: { name: 'api_studio.react_native', platform: 'react-native' },
    });
    expect(queued[0].breadcrumbs.map((b: any) => b.message)).toEqual(['Cart', 'Cart → Checkout']);
    expect(queued[0].device.install_id).toBeTruthy();
    expect(sent[0].events[0].exception_type).toBe('TypeError');

    await ApiStudio.close();
    globalThis.fetch = realFetch;
  });
});
