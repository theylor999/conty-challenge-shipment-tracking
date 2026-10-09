import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RastroHubClient } from '../src/provider/rastrohub/client.ts';
import { CODE, json, makeApp, startFakeAggregator, at } from './helpers/index.ts';
import type { FakeCheckpoint } from '../src/fake-aggregator/app.ts';

// Whole stack: Hono API -> service -> RastroHubClient -> real HTTP -> fake aggregator.
let agg: Awaited<ReturnType<typeof startFakeAggregator>>;
let ctx: ReturnType<typeof makeApp>;

const cp = (tag: string, h: number, extra: Partial<FakeCheckpoint> = {}): FakeCheckpoint => ({
  id: `${tag}-${h}`,
  tag,
  message: tag,
  checkpoint_time: at(h).toISOString(),
  ...extra,
});

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  ctx.app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function register(code = CODE, carrier = 'correios') {
  const res = await post('/shipments', { code, carrier, campaign_id: 'camp-1' });
  return { res, body: await json(res) };
}

beforeAll(async () => {
  agg = await startFakeAggregator();
});
afterAll(() => agg.close());
beforeEach(() => {
  agg.fake.trackings.clear();
  const client = new RastroHubClient({ baseUrl: agg.baseUrl, apiKey: agg.apiKey, timeoutMs: 2000 });
  ctx = makeApp(client, { env: { WEBHOOK_TOKEN: 'hook-secret' } });
});

describe('API', () => {
  it('registers, refreshes and reads a shipment end to end', async () => {
    const { res, body } = await register();
    expect(res.status).toBe(201);
    expect(agg.fake.trackings.has(CODE)).toBe(true);

    agg.fake.trackings.get(CODE)!.checkpoints.push(
      cp('PO', 0, { location: { city: 'Recife', state: 'PE' } }),
      cp('RO', 20),
      cp('BDE', 60, { subtag: '01', checkpoint_time: '2026-03-03T22:00:00-03:00', id: 'cp-delivered' }),
    );
    const refreshed = await json(await post(`/shipments/${body.id}/refresh`));
    expect(refreshed).toMatchObject({ status: 'delivered', refresh: { fetched: 3, inserted: 3, duplicates: 0 } });
    expect(refreshed.delivered_at).toBe('2026-03-04T01:00:00.000Z');

    const again = await json(await post(`/shipments/${body.id}/refresh`));
    expect(again.refresh).toEqual({ fetched: 3, inserted: 0, duplicates: 3 });

    const got = await json(await ctx.app.request(`/shipments/${body.id}`));
    expect(got.history.map((h: { raw_status: string }) => h.raw_status)).toEqual(['PO', 'RO', 'BDE/01']);
    expect(got.history[0].location).toBe('Recife/PE');
    expect(got.content_due_at).toBe('2026-03-11T01:00:00.000Z');
  });

  it('the aggregator repeating and reordering events does not change the outcome', async () => {
    const { body } = await register();
    const list = agg.fake.trackings.get(CODE)!.checkpoints;
    list.push(cp('BDE', 60, { subtag: '01' }), cp('RO', 20), cp('BDE', 60, { subtag: '01' }), cp('PO', 0));
    const view = await json(await post(`/shipments/${body.id}/refresh`));
    expect(view.status).toBe('delivered');
    expect(view.refresh).toEqual({ fetched: 4, inserted: 3, duplicates: 1 });
  });

  it('surfaces an invented carrier status in unmapped_events', async () => {
    const { body } = await register();
    agg.fake.trackings.get(CODE)!.checkpoints.push(cp('RO', 5), cp('XYZ', 9, { message: 'Objeto entregue ao destinatário' }));
    const view = await json(await post(`/shipments/${body.id}/refresh`));
    expect(view.status).toBe('in_transit');
    expect(view.unmapped_events).toHaveLength(1);
    expect(view.unmapped_events[0]).toMatchObject({ raw_status: 'XYZ', status: 'unknown' });
  });

  it('answers 502 with a provider code when the aggregator fails, and keeps state', async () => {
    const { body } = await register();
    agg.fake.failNext(503);
    const res = await post(`/shipments/${body.id}/refresh`);
    expect(res.status).toBe(502);
    expect((await json(res)).error.code).toBe('provider_unavailable');
  });

  it('answers 502 provider_not_found when the aggregator forgot the code', async () => {
    const { body } = await register();
    agg.fake.trackings.clear();
    const res = await post(`/shipments/${body.id}/refresh`);
    expect(res.status).toBe(502);
    expect((await json(res)).error.code).toBe('provider_not_found');
  });

  it('registering the same code twice returns 200 with the same shipment', async () => {
    const first = await register();
    const second = await register();
    expect(second.res.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect((await register(CODE, 'jadlog')).res.status).toBe(409);
  });

  it('validates input', async () => {
    expect((await post('/shipments', { code: 'x', carrier: 'correios' })).status).toBe(400);
    expect((await post('/shipments', { code: CODE, carrier: 'dhl' })).status).toBe(400);
    expect((await ctx.app.request('/shipments', { method: 'POST', body: '{nope' })).status).toBe(400);
    expect((await post('/shipments', [1])).status).toBe(400);
    expect((await ctx.app.request('/shipments?late=maybe')).status).toBe(400);
    expect((await ctx.app.request('/shipments/nope')).status).toBe(404);
    expect((await post('/shipments/nope/refresh')).status).toBe(404);
  });

  it('lists late shipments only with late=true', async () => {
    const late = (await register()).body;
    const fine = (await register('BB123456789BR')).body;
    agg.fake.trackings.get(CODE)!.checkpoints.push(cp('PO', 0));
    agg.fake.trackings.get('BB123456789BR')!.checkpoints.push(cp('PO', 0), cp('BDE', 10, { subtag: '01' }));
    ctx.clock.set(at(200));
    await post(`/shipments/${late.id}/refresh`);
    await post(`/shipments/${fine.id}/refresh`);

    const lateList = await json(await ctx.app.request('/shipments?late=true'));
    expect(lateList.shipments.map((s: { id: string }) => s.id)).toEqual([late.id]);
    expect(lateList.shipments[0].history).toBeUndefined();
    const all = await json(await ctx.app.request('/shipments?campaign_id=camp-1'));
    expect(all.shipments).toHaveLength(2);
    expect(ctx.alerts).toHaveLength(1);
  });
});

describe('webhook', () => {
  const payload = (code = CODE) => ({
    tracking: { number: code, carrier: 'correios' },
    checkpoints: [cp('PO', 0), cp('BDE', 30, { subtag: '01' })],
  });
  const hook = { 'x-webhook-token': 'hook-secret' };

  it('is mapped by the same adapter, deduplicated, and needs the token', async () => {
    const { body } = await register();
    expect((await post('/webhooks/aggregator', payload())).status).toBe(401);
    expect((await post('/webhooks/aggregator', payload(), { 'x-webhook-token': 'wrong' })).status).toBe(401);

    const ok = await post('/webhooks/aggregator', payload(), hook);
    expect(ok.status).toBe(202);
    expect(await json(ok)).toMatchObject({ inserted: 2, duplicates: 0, ignored: false });
    expect(await json(await post('/webhooks/aggregator', payload(), hook))).toMatchObject({ inserted: 0, duplicates: 2 });

    // a poll after the push finds the same events: still no duplicates
    agg.fake.trackings.get(CODE)!.checkpoints.push(...payload().checkpoints);
    expect((await json(await post(`/shipments/${body.id}/refresh`))).refresh.inserted).toBe(0);
    expect((await json(await ctx.app.request(`/shipments/${body.id}`))).status).toBe('delivered');
  });

  it('ignores unknown codes with 202 and rejects malformed bodies with 400', async () => {
    expect(await json(await post('/webhooks/aggregator', payload('ZZ999999999BR'), hook))).toEqual({ ignored: true });
    expect((await post('/webhooks/aggregator', { nope: true }, hook)).status).toBe(400);
  });

  it('is not mounted without a token configured', async () => {
    const off = makeApp(new RastroHubClient({ baseUrl: agg.baseUrl, apiKey: agg.apiKey }), { env: {} });
    const res = await off.app.request('/webhooks/aggregator', { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });
});
