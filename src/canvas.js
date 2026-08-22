/**
 * ag-psd reaches for a canvas to allocate ImageData. It auto-wires itself only
 * when `document` exists — so in a Web Worker (where we want decoding to run)
 * it throws "Canvas not initialized".
 *
 * We never want a real canvas anyway: `getImageData` clamps to 8-bit and
 * premultiplies alpha, which silently corrupts 16/32-bit documents. This
 * installs plain typed-array allocation instead, so the pixel path never
 * touches the DOM.
 */
import { initializeCanvas } from 'ag-psd';

let installed = false;

/** Idempotent. Safe to call from a worker, from Node, or from the main thread. */
export function installPlainPixelBackend() {
  if (installed) return;
  installed = true;

  const makeImageData = (width, height) => ({
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  });

  initializeCanvas(
    (width, height) => ({
      width,
      height,
      getContext: () => ({
        createImageData: makeImageData,
        // Present so ag-psd's JPEG path (embedded smart-object previews) fails
        // soft instead of throwing. We don't use its output.
        putImageData: () => {},
        drawImage: () => {},
      }),
    }),
    makeImageData,
  );
}
