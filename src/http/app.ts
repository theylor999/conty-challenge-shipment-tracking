import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { AppError } from '../errors.ts';
import { ProviderError, type TrackingProvider } from '../provider/provider.ts';
import type { ShipmentService } from '../service.ts';

export interface AppDeps {
  service: ShipmentService;
  provider: TrackingProvider;
  webhookToken: string | null;
}

const HTTP_BY_APP_ERROR = { validation: 400, not_found: 404, conflict: 409 } as const;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError('validation', 'body must be valid JSON');
  }
}

export function createApp({ service, provider, webhookToken }: AppDeps): Hono {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  app.post('/shipments', async (c) => {
    const body = await readJson(c);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new AppError('validation', 'body must be a JSON object');
    }
    const { code, carrier, campaign_id } = body as Record<string, unknown>;
    const { shipment, created } = await service.register({ code, carrier, campaign_id });
    return c.json(shipment, created ? 201 : 200);
  });

  app.get('/shipments', (c) => {
    const late = c.req.query('late');
    if (late !== undefined && late !== 'true' && late !== 'false') {
      throw new AppError('validation', 'late must be true or false');
    }
    const shipments = service.list({
      ...(late === undefined ? {} : { late: late === 'true' }),
      ...(c.req.query('campaign_id') ? { campaign_id: c.req.query('campaign_id')! } : {}),
    });
    return c.json({ shipments });
  });

  app.get('/shipments/:id', (c) => c.json(service.get(c.req.param('id'))));

  app.post('/shipments/:id/refresh', async (c) => {
    const { shipment, refresh } = await service.refresh(c.req.param('id'));
    return c.json({ ...shipment, refresh });
  });

  if (webhookToken && provider.parseWebhook) {
    const parse = provider.parseWebhook.bind(provider);
    app.post('/webhooks/aggregator', async (c) => {
      if (!safeEqual(c.req.header('x-webhook-token') ?? '', webhookToken)) {
        return c.json({ error: { code: 'unauthorized', message: 'bad webhook token' } }, 401);
      }
      const body = await readJson(c);
      let refresh: ReturnType<typeof service.ingestWebhook>;
      try {
        const parsed = parse(body);
        refresh = service.ingestWebhook(parsed.code, parsed.events);
      } catch (err) {
        if (err instanceof ProviderError) throw new AppError('validation', err.message);
        throw err;
      }
      // 2xx for unknown codes: the aggregator would retry a 404 forever.
      return c.json(refresh ? { ...refresh, ignored: false } : { ignored: true }, 202);
    });
  }

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message } }, HTTP_BY_APP_ERROR[err.code]);
    }
    if (err instanceof ProviderError) {
      return c.json({ error: { code: `provider_${err.kind}`, message: err.message } }, 502);
    }
    console.error(err);
    return c.json({ error: { code: 'internal', message: 'unexpected error' } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'route not found' } }, 404));

  return app;
}
