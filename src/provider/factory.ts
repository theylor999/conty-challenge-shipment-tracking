import type { ProviderConfig } from '../config.ts';
import { ParcelNetClient } from './parcelnet/client.ts';
import type { TrackingProvider } from './provider.ts';
import { RastroHubClient } from './rastrohub/client.ts';

export function createProvider(config: ProviderConfig): TrackingProvider {
  const opts = { baseUrl: config.baseUrl, apiKey: config.apiKey, timeoutMs: config.timeoutMs };
  switch (config.kind) {
    case 'rastrohub':
      return new RastroHubClient(opts);
    case 'parcelnet':
      return new ParcelNetClient(opts);
    default:
      throw new Error(`unknown PROVIDER "${config.kind}" (expected rastrohub or parcelnet)`);
  }
}
