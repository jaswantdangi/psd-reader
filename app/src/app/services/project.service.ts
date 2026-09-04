import { Injectable, computed, inject, signal } from '@angular/core';
import { PsdLoaderService } from './psd-loader.service';
import {
  setLayer as engineSetLayer,
  setAdjust as engineSetAdjust,
  reorderLayer as engineReorderLayer,
  undo as engineUndo,
  redo as engineRedo,
  discardTo as engineDiscardTo,
  findLayer as engineFindLayer,
  hitTest as engineHitTest,
  nextGestureKey as engineNextGestureKey,
  setFrame as engineSetFrame,
} from '@engine/edit.js';
import {
  // Aliased for the same reason as `replaceImage` below: the method that wraps
  // it carries the same name.
  removeLayer as removeLayerCmd,
  insertTextLayer, retypeText, resizeTextBox, insertImageLayer,
  // Aliased: the method below has the same name, and a bare `replaceImage`
  // inside it would read as recursion to anyone skimming.
  replaceImage as replaceImageCmd,
} from '@engine/creative/index.js';
import { createView } from '@engine/view.js';

/**
 * The engine is plain JavaScript, so TypeScript reads its JSDoc as the
 * signature. `setLayer`'s tag says `@param {string[]} [coalesceKey]` while the
 * engine, its tests and every caller use a plain string — so the call site
 * would not type-check. Re-stating the two signatures ONCE here is better than
 * an `any` at every call, and it is the only place in `app/` that knows about
 * the discrepancy.
 */
const setLayerCmd = engineSetLayer as unknown as
  (project: any, id: number, changes: any, coalesceKey?: string) => any;
const setAdjustCmd = engineSetAdjust as unknown as
  (project: any, id: number, changes: any, coalesceKey?: string) => any;

/**
 * Screen-level states. `refused` is deliberately separate from `error`: the
 * remedies differ (pick a smaller file vs. retry), and an out-of-memory
 * WebView is a blank screen, which is the failure the size guard exists to
 * prevent. It must never be reported as a generic decode failure.
 */
export type EditorState = 'empty' | 'loading' | 'ready' | 'error' | 'refused';

/**
 * Holds the project and funnels every mutation.
 *
 * Nothing here decides anything the engine already decides. Each method is a
 * call into `src/edit.js` plus one signal bump, because the project object is
 * mutated in place and signals cannot observe that on their own.
 */
@Injectable({ providedIn: 'root' })
export class ProjectService {
  private loader = inject(PsdLoaderService);

  /** The live project object. Mutated in place by the engine — never replaced on an edit. */
  readonly project = signal<any | null>(null);

  /**
   * Bumped after EVERY engine mutation, coalesced drag frames included.
   *
   * `project.revision` deliberately does not move during a coalesced drag —
   * that is what lets the sandwich cache survive a gesture — so it cannot be
   * the signal the UI reads. This one can, and anything derived from the
   * project reads it first to declare the dependency.
   */
  readonly version = signal(0);

  /**
   * The file the picker handed us, kept so a full-resolution export can re-read
   * it. `project.source.uri` is a synthetic `file://<name>` that nothing can
   * open, so the handle is the only way back to the bytes.
   *
   * A `File` is a Blob HANDLE, not the bytes: holding it costs a reference, and
   * the file stays on disk. `file.arrayBuffer()` materialises a full copy, but
   * only inside the export worker, only for the duration of the parse, and
   * `exportFullRes` drops its own reference before the encode peak. Nothing is
   * resident between exports.
   */
  readonly sourceFile = signal<File | null>(null);

  readonly selectedId = signal<number | null>(null);
  readonly state = signal<EditorState>('empty');
  readonly message = signal('');
  readonly fileName = signal('');
  readonly decodeMs = signal(0);

  /** Layers decoded so far, and the total, both published by the decode worker. */
  readonly decoded = this.loader.progress;
  readonly total = this.loader.total;

  /** How the composite is presented. Never reaches `renderProject`. */
  readonly view = signal(createView());

  /** Last measured composite durations, per rung. Feed `chooseRenderMode`. */
  readonly lastLiveMs = signal<number | null>(null);
  readonly lastSandwichMs = signal<number | null>(null);

  /** The rung in use and what it must disclose. Both are the engine's answer, not ours. */
  readonly renderMode = signal<string>('live');
  readonly previewPill = signal<string | null>(null);
  readonly gesturing = signal(false);

  /**
   * Select mode: one finger on the canvas PICKS a layer instead of moving or
   * scaling the selected one.
   *
   * Held here rather than in the stage because two components read it — the
   * stage arbitrates with it, and the top bar both sets it and has to show
   * which mode is live. A mode the user cannot see is a mode they will fight.
   */
  readonly selectMode = signal(false);

  readonly selected = computed(() => {
    this.version();
    const project = this.project();
    const id = this.selectedId();
    return project && id !== null ? engineFindLayer(project, id) : null;
  });

  /** Index into `project.layers` — 0 is the bottom. `-1` when nothing is selected. */
  readonly selectionIndex = computed(() => {
    this.version();
    const project = this.project();
    const id = this.selectedId();
    if (!project || id === null) return -1;
    return project.layers.findIndex((layer: any) => layer.id === id);
  });

  readonly canUndo = computed(() => {
    this.version();
    const project = this.project();
    return !!project && project.history.length > 0;
  });

  readonly canRedo = computed(() => {
    this.version();
    const project = this.project();
    return !!project && project.future.length > 0;
  });

  readonly warnings = computed<string[]>(() => {
    this.version();
    const project = this.project();
    return project ? project.warnings : [];
  });

  // ------------------------------------------------------------ loading

  async open(file: File): Promise<void> {
    this.state.set('loading');
    this.message.set('');
    this.fileName.set(file.name);
    this.project.set(null);
    this.selectedId.set(null);
    this.sourceFile.set(file);

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (error: any) {
      this.state.set('error');
      this.message.set(`Could not read ${file.name}: ${error?.message ?? error}`);
      return;
    }

    const started = performance.now();
    const result = await this.loader.load(bytes, file.name, `file://${file.name}`);
    this.decodeMs.set(Math.round(performance.now() - started));

    if (!result.ok) {
      // The guard refuses BEFORE a worker is started, and its message already
      // names the file size and the device limit. Keeping the two apart is what
      // lets the screen offer the right remedy.
      this.state.set(result.reason === 'guard' ? 'refused' : 'error');
      this.message.set(result.message);
      return;
    }

    this.project.set(result.project);
    this.version.update((v) => v + 1);
    this.state.set('ready');
  }

  close(): void {
    this.project.set(null);
    this.selectedId.set(null);
    this.sourceFile.set(null);
    this.state.set('empty');
    this.message.set('');
    this.fileName.set('');
    this.previewPill.set(null);
    this.gesturing.set(false);
    // A sticky mode must not outlive the document it was turned on for.
    this.selectMode.set(false);
    this.lastLiveMs.set(null);
    this.lastSandwichMs.set(null);
  }

  // ------------------------------------------------------------ selection

  select(id: number | null): void {
    this.selectedId.set(id);
  }

  hitTest(docX: number, docY: number): any {
    const project = this.project();
    return project ? engineHitTest(project, docX, docY) : null;
  }

  /**
   * The topmost layer at a point that sits STRICTLY BELOW `index` — what a
   * repeated select-mode tap walks down through.
   *
   * The engine's `hitTest` searches from the top of `project.layers` down, so
   * a shorter stack IS "below index": handing it a shallow project whose
   * `layers` is `slice(0, index)` gets the engine's own hit rule, alpha
   * threshold and crop-frame arithmetic applied to the rest of the pile,
   * rather than a second copy of that logic living up here where it would
   * drift. `frameOf` reads `project.frame`/`width`/`height`, all carried by
   * the spread.
   *
   * The cost is one shallow object and one array of references per TAP — not
   * per frame — and one alpha read per layer under the finger, which is what
   * an ordinary `hitTest` already costs.
   */
  hitTestBelow(docX: number, docY: number, index: number): any {
    const project = this.project();
    if (!project || index <= 0) return null;
    return engineHitTest({ ...project, layers: project.layers.slice(0, index) }, docX, docY);
  }

  /** One key per gesture, minted at pointer-down and reused for every frame of it. */
  gestureKey(prefix: string): string {
    return engineNextGestureKey(prefix);
  }

  // ------------------------------------------------------------ mutations

  setLayer(id: number, changes: any, coalesceKey?: string): void {
    const project = this.project();
    if (!project) return;
    setLayerCmd(project, id, changes, coalesceKey);
    this.version.update((v) => v + 1);
  }

  setAdjust(id: number, changes: any, coalesceKey?: string): void {
    const project = this.project();
    if (!project) return;
    setAdjustCmd(project, id, changes, coalesceKey);
    this.version.update((v) => v + 1);
  }

  /**
   * Retype or restyle a text layer, box included.
   *
   * `retypeText` is ONE `setLayer` carrying the text fields and the new bounds
   * together, so the string and its box are a single undo step. Pass a gesture
   * key from `gestureKey('type')` for a typing burst and the keystrokes
   * coalesce into one history entry.
   *
   * It THROWS rather than guessing when there is no measurer — a made-up glyph
   * width produces a box that is confidently the wrong size. There is always
   * one on the main thread, so the catch is here to report the impossible case
   * rather than to swallow it.
   *
   * @returns the engine's message when it refused, otherwise null
   */
  retypeText(id: number, changes: any, coalesceKey?: string): string | null {
    const project = this.project();
    if (!project) return null;
    try {
      retypeText(project, id, changes, coalesceKey);
    } catch (error: any) {
      return error?.message ?? String(error);
    }
    this.version.update((v) => v + 1);
    return null;
  }

  /**
   * Resize a PARAGRAPH layer's own box: the author's width becomes `rect.w`,
   * the text re-wraps to it, and the type size does not move.
   *
   * The OTHER half of what a handle drag used to do. A drag on point text still
   * goes through `setLayer` and scales, because point text has no author width;
   * the engine refuses this call for it rather than guessing, and the caller
   * decides which one to make with `wrapsInBox`.
   *
   * @returns the engine's message when it refused, otherwise null
   */
  resizeTextBox(
    id: number,
    rect: { x?: number; y?: number; w: number },
    coalesceKey?: string,
  ): string | null {
    const project = this.project();
    if (!project) return null;
    try {
      resizeTextBox(project, id, rect, coalesceKey);
    } catch (error: any) {
      return error?.message ?? String(error);
    }
    this.version.update((v) => v + 1);
    return null;
  }

  /**
   * Create a text layer on top of the stack and select it.
   *
   * Selecting is part of the command rather than the caller's job: only this
   * knows the id the engine minted, and a layer you cannot then reach is a dead
   * end. `insertLayer` goes through `commit`, so the insert is an ordinary undo
   * step and `✕ Discard changes` removes it again.
   *
   * @returns the engine's message when it refused, otherwise null
   */
  insertText(options: any): string | null {
    const project = this.project();
    if (!project) return null;
    let layer: any;
    try {
      layer = insertTextLayer(project, options);
    } catch (error: any) {
      return error?.message ?? String(error);
    }
    this.version.update((v) => v + 1);
    this.selectedId.set(layer.id);
    return null;
  }

  /**
   * Put a decoded picture into the stack as a layer of its own, and select it.
   *
   * The sibling of `insertText`, and deliberately the same shape: the engine
   * mints the id, so only this can select the result, and a layer the user
   * cannot then reach is a dead end. `insertImageLayer` goes through
   * `insertLayer` -> `commit`, so the insert is one ordinary undo step.
   *
   * `pixels` must be decoded RGBA — the engine has no codec and refuses
   * anything else by shape. What resolution to decode at is the caller's
   * decision, and a consequential one: the buffer handed in here IS the
   * layer's full-resolution material, because `selfSupplied` layers have no
   * file to be re-read from at export. See `image-actions.ts`.
   *
   * @returns the engine's message when it refused, otherwise null
   */
  insertImage(options: any): string | null {
    const project = this.project();
    if (!project) return null;
    let layer: any;
    try {
      layer = insertImageLayer(project, options);
    } catch (error: any) {
      return error?.message ?? String(error);
    }
    this.version.update((v) => v + 1);
    this.selectedId.set(layer.id);
    return null;
  }

  /**
   * Swap the picture on an existing raster layer, keeping its place in the
   * stack, its opacity, its blend mode and its mask.
   *
   * `fit: 'contain'` rather than `'stretch'`, and not offered as a choice: a
   * replacement of a different aspect ratio squashed into the old box is the
   * kind of wrong that looks like a rendering bug rather than a setting. The
   * layer keeps the box it had and the picture is fitted inside it.
   *
   * The engine THROWS for a text layer rather than guessing — there is no
   * image on it to replace — and that message is what comes back here. The
   * caller does not offer the action for one in the first place; this is the
   * backstop, not the explanation.
   *
   * @returns the engine's message when it refused, otherwise null
   */
  replaceImage(id: number, pixels: any): string | null {
    const project = this.project();
    if (!project) return null;
    try {
      replaceImageCmd(project, id, { pixels, fit: 'contain' });
    } catch (error: any) {
      return error?.message ?? String(error);
    }
    this.version.update((v) => v + 1);
    return null;
  }

  reorder(fromIndex: number, toIndex: number): void {
    const project = this.project();
    if (!project || fromIndex === toIndex) return;
    engineReorderLayer(project, fromIndex, toIndex);
    this.version.update((v) => v + 1);
  }

  /**
   * Take a layer out. Undoable — the engine keeps the layer object on the
   * history entry, so undo puts back the same pixels at the same index.
   *
   * @returns true when a layer was removed; false when nothing had that id.
   */
  removeLayer(id: number): boolean {
    const project = this.project();
    if (!project) return false;
    if (!removeLayerCmd(project, id)) return false;
    if (this.selectedId() === id) this.selectedId.set(null);
    this.version.update((v) => v + 1);
    return true;
  }

  /** The document frame — a crop, or a canvas resize. `null` restores the full frame. */
  setFrame(rect: any | null, coalesceKey?: string): void {
    const project = this.project();
    if (!project) return;
    engineSetFrame(project, rect, coalesceKey);
    this.version.update((v) => v + 1);
  }

  undo(): void {
    const project = this.project();
    if (project && engineUndo(project)) this.version.update((v) => v + 1);
  }

  redo(): void {
    const project = this.project();
    if (project && engineRedo(project)) this.version.update((v) => v + 1);
  }

  /** History length as it was when a sheet opened — what `✕` rolls back to. */
  historyLength(): number {
    const project = this.project();
    return project ? project.history.length : 0;
  }

  discardTo(historyLength: number): void {
    const project = this.project();
    if (!project) return;
    if (engineDiscardTo(project, historyLength) > 0) this.version.update((v) => v + 1);
  }
}
