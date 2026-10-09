import type { CarrierEvent } from '../../domain/types.ts';
import { callJson } from '../http.ts';
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

  constructor(private readonly opts: RastroHubOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
  }

  async register(code: string, carrier: string): Promise<void> {
    await this.call('POST', '/v1/trackings', false, { number: code, carrier });
  }

  async fetchEvents(code: string): Promise<CarrierEvent[]> {
    const body = await this.call('GET', `/v1/trackings/${encodeURIComponent(code)}`, true);
    const parsed = parseTracking(body);
    if (parsed.code.toUpperCase() !== code.toUpperCase()) {
      throw new ProviderError('invalid_response', `rastrohub answered for ${parsed.code}, asked for ${code}`);
    }
    return parsed.events;
  }

  parseWebhook(body: unknown): { code: string; events: CarrierEvent[] } {
    const { code, events } = parseTracking(body);
    return { code, events };
  }

  private call(method: string, path: string, readBody: boolean, body?: unknown) {
    return callJson({
      name: 'rastrohub',
      fetch: this.opts.fetch ?? fetch,
      url: `${this.baseUrl}${path}`,
      method,
      headers: { authorization: `Bearer ${this.opts.apiKey}` },
      body,
      timeoutMs: this.opts.timeoutMs ?? 5000,
      readBody,
    });
  }
}
