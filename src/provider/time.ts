const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

// Strict on purpose: a timestamp without an offset is ambiguous (the carrier's local
// time? ours?) and a wrong guess silently shifts the delay clock. Date.parse alone
// would also roll "2026-02-31" over to March, so the calendar is checked too.
export function parseIsoWithOffset(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const m = ISO.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as [number, number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return null;
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d < 1 || d > daysInMonth) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
