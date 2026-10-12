/**
 * Best bid/ask for the traded pair.
 *
 * Two jobs:
 *   1. Give the engine a mark price for stop monitoring and sizing.
 *   2. Feed the SDK's paper engine. This is NOT optional in paper mode —
 *      `PaperTradingEngine.fillMarketOrder` looks the pair up in its price
 *      cache and marks the order `rejected` if nothing is there. Without
 *      `paper.updatePrice(...)` every paper market order silently fails.
 *
 * The WS depth payload carries no pair field, so this class is deliberately
 * single-pair. Trading several instruments means one feed per pair on its own
 * socket, or switching to the batched futures price stream.
 */

import type { CoinDCXClient } from '@nemesis-oss/coindcx-sdk';
import type { Config } from './config.js';
import { log } from './logger.js';
import * as state from './state.js';

export interface BidAsk {
  bid: number;
  ask: number;
}

/** Highest bid / lowest ask out of a depth map keyed by price string. */
function topOfBook(levels: Record<string, number | string>, side: 'bid' | 'ask'): number | null {
  let best: number | null = null;
  for (const [priceStr, qtyRaw] of Object.entries(levels)) {
    const price = Number(priceStr);
    const qty = Number(qtyRaw);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (!Number.isFinite(qty) || qty <= 0) continue; // a zero-qty level is a deletion
    if (best === null) best = price;
    else if (side === 'bid' ? price > best : price < best) best = price;
  }
  return best;
}

const STALE_AFTER_MS = 15_000;
const REFRESH_INTERVAL_MS = 10_000;

export class PriceFeed {
  private current: BidAsk | null = null;
  private lastUpdate = 0;
  private timer: NodeJS.Timeout | null = null;
  private depthHandler: ((data: import('@nemesis-oss/coindcx-sdk').WsDepthData) => void) | null = null;
  private bids: Record<string, number | string> = {};
  private asks: Record<string, number | string> = {};

  constructor(
    private readonly client: CoinDCXClient,
    private readonly cfg: Config,
  ) {}

  /** Pulls one REST snapshot so the engine is never blind at startup. */
  async seed(): Promise<void> {
    await this.refreshFromRest();
    if (!this.current) {
      throw new Error(
        `Could not read an order book for ${this.cfg.pair}. Check the pair exists ` +
          '(npm run preflight lists valid instruments) before starting the engine.',
      );
    }
  }

  /**
   * Subscribes to depth updates and starts the REST fallback poller.
   * Call after `client.connectWebsocket()`.
   */
  start(): void {
    const onDepth = (data: { bids: Record<string, number | string>; asks: Record<string, number | string> }): void => {
      this.mergeLevels(this.bids, data.bids ?? {});
      this.mergeLevels(this.asks, data.asks ?? {});
      const bid = topOfBook(this.bids, 'bid');
      const ask = topOfBook(this.asks, 'ask');
      if (bid === null || ask === null) return;
      // A crossed book means we are mid-update; wait for the next frame rather
      // than handing the paper engine a negative spread.
      if (ask <= bid) return;
      this.set(bid, ask);
    };

    this.depthHandler = onDepth;
    this.client.ws.on('depthSnapshot', this.onSnapshot);
    this.client.ws.on('depthUpdate', onDepth);
    this.client.publicStreams.subscribeOrderBook(this.cfg.pair);

    this.timer = setInterval(() => {
      if (Date.now() - this.lastUpdate < REFRESH_INTERVAL_MS) return;
      void this.refreshFromRest().catch((err: unknown) => {
        log.warn('price refresh failed', { error: String(err) });
      });
    }, REFRESH_INTERVAL_MS);
    // Not unref'd — see the note on Engine.addTimer. This timer is part of
    // what keeps the process alive when the websocket is gone.
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.client.ws.off('depthSnapshot', this.onSnapshot);
    if (this.depthHandler) this.client.ws.off('depthUpdate', this.depthHandler);
    this.depthHandler = null;
  }

  private readonly onSnapshot = (data: import('@nemesis-oss/coindcx-sdk').WsDepthData): void => {
    this.bids = {}; this.asks = {};
    this.depthHandler?.(data);
  };

  private mergeLevels(book: Record<string, number | string>, delta: Record<string, number | string>): void {
    for (const [price, qty] of Object.entries(delta)) {
      if (Number(qty) === 0) delete book[price];
      else book[price] = qty;
    }
  }

  private async refreshFromRest(): Promise<void> {
    const book = await this.client.futures.market.getOrderBook(this.cfg.pair);
    this.bids = { ...book.bids };
    this.asks = { ...book.asks };
    const bid = topOfBook(book.bids ?? {}, 'bid');
    const ask = topOfBook(book.asks ?? {}, 'ask');
    if (bid === null || ask === null || ask <= bid) return;
    this.set(bid, ask);
  }

  private set(bid: number, ask: number): void {
    this.current = { bid, ask };
    this.lastUpdate = Date.now();
    state.update({ quote: { bid, ask }, quoteAt: this.lastUpdate, quoteStale: false });
    // Keep the paper engine's cache warm even in live mode: it costs nothing
    // and means flipping MODE=paper never produces a run of rejected orders.
    this.client.paper.updatePrice(this.cfg.pair, bid, ask);
  }

  getBidAsk(): BidAsk | null {
    return this.current;
  }

  /** Mid price, or null if we have never had a quote. */
  getMark(): number | null {
    if (!this.current) return null;
    return (this.current.bid + this.current.ask) / 2;
  }

  isStale(): boolean {
    const stale = Date.now() - this.lastUpdate > STALE_AFTER_MS;
    if (stale) state.update({ quoteStale: true });
    return stale;
  }

  /** Throws unless we hold a fresh two-sided quote. Gate every order on this. */
  requireFreshMark(): number {
    const mark = this.getMark();
    if (mark === null) throw new Error('No price quote available yet');
    if (this.isStale()) {
      throw new Error(`Price feed is stale (last update ${Date.now() - this.lastUpdate}ms ago)`);
    }
    return mark;
  }
}
