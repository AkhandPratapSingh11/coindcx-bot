/**
 * Read-only check. Places nothing, cancels nothing, needs no lock.
 *
 * Run this before every live session. It answers the questions that otherwise
 * get answered by a rejected order at the worst moment: does the pair exist,
 * what is its lot size, is there margin in the futures wallet, do the
 * credentials actually work, and what would the first order look like?
 */

import { Broker } from '../broker.js';
import { buildClient } from '../client.js';
import { loadConfig } from '../config.js';
import { checkOrder } from '../instrument.js';
import { log } from '../logger.js';
import { PriceFeed } from '../marks.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const client = buildClient(cfg);
  const prices = new PriceFeed(client, cfg);
  const broker = new Broker(client, cfg, prices);

  log.info('preflight: config', {
    mode: cfg.mode,
    dryRun: cfg.dryRun,
    pair: cfg.pair,
    interval: cfg.candleInterval,
    leverage: cfg.leverage,
    marginType: cfg.marginType,
    riskPercent: cfg.riskPercent,
    stopLossPct: cfg.stopLossPct,
    takeProfitPct: cfg.takeProfitPct ?? null,
  });

  // 1. Does the pair exist?
  const instruments = await client.futures.market.getActiveInstruments(cfg.quoteCurrency);
  const list = Array.isArray(instruments) ? instruments : [];
  const exists = list.includes(cfg.pair);
  log.info('preflight: instrument', {
    pair: cfg.pair,
    exists,
    totalActive: list.length,
    sample: list.slice(0, 8),
  });
  if (!exists) {
    throw new Error(
      `${cfg.pair} is not in the active ${cfg.quoteCurrency} instrument list. ` +
        'Check BASE_CURRENCY/QUOTE_CURRENCY against the sample above.',
    );
  }

  // 2. Size steps, min notional, leverage ceiling — read from the raw payload
  //    because the SDK's own mapping returns nulls for these (see instrument.ts).
  const instrument = await broker.loadInstrument();

  // 3. A live two-sided quote. Seed only — preflight is a one-shot, so it
  //    never starts the feed's subscriptions or refresh timer.
  await prices.seed();
  const quote = prices.getBidAsk();
  const mark = prices.requireFreshMark();
  log.info('preflight: quote', {
    bid: quote?.bid ?? null,
    ask: quote?.ask ?? null,
    mark,
    spreadBps: quote ? ((quote.ask - quote.bid) / mark) * 10_000 : null,
  });

  // 4. Candle history deep enough to warm the indicators.
  const candles = await client.futures.market.getCandles(
    cfg.pair,
    cfg.candleInterval,
    cfg.warmupCandles,
  );
  log.info('preflight: candles', {
    requested: cfg.warmupCandles,
    received: Array.isArray(candles) ? candles.length : 0,
    enoughForEmaSlow: (Array.isArray(candles) ? candles.length : 0) > cfg.emaSlow,
  });

  // 5. Credentials and balance. Paper mode reports engine equity instead.
  const equity = await broker.getEquity();
  log.info('preflight: equity', { currency: cfg.quoteCurrency, equity });

  // 6. Current exposure.
  const [position, openOrders] = await Promise.all([broker.getPosition(), broker.getOpenOrders()]);
  log.info('preflight: exposure', {
    position: position
      ? {
          side: position.side,
          size: position.size,
          entryPrice: position.entryPrice,
          unrealizedPnl: position.unrealizedPnl,
        }
      : null,
    openOrders: openOrders.length,
  });

  // 7. What the first entry would actually be, and whether the venue would
  //    take it.
  const stopLoss = mark * (1 - cfg.stopLossPct);
  const quantity = await broker.sizeEntry(mark, stopLoss);
  const verdict = checkOrder(instrument, quantity, mark, cfg.leverage, 'buy');
  log.info('preflight: projected first long entry', {
    mark,
    stopLoss,
    takeProfit: cfg.takeProfitPct === undefined ? null : mark * (1 + cfg.takeProfitPct),
    quantity,
    notional: quantity * mark,
    minNotional: instrument.minNotional,
    withinQuantityCap: cfg.maxOrderQuantity === undefined || quantity <= cfg.maxOrderQuantity,
    withinNotionalCap:
      cfg.maxOrderNotional === undefined || quantity * mark <= cfg.maxOrderNotional,
    liquidationPriceIfLong: client.ops.sizing.calculateLiquidationPrice(
      mark,
      cfg.leverage,
      'long',
    ),
    acceptable: verdict.ok,
    rejectionReason: verdict.reason ?? null,
  });

  if (!verdict.ok) {
    throw new Error(`The first entry would be rejected: ${verdict.reason}`);
  }

  prices.stop();
  client.disconnect();
  log.info('preflight: OK — no orders were placed');
}

main().catch((err: unknown) => {
  log.error('preflight failed', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
