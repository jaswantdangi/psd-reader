import { Injectable, signal } from '@angular/core';
import { memoryBudgetBytes, guardFileSize } from '@engine/budget.js';

export type LoadResult =
  | { ok: true; project: any }
  | { ok: false; message: string };

@Injectable({ providedIn: 'root' })
export class PsdLoaderService {
  readonly progress = signal(0);

  load(bytes: Uint8Array, fileName: string, uri: string): Promise<LoadResult> {
    // navigator.deviceMemory is non-standard and absent on many WebViews;
    // memoryBudgetBytes falls back to a conservative default when undefined.
    const budget = memoryBudgetBytes((navigator as any).deviceMemory);
    const guard = guardFileSize(bytes.byteLength, budget);
    if (!guard.ok) return Promise.resolve({ ok: false, message: guard.message! });

    return new Promise<LoadResult>((resolve) => {
      const worker = new Worker(new URL('../workers/psd-decode.worker', import.meta.url));
      this.progress.set(0);

      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') { this.progress.set(data.decoded); return; }
        worker.terminate();
        resolve(data.type === 'done'
          ? { ok: true, project: data.project }
          : { ok: false, message: data.message });
      };

      worker.onerror = (e) => {
        worker.terminate();
        resolve({ ok: false, message: e.message || 'Decode worker failed' });
      };

      const source = { uri, name: fileName, size: bytes.byteLength };
      // Transfer the file bytes into the worker; the main thread must not keep
      // them, they are 68-78% of peak memory.
      worker.postMessage(
        { bytes: bytes.buffer, fileName, source, proxyEdge: 1024 },
        [bytes.buffer],
      );
    });
  }
}
