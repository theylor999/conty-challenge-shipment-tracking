import { createHash } from 'node:crypto';
import type { CarrierEvent } from './types.ts';

// Provider id wins when present. Otherwise the identity is the event content,
// with the instant in UTC so "-03:00" and "Z" spellings of the same moment match.
export function dedupKey(code: string, event: CarrierEvent): string {
  if (event.external_id) return `id:${event.external_id}`;
  const parts = [
    code,
    event.carrier,
    event.raw_status,
    event.occurred_at.toISOString(),
    event.location ?? '',
  ].map((p) => p.trim().toLowerCase());
  return `h:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}
