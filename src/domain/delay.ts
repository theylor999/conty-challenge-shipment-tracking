import type { TimedStatus } from './projection.ts';

export interface DelayAssessment {
  started_at: Date | null;
  elapsed_ms: number | null;
  limit_hours: number;
  late: boolean;
}

const HOUR_MS = 3_600_000;

// Transit clock: starts at the carrier's first posted/in_transit instant (falling
// back to the first progress event if those are missing) and stops at the carrier's
// delivered instant. Ingestion time is never used, so a delivery we learn about
// late is still measured at the moment it really happened.
export function assessDelay(
  events: readonly TimedStatus[],
  delivered_at: Date | null,
  limitHours: number,
  now: Date,
): DelayAssessment {
  const earliest = (statuses: readonly string[]) =>
    events
      .filter((e) => statuses.includes(e.status))
      .reduce<Date | null>((min, e) => (!min || e.occurred_at < min ? e.occurred_at : min), null);

  const started_at =
    earliest(['posted', 'in_transit']) ?? earliest(['out_for_delivery', 'delivered']);
  if (!started_at) return { started_at: null, elapsed_ms: null, limit_hours: limitHours, late: false };

  const elapsed_ms = (delivered_at ?? now).getTime() - started_at.getTime();
  return { started_at, elapsed_ms, limit_hours: limitHours, late: elapsed_ms > limitHours * HOUR_MS };
}
