/**
 * Startup reconciliation.
 *
 * A bot that boots and assumes it is flat is the single most expensive bug in
 * this category: it opens a second position on top of one it forgot about, or
 * leaves a real position unmanaged with no stop. So the first thing we do is
 * ask the venue what we actually hold, and adopt it.
 */

import type { Broker, OpenPosition } from './broker.js';
import type { Config } from './config.js';
import { log } from './logger.js';

export interface ReconcileResult {
  position: OpenPosition | null;
  /** Orders already resting on the venue for this pair at boot. */
  openOrderCount: number;
}

export async function reconcile(broker: Broker, _cfg: Config): Promise<ReconcileResult> {
  const [position, openOrders] = await Promise.all([broker.getPosition(), broker.getOpenOrders()]);

  if (position) {
    await broker.ensureProtection(position);
    log.warn('adopted an existing position at startup', {
      id: position.id,
      side: position.side,
      size: position.size,
      entryPrice: position.entryPrice,
      unrealizedPnl: position.unrealizedPnl,
      note: 'Venue protection was verified before adopting the position.',
    });
  } else {
    log.info('reconciled: flat at startup');
  }

  if (openOrders.length > 0) {
    log.warn('found resting orders at startup', {
      count: openOrders.length,
      orders: openOrders.map((o) => ({
        id: o.id,
        side: o.side,
        type: o.order_type,
        price: o.price,
        quantity: o.target_quantity,
        status: o.status,
      })),
    });
    // Stray working orders could fill after a new entry. Cancel only this
    // pair's enumerated orders when flat; retain protective orders when open.
    if (!position) {
      await broker.cancelAllOrders();
    } else {
      log.warn('leaving resting orders in place because a position is open', {
        note: 'Cancelling could remove a protective order. Review manually.',
      });
    }
  }

  return { position, openOrderCount: openOrders.length };
}
