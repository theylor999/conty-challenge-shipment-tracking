import { describe, expect, it } from 'vitest';
import { limitFor, loadConfig } from '../src/config.ts';
import { createProvider } from '../src/provider/factory.ts';

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
  });

  it('ignores a blank per-carrier override instead of reading it as zero hours', () => {
    const c = loadConfig({ MAX_TRANSIT_HOURS_CORREIOS: '', MAX_TRANSIT_HOURS_: '5' });
    expect(limitFor(c, 'correios')).toBe(120);
  });

  it('fails at startup on an unknown provider', () => {
    const c = loadConfig({ PROVIDER: 'x' });
    expect(() => createProvider(c.provider)).toThrow(/PROVIDER/);
  });
});
