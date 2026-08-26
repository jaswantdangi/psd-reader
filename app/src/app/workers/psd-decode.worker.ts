/// <reference lib="webworker" />
import { loadProjectProxy } from '@engine/load.js';

addEventListener('message', async ({ data }) => {
  const { bytes, fileName, source, proxyEdge } = data;
  try {
    // `bytes` arrives as a Uint8Array view, already spanning the right range —
    // do not re-wrap its buffer, that would discard byteOffset/byteLength.
    const project = await loadProjectProxy(bytes, {
      fileName,
      source,
      proxyEdge,
      // `total` is forwarded as well: loadProjectProxy already has it from
      // onStart, and a determinate bar over a 12-20 s decode is the whole
      // reason the reader computes it before the first layer arrives.
      onProgress: (decoded: number, total: number) =>
        postMessage({ type: 'progress', decoded, total }),
    });
    // Transfer the proxy buffers rather than copying them.
    const transfers = project.layers
      .filter((l: any) => l.pixels?.data?.buffer)
      .map((l: any) => l.pixels.data.buffer);
    postMessage({ type: 'done', project }, transfers);
  } catch (error: any) {
    postMessage({ type: 'error', message: error?.message ?? String(error) });
  }
});
