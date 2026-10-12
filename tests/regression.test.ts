import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { CoinDCXAPIError, CoinDCXClient } from '@nemesis-oss/coindcx-sdk';
import { Broker } from '../src/broker.js';
import { Engine } from '../src/engine.js';
import { PriceFeed } from '../src/marks.js';
import { buildClient } from '../src/client.js';
import { loadConfig, type Config } from '../src/config.js';
import { log } from '../src/logger.js';
import { venueRequest, type VenueRequest } from '../src/venue.js';
import { assertClientOrderId, MAX_CLIENT_ORDER_ID_LENGTH } from '../src/instrument.js';

for (const level of ['info', 'warn', 'error', 'debug'] as const) log[level] = () => {};
const cfg: Config = { ...loadConfig(), apiKey: 'test', apiSecret: 'test-secret', mode: 'live',
  dryRun: false, pair: 'B-BTC_USDT', candleInterval: '1m', candleIntervalMs: 60_000,
  maxOrderQuantity: 10, maxOrderNotional: 1000, maxSlippagePct: 0.005 };
const instrument = { pair: cfg.pair, status: 'active', quantityIncrement: 0.001,
  priceIncrement: 0.1, minQuantity: 0.001, maxQuantity: 1000, minNotional: 1,
  maxMarketOrderQuantity: null, maxLeverageLong: 100, maxLeverageShort: 100, exitOnly: false };
const prices = { requireFreshMark: () => 100, getMark: () => 100,
  getBidAsk: () => ({ bid: 99.9, ask: 100.1 }), isStale: () => false } as unknown as PriceFeed;
const position = (extras = {}) => ({ id: 'position-1', pair: cfg.pair, active_pos: 1,
  avg_price: 100, stop_loss_trigger: 98, take_profit_trigger: 110, ...extras });
const order = { id: 'order-1', pair: cfg.pair, total_quantity: 1, side: 'buy', status: 'filled' };
const entry = { side: 'buy' as const, quantity: 1, stopLoss: 98, takeProfit: 110 };
function broker(request: VenueRequest, config = cfg): Broker {
  const b = new Broker({} as CoinDCXClient, config, prices, request);
  (b as any).instrument = instrument;
  return b;
}

test('client order IDs accept the venue boundary and reject empty or oversized values', () => {
  assert.equal(MAX_CLIENT_ORDER_ID_LENGTH, 36);
  assert.doesNotThrow(() => assertClientOrderId('a'.repeat(36)));
  assert.throws(() => assertClientOrderId(''), /must not be empty/);
  assert.throws(() => assertClientOrderId('a'.repeat(37)), /37 characters.*maximum is 36/);
  assert.throws(() => assertClientOrderId('bot-00000000-0000-4000-8000-000000000000'), /40 characters/);
});

test('wire requests sign millisecond timestamp and serialize GET body without exposing credentials', async () => {
  const client = new CoinDCXClient({ apiKey: 'test', apiSecret: 'test' });
  const sent: any[] = [];
  (client.futures.trading as any).axiosInstance.defaults.adapter = async (config: any) => {
    sent.push(config);
    return { data: [], status: 200, statusText: 'OK', headers: {}, config };
  };
  await venueRequest(client, cfg)('GET', 'wallets');
  assert.equal(sent[0].params, undefined);
  const raw = sent[0].data;
  assert.ok(JSON.parse(raw).timestamp > 1e12);
  assert.equal(sent[0].headers['X-AUTH-SIGNATURE'], createHmac('sha256', cfg.apiSecret).update(raw).digest('hex'));
});

test('entry uses nested API payload and waits for a delayed fill', async () => {
  const calls: any[] = []; let created = false; let reads = 0;
  const b = broker(async (_method, path, body) => {
    calls.push({ path, body });
    if (path === 'positions') return created && ++reads >= 2 ? [position()] : [];
    if (path === 'orders') return [];
    if (path === 'orders/create') { created = true; return [order]; }
    throw new Error(`Unexpected ${path}`);
  });
  await b.open(entry);
  const payload = calls.find(c => c.path === 'orders/create').body;
  assert.equal(payload.order.pair, cfg.pair);
  assert.equal(payload.order.total_quantity, 1);
  assert.equal(payload.order.stop_loss_price, 98);
  assert.equal(payload.order.take_profit_price, 110);
  assert.equal(payload.order.price, null);
  assert.equal(payload.order.notification, 'no_notification');
  assert.equal(payload.order.client_order_id.length, 33);
  assert.match(payload.order.client_order_id, /^b[0-9a-f]{32}$/);
  assert.equal(payload.target_quantity, undefined);
  assert.ok(reads >= 2);
});

test('missing inline protection uses position-id TP/SL endpoint and confirms triggers', async () => {
  let attached = false; const calls: any[] = [];
  const b = broker(async (_m, path, body) => {
    calls.push({ path, body });
    if (path === 'positions/create_tpsl') { attached = true; return { stop_loss: { status: 'untriggered' } }; }
    if (path === 'positions') return [position({ stop_loss_trigger: attached ? 98 : null })];
    throw new Error(path);
  });
  const pos = await b.getPosition();
  await b.ensureProtection(pos!, 98, 110);
  assert.deepEqual(calls.find(c => c.path === 'positions/create_tpsl').body,
    { id: 'position-1', stop_loss: { stop_price: '98', order_type: 'stop_market' },
      take_profit: { stop_price: '110', order_type: 'take_profit_market' } });
});

test('failed protection exits by position id and permanently blocks further entries', async () => {
  let created = false; let exited = false; let submissions = 0;
  const b = broker(async (_m, path, body) => {
    if (path === 'positions') return created && !exited ? [position({ stop_loss_trigger: null })] : [];
    if (path === 'orders') return [];
    if (path === 'orders/create') { created = true; submissions++; return [order]; }
    if (path === 'positions/create_tpsl') throw new CoinDCXAPIError('TP/SL rejected', 400, {}, 'POST', path);
    if (path === 'orders/cancel') return {};
    if (path === 'positions/exit') { assert.equal(body!.id, 'position-1'); exited = true; return {}; }
    throw new Error(path);
  });
  await assert.rejects(b.open(entry), /TP\/SL rejected/);
  assert.equal(exited, true);
  await assert.rejects(b.open(entry), /Entries blocked/);
  assert.equal(submissions, 1);
});

for (const status of [400, 422]) {
  test(`HTTP ${status} create rejection permits a later entry without cleanup mutations`, async () => {
    let submissions = 0; let created = false; const ids: string[] = [];
    const error = new CoinDCXAPIError('create refused', status, {}, 'POST', 'orders/create');
    const b = broker(async (_m, path, body) => {
      if (path === 'positions') return created ? [position()] : [];
      if (path === 'orders') return [];
      if (path === 'orders/create') {
        submissions++;
        ids.push(String((body!.order as any).client_order_id));
        if (submissions === 1) throw error;
        created = true; return [order];
      }
      assert.fail(`Unexpected cleanup mutation: ${path}`);
    });
    await assert.rejects(b.open(entry), err => err === error);
    assert.equal((await b.open(entry))?.id, order.id);
    assert.equal(submissions, 2);
    assert.notEqual(ids[0], ids[1]);
  });
}

for (const status of [408, 500, 503]) {
  test(`HTTP ${status} create failure keeps entries latched and records the cause`, async () => {
    let submissions = 0;
    const error = new CoinDCXAPIError('create outcome unknown', status, {}, 'POST', 'orders/create');
    const b = broker(async (_m, path) => {
      if (path === 'orders' || path === 'positions') return [];
      if (path === 'orders/create') { submissions++; throw error; }
      throw new Error(path);
    });
    await assert.rejects(b.open(entry), err => err === error);
    await assert.rejects(b.open(entry), /Entries blocked: .*create outcome unknown/);
    assert.equal(submissions, 1);
  });
}

test('malformed acknowledgement stays latched and preserves the cause when cleanup also fails', async () => {
  let submissions = 0;
  const b = broker(async (_m, path) => {
    if (path === 'positions') {
      if (submissions) throw new Error('cleanup read failed');
      return [];
    }
    if (path === 'orders') return [];
    if (path === 'orders/create') { submissions++; return {}; }
    throw new Error(path);
  });
  await assert.rejects(b.open(entry), /Order has no valid id or pair/);
  await assert.rejects(b.open(entry), /Entries blocked: .*Order has no valid id or pair/);
  assert.equal(submissions, 1);
});

test('venue response-body rejection retains its status so the broker can release the latch', async () => {
  const client = new CoinDCXClient({ apiKey: 'test', apiSecret: 'test' });
  const request = venueRequest(client, cfg);
  let submissions = 0;
  (client.futures.trading as any).axiosInstance.defaults.adapter = async (config: any) => {
    const data = config.url.endsWith('/orders/create')
      ? (submissions++, { status: '400', message: 'Client order is too long' }) : [];
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
  const b = broker(request);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(b.open(entry), err => {
      assert.match((err as Error).message, /Client order is too long/);
      assert.equal((err as CoinDCXAPIError).status, 400);
      return true;
    });
  }
  assert.equal(submissions, 2);
});

test('uncertain submission is not resubmitted even when positions still appear flat', async () => {
  let submissions = 0;
  const b = broker(async (_m, path) => {
    if (path === 'orders' || path === 'positions') return [];
    if (path === 'orders/create') { submissions++; throw new Error('timeout after send'); }
    throw new Error(path);
  });
  await assert.rejects(b.open(entry), /timeout/);
  await assert.rejects(b.open(entry), /Entries blocked/);
  assert.equal(submissions, 1);
});

test('exit waits through delayed venue position reads', async () => {
  let exiting = false; let reads = 0;
  const b = broker(async (_m, path, body) => {
    if (path === 'positions') return exiting && ++reads >= 2 ? [] : [position()];
    if (path === 'positions/exit') { assert.equal(body!.id, 'position-1'); assert.equal(body!.pair, undefined); exiting = true; return {}; }
    throw new Error(path);
  });
  await b.flatten('test'); assert.ok(reads >= 2);
});

test('fresh executable price and slippage allowance enforce the notional cap before sending', async () => {
  let sent = false;
  const b = broker(async (_m, path) => {
    if (path === 'orders' || path === 'positions') return [];
    sent = true; return [order];
  }, { ...cfg, maxOrderNotional: 100 });
  await assert.rejects(b.open(entry), /Notional cap/);
  assert.equal(sent, false);
});

test('NaN quantity and off-step quantities cannot reach the venue', async () => {
  const b = broker(async () => []);
  await assert.rejects(b.open({ ...entry, quantity: NaN }), /finite/);
  await assert.rejects(b.open({ ...entry, quantity: 0.0015 }), /multiple/);
});

test('malformed exposure fails closed; a real zero position is flat', async () => {
  for (const raw of [{}, [position({ avg_price: undefined })], [position({ id: undefined })], [{ pair: cfg.pair }]]) {
    await assert.rejects(broker(async () => raw).getPosition());
  }
  assert.equal(await broker(async () => [position({ active_pos: 0 })]).getPosition(), null);
});

test('positions paginate so exposure after the first page is not missed', async () => {
  const b = broker(async (_m, path, body) => {
    assert.equal(path, 'positions');
    return body!.page === '1' ? Array.from({ length: 100 }, (_, i) => position({ pair: `B-OTHER${i}_USDT` })) : [position()];
  });
  assert.equal((await b.getPosition())?.id, 'position-1');
});

test('working orders on either side prevent stacking another entry', async () => {
  const b = broker(async (_m, path, body) => path === 'positions' ? [] : body!.side === 'sell' ? [order] : []);
  await assert.rejects(b.open(entry), /Working orders/);
});

const interval = 60_000;
const boundary = Math.floor(Date.now() / interval) * interval;
function candle(t: number, close: number) {
  return { time: t, open: close, high: close, low: close, close, volume: 1 };
}
function engine(raw: () => unknown, seen: number[], targets: string[] = []) {
  const e = new Engine({ futures: { market: { getCandles: async () => raw() } } } as any,
    cfg, {} as Broker, prices, { name: 'test', isReady: () => true, warmup: () => {},
      onClosedCandle: c => { seen.push(c.close); return c.close > 100 ? 'long' : 'flat'; } });
  (e as any).applyTarget = async (target: string) => { targets.push(target); };
  return e as any;
}

test('REST finalized close overrides cached partial; forming candle never reaches strategy', async () => {
  const seen: number[] = []; const targets: string[] = [];
  const e = engine(() => [candle(boundary - interval, 150), candle(boundary, 100)], seen, targets);
  e.lastDispatched = boundary - 2 * interval;
  await e.pollCandles();
  assert.deepEqual(seen, [150]); assert.deepEqual(targets, ['long']);
  await e.pollCandles(); assert.deepEqual(seen, [150]);
});

test('gap recovery updates all missing indicators and executes only latest target', async () => {
  const seen: number[] = []; const targets: string[] = [];
  const e = engine(() => Array.from({ length: 6 }, (_, i) => candle(boundary - (5 - i) * interval, 98 + i)), seen, targets);
  e.lastDispatched = boundary - 6 * interval;
  await e.pollCandles();
  assert.deepEqual(seen, [98, 99, 100, 101, 102]); assert.deepEqual(targets, ['long']);
});

test('unrecoverable gap blocks pending target until contiguous data returns', async () => {
  const seen: number[] = []; const targets: string[] = [];
  const e = engine(() => [candle(boundary - interval, 150), candle(boundary, 100)], seen, targets);
  e.lastDispatched = boundary - 4 * interval;
  e.pendingTarget = 'long'; e.targetVersion = 1;
  await assert.rejects(e.pollCandles(), /Missing candles/);
  await e.drainTarget(); assert.deepEqual(targets, []); assert.deepEqual(seen, []);
});

test('target arriving during an active order is applied once that order settles', async () => {
  const e = engine(() => [], []); let release!: () => void; const targets: string[] = [];
  const pending = new Promise<void>(resolve => { release = resolve; });
  e.applyTarget = async (target: string) => { targets.push(target); if (target === 'long') await pending; };
  e.pendingTarget = 'long'; e.targetVersion = 1;
  const first = e.drainTarget();
  await new Promise(resolve => setImmediate(resolve));
  const second = e.onClosedCandle({ ...candle(boundary - interval, 90), openTime: boundary - interval });
  release(); await Promise.all([first, second]);
  assert.deepEqual(targets, ['long', 'flat']);
});

test('failed action retains target for a later bounded retry', async () => {
  const e = engine(() => [], []); let attempts = 0;
  e.applyTarget = async () => { if (++attempts === 1) throw new Error('temporary read failure'); };
  e.pendingTarget = 'flat'; e.targetVersion = 1;
  await e.drainTarget(); assert.equal(e.appliedVersion, 0);
  await e.drainTarget(); assert.equal(e.appliedVersion, 1); assert.equal(attempts, 2);
});

test('actual SDK stream events reach price feed and merged deltas preserve top of book', () => {
  const client = new CoinDCXClient({ apiKey: 'test', apiSecret: 'test' });
  const feed = new PriceFeed(client, cfg);
  feed.start();
  try {
    client.ws.emit('depth-snapshot', { bids: { '99': '1', '98': '1' }, asks: { '101': '1', '102': '1' } });
    assert.deepEqual(feed.getBidAsk(), { bid: 99, ask: 101 });
    client.ws.emit('depth-update', { bids: { '99': '0' }, asks: {} });
    assert.deepEqual(feed.getBidAsk(), { bid: 98, ask: 101 });
  } finally { feed.stop(); }
});

test('SDK candle/private runtime events trigger engine callbacks', async () => {
  const client = new CoinDCXClient({ apiKey: 'test', apiSecret: 'test' });
  const e = new Engine(client, cfg, {} as Broker, prices, {} as any) as any;
  let polls = 0; let updates = 0;
  e.pollCandles = async () => { polls++; };
  const originalInfo = log.info;
  log.info = (msg) => { if (msg === 'order update') updates++; };
  try {
    e.subscribeCandles(); e.wirePrivateStreams();
    client.ws.emit('candlestick', { open_time: boundary, close: '100' });
    client.ws.emit('df-order-update', { id: 'test', status: 'filled' });
    assert.equal(polls, 1); assert.equal(updates, 1);
  } finally { log.info = originalInfo; }
});

test('paper round trip shares live wire contract and simulates venue stop independently', async () => {
  const paperCfg = { ...cfg, mode: 'paper' as const, paperSlippage: 0 };
  const client = buildClient(paperCfg);
  client.paper.updatePrice(cfg.pair, 99.9, 100.1);
  const b = new Broker(client, paperCfg, prices);
  (b as any).instrument = instrument;
  const result = await b.open(entry);
  assert.equal(result?.status, 'filled');
  assert.equal((await b.getPosition())?.stopLoss, 98);
  client.paper.updatePrice(cfg.pair, 97.9, 98);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await b.getPosition(), null);
});

test('stale successful REST response cannot release a pending entry', async () => {
  const seen: number[] = []; const targets: string[] = [];
  const e = engine(() => [candle(boundary - 3 * interval, 150)], seen, targets);
  e.lastDispatched = boundary - 4 * interval;
  e.pendingTarget = 'long'; e.targetVersion = 1;
  await assert.rejects(e.pollCandles(), /stale/);
  await e.drainTarget(); assert.deepEqual(targets, []);
});

test('REST polling continues to update the newest target while an entry is pending', async () => {
  let history = [candle(boundary - 2 * interval, 150), candle(boundary - interval, 150)];
  const seen: number[] = []; const targets: string[] = [];
  const e = engine(() => history, seen, targets);
  e.lastDispatched = boundary - 3 * interval;
  let release!: () => void;
  const pending = new Promise<void>(r => { release = r; });
  e.applyTarget = async (target: string) => { targets.push(target); if (target === 'long') await pending; };
  const first = e.pollCandles();
  await new Promise(resolve => setImmediate(resolve));
  // Exercise the same fetch path independently of action duration. A new
  // closed bar would ordinarily arrive at the next boundary.
  e.lastDispatched = boundary - 2 * interval;
  history = [candle(boundary - interval, 90), candle(boundary, 90)];
  const second = e.pollCandles();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(e.pendingTarget, 'flat');
  release(); await Promise.all([first, second]);
  assert.deepEqual(targets, ['long', 'flat']);
});

test('split entry acknowledgements cancel every remaining entry child before releasing the block', async () => {
  let created = false; const cancelled: string[] = [];
  const children = [{ ...order, id: 'child-1', status: 'partially_filled' }, { ...order, id: 'child-2', status: 'open' }];
  const b = broker(async (_m, path, body) => {
    if (path === 'positions') return created ? [position()] : [];
    if (path === 'orders') return created && body!.side === 'buy' ? children.filter(o => !cancelled.includes(o.id)) : [];
    if (path === 'orders/create') { created = true; return children; }
    if (path === 'orders/cancel') { cancelled.push(String(body!.id)); return {}; }
    throw new Error(path);
  });
  await b.open(entry);
  assert.deepEqual(cancelled, ['child-1', 'child-2']);
});

test('dry-run does not send entries, exits, or TP/SL mutations', async () => {
  const mutations: string[] = []; let exposed = false;
  const b = broker(async (_m, path) => {
    if (path === 'positions') return exposed ? [position({ stop_loss_trigger: null })] : [];
    if (path === 'orders') return [];
    mutations.push(path); return {};
  }, { ...cfg, dryRun: true });
  assert.equal(await b.open(entry), null);
  exposed = true;
  await b.ensureProtection((await b.getPosition())!, 98, 110);
  await b.flatten('dry-run');
  assert.deepEqual(mutations, []);
});

test('newly visible unprotected position is protected by the monitor', async () => {
  let protectedPosition = false;
  const e = new Engine({} as any, cfg, {
    getPosition: async () => ({ side: 'long', entryPrice: 100, stopLoss: null }),
    ensureProtection: async () => { protectedPosition = true; },
  } as any, prices, {} as any) as any;
  await e.monitorStop(); assert.equal(protectedPosition, true);
});

test('invalid boolean configuration cannot accidentally disable dry-run', () => {
  const previous = process.env['DRY_RUN'];
  process.env['DRY_RUN'] = 'treu';
  try { assert.throws(() => loadConfig(), /must be a boolean/); }
  finally { if (previous === undefined) delete process.env['DRY_RUN']; else process.env['DRY_RUN'] = previous; }
});
