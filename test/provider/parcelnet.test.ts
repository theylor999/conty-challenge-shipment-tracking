import { describe, expect, it } from 'vitest';
import { mapParcelNet, ParcelNetClient } from '../../src/provider/parcelnet/client.ts';
import { ShipmentService } from '../../src/service.ts';
import { Repository } from '../../src/repository.ts';
import { openDb } from '../../src/db.ts';
import { CODE, ManualClock, T0, testConfig } from '../helpers/index.ts';

// Different dialect, same domain result: nothing outside src/provider changes.
describe('second adapter (ParcelNet)', () => {
  const payload = {
    parcel: CODE,
    carrier_slug: 'correios',
    events: [
      { event_id: 'e1', carrier_code: 'PO', text: 'Postado', epoch: Date.parse('2026-03-01T10:00:00Z') / 1000, place: 'Recife/PE' },
      { event_id: 'e2', carrier_code: 'BDE', carrier_subcode: '01', epoch: Date.parse('2026-03-03T12:00:00Z') / 1000 },
    ],
  };
  const fetchStub: typeof fetch = async (url, init) =>
    init?.method === 'POST' ? Response.json({ ok: true }, { status: 201 }) : Response.json(payload);

  it('feeds the same service and yields the same normalized status', async () => {
    const provider = new ParcelNetClient({ baseUrl: 'http://parcelnet.test', apiKey: 'k', fetch: fetchStub });
    const service = new ShipmentService({
      repo: new Repository(openDb()),
      provider,
      clock: new ManualClock(T0),
      config: testConfig(),
    });
    const { shipment } = await service.register({ code: CODE, carrier: 'correios' });
    const { shipment: after, refresh } = await service.refresh(shipment.id);
    expect(refresh).toEqual({ fetched: 2, inserted: 2, duplicates: 0 });
    expect(after.status).toBe('delivered');
    expect(after.delivered_at).toBe('2026-03-03T12:00:00.000Z');
  });

  it('rejects malformed events instead of coercing them', () => {
    const wrap = (events: unknown[]) => ({ parcel: CODE, carrier_slug: 'correios', events });
    expect(() => mapParcelNet(wrap([null]))).toThrow(/not an object/);
    expect(() => mapParcelNet(wrap([{ carrier_code: 'PO', epoch: null }]))).toThrow(/epoch/);
    expect(() => mapParcelNet(wrap([{ carrier_code: 'BDE', carrier_subcode: ['01'], epoch: 1 }]))).toThrow(/subcode/);
    expect(() => mapParcelNet({ parcel: CODE })).toThrow(/expected/);
  });

  it('rejects an answer that belongs to another code', async () => {
    const provider = new ParcelNetClient({ baseUrl: 'http://x', apiKey: 'k', fetch: async () => Response.json({ ...payload, parcel: 'BB123456789BR' }) });
    await expect(provider.fetchEvents(CODE)).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
