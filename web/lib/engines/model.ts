/** Fetch the ONNX model with progress + persistent caching (Cache Storage). */

export async function loadModelBytes(
  url: string,
  cacheName: string,
  onProgress?: (fraction: number) => void,
): Promise<ArrayBuffer> {
  // Cache Storage is available in both window and worker scopes.
  const cache = typeof caches !== 'undefined' ? await caches.open(cacheName) : null;
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      onProgress?.(1);
      return hit.arrayBuffer();
    }
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Model download failed (${res.status}) from ${url}`);

  const total = Number(res.headers.get('Content-Length') ?? 0);
  if (res.body && total > 0 && onProgress) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.length;
        onProgress(Math.min(1, received / total));
      }
    }
    const bytes = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.length;
    }
    if (cache) await cache.put(url, new Response(bytes, { headers: res.headers }));
    return bytes.buffer;
  }

  const buf = await res.arrayBuffer();
  if (cache) await cache.put(url, new Response(buf));
  onProgress?.(1);
  return buf;
}
