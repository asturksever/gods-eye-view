/**
 * Incremental NDJSON parsing for the streamed feature query. The server
 * writes one JSON object per line; chunks arrive split at arbitrary byte
 * boundaries, so a parser keeps the unfinished tail between pushes.
 */
export function createNdjsonParser(onRecord, onError = () => {}) {
  let tail = '';
  const emitLine = (line) => {
    const text = line.trim();
    if (!text) return;
    try {
      onRecord(JSON.parse(text));
    } catch (error) {
      onError(error, text);
    }
  };
  return {
    /** Feed one decoded text chunk. */
    push(chunk) {
      tail += chunk;
      let index;
      while ((index = tail.indexOf('\n')) >= 0) {
        emitLine(tail.slice(0, index));
        tail = tail.slice(index + 1);
      }
    },
    /** Flush a final line that had no trailing newline. */
    end() {
      if (tail) emitLine(tail);
      tail = '';
    },
  };
}

/**
 * Read a fetch Response body as NDJSON, invoking `onRecord` per object.
 * Resolves when the stream ends; rejects on network failure or abort.
 */
export async function readNdjsonResponse(response, onRecord, { signal } = {}) {
  const parser = createNdjsonParser(onRecord);
  const decoder = new TextDecoder();
  const reader = response.body?.getReader?.();
  if (!reader) {
    parser.push(await response.text());
    parser.end();
    return;
  }
  const abort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
