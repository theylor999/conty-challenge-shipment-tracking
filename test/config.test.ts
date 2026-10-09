import { describe, expect, it } from 'vitest';
import { limitFor, loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
  it('has sane defaults', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ maxTransitHours: 120, contentDaysAfterDelivery: 7, provider: { kind: 'rastrohub' } });
  });

  it('reads a per-carrier override', () => {
    const c = loadConfig({ MAX_TRANSIT_HOURS: '100', MAX_TRANSIT_HOURS_JADLOG: '72' });
    expect(limitFor(c, 'jadlog')).toBe(72);
    expect(limitFor(c, 'correios')).toBe(100);
  });

  it('refuses nonsense instead of silently flagging everything', () => {
    expect(() => loadConfig({ MAX_TRANSIT_HOURS: '0' })).toThrow(/MAX_TRANSIT_HOURS/);
    expect(() => loadConfig({ MAX_TRANSIT_HOURS: 'abc' })).toThrow();
    expect(() => loadConfig({ PROVIDER: 'x' })).toThrow(/PROVIDER/);
  });
});
