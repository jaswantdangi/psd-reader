/// <reference lib="webworker" />
import { canUseCanvasEncoder, encodePngStored } from '@engine/export/png.js';
import { isDeterminate, phaseFraction } from '@engine/export/progress.js';
import { createMemorySpill } from '@engine/export/spill.js';
import { exportFullRes } from '@engine/export/stream.js';
import { SPILL_ROOT } from '@engine/export/sweep.js';

/**
 * Full-resolution export, off the main thread.
 *
 * WHY A WORKER AT ALL. `exportFullRes` yields only where its injected side
 * effects yield, and on the fast path — arrival order already blend order —
 * nothing is written to disk at all, so every `await` in the walk settles as a
 * microtask, which does NOT return to the event loop. On the main thread that
 * is a 3-20 second freeze in which the progress bar cannot repaint and a
 * Cancel button cannot be pressed. Progress that cannot paint is worse than no
 * progress, so the whole walk lives here instead.
 *
 * WHAT CANCEL IS. `exportFullRes` accepts a `{cancelled}` signal checked at
 * every layer boundary, but the message that would set it can only be delivered
 * when this worker returns to ITS event loop — which, on the fast path, is
 * exactly what never happens. So cancellation is `worker.terminate()` on the
 * main thread instead: immediate, unconditional, and it drops this worker's
 * whole heap. The cost is that `exportFullRes`'s `finally` never runs, so the
 * spill directory is left behind — which is why setup below wipes it before
 * every export rather than only after one.
 */

/**
 * Re-view engine bytes as a plain `Uint8Array<ArrayBuffer>`.
 *
 * The engine is untyped JavaScript, so everything it produces is typed
 * `Uint8Array<ArrayBufferLike>`, and every DOM sink here — `write`, `Blob` —
 * declares `ArrayBufferView<ArrayBuffer>` and rejects it outright. This is the
 * same shape as the `new ImageData(buffer.data, …)` rejection on the canvas
 * side, and it has the same fix: build a VIEW over the existing buffer. It must
 * never copy — a copy here is a second 66 MB layer.
 */
const asBytes = (view: { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }): Uint8Array<ArrayBuffer> =>
  new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);

/** The four methods `exportFullRes` injects. Matches its JSDoc exactly. */
interface ExportSpill {
  write(name: string, chunks: Uint8Array[]): Promise<void>;
  read(name: string): Promise<Uint8Array>;
  remove(name: string): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Spill over the Origin Private File System.
 *
 * The engine's spill contract exists because a reorder parks full-resolution
 * layers — up to 66 MB each for the measured poster — until the blend order
 * reaches them. `createMemorySpill` satisfies the same contract by holding them
 * in the heap, which on a phone is the out-of-memory kill this whole pipeline
 * is built to avoid. OPFS is the only real filesystem a worker can reach
 * without Capacitor, and it works in a WebView.
 *
 * `createWritable` is used rather than `createSyncAccessHandle`: the sync
 * handle is faster, but its type exists only in TypeScript's `webworker` lib,
 * and `tsconfig.app.json` also compiles this file against the `dom` lib, where
 * it does not. `createWritable` is declared in both.
 */
async function createOpfsSpill(): Promise<ExportSpill | null> {
  const storage = navigator.storage;
  if (!storage || typeof storage.getDirectory !== 'function') return null;

  try {
    const root = await storage.getDirectory();

    // Wipe first, not only on the way out. A terminated export (see the Cancel
    // note above) and an OS kill both skip the cleanup, and this app never runs
    // two exports at once — the button is disabled while one is in flight — so
    // anything already here is garbage by definition.
    await root.removeEntry(SPILL_ROOT, { recursive: true }).catch(() => {});
    const dir = await root.getDirectoryHandle(SPILL_ROOT, { create: true });

    return {
      async write(name, chunks) {
        const handle = await dir.getFileHandle(name, { create: true });
        const stream = await handle.createWritable();
        let complete = false;
        try {
          // Chunk by chunk: the engine hands over `[header, pixels]` precisely
          // so the 66 MB payload is never concatenated into a third buffer.
          for (const chunk of chunks) await stream.write(asBytes(chunk));
          complete = true;
        } finally {
          // close() on a stream that failed mid-write throws over the original
          // error and hides it. abort() is the disposal that does not.
          if (complete) await stream.close();
          else await stream.abort().catch(() => {});
        }
      },

      async read(name) {
        const handle = await dir.getFileHandle(name);
        const file = await handle.getFile();
        // A fresh buffer every time: `decodeSpill` returns a VIEW onto whatever
        // it is handed, so a reused buffer would alias a layer already blended.
        return new Uint8Array(await file.arrayBuffer());
      },

      async remove(name) {
        await dir.removeEntry(name).catch(() => {});
      },

      async dispose() {
        await root.removeEntry(SPILL_ROOT, { recursive: true }).catch(() => {});
      },
    };
  } catch {
    // No quota, a private window that refuses OPFS, an old WebView. The caller
    // falls back to the heap and says so.
    return null;
  }
}

/**
 * @param image the composite, straight alpha, at document resolution.
 *
 * The canvas route is `png.js`'s own primary: it deflates, so the file is a
 * fraction of the raw pixels. It is unusable above `CANVAS_AREA_CAP`, which the
 * measured 4961x3508 poster exceeds — that is exactly why the dependency-free
 * writer exists — and its round trip through premultiplied alpha can shift RGB
 * by +/-1 under partial alpha. `encodePngStored` touches no pixel but stores
 * every block, so its output is roughly the size of the raw RGBA.
 */
async function encode(image: { width: number; height: number; data: Uint8ClampedArray }): Promise<Blob> {
  if (canUseCanvasEncoder(image.width, image.height) && typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    if (context) {
      // createImageData + set, never `new ImageData(image.data, …)` — the
      // engine is untyped JS and that constructor rejects its buffer type.
      const data = context.createImageData(image.width, image.height);
      data.data.set(image.data);
      context.putImageData(data, 0, 0);
      return await canvas.convertToBlob({ type: 'image/png' });
    }
  }
  return new Blob([asBytes(encodePngStored(image))], { type: 'image/png' });
}

/**
 * Install the user's font files into THIS worker's font set.
 *
 * `document.fonts` does not reach here. A worker has its own `FontFaceSet`, and
 * an `OffscreenCanvas` — which is what `create2dSurface` returns in a worker,
 * and therefore what rasterises every re-drawn text layer at full resolution —
 * draws from that one. So a face the editor loaded on the main thread is simply
 * absent during export, and `ctx.font` falls through to the substitute stack
 * behind it. The screen would be right and the exported PNG wrong, which is the
 * worst place for the two to disagree: the user only finds out in the file they
 * ship.
 *
 * THROWS rather than carrying on. A font that parsed on the main thread parses
 * here too — the same bytes through the same engine — so a failure here means
 * the file handle has gone stale (moved or deleted since it was picked). An
 * export that silently substitutes is worse than one that stops and says which
 * file it could not read.
 */
async function installFonts(fonts: { family: string; file: File }[]): Promise<void> {
  if (!fonts?.length) return;
  const set = (self as unknown as { fonts?: FontFaceSet }).fonts;
  if (!set || typeof FontFace === 'undefined')
    throw new Error('This browser cannot load fonts inside the export worker, so the '
      + 'export would come back in a substitute typeface.');

  for (const { family, file } of fonts) {
    try {
      const face = new FontFace(family, await file.arrayBuffer());
      await face.load();
      set.add(face);
    } catch (error: any) {
      throw new Error(`Could not read ${file.name} for the export. The typeface on screen `
        + `would not be the one in the PNG. (${error?.message ?? error})`);
    }
  }
}

addEventListener('message', async ({ data }) => {
  const { project, file, fonts } = data as {
    project: any; file: File; fonts: { family: string; file: File }[];
  };

  const report = (p: { phase: string; done: number; total: number; fraction: number }) =>
    postMessage({
      type: 'progress',
      phase: p.phase,
      done: p.done,
      total: p.total,
      fraction: p.fraction,
      // `parse` and `encode` are single synchronous calls with no yield point
      // inside them. The engine says so; the UI must not draw a creeping bar
      // over a three-second freeze.
      determinate: isDeterminate(p.phase),
    });

  try {
    // Before the walk, not during it: a face arriving halfway through would
    // leave the layers already blended in the substitute and the rest in the
    // real face, inside one image.
    await installFonts(fonts);

    const opfs = await createOpfsSpill();
    const spill: ExportSpill = opfs ?? createMemorySpill();

    const image = await exportFullRes({
      project,
      // Re-reads the original file from the Blob the picker handed us. The
      // result is NOT retained here — the engine drops its own reference before
      // the readback, and a second one would hold the file bytes, 68-78% of
      // peak, alive through the encode peak.
      readSource: async () => new Uint8Array(await file.arrayBuffer()),
      spill,
      onProgress: report,
    });

    report({ phase: 'encode', done: 0, total: 0, fraction: phaseFraction('encode') });
    const blob = await encode(image);
    report({ phase: 'write', done: 1, total: 1, fraction: phaseFraction('write', 1, 1) });

    // A Blob crosses structured clone by reference, so the PNG is not copied.
    postMessage({
      type: 'done',
      blob,
      width: image.width,
      height: image.height,
      bytes: blob.size,
      spill: opfs ? 'disk' : 'memory',
    });
  } catch (error: any) {
    postMessage({
      type: 'error',
      message: error?.message ?? String(error),
      // ExportError carries a code — SOURCE_CHANGED, TEXT_MISSING, NO_IDENTITY
      // and the rest — so the screen can say something specific rather than
      // matching on prose.
      code: error?.code ?? null,
    });
  }
});
