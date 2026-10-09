import type { Clock } from './clock.ts';
import type { Config } from './config.ts';
import { openDb } from './db.ts';
import { createApp } from './http/app.ts';
import type { TrackingProvider } from './provider/provider.ts';
import { Repository } from './repository.ts';
import { ShipmentService, type DelayAlertNotice } from './service.ts';

export interface Wiring {
  config: Config;
  provider: TrackingProvider;
  clock: Clock;
  onDelayAlert?: (notice: DelayAlertNotice) => void;
}

export function buildApp({ config, provider, clock, onDelayAlert }: Wiring) {
  const db = openDb(config.dbPath);
  const service = new ShipmentService({
    repo: new Repository(db),
    provider,
    clock,
    config,
    ...(onDelayAlert ? { onDelayAlert } : {}),
  });
  return { app: createApp({ service, provider, webhookToken: config.webhookToken }), service, db };
}
