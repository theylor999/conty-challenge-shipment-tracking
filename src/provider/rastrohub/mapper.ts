import type { CarrierEvent } from '../../domain/types.ts';
import { ProviderError } from '../provider.ts';
import { parseIsoWithOffset } from '../time.ts';

// RastroHub dialect (fictitious aggregator):
// { tracking: { number, carrier },
//   checkpoints: [{ id?, tag, subtag?, message, checkpoint_time, location?: { city, state } }] }
// This file is the only place that knows that shape.

function invalid(message: string): never {
  throw new ProviderError('invalid_response', `rastrohub: ${message}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function mapLocation(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (isRecord(value)) {
    const parts = [value.city, value.state].filter((p): p is string => typeof p === 'string' && p.trim() !== '');
    return parts.length ? parts.map((p) => p.trim()).join('/') : null;
  }
  return invalid('location must be a string or { city, state }');
}

export function parseTracking(payload: unknown): { code: string; carrier: string; events: CarrierEvent[] } {
  if (!isRecord(payload) || !isRecord(payload.tracking) || !Array.isArray(payload.checkpoints)) {
    return invalid('expected { tracking, checkpoints }');
  }
  const { number, carrier } = payload.tracking;
  if (typeof number !== 'string' || !number) return invalid('tracking.number missing');
  if (typeof carrier !== 'string' || !carrier) return invalid('tracking.carrier missing');

  const events = payload.checkpoints.map((cp, i): CarrierEvent => {
    if (!isRecord(cp)) return invalid(`checkpoints[${i}] is not an object`);
    if (typeof cp.tag !== 'string' || !cp.tag.trim()) return invalid(`checkpoints[${i}].tag missing`);
    const occurred_at = parseIsoWithOffset(cp.checkpoint_time);
    if (!occurred_at) return invalid(`checkpoints[${i}].checkpoint_time must be ISO-8601 with offset`);

    // A subtag that is present but not a string is malformed; dropping it would turn
    // e.g. ENTREGUE/99 into a plain ENTREGUE.
    if (cp.subtag != null && typeof cp.subtag !== 'string') return invalid(`checkpoints[${i}].subtag must be a string`);
    if (cp.id != null && typeof cp.id !== 'string' && typeof cp.id !== 'number') return invalid(`checkpoints[${i}].id must be a string or number`);
    if (cp.message != null && typeof cp.message !== 'string') return invalid(`checkpoints[${i}].message must be a string`);
    const subtag = cp.subtag?.trim() || null;
    const id = cp.id == null || cp.id === '' ? undefined : String(cp.id);
    return {
      ...(id ? { external_id: id } : {}),
      carrier,
      // Correios gives code + type (BDE + 01); the pair is the carrier's real status.
      raw_status: subtag ? `${cp.tag.trim()}/${subtag}` : cp.tag.trim(),
      raw_description: cp.message ?? '',
      occurred_at,
      location: mapLocation(cp.location),
    };
  });

  return { code: number, carrier, events };
}
