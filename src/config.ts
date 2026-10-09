export interface DomainConfig {
  maxTransitHours: number;
  carrierMaxTransitHours: Record<string, number>;
  contentDaysAfterDelivery: number;
}

export interface ProviderConfig {
  kind: 'rastrohub' | 'parcelnet';
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export interface Config extends DomainConfig {
  port: number;
  dbPath: string;
  pollIntervalMs: number;
  webhookToken: string | null;
  provider: ProviderConfig;
}

export function limitFor(config: DomainConfig, carrier: string): number {
  return config.carrierMaxTransitHours[carrier.toLowerCase()] ?? config.maxTransitHours;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number, opts: { min: number }): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < opts.min) {
    throw new Error(`${key} must be a number >= ${opts.min}, got "${raw}"`);
  }
  return value;
}

// MAX_TRANSIT_HOURS is the default; MAX_TRANSIT_HOURS_JADLOG=72 overrides one carrier.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const prefix = 'MAX_TRANSIT_HOURS_';
  const carrierMaxTransitHours: Record<string, number> = {};
  for (const key of Object.keys(env)) {
    if (key.startsWith(prefix)) {
      carrierMaxTransitHours[key.slice(prefix.length).toLowerCase()] = num(env, key, 0, { min: 0.001 });
    }
  }

  const kind = env.PROVIDER ?? 'rastrohub';
  if (kind !== 'rastrohub' && kind !== 'parcelnet') {
    throw new Error(`PROVIDER must be rastrohub or parcelnet, got "${kind}"`);
  }

  return {
    port: num(env, 'PORT', 3000, { min: 0 }),
    dbPath: env.DB_PATH || 'tracking.db',
    maxTransitHours: num(env, 'MAX_TRANSIT_HOURS', 120, { min: 0.001 }),
    carrierMaxTransitHours,
    contentDaysAfterDelivery: num(env, 'CONTENT_DAYS_AFTER_DELIVERY', 7, { min: 0 }),
    pollIntervalMs: num(env, 'POLL_INTERVAL_MS', 900_000, { min: 0 }),
    webhookToken: env.WEBHOOK_TOKEN || null,
    provider: {
      kind,
      baseUrl: env.AGGREGATOR_URL ?? 'http://localhost:4001',
      apiKey: env.AGGREGATOR_API_KEY ?? 'dev-key',
      timeoutMs: num(env, 'AGGREGATOR_TIMEOUT_MS', 5000, { min: 1 }),
    },
  };
}
