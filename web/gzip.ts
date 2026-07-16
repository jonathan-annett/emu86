/**
 * Gzip inflation for image transfer (Phase 17 follow-on, Jonathan's
 * ask: "can we gzip it and decompress it in the browser?" — yes:
 * `DecompressionStream('gzip')` is native in every modern browser
 * AND Node ≥18, zero dependencies, CRC integrity built into the
 * format).
 *
 * Measured why it's worth it: hd32-minix.img is 32,514,048 bytes of
 * mostly-empty MINIX zones — 3,279,912 bytes gzipped (10:1). The
 * showcase's "fetching a hard disk" drops from ~31 MB to ~3 MB.
 *
 * Transfer-side ONLY, by decision: the image library stores raw
 * bytes (the fork auto-persist writes every ~5 s and needs
 * random-access; compressing at rest is CPU churn for quota we
 * aren't short of).
 */

/**
 * Inflate a gzip stream to bytes, reporting COMPRESSED progress —
 * measured on the wire (what the user is waiting for), not on the
 * inflated output.
 *
 * Explicit feed/drain pump rather than pipeThrough: TS's lib types
 * DecompressionStream.writable as WritableStream<BufferSource>,
 * which pipeThrough's ReadableWritablePair can't reconcile with a
 * Uint8Array stream — but WRITING a Uint8Array into it is perfectly
 * typed. No casts needed, and Promise.all keeps a failure on either
 * side (corrupt gzip errors the readable AND rejects the writer)
 * from going unhandled.
 */
export async function gunzipStream(
  body: ReadableStream<Uint8Array>,
  onProgress?: (loadedCompressed: number) => void,
): Promise<Uint8Array> {
  const gunzip = new DecompressionStream('gzip');

  const feed = async (): Promise<void> => {
    const reader = body.getReader();
    const writer = gunzip.writable.getWriter();
    let loaded = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        loaded += value.byteLength;
        onProgress?.(loaded);
        // Copy: TS 5.7 types the incoming chunk over ArrayBufferLike,
        // and BufferSource wants a plain-ArrayBuffer view (the
        // sha256Hex precedent). One extra pass over ~3 MB, once.
        await writer.write(new Uint8Array(value));
      }
      await writer.close();
    } catch (err) {
      await writer.abort(err).catch(() => { /* already errored */ });
      throw err;
    }
  };

  const drain = async (): Promise<Uint8Array> => {
    const reader = gunzip.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(new Uint8Array(value));
      total += value.byteLength;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  };

  const [, out] = await Promise.all([feed(), drain()]);
  return out;
}

/** Inflate in-memory gzip bytes (tests, small payloads). */
export async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(bytes)]).stream();
  return gunzipStream(stream);
}

/**
 * Deflate in-memory bytes to gzip (Phase 18 M2 — the compress half the
 * module never needed until save-states: a stored machine snapshot
 * embeds its full disk images per D2(a), and 32 MB of mostly-empty
 * MINIX zones squeezes ~10:1). `CompressionStream('gzip')` is native
 * in every modern browser AND Node ≥18 — same zero-dependency ground
 * the inflate half stands on. Same explicit feed/drain pump shape as
 * {@link gunzipStream}, same typing rationale.
 */
export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const gzip = new CompressionStream('gzip');

  const feed = async (): Promise<void> => {
    const writer = gzip.writable.getWriter();
    try {
      await writer.write(new Uint8Array(bytes));
      await writer.close();
    } catch (err) {
      await writer.abort(err).catch(() => { /* already errored */ });
      throw err;
    }
  };

  const drain = async (): Promise<Uint8Array> => {
    const reader = gzip.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(new Uint8Array(value));
      total += value.byteLength;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  };

  const [, out] = await Promise.all([feed(), drain()]);
  return out;
}
