import type { CarrierEvent } from '../../domain/types.ts';
import { callJson } from '../http.ts';
import { ProviderError, type TrackingProvider } from '../provider.ts';

const invalid = (message: string): never => {
  throw new ProviderError('invalid_response', `parcelnet: ${message}`);
};
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Dialect: { parcel, carrier_slug, events: [{ event_id?, carrier_code, carrier_subcode?, text?, epoch, place? }] }
export function mapParcelNet(payload: unknown): { code: string; events: CarrierEvent[] } {
  if (!isRecord(payload) || typeof payload.parcel !== 'string' || typeof payload.carrier_slug !== 'string' || !Array.isArray(payload.events)) {
    return invalid('expected { parcel, carrier_slug, events }');
  }
  const carrier = payload.carrier_slug;
  const events = payload.events.map((e, i): CarrierEvent => {
    if (!isRecord(e)) return invalid(`events[${i}] is not an object`);
    if (typeof e.carrier_code !== 'string' || !e.carrier_code.trim()) return invalid(`events[${i}].carrier_code missing`);
    if (e.carrier_subcode != null && typeof e.carrier_subcode !== 'string') return invalid(`events[${i}].carrier_subcode must be a string`);
    if (e.event_id != null && typeof e.event_id !== 'string') return invalid(`events[${i}].event_id must be a string`);
    if (e.text != null && typeof e.text !== 'string') return invalid(`events[${i}].text must be a string`);
    if (e.place != null && typeof e.place !== 'string') return invalid(`events[${i}].place must be a string`);
    const occurred_at = typeof e.epoch === 'number' ? new Date(e.epoch * 1000) : null;
    if (!occurred_at || Number.isNaN(occurred_at.getTime())) return invalid(`events[${i}].epoch must be a number`);

    const subcode = e.carrier_subcode?.trim();
    return {
      ...(e.event_id ? { external_id: e.event_id } : {}),
      carrier,
      raw_status: subcode ? `${e.carrier_code.trim()}/${subcode}` : e.carrier_code.trim(),
      raw_description: e.text ?? '',
      occurred_at,
      location: e.place ?? null,
    };
  });
  return { code: payload.parcel, events };
}

export class ParcelNetClient implements TrackingProvider {
  constructor(
    private readonly opts: { baseUrl: string; apiKey: string; timeoutMs?: number; fetch?: typeof fetch },
  ) {}

  async register(code: string, carrier: string): Promise<void> {
    await this.call('POST', '/parcels', false, { code, carrier_slug: carrier });
  }

  async fetchEvents(code: string): Promise<CarrierEvent[]> {
    const parsed = mapParcelNet(await this.call('GET', `/parcels/${encodeURIComponent(code)}/events`, true));
    if (parsed.code.toUpperCase() !== code.toUpperCase()) {
      return invalid(`answered for ${parsed.code}, asked for ${code}`);
    }
    return parsed.events;
  }

  private call(method: string, path: string, readBody: boolean, body?: unknown) {
    return callJson({
      name: 'parcelnet',
      fetch: this.opts.fetch ?? fetch,
      url: `${this.opts.baseUrl.replace(/\/+$/, '')}${path}`,
      method,
      headers: { 'x-api-key': this.opts.apiKey },
      body,
      timeoutMs: this.opts.timeoutMs ?? 5000,
      readBody,
    });
  }
}
