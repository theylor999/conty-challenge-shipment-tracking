import { describe, expect, it } from 'vitest';
import { assessDelay } from '../../src/domain/delay.ts';
import type { TimedStatus } from '../../src/domain/projection.ts';
import { at, T0 } from '../helpers/index.ts';

const e = (status: TimedStatus['status'], h: number): TimedStatus => ({ status, occurred_at: at(h) });
const LIMIT = 120;
const limitInstant = at(LIMIT);

describe('assessDelay', () => {
  it('is not late exactly at the limit and is late 1 ms after', () => {
    const events = [e('posted', 0)];
    expect(assessDelay(events, null, LIMIT, limitInstant).late).toBe(false);
    expect(assessDelay(events, null, LIMIT, new Date(limitInstant.getTime() + 1)).late).toBe(true);
  });

  it('starts at the first posted/in_transit instant, not at the first event ingested', () => {
    const d = assessDelay([e('in_transit', 10), e('posted', 2)], null, LIMIT, at(3));
    expect(d.started_at).toEqual(at(2));
  });

  it('falls back to the first progress event when posted/in_transit are missing', () => {
    expect(assessDelay([e('out_for_delivery', 7)], null, LIMIT, at(8)).started_at).toEqual(at(7));
  });

  it('a delivery inside the limit is never late, however late "now" is', () => {
    const d = assessDelay([e('posted', 0), e('delivered', 100)], at(100), LIMIT, at(10_000));
    expect(d.late).toBe(false);
    expect(d.elapsed_ms).toBe(100 * 3_600_000);
  });

  it('a delivery after the limit is late', () => {
    expect(assessDelay([e('posted', 0), e('delivered', 121)], at(121), LIMIT, at(122)).late).toBe(true);
  });

  it('has no clock without progress events', () => {
    const d = assessDelay([e('exception', 1), e('unknown', 2)], null, LIMIT, at(10_000));
    expect(d).toMatchObject({ started_at: null, late: false });
  });

  it('does not flag a start in the future (carrier clock ahead of ours)', () => {
    expect(assessDelay([e('posted', 5)], null, LIMIT, T0).late).toBe(false);
  });
});
