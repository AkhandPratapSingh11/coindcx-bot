import { createHmac } from 'node:crypto';
import type { CoinDCXClient } from '@nemesis-oss/coindcx-sdk';
import type { Config } from './config.js';

export type VenueRequest = (method: 'GET' | 'POST', path: string,
  body?: Record<string, unknown>) => Promise<unknown>;

/** The SDK's futures types, signing timestamp and GET serialization differ
 * from the venue contract. Keep the runtime bridge here; use its existing
 * HTTP timeout, rate limiter and paper adapter, but sign the exact wire body.
 * Writes are never automatically retried: futures idempotency is unverified.
 */
export function venueRequest(client: CoinDCXClient, cfg: Config): VenueRequest {
  const runtime = client.futures.trading as unknown as {
    axiosInstance: { request(config: Record<string, unknown>): Promise<{ data: unknown }> };
  };
  return async (method, path, body = {}) => {
    const payload = JSON.stringify({ ...body, timestamp: Date.now() });
    const headers = cfg.mode === 'live' ? {
      'X-AUTH-APIKEY': cfg.apiKey,
      'X-AUTH-SIGNATURE': createHmac('sha256', cfg.apiSecret).update(payload).digest('hex'),
    } : {};
    const response = await runtime.axiosInstance.request({
      method, url: `/exchange/v1/derivatives/futures/${path}`, data: payload, headers,
    });
    const data = response.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const r = data as Record<string, unknown>;
      if (r['success'] === false || (r['status'] !== undefined &&
          Number.isFinite(Number(r['status'])) && Number(r['status']) >= 400)) {
        throw new Error(`Venue rejected ${path}: ${String(r['message'] ?? r['error'] ?? r['status'])}`);
      }
    }
    return data;
  };
}
