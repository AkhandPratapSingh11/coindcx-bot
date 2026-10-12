/**
 * Client construction. One place decides whether orders can reach the
 * exchange, and the guardrails are attached at the same moment the
 * credentials are — they cannot be forgotten separately.
 */

import { CoinDCXClient, type TradingSafetyLimits } from '@nemesis-oss/coindcx-sdk';
import type { Config } from './config.js';
import { log } from './logger.js';
import { installPaperAdapter } from './paper-adapter.js';

export function buildClient(cfg: Config): CoinDCXClient {
  const safetyLimits: TradingSafetyLimits = {};
  if (cfg.maxOrderQuantity !== undefined) safetyLimits.maxOrderQuantity = cfg.maxOrderQuantity;
  if (cfg.maxOrderNotional !== undefined) safetyLimits.maxOrderNotional = cfg.maxOrderNotional;

  const client = new CoinDCXClient({
    apiKey: cfg.apiKey,
    apiSecret: cfg.apiSecret,
    ...(cfg.wsUrl ? { wsUrl: cfg.wsUrl } : {}),
    paperMode: cfg.mode === 'paper',
    initialBalance: cfg.paperBalance,
    initialFuturesBalance: cfg.paperBalance,
    takerFee: cfg.paperTakerFee,
    makerFee: cfg.paperTakerFee,
    slippage: cfg.paperSlippage,
    safetyLimits: Object.keys(safetyLimits).length > 0 ? safetyLimits : undefined,
    // Public market reads use SDK retries. Broker writes use venue.ts and
    // are submitted once; an uncertain outcome blocks subsequent entries.
    maxRetries: 3,
    retryBaseDelayMs: 500,
    retryMaxDelayMs: 10_000,
  });

  // The SDK's own paper handler cannot read the request body it is handed, so
  // swap it out before anything places an order. See paper-adapter.ts.
  if (cfg.mode === 'paper') {
    installPaperAdapter(client);
  }

  log.info('client ready', {
    mode: cfg.mode,
    dryRun: cfg.dryRun,
    pair: cfg.pair,
    safetyLimits: client.getSafetyLimits() ?? null,
    retry: client.getRetryConfig(),
  });

  return client;
}
