/**
 * The dashboard page, as a single inlined string. Kept as one file with no
 * assets so the bot has nothing to serve but itself.
 */

export const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>coindcx-bot</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='26' font-size='26'%3E%F0%9F%93%88%3C/text%3E%3C/svg%3E">
<style>
  :root {
    --bg: #fbfbfa;
    --panel: #ffffff;
    --border: #e5e3df;
    --text: #1a1a18;
    --muted: #76736c;
    --accent: #3a6ea5;
    --long: #1f7a4d;
    --short: #b3412c;
    --flat: #76736c;
    --warn: #9a6700;
    --error: #b3412c;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #14140f;
      --panel: #1c1c17;
      --border: #2e2e27;
      --text: #eceae4;
      --muted: #9a968d;
      --accent: #7aa7d4;
      --long: #4cb782;
      --short: #e8795f;
      --flat: #9a968d;
      --warn: #d9a441;
      --error: #e8795f;
    }
  }
  :root[data-theme="dark"] {
    --bg: #14140f; --panel: #1c1c17; --border: #2e2e27; --text: #eceae4;
    --muted: #9a968d; --accent: #7aa7d4; --long: #4cb782; --short: #e8795f;
    --flat: #9a968d; --warn: #d9a441; --error: #e8795f;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0 16px 48px;
    background: var(--bg); color: var(--text);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1040px; margin: 0 auto; }

  header {
    display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline;
    padding: 24px 0 16px; border-bottom: 1px solid var(--border); margin-bottom: 20px;
  }
  h1 { font-size: 19px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
  h1 .pair { font-family: var(--mono); color: var(--accent); }
  .badges { display: flex; gap: 6px; flex-wrap: wrap; }
  .badge {
    font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
    padding: 3px 8px; border-radius: 4px; border: 1px solid var(--border); color: var(--muted);
  }
  .badge.paper { color: var(--accent); border-color: currentColor; }
  .badge.live { color: var(--error); border-color: currentColor; }
  .badge.dry { color: var(--warn); border-color: currentColor; }
  .spacer { flex: 1; }
  .conn { display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--muted); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--flat); }
  .dot.on { background: var(--long); }
  .dot.off { background: var(--error); }

  .grid {
    display: grid; gap: 12px; margin-bottom: 20px;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  }
  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px;
  }
  .card .label {
    font-size: 11px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
    color: var(--muted); margin-bottom: 7px;
  }
  .card .value { font-family: var(--mono); font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
  .card .sub { font-size: 12px; color: var(--muted); margin-top: 4px; font-family: var(--mono); }
  .long { color: var(--long); } .short { color: var(--short); } .flat { color: var(--flat); }
  .pos { color: var(--long); } .neg { color: var(--short); }

  section { margin-bottom: 20px; }
  h2 {
    font-size: 12px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
    color: var(--muted); margin: 0 0 10px;
  }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .kv { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .kv td { padding: 9px 16px; border-bottom: 1px solid var(--border); }
  .kv tr:last-child td { border-bottom: none; }
  .kv td:first-child { color: var(--muted); width: 42%; }
  .kv td:last-child { font-family: var(--mono); text-align: right; }

  .logs { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .logs table { font-family: var(--mono); font-size: 12px; }
  .logs td { padding: 6px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  .logs tr:last-child td { border-bottom: none; }
  .logs .t { color: var(--muted); white-space: nowrap; width: 1%; }
  .logs .l { width: 1%; white-space: nowrap; font-weight: 600; font-size: 11px; }
  .logs .l.info { color: var(--accent); }
  .logs .l.warn { color: var(--warn); }
  .logs .l.error { color: var(--error); }
  .logs .l.debug { color: var(--muted); }
  .logs .m { word-break: break-word; }
  .logs .f { color: var(--muted); }

  .empty { color: var(--muted); font-size: 13px; padding: 16px; text-align: center; }
  footer { color: var(--muted); font-size: 12px; text-align: center; padding-top: 8px; }
  @media (max-width: 560px) {
    .card .value { font-size: 19px; }
    .kv td { padding: 8px 12px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>coindcx-bot <span class="pair" id="pair">—</span></h1>
    <div class="badges" id="badges"></div>
    <div class="spacer"></div>
    <div class="conn"><span class="dot" id="dot"></span><span id="conn">connecting…</span></div>
  </header>

  <div class="grid" id="cards"></div>

  <section>
    <h2>Position</h2>
    <div id="position"></div>
  </section>

  <section>
    <h2>Configuration</h2>
    <table class="kv"><tbody id="config"></tbody></table>
  </section>

  <section>
    <h2>Activity</h2>
    <div class="logs" id="logs"></div>
  </section>

  <footer>Polls every 2s · read-only · <span id="uptime"></span></footer>
</div>

<script>
const $ = (id) => document.getElementById(id);
let failures = 0;

const fmt = (n, dp = 2) =>
  n === null || n === undefined || !isFinite(n)
    ? '—'
    : Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

function duration(ms) {
  if (ms === null || ms === undefined || !isFinite(ms)) return '—';
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const out = h > 0 ? h + 'h ' + m + 'm' : m > 0 ? m + 'm ' + s + 's' : s + 's';
  return neg ? 'overdue by ' + out : out;
}

const clock = (ts) =>
  ts ? new Date(ts).toLocaleTimeString('en-US', { hour12: false }) : '—';

function card(label, value, cls, sub) {
  return '<div class="card"><div class="label">' + label + '</div>' +
    '<div class="value ' + (cls || '') + '">' + value + '</div>' +
    (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
}

function render(d) {
  $('pair').textContent = d.pair || '—';

  const badges = [];
  badges.push('<span class="badge ' + (d.mode === 'live' ? 'live' : 'paper') + '">' + d.mode + '</span>');
  if (d.dryRun) badges.push('<span class="badge dry">dry run</span>');
  badges.push('<span class="badge">' + d.interval + '</span>');
  badges.push('<span class="badge">' + d.leverage + 'x</span>');
  $('badges').innerHTML = badges.join('');

  const t = d.target || 'none';
  const pos = d.position;
  const mark = d.quote ? (d.quote.bid + d.quote.ask) / 2 : null;

  const cards = [];
  cards.push(card('Target', t, t === 'long' ? 'long' : t === 'short' ? 'short' : 'flat',
    d.strategy));
  cards.push(card('Actual', pos ? pos.side : 'flat',
    pos ? (pos.side === 'long' ? 'long' : 'short') : 'flat',
    pos ? fmt(pos.size, 4) + ' @ ' + fmt(pos.entryPrice) : 'no exposure'));
  cards.push(card('Mark', fmt(mark), d.quoteStale ? 'short' : '',
    d.quoteStale ? 'STALE · ' + clock(d.quoteAt) : 'updated ' + clock(d.quoteAt)));
  cards.push(card('Equity', fmt(d.equity), '', 'USDT · ' + clock(d.equityAt)));
  cards.push(card('Next close', duration(d.nextCloseAt ? d.nextCloseAt - d.now : null), '',
    d.nextCloseAt ? 'at ' + clock(d.nextCloseAt) : '—'));
  const c = d.counters || {};
  cards.push(card('Counters', (c.candles || 0) + ' / ' + (c.entries || 0) + ' / ' + (c.exits || 0),
    c.errors > 0 ? 'short' : '',
    'candles / entries / exits' + (c.errors ? ' · ' + c.errors + ' errors' : '')));
  $('cards').innerHTML = cards.join('');

  if (pos) {
    const pnl = pos.unrealizedPnl;
    const rows = [
      ['Side', '<span class="' + pos.side + '">' + pos.side + '</span>'],
      ['Size', fmt(pos.size, 4)],
      ['Entry price', fmt(pos.entryPrice)],
      ['Mark price', fmt(pos.markPrice !== null ? pos.markPrice : mark)],
      ['Unrealized PnL', pnl === null || pnl === undefined
        ? '—'
        : '<span class="' + (pnl >= 0 ? 'pos' : 'neg') + '">' + fmt(pnl) + '</span>'],
      ['Leverage', pos.leverage ? pos.leverage + 'x' : '—'],
      ['Stop (engine backstop)', fmt(pos.side === 'long'
        ? pos.entryPrice * (1 - d.config.stopLossPct)
        : pos.entryPrice * (1 + d.config.stopLossPct))],
    ];
    $('position').innerHTML = '<table class="kv"><tbody>' +
      rows.map((r) => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>').join('') +
      '</tbody></table>';
  } else {
    $('position').innerHTML = '<div class="kv"><div class="empty">Flat — no open position</div></div>';
  }

  const cf = d.config || {};
  const sig = d.lastSignalChange;
  const cfgRows = [
    ['Strategy', d.strategy],
    ['Risk per trade', cf.riskPercent + '%'],
    ['Stop loss', (cf.stopLossPct * 100).toFixed(2) + '%'],
    ['Take profit', cf.takeProfitPct === null ? 'none' : (cf.takeProfitPct * 100).toFixed(2) + '%'],
    ['Max order quantity', cf.maxOrderQuantity === null ? 'unset' : cf.maxOrderQuantity],
    ['Max order notional', cf.maxOrderNotional === null ? 'unset' : cf.maxOrderNotional + ' USDT'],
    ['Min notional (venue)', d.instrument ? d.instrument.minNotional + ' USDT' : '—'],
    ['Last candle close', d.lastCandle ? fmt(d.lastCandle.close) + ' at ' + clock(d.lastCandle.openTime) : '—'],
    ['Last signal change', sig ? sig.from + ' \\u2192 ' + sig.to + ' at ' + clock(sig.at) : 'none this session'],
  ];
  $('config').innerHTML = cfgRows
    .map((r) => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>')
    .join('');

  const logs = d.logs || [];
  if (logs.length === 0) {
    $('logs').innerHTML = '<div class="empty">No log lines yet</div>';
  } else {
    $('logs').innerHTML = '<table><tbody>' + logs.map((l) => {
      const skip = { ts: 1, level: 1, msg: 1 };
      const extra = Object.keys(l)
        .filter((k) => !skip[k])
        .map((k) => k + '=' + (typeof l[k] === 'object' ? JSON.stringify(l[k]) : l[k]))
        .join(' ');
      return '<tr><td class="t">' + clock(l.ts ? Date.parse(l.ts) : null) + '</td>' +
        '<td class="l ' + (l.level || 'info') + '">' + (l.level || 'info') + '</td>' +
        '<td class="m">' + esc(l.msg || '') +
        (extra ? ' <span class="f">' + esc(extra) + '</span>' : '') + '</td></tr>';
    }).join('') + '</tbody></table>';
  }

  $('uptime').textContent = 'up ' + duration(d.now - d.startedAt);
  $('dot').className = 'dot ' + (d.wsConnected ? 'on' : 'off');
  $('conn').textContent = d.wsConnected ? 'websocket live' : 'REST polling only';
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
}

async function tick() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    render(await res.json());
    failures = 0;
  } catch (err) {
    failures += 1;
    if (failures >= 2) {
      $('dot').className = 'dot off';
      $('conn').textContent = 'bot not responding — is it still running?';
    }
  }
}

tick();
setInterval(tick, 2000);
</script>
</body>
</html>`;
