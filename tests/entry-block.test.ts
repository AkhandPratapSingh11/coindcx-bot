import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileEntryBlockStore, entryBlockStore } from '../src/entry-block.js';
import { loadConfig } from '../src/config.js';

test('entry journal survives reconstruction, updates atomically and clears after confirmation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coindcx-entry-'));
  try {
    const path = join(directory, 'state', 'entry.json');
    const store = new FileEntryBlockStore(path);
    assert.equal(store.read(), null);
    store.write('submission b123 has not been reconciled');
    assert.equal(new FileEntryBlockStore(path).read(), 'submission b123 has not been reconciled');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    store.write('submission b123 failed: timeout');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).reason, 'submission b123 failed: timeout');
    store.write(null);
    assert.equal(new FileEntryBlockStore(path).read(), null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('corrupt journals fail closed instead of silently permitting another submission', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coindcx-entry-'));
  try {
    const path = join(directory, 'entry.json');
    for (const raw of ['{', '{}', 'null', '{"version":1,"reason":""}']) {
      writeFileSync(path, raw);
      assert.throws(() => new FileEntryBlockStore(path).read());
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('live journals are scoped to account and instrument; paper never uses a live journal', () => {
  const cfg = { ...loadConfig(), mode: 'live' as const, apiKey: 'account-one' };
  const first = entryBlockStore(cfg) as FileEntryBlockStore;
  assert.equal(first.path, (entryBlockStore(cfg) as FileEntryBlockStore).path);
  assert.notEqual(first.path, (entryBlockStore({ ...cfg, apiKey: 'account-two' }) as FileEntryBlockStore).path);
  assert.notEqual(first.path, (entryBlockStore({ ...cfg, pair: 'B-ETH_USDT' }) as FileEntryBlockStore).path);
  assert.ok(!first.path.includes(cfg.apiKey));
  assert.ok(!(entryBlockStore({ ...cfg, mode: 'paper' }) instanceof FileEntryBlockStore));
});
