import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { PsdLoaderService } from '../services/psd-loader.service';
import { renderProject } from '@engine/render.js';

@Component({
  selector: 'app-harness',
  standalone: true,
  template: `
    <div class="p-4 space-y-4 font-mono text-sm">
      <input type="file" accept=".psd,.psb" (change)="onPick($event)" class="block" />

      @if (status()) { <p class="text-slate-600">{{ status() }}</p> }

      <!-- Decode runs 12-20 s on mid-range mobile. A progress line is the
           difference between "working" and "frozen", so it is not optional. -->
      @if (busy()) {
        <p class="text-slate-500">decoded {{ progress() }} layer(s)…</p>
      }

      @if (error()) { <p class="text-red-600 font-bold">{{ error() }}</p> }

      @if (info()) {
        <pre class="bg-slate-100 p-3 overflow-x-auto">{{ info() }}</pre>
      }

      <canvas #cv class="border border-slate-300 max-w-full"></canvas>
    </div>
  `,
})
export class HarnessPage {
  private loader = inject(PsdLoaderService);

  /** Bound to the #cv template ref — never reach for document.querySelector here. */
  private cv = viewChild.required<ElementRef<HTMLCanvasElement>>('cv');

  status = signal('');
  error = signal('');
  info = signal('');
  busy = signal(false);

  /** Layer count decoded so far, published by the worker during the load. */
  progress = this.loader.progress;

  async onPick(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;

    this.error.set('');
    this.info.set('');
    this.busy.set(true);
    this.status.set(`reading ${file.name}…`);

    let result;
    let ms = 0;
    try {
      // `loader.load` resolves rather than rejects on every failure it handles,
      // but reading the file and constructing the Worker can both still throw.
      // Without the finally, `busy` would stick true and the progress line would
      // stay on screen forever — the same stuck-UI failure this is meant to show.
      const bytes = new Uint8Array(await file.arrayBuffer());
      const t0 = performance.now();
      result = await this.loader.load(bytes, file.name, `file://${file.name}`);
      ms = Math.round(performance.now() - t0);
    } catch (e: any) {
      this.error.set(`Could not read ${file.name}: ${e?.message ?? e}`);
      this.status.set('');
      return;
    } finally {
      this.busy.set(false);
    }

    if (!result.ok) { this.error.set(result.message); this.status.set(''); return; }

    const project = result.project;
    this.status.set(`decoded in ${ms} ms`);
    this.info.set(JSON.stringify({
      canvas: `${project.width}x${project.height}`,
      layers: project.layers.length,
      proxyScale: +project.proxyScale.toFixed(4),
      warnings: project.warnings,
    }, null, 1));

    // Render at proxy scale: geometry is in document space, so this is what
    // draws the proxy pixels at their natural size.
    const buffer = renderProject(project, { scale: project.proxyScale });
    const canvas = this.cv().nativeElement;
    canvas.width = buffer.width;
    canvas.height = buffer.height;

    // Go through createImageData rather than `new ImageData(buffer.data, …)`.
    // The engine is untyped JS, so its buffer types as Uint8ClampedArray<
    // ArrayBufferLike>, which the ImageData constructor rejects. Copying into
    // the context's own allocation keeps this type-safe without an assertion.
    const ctx = canvas.getContext('2d')!;
    const image = ctx.createImageData(buffer.width, buffer.height);
    image.data.set(buffer.data);
    ctx.putImageData(image, 0, 0);
  }
}
