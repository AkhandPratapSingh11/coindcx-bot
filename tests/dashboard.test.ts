import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { startDashboard } from '../src/dashboard.js';
import { loadConfig } from '../src/config.js';
import { log } from '../src/logger.js';
import * as state from '../src/state.js';

test('dashboard reports stale data and refresh failures while throttling read-only requests', async () => {
  // Reserve a free port, rather than depending on a machine-specific fixed port.
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const info = log.info, warn = log.warn;
  log.info = log.warn = () => {};
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  let refreshes = 0;
  state.update({ quoteAt: now - 60_000, quoteStale: false, candleDataBlocked: true,
    equityBasis: 'available-balance', candleHistory: [{ openTime: now - 900_000, close: 108 }] });
  const server = startDashboard({ cfg: { ...loadConfig(), dashboardPort: port },
    entryBlock: () => 'uncertain submission', refresh: async () => {
      if (++refreshes === 1) throw new Error('venue unavailable');
      state.update({ quoteAt: now });
    } })!;
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${port}`;
    const first = await (await fetch(base + '/api/status')).json() as any;
    assert.equal(first.quoteStale, true);
    assert.equal(first.candleDataBlocked, true);
    assert.equal(first.equityBasis, 'available-balance');
    assert.equal(first.entryBlock, 'uncertain submission');
    assert.match(first.refreshError, /displayed values may be outdated/);
    await fetch(base + '/api/status?poll=2');
    assert.equal(refreshes, 1);
    now += 5000;
    const recovered = await (await fetch(base + '/api/status')).json() as any;
    assert.equal(recovered.refreshError, null);
    assert.equal(recovered.quoteStale, false);
    assert.equal(refreshes, 2);
    assert.equal((await fetch(base + '/api/status-invalid')).status, 404);
    assert.match(await (await fetch(base)).text(), /Market history/);
  } finally {
    Date.now = originalNow; log.info = info; log.warn = warn;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
