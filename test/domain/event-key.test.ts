import { describe, expect, it } from 'vitest';
import { dedupKey } from '../../src/domain/event-key.ts';
import { CODE, ev } from '../helpers/index.ts';

describe('dedupKey', () => {
  it('uses the provider id when there is one', () => {
    const a = ev({ raw_status: 'RO', external_id: 'cp-1' });
    const b = ev({ raw_status: 'PO', external_id: 'cp-1', occurred_at: new Date('2030-01-01T00:00:00Z') });
    expect(dedupKey(CODE, a)).toBe(dedupKey(CODE, b));
  });

  it('hashes the content otherwise, treating the same instant in other offsets as equal', () => {
    const a = ev({ raw_status: 'RO', occurred_at: new Date('2026-03-10T14:02:00-03:00'), location: 'São Paulo/SP' });
    const b = ev({ raw_status: 'ro ', occurred_at: new Date('2026-03-10T17:02:00Z'), location: 'são paulo/sp' });
    expect(dedupKey(CODE, a)).toBe(dedupKey(CODE, b));
  });

  it('separates events that differ in status, instant or place', () => {
    const base = ev({ raw_status: 'RO', location: 'A' });
    expect(dedupKey(CODE, base)).not.toBe(dedupKey(CODE, { ...base, raw_status: 'DO' }));
    expect(dedupKey(CODE, base)).not.toBe(dedupKey(CODE, { ...base, location: 'B' }));
    expect(dedupKey(CODE, base)).not.toBe(dedupKey(CODE, { ...base, occurred_at: new Date(base.occurred_at.getTime() + 1) }));
  });
});
