import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import type { Clock } from '../../src/clock.ts';
import { loadConfig, type Config } from '../../src/config.ts';
import type { CarrierEvent } from '../../src/domain/types.ts';
import { createFakeAggregator } from '../../src/fake-aggregator/app.ts';
import type { TrackingProvider } from '../../src/provider/provider.ts';
import { buildApp } from '../../src/wiring.ts';

export const CODE = 'AA123456789BR';
export const T0 = new Date('2026-03-01T10:00:00.000Z');
export const HOUR = 3_600_000;
export const at = (hoursAfterT0: number) => new Date(T0.getTime() + hoursAfterT0 * HOUR);

export class ManualClock implements Clock {
  constructor(private current: Date) {}
  now() {
    return new Date(this.current);
  }
  set(date: Date) {
    this.current = date;
  }
}

export function ev(over: Partial<CarrierEvent> & { raw_status: string }): CarrierEvent {
  return {
    carrier: 'correios',
    raw_description: '',
    occurred_at: T0,
    location: null,
    ...over,
  };
}

export class StubProvider implements TrackingProvider {
  events: CarrierEvent[] = [];
  registered: Array<[string, string]> = [];
  failure: Error | null = null;
  async register(code: string, carrier: string) {
    this.registered.push([code, carrier]);
  }
  async fetchEvents(): Promise<CarrierEvent[]> {
    if (this.failure) throw this.failure;
    return [...this.events];
  }
}

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ DB_PATH: ':memory:', MAX_TRANSIT_HOURS: '120', CONTENT_DAYS_AFTER_DELIVERY: '7', ...env });
}

export function makeApp(provider: TrackingProvider, opts: { env?: Record<string, string>; clock?: ManualClock } = {}) {
  const clock = opts.clock ?? new ManualClock(T0);
  const alerts: unknown[] = [];
  const built = buildApp({
    config: testConfig(opts.env),
    provider,
    clock,
    onDelayAlert: (n) => alerts.push(n),
  });
  return { ...built, clock, alerts };
}

export async function startFakeAggregator(apiKey = 'test-key') {
  const fake = createFakeAggregator({ apiKey });
  const server = serve({ fetch: fake.app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    fake,
    apiKey,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function json(res: Response) {
  return (await res.json()) as any;
}
