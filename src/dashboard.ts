/**
 * Local monitoring UI. No dependencies, no build step.
 *
 *   GET /             the page
 *   GET /api/status   JSON snapshot + recent log lines
 *
 * Binds to 127.0.0.1 only. This endpoint exposes positions and balances, so it
 * must not be reachable from the network; if you want it on another machine,
 * tunnel it over SSH rather than changing the bind address.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import type { Config } from './config.js';
import { log } from './logger.js';
import { page } from './dashboard-page.js';
import * as state from './state.js';

const MAX_LOG_LINES = 60;
/** The status route refreshes position/equity at most this often. */
const REFRESH_THROTTLE_MS = 4000;

function recentLogLines(path: string): unknown[] {
  try {
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    return lines
      .slice(-MAX_LOG_LINES)
      .reverse()
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { level: 'info', msg: l };
        }
      });
  } catch {
    return [];
  }
}

export interface DashboardOptions {
  cfg: Config;
  /** Pulls fresh position + equity. Called at most once per throttle window. */
  refresh: () => Promise<void>;
  entryBlock: () => string | null;
}

export function startDashboard(opts: DashboardOptions): Server | null {
  const { cfg, refresh } = opts;
  if (cfg.dashboardPort <= 0) {
    log.info('dashboard disabled (DASHBOARD_PORT=0)');
    return null;
  }

  const day = new Date().toISOString().slice(0, 10);
  const logPath = `logs/bot-${day}.jsonl`;

  let lastRefresh = 0;
  let refreshing: Promise<void> | null = null;

  const maybeRefresh = async (): Promise<void> => {
    if (refreshing) return refreshing;
    if (Date.now() - lastRefresh < REFRESH_THROTTLE_MS) return;
    refreshing = refresh()
      .catch((err: unknown) => {
        // A dashboard poll must never be able to break the bot.
        log.warn('dashboard refresh failed', { error: String(err) });
      })
      .finally(() => {
        lastRefresh = Date.now();
        refreshing = null;
      });
    return refreshing;
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? '/';

    if (url.startsWith('/api/status')) {
      void maybeRefresh().then(() => {
        const snap = state.get();
        const body = JSON.stringify({
          ...snap,
          now: Date.now(),
          nextCloseAt: state.nextCloseAt(),
          entryBlock: opts.entryBlock(),
          config: {
            quoteCurrency: cfg.quoteCurrency,
            marginType: cfg.marginType,
            riskPercent: cfg.riskPercent,
            stopLossPct: cfg.stopLossPct,
            takeProfitPct: cfg.takeProfitPct ?? null,
            maxOrderQuantity: cfg.maxOrderQuantity ?? null,
            maxOrderNotional: cfg.maxOrderNotional ?? null,
          },
          logs: recentLogLines(logPath),
        });
        res.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        res.end(body);
      });
      return;
    }

    if (url === '/' || url.startsWith('/?')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  };

  const server = createServer(handler);

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.warn('dashboard port in use; continuing without the UI', {
        port: cfg.dashboardPort,
        hint: 'Another instance may be running, or set DASHBOARD_PORT to a free port.',
      });
      return;
    }
    log.warn('dashboard error', { error: String(err) });
  });

  server.listen(cfg.dashboardPort, '127.0.0.1', () => {
    log.info('dashboard listening', { url: `http://127.0.0.1:${cfg.dashboardPort}` });
  });

  // Never let an open browser tab hold the process alive at shutdown.
  server.unref();
  return server;
}
