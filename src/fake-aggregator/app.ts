import { Hono } from 'hono';

// Stand-in for the RastroHub service. Used by the tests and by `npm run dev`.
// /v1 mimics the real API; /_sim lets a script (or curl) append checkpoints exactly
// as given, which is how repeated and out-of-order deliveries are produced.

export interface FakeCheckpoint {
  id?: string | number;
  tag: string;
  subtag?: string | null;
  message?: string;
  checkpoint_time: string;
  location?: { city: string; state: string } | string | null;
}

interface FakeTracking {
  carrier: string;
  checkpoints: FakeCheckpoint[];
}

const CARRIERS = ['correios', 'jadlog', 'loggi'];

export interface FakeAggregator {
  app: Hono;
  trackings: Map<string, FakeTracking>;
  failNext(status: number, times?: number): void;
}

export function createFakeAggregator(opts: { apiKey?: string } = {}): FakeAggregator {
  const apiKey = opts.apiKey ?? 'dev-key';
  const trackings = new Map<string, FakeTracking>();
  let failure: { status: number; times: number } | null = null;
  const app = new Hono();

  app.use('/v1/*', async (c, next) => {
    if (c.req.header('authorization') !== `Bearer ${apiKey}`) {
      return c.json({ error: { code: 'unauthorized' } }, 401);
    }
    if (failure && failure.times > 0) {
      failure.times -= 1;
      return c.json({ error: { code: 'upstream_error' } }, failure.status as 500);
    }
    await next();
  });

  app.post('/v1/trackings', async (c) => {
    const body = await c.req.json().catch(() => null);
    const number = body?.number;
    const carrier = body?.carrier;
    if (typeof number !== 'string' || !CARRIERS.includes(carrier)) {
      return c.json({ error: { code: 'invalid_tracking' } }, 422);
    }
    const existing = trackings.get(number);
    if (existing && existing.carrier !== carrier) {
      return c.json({ error: { code: 'carrier_mismatch' } }, 409);
    }
    if (!existing) trackings.set(number, { carrier, checkpoints: [] });
    return c.json({ tracking: { number, carrier, status: 'registered' } }, existing ? 200 : 201);
  });

  app.get('/v1/trackings/:number', (c) => {
    const number = c.req.param('number');
    const t = trackings.get(number);
    if (!t) return c.json({ error: { code: 'not_found', message: `no tracking ${number}` } }, 404);
    return c.json({ tracking: { number, carrier: t.carrier }, checkpoints: t.checkpoints });
  });

  app.post('/_sim/trackings/:number/checkpoints', async (c) => {
    const t = trackings.get(c.req.param('number'));
    if (!t) return c.json({ error: { code: 'not_found' } }, 404);
    const body = await c.req.json().catch(() => null);
    const list: FakeCheckpoint[] = Array.isArray(body) ? body : [body];
    t.checkpoints.push(...list);
    return c.json({ checkpoints: t.checkpoints.length }, 201);
  });

  app.post('/_sim/fail', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    failure = { status: Number(body.status) || 503, times: Number(body.times) || 1 };
    return c.json(failure);
  });

  return {
    app,
    trackings,
    failNext(status, times = 1) {
      failure = { status, times };
    },
  };
}
