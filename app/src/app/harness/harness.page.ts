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

  async onPick(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;

    this.error.set('');
    this.status.set(`reading ${file.name}…`);

    const bytes = new Uint8Array(await file.arrayBuffer());
    const t0 = performance.now();
    const result = await this.loader.load(bytes, file.name, `file://${file.name}`);
    const ms = Math.round(performance.now() - t0);

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
    canvas.getContext('2d')!.putImageData(
      new ImageData(buffer.data, buffer.width, buffer.height), 0, 0,
    );
  }
}
