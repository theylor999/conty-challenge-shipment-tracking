import { serve } from '@hono/node-server';
import { systemClock } from './clock.ts';
import { loadConfig } from './config.ts';
import { createProvider } from './provider/factory.ts';
import { buildApp } from './wiring.ts';

export function start(config = loadConfig(), provider = createProvider(config.provider)) {
  const { app, service } = buildApp({
    config,
    provider,
    clock: systemClock,
    onDelayAlert: (notice) => console.warn('[delay-alert]', JSON.stringify(notice)),
  });

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`api listening on :${info.port}`);
  });

  let timer: NodeJS.Timeout | undefined;
  if (config.pollIntervalMs > 0) {
    let running = false;
    timer = setInterval(() => {
      if (running) return;
      running = true;
      service
        .scan()
        .catch((err) => console.error('scan failed', err))
        .finally(() => {
          running = false;
        });
    }, config.pollIntervalMs);
    timer.unref();
  }
  return { server, stop: () => timer && clearInterval(timer) };
}
