import { describe, expect, it } from 'vitest';
import { project, type TimedStatus } from '../../src/domain/projection.ts';
import { at } from '../helpers/index.ts';

const e = (status: TimedStatus['status'], h: number): TimedStatus => ({ status, occurred_at: at(h) });

describe('project', () => {
  it('has no status without events', () => {
    expect(project([])).toEqual({ status: 'unknown', delivered_at: null });
  });

  it('ignores arrival order: result depends on occurred_at only', () => {
    const events = [e('in_transit', 10), e('posted', 0), e('out_for_delivery', 20)];
    expect(project(events).status).toBe('out_for_delivery');
    expect(project([...events].reverse()).status).toBe('out_for_delivery');
  });

  it('an old event arriving after delivered does not regress the status', () => {
    const p = project([e('delivered', 30), e('in_transit', 5)]);
    expect(p.status).toBe('delivered');
    expect(p.delivered_at).toEqual(at(30));
  });

  it('exception later than the latest progress wins, until a later progress event', () => {
    expect(project([e('in_transit', 1), e('exception', 2)]).status).toBe('exception');
    expect(project([e('in_transit', 1), e('exception', 2), e('in_transit', 3)]).status).toBe('in_transit');
  });

  it('an exception older than the latest progress does not show', () => {
    expect(project([e('exception', 1), e('in_transit', 2)]).status).toBe('in_transit');
  });

  it('delivered is terminal, even against a later exception', () => {
    expect(project([e('delivered', 10), e('exception', 20)]).status).toBe('delivered');
  });

  it('uses the earliest delivered instant when delivered is reported twice', () => {
    expect(project([e('delivered', 12), e('delivered', 10)]).delivered_at).toEqual(at(10));
  });

  it('breaks same-instant ties by rank', () => {
    expect(project([e('exception', 5), e('in_transit', 5)]).status).toBe('exception');
    expect(project([e('delivered', 5), e('out_for_delivery', 5)]).status).toBe('delivered');
  });

  it('unknown events never count', () => {
    expect(project([e('unknown', 50)]).status).toBe('unknown');
    expect(project([e('in_transit', 1), e('unknown', 50)]).status).toBe('in_transit');
  });
});
