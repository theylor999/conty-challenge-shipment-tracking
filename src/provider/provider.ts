import type { CarrierEvent } from '../domain/types.ts';

export interface TrackingProvider {
  register(code: string, carrier: string): Promise<void>;
  fetchEvents(code: string): Promise<CarrierEvent[]>;
  // Optional push channel. Maps the aggregator's webhook body with the same adapter.
  parseWebhook?(body: unknown): { code: string; events: CarrierEvent[] };
}

export type ProviderErrorKind =
  | 'not_found'
  | 'unavailable'
  | 'unauthorized'
  | 'rejected'
  | 'invalid_response';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
