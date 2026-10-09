import { beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../src/provider/provider.ts';
import { at, CODE, ev, makeApp, StubProvider, T0 } from './helpers/index.ts';

let provider: StubProvider;
let ctx: ReturnType<typeof makeApp>;
let id: string;

async function setup(env: Record<string, string> = {}) {
  provider = new StubProvider();
  ctx = makeApp(provider, { env });
  id = (await ctx.service.register({ code: CODE, carrier: 'correios' })).shipment.id;
}

const posted = (h = 0) => ev({ raw_status: 'PO', occurred_at: at(h), external_id: `po-${h}` });
const transit = (h: number) => ev({ raw_status: 'RO', occurred_at: at(h), external_id: `ro-${h}` });
const delivered = (h: number) => ev({ raw_status: 'BDE/01', occurred_at: at(h), external_id: `bde-${h}` });

describe('registration', () => {
  beforeEach(() => setup());

  it('registers with the provider and starts with no status', async () => {
    expect(provider.registered).toEqual([[CODE, 'correios']]);
    expect(ctx.service.get(id)).toMatchObject({ status: 'unknown', history: [], delay: { late: false } });
  });

  it('is idempotent for the same code and rejects the same code on another carrier', async () => {
    const again = await ctx.service.register({ code: CODE.toLowerCase(), carrier: 'correios' });
    expect(again).toMatchObject({ created: false, shipment: { id } });
    expect(provider.registered).toHaveLength(1);
    await expect(ctx.service.register({ code: CODE, carrier: 'jadlog' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('validates carrier and code format', async () => {
    await expect(ctx.service.register({ code: CODE, carrier: 'dhl' })).rejects.toMatchObject({ code: 'validation' });
    await expect(ctx.service.register({ code: '123', carrier: 'correios' })).rejects.toMatchObject({ code: 'validation' });
    await expect(ctx.service.register({ code: 42, carrier: 'correios' })).rejects.toMatchObject({ code: 'validation' });
  });

  it('stores nothing when the provider refuses the registration', async () => {
    provider.register = async () => {
      throw new ProviderError('unavailable', 'down');
    };
    await expect(ctx.service.register({ code: 'JD0000001', carrier: 'jadlog' })).rejects.toBeInstanceOf(ProviderError);
    expect(ctx.service.list({})).toHaveLength(1);
  });
});

describe('registration races and identity', () => {
  it('two concurrent identical registrations give one shipment: 201 then 200 semantics', async () => {
    provider = new StubProvider();
    ctx = makeApp(provider);
    const [a, b] = await Promise.all([
      ctx.service.register({ code: CODE, carrier: 'correios' }),
      ctx.service.register({ code: CODE, carrier: 'correios' }),
    ]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.shipment.id).toBe(b.shipment.id);
    expect(ctx.service.list({})).toHaveLength(1);
  });

  it('rejects a batch with events from another carrier, storing none of it', async () => {
    await setup();
    provider.events = [ev({ raw_status: 'ENTREGUE', carrier: 'loggi', occurred_at: at(5) })];
    await expect(ctx.service.refresh(id)).rejects.toMatchObject({ kind: 'invalid_response' });
    expect(ctx.service.get(id)).toMatchObject({ status: 'unknown', history: [] });
  });
});

describe('status and history', () => {
  beforeEach(() => setup());

  it('delivered then an old in_transit arrives later: still delivered, history keeps both in order', async () => {
    provider.events = [posted(0), delivered(48)];
    await ctx.service.refresh(id);

    provider.events = [posted(0), delivered(48), transit(10)];
    const { shipment, refresh } = await ctx.service.refresh(id);

    expect(refresh).toEqual({ fetched: 3, inserted: 1, duplicates: 2 });
    expect(shipment.status).toBe('delivered');
    expect(shipment.delivered_at).toBe(at(48).toISOString());
    expect(shipment.history!.map((h) => h.status)).toEqual(['posted', 'in_transit', 'delivered']);
  });

  it('a stale event must not regress a package that is out for delivery', async () => {
    provider.events = [ev({ raw_status: 'OEC', occurred_at: at(40) })];
    await ctx.service.refresh(id);
    provider.events = [ev({ raw_status: 'OEC', occurred_at: at(40) }), transit(12)];
    expect((await ctx.service.refresh(id)).shipment.status).toBe('out_for_delivery');
  });

  it('a status the carrier invented is unknown, never delivered, and is listed as unmapped', async () => {
    provider.events = [
      transit(5),
      ev({
        raw_status: 'ZZ9',
        raw_description: 'Objeto entregue ao destinatário',
        occurred_at: at(50),
        external_id: 'x1',
      }),
    ];
    const { shipment } = await ctx.service.refresh(id);

    expect(shipment.status).toBe('in_transit');
    expect(shipment.delivered_at).toBeNull();
    expect(shipment.content_due_at).toBeNull();
    expect(shipment.unmapped_count).toBe(1);
    expect(shipment.unmapped_events).toEqual([
      expect.objectContaining({ raw_status: 'ZZ9', status: 'unknown', raw_description: 'Objeto entregue ao destinatário' }),
    ]);
  });

  it('an invented status alone leaves the shipment unknown', async () => {
    provider.events = [ev({ raw_status: 'ENTREGA_OK', carrier: 'correios' })];
    expect((await ctx.service.refresh(id)).shipment.status).toBe('unknown');
  });

  it('re-mapping applies to history already stored (status is derived, not persisted)', async () => {
    provider.events = [ev({ raw_status: 'BDE/04', occurred_at: at(3), external_id: 'a' }), ev({ raw_status: 'BDE/77', occurred_at: at(4), external_id: 'b' })];
    const view = (await ctx.service.refresh(id)).shipment;
    expect(view.history!.map((h) => h.status)).toEqual(['exception', 'unknown']);
  });

  it('polling the same events again inserts nothing', async () => {
    provider.events = [posted(0), transit(5), ev({ raw_status: 'RO', occurred_at: at(6) })];
    const first = await ctx.service.refresh(id);
    const second = await ctx.service.refresh(id);
    expect(first.refresh).toEqual({ fetched: 3, inserted: 3, duplicates: 0 });
    expect(second.refresh).toEqual({ fetched: 3, inserted: 0, duplicates: 3 });
    expect(second.shipment.history).toHaveLength(3);
  });

  it('dedups events without a provider id by content, and repeats inside one batch', async () => {
    const noId = ev({ raw_status: 'RO', occurred_at: at(2), location: 'Curitiba/PR' });
    provider.events = [noId, { ...noId }, { ...noId, occurred_at: new Date(noId.occurred_at) }];
    const { refresh, shipment } = await ctx.service.refresh(id);
    expect(refresh).toEqual({ fetched: 3, inserted: 1, duplicates: 2 });
    expect(shipment.history).toHaveLength(1);
  });

  it('exception shows until a later progress event arrives', async () => {
    provider.events = [transit(5), ev({ raw_status: 'BDE/02', occurred_at: at(30), external_id: 'ex' })];
    expect((await ctx.service.refresh(id)).shipment.status).toBe('exception');
    provider.events.push(transit(40));
    expect((await ctx.service.refresh(id)).shipment.status).toBe('in_transit');
  });

  it('a provider failure leaves stored history untouched', async () => {
    provider.events = [posted(0)];
    await ctx.service.refresh(id);
    provider.failure = new ProviderError('unavailable', 'boom');
    await expect(ctx.service.refresh(id)).rejects.toBeInstanceOf(ProviderError);
    expect(ctx.service.get(id).history).toHaveLength(1);
  });
});

describe('delay', () => {
  beforeEach(() => setup({ MAX_TRANSIT_HOURS: '120' }));

  it('is not late at exactly the limit and is late 1 ms after', async () => {
    provider.events = [posted(0)];
    ctx.clock.set(at(120));
    expect((await ctx.service.refresh(id)).shipment.delay.late).toBe(false);
    expect(ctx.alerts).toHaveLength(0);

    ctx.clock.set(new Date(at(120).getTime() + 1));
    const view = (await ctx.service.refresh(id)).shipment;
    expect(view.delay).toMatchObject({ late: true, limit_hours: 120, started_at: T0.toISOString() });
    expect(ctx.alerts).toHaveLength(1);
  });

  it('raises the alert once, however many times it is checked', async () => {
    provider.events = [posted(0)];
    ctx.clock.set(at(130));
    await ctx.service.refresh(id);
    ctx.clock.set(at(200));
    await ctx.service.refresh(id);
    await ctx.service.scan();
    expect(ctx.alerts).toHaveLength(1);
    expect(ctx.service.get(id).delay.alert).toEqual({ raised_at: at(130).toISOString(), cleared_at: null });
  });

  it('a delivery inside the limit that we only ingest later is not late', async () => {
    provider.events = [posted(0), delivered(100)];
    ctx.clock.set(at(400));
    const view = (await ctx.service.refresh(id)).shipment;
    expect(view.status).toBe('delivered');
    expect(view.delay).toMatchObject({ late: false, elapsed_hours: 100, alert: null });
    expect(ctx.alerts).toHaveLength(0);
    expect(ctx.service.list({ late: true })).toHaveLength(0);
  });

  it('a delivery after the limit is late and listed', async () => {
    provider.events = [posted(0), delivered(121)];
    ctx.clock.set(at(122));
    const view = (await ctx.service.refresh(id)).shipment;
    expect(view.delay).toMatchObject({ late: true, elapsed_hours: 121 });
    expect(ctx.alerts).toHaveLength(1);
    expect(ctx.service.list({ late: true }).map((s) => s.id)).toEqual([id]);
  });

  it('clears the alert when the delivery we learn about happened inside the limit', async () => {
    provider.events = [posted(0)];
    ctx.clock.set(at(130));
    await ctx.service.refresh(id);
    expect(ctx.service.get(id).delay.late).toBe(true);

    provider.events = [posted(0), delivered(100)];
    ctx.clock.set(at(131));
    const view = (await ctx.service.refresh(id)).shipment;
    expect(view.delay.late).toBe(false);
    expect(view.delay.alert).toEqual({ raised_at: at(130).toISOString(), cleared_at: at(131).toISOString() });
    expect(ctx.alerts).toHaveLength(1);
  });

  it('a late-arriving older posted event moves the start back (and can make it late)', async () => {
    provider.events = [transit(100)];
    ctx.clock.set(at(150));
    expect((await ctx.service.refresh(id)).shipment.delay.late).toBe(false);
    provider.events = [transit(100), posted(0)];
    expect((await ctx.service.refresh(id)).shipment.delay.late).toBe(true);
  });

  it('keeps alerting when the aggregator is down (scan)', async () => {
    provider.events = [posted(0)];
    await ctx.service.refresh(id);
    provider.failure = new ProviderError('unavailable', 'down');
    ctx.clock.set(at(121));
    expect(await ctx.service.scan()).toEqual({ checked: 1, failed: 1 });
    expect(ctx.alerts).toHaveLength(1);
  });

  it('scan skips delivered shipments', async () => {
    provider.events = [posted(0), delivered(10)];
    await ctx.service.refresh(id);
    expect(await ctx.service.scan()).toEqual({ checked: 0, failed: 0 });
  });

  it('scan keeps polling a delivery whose start never arrived, and the delay appears when it does', async () => {
    provider.events = [delivered(121)];
    ctx.clock.set(at(130));
    await ctx.service.refresh(id);
    expect(ctx.service.get(id).delay.late).toBe(false);

    provider.events = [delivered(121), posted(0)];
    expect(await ctx.service.scan()).toEqual({ checked: 1, failed: 0 });
    expect(ctx.service.get(id).delay).toMatchObject({ late: true, elapsed_hours: 121 });
    expect(ctx.alerts).toHaveLength(1);
  });

  it('honours a per-carrier limit', async () => {
    await setup({ MAX_TRANSIT_HOURS: '120', MAX_TRANSIT_HOURS_CORREIOS: '24' });
    provider.events = [posted(0)];
    ctx.clock.set(at(25));
    expect((await ctx.service.refresh(id)).shipment.delay).toMatchObject({ limit_hours: 24, late: true });
  });
});

describe('content deadline', () => {
  it('is delivered_at plus the configured days, and absent before delivery', async () => {
    await setup({ CONTENT_DAYS_AFTER_DELIVERY: '5' });
    provider.events = [posted(0)];
    expect((await ctx.service.refresh(id)).shipment.content_due_at).toBeNull();
    provider.events = [posted(0), delivered(48)];
    expect((await ctx.service.refresh(id)).shipment.content_due_at).toBe(at(48 + 5 * 24).toISOString());
  });
});
