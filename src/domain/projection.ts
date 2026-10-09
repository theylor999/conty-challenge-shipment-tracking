import type { Status } from './types.ts';

export interface TimedStatus {
  occurred_at: Date;
  status: Status;
}

// Tie-break for events with the same instant. delivered is highest so a same-second
// pair never leaves a delivered package looking pending; exception beats progress
// so ops sees the problem.
const RANK: Record<Status, number> = {
  unknown: 0,
  posted: 1,
  in_transit: 2,
  out_for_delivery: 3,
  exception: 4,
  delivered: 5,
};

export function compareEvents(a: TimedStatus, b: TimedStatus): number {
  return a.occurred_at.getTime() - b.occurred_at.getTime() || RANK[a.status] - RANK[b.status];
}

export interface Projection {
  status: Status;
  delivered_at: Date | null;
}

// The status is a function of the event set, never of arrival order.
// unknown events are ignored. delivered is terminal: once any delivered event
// exists, later events (even an exception) do not change the status.
export function project(events: readonly TimedStatus[]): Projection {
  const known = events.filter((e) => e.status !== 'unknown').sort(compareEvents);
  const delivered = known.find((e) => e.status === 'delivered');
  if (delivered) return { status: 'delivered', delivered_at: delivered.occurred_at };
  const latest = known[known.length - 1];
  return { status: latest?.status ?? 'unknown', delivered_at: null };
}
