/**
 * A working paper-mode adapter, replacing the SDK's.
 *
 * The SDK installs its paper handler as an **axios adapter**, then reads order
 * fields off `config.data`. By the time an adapter runs, axios has already
 * applied `transformRequest` and `config.data` is a JSON *string*. So the
 * built-in handler does `data.side`, `data.order_type`, `data.base_currency`
 * on a string and gets `undefined` for all of them. Every paper order is
 * created with no side, no type and no quantity: it is never filled (a market
 * order only fills when `order_type === 'market_order'`), the pair is recorded
 * as `B-undefined_undefined`, and no position is ever opened. Paper mode looks
 * like it works — orders come back with ids — but nothing happens.
 *
 * This handler parses the body first, then routes to the same
 * `PaperTradingEngine`. It also implements position exit, which the SDK's
 * handler answers with a bare `[]` while leaving the position open, and it
 * emits snake_case positions so the shape matches the declared
 * `PositionResponse` type that callers are compiled against.
 */

import type { CoinDCXClient, PaperPosition } from '@nemesis-oss/coindcx-sdk';
import { log } from './logger.js';

interface AdapterConfig {
  url?: string;
  data?: unknown;
  params?: unknown;
  method?: string;
}

interface AdapterResponse {
  data: unknown;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  config: AdapterConfig;
}

/** The request body, whether axios has serialized it yet or not. */
function parseBody(config: AdapterConfig): Record<string, unknown> {
  const raw = config.data ?? config.params ?? {};
  if (typeof raw === 'string') {
    if (raw.trim() === '') return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      log.warn('paper adapter: could not parse request body', { body: raw.slice(0, 200) });
      return {};
    }
  }
  return raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

/** camelCase paper position -> the snake_case shape the SDK's types promise. */
function toPositionResponse(p: PaperPosition): Record<string, unknown> {
  return {
    id: p.id,
    pair: p.pair,
    side: p.side,
    size: p.size,
    entry_price: p.entryPrice,
    mark_price: p.markPrice,
    liquidation_price: p.liquidationPrice,
    unrealized_pnl: p.unrealizedPnl,
    realized_pnl: p.realizedPnl,
    leverage: p.leverage,
    margin_type: p.marginType,
    margin: p.margin,
    timestamp: p.timestamp,
  };
}

function ok(data: unknown, config: AdapterConfig): AdapterResponse {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    config,
  };
}

/**
 * Installs the corrected handler. Call immediately after constructing the
 * client, before any order is placed.
 */
export function installPaperAdapter(client: CoinDCXClient): void {
  const engine = client.paper;
  const brackets = new Map<string, { stop: number; tp?: number }>();
  const closing = new Set<string>();


  const closePosition = async (pair: string): Promise<unknown> => {
    const position = engine.getPosition(pair);
    if (!position) return [];
    brackets.delete(position.id);

    // Exactly the position size: an oversized opposite fill flips the paper
    // position rather than closing it.
    const parsed = parsePair(pair);
    const result = await engine.placeOrder({
      side: position.side === 'long' ? 'sell' : 'buy',
      order_type: 'market_order',
      base_currency: parsed.base,
      quote_currency: parsed.quote,
      target_quantity: position.size,
      price: undefined,
      leverage: position.leverage,
      client_order_id: `paper-exit-${Date.now()}`,
      time_in_force: undefined,
      stop_loss: undefined,
      take_profit: undefined,
      margin_type: position.marginType,
    });
    log.info('paper adapter: position exited', {
      pair,
      side: position.side,
      size: position.size,
      closeStatus: result.status,
    });
    return result;
  };

  const handler = async (config: AdapterConfig): Promise<AdapterResponse> => {
    const url = String(config.url ?? '');
    const body = parseBody(config);

    // Order of these tests matters: '/orders/cancel_all' must be checked
    // before '/orders/cancel', and both before the bare '/orders'.
    if (url.includes('/orders/create')) {
      const spec = body['order'] as Record<string, unknown> | undefined;
      if (!spec || typeof spec['pair'] !== 'string' || !['buy', 'sell'].includes(String(spec['side'])) ||
          spec['order_type'] !== 'market_order' || !(Number(spec['total_quantity']) > 0)) {
        throw new Error('Paper adapter requires the documented nested market order contract');
      }
      const parsed = parsePair(spec['pair']);
      const order = await engine.placeOrder({
        side: spec['side'], order_type: spec['order_type'],
        base_currency: parsed.base, quote_currency: parsed.quote,
        target_quantity: spec['total_quantity'], leverage: spec['leverage'],
        client_order_id: spec['client_order_id'],
        margin_type: spec['position_margin_type'] === 'crossed' ? 'cross' : 'isolated',
      } as never);
      const pos = engine.getPosition(spec['pair']);
      if (pos && Number(spec['stop_loss_price']) > 0) {
        brackets.set(pos.id, { stop: Number(spec['stop_loss_price']),
          ...(spec['take_profit_price'] === undefined ? {} : { tp: Number(spec['take_profit_price']) }) });
      }
      if (order.status === 'rejected') {
        log.warn('paper adapter: order rejected — no price cached for the pair', {
          pair: order.pair,
          hint: 'PriceFeed must call paper.updatePrice() before a market order can fill.',
        });
      }
      return ok([{ ...order, total_quantity: order.target_quantity }], config);
    }
    if (url.includes('/orders/cancel_all')) {
      const cancelled: unknown[] = [];
      for (const o of engine.getOpenOrders()) {
        if (body['pair'] && o.pair !== body['pair']) continue;
        if (await engine.cancelOrder(o.id)) cancelled.push(o.id);
      }
      return ok(cancelled, config);
    }
    if (url.includes('/orders/cancel')) {
      const id = String(body['id'] ?? body['order_id'] ?? '');
      return ok(await engine.cancelOrder(id), config);
    }
    if (url.includes('/orders/details') || url.includes('/orders/status')) {
      const id = String(body['id'] ?? body['order_id'] ?? '');
      return ok(engine.getOrder(id) ?? null, config);
    }
    if (url.includes('/orders/edit') || url.includes('/orders/update')) {
      const id = String(body['id'] ?? body['order_id'] ?? '');
      return ok(engine.getOrder(id) ?? null, config);
    }
    if (url.includes('/orders')) {
      const status = body['status'];
      const orders = typeof status === 'string' && status.includes('open') ? engine.getOpenOrders() : engine.getOrders();
      const matching = orders.filter(o => !body['side'] || o.side === body['side']);
      const start = (Number(body['page'] ?? 1) - 1) * Number(body['size'] ?? 100);
      return ok(matching.slice(start, start + Number(body['size'] ?? 100)).map(o => ({
        ...o, id: o.id, pair: o.pair, status: o.status, total_quantity: o.quantity,
      })), config);
    }

    if (url.includes('/positions/exit')) {
      if (typeof body['id'] !== 'string') throw new Error('Position exit requires id');
      const pos = engine.getPositions().find(p => p.id === body['id']);
      return ok(pos ? await closePosition(pos.pair) : [], config);
    }
    if (url.includes('/positions/close')) {
      const id = String(body['id'] ?? '');
      const match = engine.getPositions().find((p) => String(p.id) === id);
      return ok(match ? await closePosition(match.pair) : [], config);
    }
    if (url.includes('/positions/create_tpsl')) {
      const pos = engine.getPositions().find(p => p.id === body['id']);
      const stop = body['stop_loss'] as Record<string, unknown> | undefined;
      const tp = body['take_profit'] as Record<string, unknown> | undefined;
      if (!pos || stop?.['order_type'] !== 'stop_market' || !(Number(stop['stop_price']) > 0)) {
        throw new Error('Invalid paper TP/SL request');
      }
      brackets.set(pos.id, { stop: Number(stop['stop_price']),
        ...(tp === undefined ? {} : { tp: Number(tp['stop_price']) }) });
      return ok({ stop_loss: { id: `sl-${pos.id}`, status: 'untriggered' } }, config);
    }
    if (url.includes('/positions/update_leverage') || url.includes('/positions/margin_type')) {
      return ok({}, config);
    }
    if (url.includes('/positions')) {
      const pair = body['pair'];
      const positions = engine
        .getPositions()
        .filter((p) => typeof pair !== 'string' || p.pair === pair)
        .map(p => ({ ...toPositionResponse(p), stop_loss_trigger: brackets.get(p.id)?.stop ?? null,
          take_profit_trigger: brackets.get(p.id)?.tp ?? null }));
      const start = (Number(body['page'] ?? 1) - 1) * Number(body['size'] ?? 100);
      return ok(positions.slice(start, start + Number(body['size'] ?? 100)), config);
    }

    return ok({}, config);
  };

  // Simulate venue market stops/TP on each quote, independent of the engine.
  const updatePrice = engine.updatePrice.bind(engine);
  engine.updatePrice = (pair, bid, ask) => {
    updatePrice(pair, bid, ask);
    const pos = engine.getPosition(pair);
    if (!pos || closing.has(pair)) return;
    const bracket = brackets.get(pos.id);
    if (!bracket) return;
    const mark = (bid + ask) / 2;
    const hit = pos.side === 'long' ? mark <= bracket.stop || (bracket.tp !== undefined && mark >= bracket.tp)
      : mark >= bracket.stop || (bracket.tp !== undefined && mark <= bracket.tp);
    if (hit) {
      closing.add(pair);
      void closePosition(pair).catch(err => log.error('paper bracket exit failed', { error: String(err) }))
        .finally(() => closing.delete(pair));
    }
  };

  client.setPaperMode(true, handler as (config: unknown) => Promise<unknown>);
  log.info('paper adapter installed (replaces the SDK handler, which cannot read its own request body)');
}

function parsePair(pair: string): { base: string; quote: string } {
  // B-BTC_USDT -> { base: 'BTC', quote: 'USDT' }
  const withoutEcode = pair.includes('-') ? (pair.split('-')[1] ?? pair) : pair;
  const [base, quote] = withoutEcode.split('_');
  return { base: base ?? '', quote: quote ?? 'USDT' };
}
