import type { CarrierEvent } from '../../domain/types.ts';
import { ProviderError, type TrackingProvider } from '../provider.ts';
import { parseTracking } from './mapper.ts';

export interface RastroHubOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class RastroHubClient implements TrackingProvider {
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: RastroHubOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.doFetch = opts.fetch ?? fetch;
  }

  async register(code: string, carrier: string): Promise<void> {
    await this.request('POST', '/v1/trackings', { number: code, carrier });
  }

  async fetchEvents(code: string): Promise<CarrierEvent[]> {
    const body = await this.request('GET', `/v1/trackings/${encodeURIComponent(code)}`);
    return parseTracking(body).events;
  }

  parseWebhook(body: unknown): { code: string; events: CarrierEvent[] } {
    const { code, events } = parseTracking(body);
    return { code, events };
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
      });
    } catch (err) {
      throw new ProviderError('unavailable', `rastrohub unreachable: ${(err as Error).message}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new ProviderError('unauthorized', `rastrohub rejected credentials (${res.status})`);
    }
    if (res.status === 404) throw new ProviderError('not_found', 'rastrohub does not know this code');
    if (res.status === 429 || res.status >= 500) {
      throw new ProviderError('unavailable', `rastrohub answered ${res.status}`);
    }
    if (!res.ok) throw new ProviderError('rejected', `rastrohub answered ${res.status}`);

    try {
      return await res.json();
    } catch {
      throw new ProviderError('invalid_response', 'rastrohub returned a body that is not JSON');
    }
  }
}
