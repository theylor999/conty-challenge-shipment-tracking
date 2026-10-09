import { serve } from '@hono/node-server';
import { loadConfig } from './config.ts';
import { createFakeAggregator } from './fake-aggregator/app.ts';
import { start } from './server.ts';

const base = loadConfig();
const aggregatorPort = Number(process.env.AGGREGATOR_PORT ?? 4001);
const apiKey = base.provider.apiKey;

const fake = createFakeAggregator({ apiKey });
serve({ fetch: fake.app.fetch, port: aggregatorPort }, () => {
  console.log(`fake aggregator on :${aggregatorPort} (simulate events via POST /_sim/trackings/:code/checkpoints)`);
});

// Dev always runs on an in-memory database: the fake aggregator forgets its
// trackings on restart, so a persisted database would point at codes it no longer knows.
start({
  ...base,
  dbPath: ':memory:',
  webhookToken: base.webhookToken ?? 'dev-webhook',
  provider: { ...base.provider, kind: 'rastrohub', baseUrl: `http://localhost:${aggregatorPort}` },
});
