import { open } from 'node:fs/promises';

/** Bounded, asynchronous reads keep dashboard traffic off the trading loop. */
export async function recentLogLines(path: string, limit = 60): Promise<unknown[]> {
  const maxBytes = 128 * 1024;
  try {
    const file = await open(path, 'r');
    try {
      const { size } = await file.stat();
      const start = Math.max(0, size - maxBytes);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
      // Ignore a final record that was only partially written.
      text = text.slice(0, text.lastIndexOf('\n') + 1);
      return text.split('\n').filter(line => line.trim()).slice(-limit).reverse().map(line => {
        try {
          const value: unknown = JSON.parse(line);
          if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
        } catch { /* Preserve non-JSON records as text. */ }
        return { level: 'info', msg: line };
      });
    } finally { await file.close(); }
  } catch { return []; }
}
