import { describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({ listeners: [] as Array<(state: string) => void>, removed: 0 }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', Version: '17.0' },
  AppState: {
    addEventListener: (_type: string, listener: (state: string) => void) => {
      appState.listeners.push(listener);
      return { remove: () => void appState.removed++ };
    },
  },
}));

describe('React Native background flush', () => {
  it('sends queued logs when the app goes to the background', async () => {
    (globalThis as any).__DEV__ = false;
    const sent: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: 202 });
    }) as typeof fetch;

    const { ApiStudio } = await import('../src/index');
    // No XMLHttpRequest in Node, so network capture installs nothing; recordRequest still records.
    ApiStudio.init({ apiKey: 'rn-key', captureErrors: false, flushIntervalMs: 60_000 });
    await new Promise((r) => setTimeout(r, 5));
    sent.length = 0;

    ApiStudio.recordRequest({ method: 'GET', url: 'https://api.test/cart', startedAt: Date.now(), durationMs: 5, statusCode: 200 });
    expect(appState.listeners).toHaveLength(1);
    appState.listeners[0]!('background');
    await vi.waitFor(() => expect(sent.some((b) => Array.isArray(b.logs) && b.logs.length === 1)).toBe(true));

    await ApiStudio.close();
    expect(appState.removed).toBe(1);
    globalThis.fetch = realFetch;
  });
});
