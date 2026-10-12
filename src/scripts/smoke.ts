/**
 * Paper-only round trip: open -> read back -> flatten -> confirm flat.
 *
 * This exercises the parts that are easy to get wrong and hard to notice:
 * order fields actually reaching the engine, the fill happening, the position
 * being readable in the shape the code expects, and the exit genuinely
 * closing rather than returning success and leaving the position open.
 *
 *   npm run smoke
 *
 * Refuses to run against live mode.
 */

import { Broker } from '../broker.js';
import { buildClient } from '../client.js';
import { loadConfig } from '../config.js';
import { log } from '../logger.js';
import { PriceFeed } from '../marks.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.mode !== 'paper') {
    throw new Error('smoke runs in paper mode only; it places real orders otherwise');
  }
  if (cfg.dryRun) {
    throw new Error('smoke needs DRY_RUN=false to actually exercise the order path');
  }

  const client = buildClient(cfg);
  const prices = new PriceFeed(client, cfg);
  const broker = new Broker(client, cfg, prices);

  const instrument = await broker.loadInstrument();
  await prices.seed();
  const mark = prices.requireFreshMark();

  let failures = 0;
  const check = (name: string, passed: boolean, detail: Record<string, unknown>): void => {
    if (passed) log.info(`PASS ${name}`, detail);
    else {
      failures += 1;
      log.error(`FAIL ${name}`, detail);
    }
  };

  // Start flat.
  const before = await broker.getPosition();
  check('starts flat', before === null, { position: before });

  // Size and open.
  const stopLoss = mark * (1 - cfg.stopLossPct);
  const quantity = await broker.sizeEntry(mark, stopLoss);
  check('sizing produced a tradeable quantity', quantity >= instrument.minQuantity, {
    quantity,
    minQuantity: instrument.minQuantity,
  });

  const order = await broker.open({
    side: 'buy',
    quantity,
    stopLoss,
    takeProfit: undefined,
  });
  check('order was accepted', order !== null, { order: order === null ? null : order.id });
  check('order filled', order?.status === 'filled', { status: order?.status ?? null });
  check('our client_order_id survived the round trip', Boolean(order?.client_order_id?.startsWith('bot-')), {
    clientOrderId: order?.client_order_id ?? null,
  });

  // Read the position back.
  const open = await broker.getPosition();
  check('position is readable after the fill', open !== null, { position: open });
  check('position side is long', open?.side === 'long', { side: open?.side ?? null });
  check('position size matches the order', open?.size === quantity, {
    positionSize: open?.size ?? null,
    ordered: quantity,
  });
  check('entry price is populated', (open?.entryPrice ?? 0) > 0, {
    entryPrice: open?.entryPrice ?? null,
  });

  // Flatten and confirm.
  await broker.flatten('smoke-test');
  const after = await broker.getPosition();
  check('flat after exit', after === null, { position: after });

  const account = client.paper.getAccount();
  log.info('paper account after round trip', {
    futuresBalance: account.futuresBalance,
    usedMargin: account.usedMargin,
    availableMargin: account.availableMargin,
    unrealizedPnl: account.unrealizedPnl,
  });

  prices.stop();
  client.disconnect();

  if (failures > 0) {
    throw new Error(`${failures} smoke check(s) failed`);
  }
  log.info('smoke: all checks passed');
}

main().catch((err: unknown) => {
  log.error('smoke failed', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
