import { ProviderError } from './provider.ts';

export interface HttpCall {
  name: string;
  fetch: typeof fetch;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  // Registration answers carry nothing we need, so a 200/201/204 without a body is fine.
  readBody: boolean;
}

// Shared status/error mapping for aggregator clients. Anything that goes wrong becomes
// a ProviderError so the rest of the code never sees fetch or HTTP details.
export async function callJson(call: HttpCall): Promise<unknown> {
  const { name } = call;
  let res: Response;
  try {
    res = await call.fetch(call.url, {
      method: call.method,
      headers: call.body === undefined ? call.headers : { ...call.headers, 'content-type': 'application/json' },
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
      signal: AbortSignal.timeout(call.timeoutMs),
    });
  } catch (err) {
    throw new ProviderError('unavailable', `${name} unreachable: ${(err as Error).message}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new ProviderError('unauthorized', `${name} rejected credentials (${res.status})`);
  }
  if (res.status === 404) throw new ProviderError('not_found', `${name} does not know this code`);
  if (res.status === 429 || res.status >= 500) {
    throw new ProviderError('unavailable', `${name} answered ${res.status}`);
  }
  if (!res.ok) throw new ProviderError('rejected', `${name} answered ${res.status}`);
  if (!call.readBody) return null;

  // Reading the body can still time out or drop: that is unavailability, not bad JSON.
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new ProviderError('unavailable', `${name} body not received: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError('invalid_response', `${name} returned a body that is not JSON`);
  }
}
