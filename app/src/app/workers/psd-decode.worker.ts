/// <reference lib="webworker" />
import { loadProjectProxy } from '@engine/load.js';

addEventListener('message', async ({ data }) => {
  const { bytes, fileName, source, proxyEdge } = data;
  try {
    const project = await loadProjectProxy(new Uint8Array(bytes), {
      fileName,
      source,
      proxyEdge,
      onProgress: (decoded: number) => postMessage({ type: 'progress', decoded }),
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
