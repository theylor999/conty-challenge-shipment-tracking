import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/provider/provider.ts';
import { RastroHubClient } from '../../src/provider/rastrohub/client.ts';
import { parseTracking } from '../../src/provider/rastrohub/mapper.ts';
import { startFakeAggregator } from '../helpers/index.ts';

const RAW = {
  tracking: { number: 'AA123456789BR', carrier: 'correios' },
  checkpoints: [
    {
      id: 'cp-9',
      tag: 'BDE',
      subtag: '01',
      message: 'Objeto entregue ao destinatário',
      checkpoint_time: '2026-03-10T14:02:00-03:00',
      location: { city: 'São Paulo', state: 'SP' },
    },
  ],
};

describe('rastrohub mapper', () => {
  it('maps the aggregator dialect into CarrierEvent', () => {
    expect(parseTracking(RAW)).toEqual({
      code: 'AA123456789BR',
      carrier: 'correios',
      events: [
        {
          external_id: 'cp-9',
          carrier: 'correios',
          raw_status: 'BDE/01',
          raw_description: 'Objeto entregue ao destinatário',
          occurred_at: new Date('2026-03-10T17:02:00.000Z'),
          location: 'São Paulo/SP',
        },
      ],
    });
  });

  it('accepts a checkpoint with no id, subtag or location', () => {
    const { events } = parseTracking({
      tracking: RAW.tracking,
      checkpoints: [{ tag: 'RO', message: 'em trânsito', checkpoint_time: '2026-03-02T10:00:00Z' }],
    });
    expect(events[0]).toMatchObject({ raw_status: 'RO', location: null });
    expect(events[0]).not.toHaveProperty('external_id');
  });

  it.each([
    ['naive timestamp', '2026-03-10T14:02:00'],
    ['impossible date', '2026-02-31T10:00:00Z'],
    ['not a date', 'ontem'],
  ])('rejects %s instead of guessing', (_name, time) => {
    const bad = { ...RAW, checkpoints: [{ ...RAW.checkpoints[0], checkpoint_time: time }] };
    expect(() => parseTracking(bad)).toThrow(ProviderError);
  });

  it('rejects payloads of the wrong shape', () => {
    expect(() => parseTracking({})).toThrow(/expected/);
    expect(() => parseTracking({ ...RAW, checkpoints: [{ message: 'x', checkpoint_time: '2026-03-02T10:00:00Z' }] })).toThrow(/tag/);
  });
});

describe('RastroHubClient over HTTP', () => {
  let agg: Awaited<ReturnType<typeof startFakeAggregator>>;
  let client: RastroHubClient;

  beforeAll(async () => {
    agg = await startFakeAggregator();
    client = new RastroHubClient({ baseUrl: agg.baseUrl, apiKey: agg.apiKey, timeoutMs: 2000 });
  });
  afterAll(() => agg.close());

  it('registers a code and reads its events back, repeated registration included', async () => {
    await client.register('RB000000001BR', 'correios');
    await client.register('RB000000001BR', 'correios');
    agg.fake.trackings.get('RB000000001BR')!.checkpoints.push(...RAW.checkpoints);
    const events = await client.fetchEvents('RB000000001BR');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ raw_status: 'BDE/01', occurred_at: new Date('2026-03-10T17:02:00Z') });
  });

  it('turns a 404 into not_found', async () => {
    await expect(client.fetchEvents('ZZ999999999BR')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('turns a 5xx into unavailable', async () => {
    agg.fake.failNext(503);
    await expect(client.fetchEvents('RB000000001BR')).rejects.toMatchObject({ kind: 'unavailable' });
    expect(await client.fetchEvents('RB000000001BR')).toHaveLength(1);
  });

  it('turns bad credentials into unauthorized', async () => {
    const bad = new RastroHubClient({ baseUrl: agg.baseUrl, apiKey: 'nope' });
    await expect(bad.fetchEvents('RB000000001BR')).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('turns a refused registration (422, 409) into rejected', async () => {
    await expect(client.register('RB000000002BR', 'dhl')).rejects.toMatchObject({ kind: 'rejected' });
    await expect(client.register('RB000000001BR', 'jadlog')).rejects.toMatchObject({ kind: 'rejected' });
  });

  it('turns a connection failure into unavailable', async () => {
    const down = new RastroHubClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'x', timeoutMs: 1000 });
    await expect(down.fetchEvents('RB000000001BR')).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('turns a non-JSON or malformed 200 into invalid_response', async () => {
    const html = new RastroHubClient({
      baseUrl: 'http://x',
      apiKey: 'k',
      fetch: async () => new Response('<html>oops</html>', { status: 200 }),
    });
    await expect(html.fetchEvents('A')).rejects.toMatchObject({ kind: 'invalid_response' });
    const wrong = new RastroHubClient({
      baseUrl: 'http://x',
      apiKey: 'k',
      fetch: async () => Response.json({ hello: 'world' }),
    });
    await expect(wrong.fetchEvents('A')).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
