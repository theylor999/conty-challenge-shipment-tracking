import type { CarrierEvent } from '../../domain/types.ts';
import { ProviderError, type TrackingProvider } from '../provider.ts';

// Second, deliberately different dialect (flat events, epoch seconds, carrier code
// split in two fields). It exists to show that swapping aggregators touches this
// folder and provider/factory.ts only.
interface ParcelNetPayload {
  parcel: string;
  carrier_slug: string;
  events: Array<{
    event_id?: string;
    carrier_code: string;
    carrier_subcode?: string;
    text?: string;
    epoch: number;
    place?: string;
  }>;
}

export function mapParcelNet(payload: ParcelNetPayload): CarrierEvent[] {
  if (!payload || !Array.isArray(payload.events) || typeof payload.carrier_slug !== 'string') {
    throw new ProviderError('invalid_response', 'parcelnet: unexpected payload');
  }
  return payload.events.map((e) => {
    if (typeof e.carrier_code !== 'string' || !Number.isFinite(new Date(e.epoch * 1000).getTime())) {
      throw new ProviderError('invalid_response', 'parcelnet: event without code or epoch');
    }
    return {
      ...(e.event_id ? { external_id: e.event_id } : {}),
      carrier: payload.carrier_slug,
      raw_status: e.carrier_subcode ? `${e.carrier_code}/${e.carrier_subcode}` : e.carrier_code,
      raw_description: e.text ?? '',
      occurred_at: new Date(e.epoch * 1000),
      location: e.place ?? null,
    };
  });
}

export class ParcelNetClient implements TrackingProvider {
  constructor(
    private readonly opts: { baseUrl: string; apiKey: string; timeoutMs?: number; fetch?: typeof fetch },
  ) {}

  async register(code: string, carrier: string): Promise<void> {
    await this.call('POST', '/parcels', { code, carrier_slug: carrier });
  }

  async fetchEvents(code: string): Promise<CarrierEvent[]> {
    return mapParcelNet((await this.call('GET', `/parcels/${encodeURIComponent(code)}/events`)) as ParcelNetPayload);
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: { 'x-api-key': this.opts.apiKey, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
      });
    } catch (err) {
      throw new ProviderError('unavailable', `parcelnet unreachable: ${(err as Error).message}`);
    }
    if (res.status === 404) throw new ProviderError('not_found', 'parcelnet does not know this code');
    if (res.status === 401 || res.status === 403) throw new ProviderError('unauthorized', 'parcelnet rejected credentials');
    if (res.status >= 500 || res.status === 429) throw new ProviderError('unavailable', `parcelnet answered ${res.status}`);
    if (!res.ok) throw new ProviderError('rejected', `parcelnet answered ${res.status}`);
    return res.json().catch(() => {
      throw new ProviderError('invalid_response', 'parcelnet returned a body that is not JSON');
    });
  }
}
