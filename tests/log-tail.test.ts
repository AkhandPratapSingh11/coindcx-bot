import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recentLogLines } from '../src/log-tail.js';

test('large log files return only the newest complete records in reverse order', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coindcx-logs-'));
  try {
    const path = join(directory, 'bot.jsonl');
    const lines = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ msg: 'event ' + i, detail: 'x'.repeat(100) }));
    writeFileSync(path, lines.join('\n') + '\n{"msg":"partial');
    const result = await recentLogLines(path) as { msg: string }[];
    assert.equal(result.length, 60);
    assert.equal(result[0]!.msg, 'event 2999');
    assert.equal(result.at(-1)!.msg, 'event 2940');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('log tails tolerate missing files, text and JSON primitives without breaking the dashboard', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coindcx-logs-'));
  try {
    const path = join(directory, 'bot.jsonl');
    assert.deepEqual(await recentLogLines(path), []);
    writeFileSync(path, 'plain text\nnull\n[]\n{"msg":"valid"}\n');
    const result = await recentLogLines(path) as { msg: string }[];
    assert.deepEqual(result.map(record => record.msg), ['valid', '[]', 'null', 'plain text']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('oversized or incomplete final records cannot be returned as misleading complete events', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coindcx-logs-'));
  try {
    const path = join(directory, 'bot.jsonl');
    writeFileSync(path, JSON.stringify({ msg: 'x'.repeat(200_000) }) + '\n');
    assert.deepEqual(await recentLogLines(path), []);
    writeFileSync(path, '{"msg":"unfinished"}');
    assert.deepEqual(await recentLogLines(path), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
