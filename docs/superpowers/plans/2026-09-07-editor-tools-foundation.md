# Editor Tools — Foundation, Colour and Crop: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the editor a real tool model — one owner of "which tool is armed", a foreground/background colour pair, an eyedropper, and the Crop tool the engine has always supported but no UI has ever reached.

**Architecture:** Three new root services (`ToolService`, `ColorService`, `StageSurfaceService`) hold the state that every future tool needs, so no tool has to invent it. Crop ships as an **overlay component** that claims the pointer only on its own rect and handles — leaving pinch and pan untouched — and therefore needs **no edit to `canvas-stage.ts`**. The one unavoidable edit to that contested file (the eyedropper's pointer branch) is isolated in the final task so the other six land regardless.

**Tech Stack:** Angular 22 (standalone components, signals), Ionic 9, Tailwind CSS, **Vitest + jsdom** for app tests (via `@angular/build:unit-test` — not Karma, and there is no real browser), plain-ESM engine reached through the `@engine/*` path alias.

> **jsdom has no canvas.** `HTMLCanvasElement.getContext()` is unimplemented, so no spec can construct a real canvas and read pixels back. Anything touching a canvas is typed against a **structural interface** and tested with a stand-in — the pattern this codebase already uses in `app/src/testing/fake-worker.ts` and `installPlainPixelBackend` (`src/canvas.js:16`). Do not add the `canvas` npm package to work around this.

**Spec:** `docs/PHOTOSHOP-TOOLS.md` — the mechanism, gate and engine-primitive analysis for all 71 Photoshop tools. This plan implements the Phase A entries that need no new gate.

---

## Global Constraints

- **Angular 22, standalone components only.** No NgModules. State is signals; derived state is `computed`. Follow the existing service shape in `app/src/app/services/project.service.ts`.
- **Tailwind utilities only.** No custom CSS, no CSS-in-JS.
- **The engine is reached as `@engine/*`**, which resolves to `../src/*` (see `app/tsconfig.json:20-22`). Import crop maths from `@engine/frame/index.js` — `src/frame` is deliberately **not** carried by the `src/index.js` barrel.
- **Two rect shapes exist and they are not interchangeable.** `moveRect`, `resizeRect`, `framingReport` and `setFrame` take **`{x, y, width, height}`**. `handleAt`, `anchorFor` and everything in `gesture.js` take **`{x, y, w, h}`** (they were written for layers). Converting between them is the single most likely place for a bug in this plan, which is why Task 5 pins it with a test.
- **`moveRect` and `resizeRect` already clamp.** Both take a `bounds` rect and keep the result inside it — `moveRect` slides, `resizeRect` caps against the anchor. `resizeRect` also takes `{ratio, min}`. **Do not write a clamping helper**; pass `bounds`.
- **Do not run the build.** Report to the user and let them build. (Project rule.)
- **App tests:** `npm --prefix app test -- --watch=false`. Engine tests: `npm run test:engine`.
- **`git add` then a separate `git commit` is racy on this branch.** Two sessions share one git index. **Always `git commit -- <exact paths>`.**

### Files owned by the other session — DO NOT EDIT

A concurrent session on this branch holds these uncommitted. Touching any of them will collide:

```
HANDOFF.md                                   src/edit.js
app/src/app/editor/canvas-stage.ts           src/index.js
app/src/app/editor/cutout-panel.ts           src/segment/cutout.js
app/src/app/services/segment.service.ts      src/segment/index.js
app/src/app/workers/bg-remove.worker.ts      src/segment/models.js
docs/BACKLOG.md                              src/segment/edge.js (untracked)
```

**Tasks 1–6 touch none of them.** Task 7 touches `canvas-stage.ts` and is gated on coordinating with that session first.

---

## The twelve tools: what exists, what is new

The requested list, measured against the code rather than against memory.

| Tool | In the app today | What is actually missing | Lands in |
|---|---|---|---|
| **Move** | ✅ **Complete.** Drag-to-move via `arbitrate` → `moveBy` → `setLayer{x,y}`; `hitTest` picks the layer; a Select mode in the header cycles overlapping layers | Nothing. It becomes the **null tool** — the state when no other tool is armed | Task 1 |
| **Hand** | ✅ **Complete**, as a pan gesture (`view.panX/panY`, `clampView`) | Nothing — **and it should not become a modal tool.** See "Two tools we should not build" below | — |
| **Zoom** | ✅ **Complete**, as pinch + wheel (`zoomAbout`, `fitView`, double-tap fit↔1:1) | Same — gesture, not a mode | — |
| **Text** | ✅ **Complete.** `insertTextLayer`, `retypeText`, `resizeTextBox`, `liveTextRect`, a full text sheet, font picker, box-reflow-vs-scale drag arbitration | Nothing for horizontal type. (Vertical type is a separate feature, not on this list) | — |
| **Crop** | 🟡 **Engine and service complete, zero UI.** `setFrame`, `setRatio`, `resizeCanvas`, `framingReport`, `layerFate`, `ASPECT_RATIOS`, `moveRect`, `resizeRect`, `largestCentredRect` all exist and are tested in `test/frame.mjs`. `ProjectService.setFrame` exists at line 415 — **and only `sync.service.ts` has ever called it** | The overlay, the sheet, and two thin service wrappers | Tasks 5–6 |
| **Colour picker** | 🟡 Two `<input type="color">` exist (text colour, gradient stops) — but **no document-level foreground/background pair** | The swatch pair, swap (`X`), reset (`D`), and an eyedropper to fill them from the image | Tasks 2–4, 7 |
| **Gradient** | 🟡 **The ramp engine already exists** as the `overlay` adjustment: linear + radial, multi-stop RGBA, `angle`/`cx`/`cy`/`radius`, blend mode, GLSL, scale-invariant (`normaliseOverlay`, `src/adjust/ops.js:488`) | The drag interaction that writes those four parameters, and the three kinds `OVERLAY_KINDS` lacks — **reflected, angle, diamond** | **Plan 2** |
| **Paint Bucket** | 🔴 Nothing | Flood fill, **plus Gate 2 (raster undo)** and Gate 3 (colour) | **Plan 4** |
| **Brush** | 🔴 Nothing for colour. `stampBrush`/`strokeMask` exist but write **masks**, not pixels | The dab engine over colour, **plus Gate 2** | **Plan 4** |
| **Eraser** | 🔴 Nothing. `paintMask` is the mask-side twin and is already wired to the stage by the cut-out tool | Alpha writes, **plus Gate 2** | **Plan 4** |
| **Magic Eraser** | 🔴 Nothing | Flood fill (shared with Paint Bucket), **plus Gate 2** | **Plan 4** |
| **Shapes** (all 7) | 🔴 Nothing. No path, anchor or bezier type exists anywhere | **Gate 5 — a vector path model and a shape layer kind** | **Plan 5** |
| **Direct Selection** | 🔴 Nothing | **Gate 5**, and it is meaningless before shapes exist | **Plan 5** |

### Two tools we should not build

**Hand and Zoom should stay gestures, not become modal tools.** They exist in Photoshop's toolbar because a desktop mouse has no second finger — the tool *is* the workaround. This app already pans with a drag and zooms with a pinch, always available, never modal. Adding a Hand *mode* would mean tapping a tool to do what one finger already does, and would take pinch away from every other tool. The stage's existing comment makes the same argument for the cut-out tool: the pinch branch is placed **before** the tool branch deliberately, *"because the edges this tool exists to fix are exactly the ones you have to zoom in on to see."* That reasoning holds for every tool we are about to add.

They stay on the list as **✅ complete** — because the capability is complete. What is not being built is the modal wrapper, and that is a deliberate refusal, not an omission.

---

## Why this is five plans, not one

The twelve tools are not one subsystem. They sit behind three different architectural gates, and a single plan spanning them would sequence work that cannot be sequenced honestly — Task 30 would be inventing the design that Task 12 was supposed to settle.

| Plan | Scope | Gate it needs | Ready? |
|---|---|---|---|
| **1 — this document** | Tool model, colour pair, eyedropper, Crop | none | **yes** |
| **2** | Gradient tool | none — builds on the existing `overlay` engine | yes, after Plan 1 |
| **3** | Document selection (`project.selection`) | **Gate 1** | needs a design pass |
| **4** | Brush, Eraser, Magic Eraser, Paint Bucket | **Gate 2 — raster undo** | needs a design pass first |
| **5** | Shapes ×7, Direct Selection, Pen | **Gate 5 — vector path model** | needs a design pass first |

Plans 4 and 5 must each open with a design decision that is not yet made — how a pixel edit is undone, and how a path is represented. Writing bite-sized TDD steps for those today would mean inventing both silently and burying them in step 14 of task 9. **Each plan gets written when its gate has been designed.**

Plan 1 produces working, testable software on its own: a tool model, a colour pair, and a Crop tool that ships.

---

## File structure

**New files** — none of them contested:

| File | Responsibility |
|---|---|
| `app/src/app/services/tool.service.ts` | The single owner of which tool is armed, and whether it claims the pointer |
| `app/src/app/services/tool.service.spec.ts` | Its tests |
| `app/src/app/services/color.service.ts` | Foreground/background pair, swap, reset, hex normalisation |
| `app/src/app/services/color.service.spec.ts` | Its tests |
| `app/src/app/services/stage-surface.service.ts` | Canvas registry + composited-pixel sampling for the eyedropper |
| `app/src/app/services/stage-surface.service.spec.ts` | Its tests |
| `app/src/app/editor/crop-overlay.ts` | The crop rect, its handles, and clamping — claims the pointer only on itself |
| `app/src/app/editor/crop-overlay.spec.ts` | Its tests |
| `app/src/app/editor/crop-sheet.ts` | Ratios, the framing report, Apply / Cancel |
| `app/src/app/editor/crop-sheet.spec.ts` | Its tests |

**Modified:**

| File | Change | Contested? |
|---|---|---|
| `app/src/app/services/project.service.ts` | Add `setRatio` and `framingReport` wrappers | No |
| `app/src/app/editor/editor.page.ts` | Tool strip and colour swatches in the header; mount the crop overlay and sheet | No |
| `app/src/app/editor/icon.ts` | Four new icon paths | No |
| `app/src/app/editor/canvas-stage.ts` | **Task 7 only** — one eyedropper branch | **YES — coordinate first** |

---

## Task 1: ToolService — one owner of the armed tool

Today the stage asks `this.seg.tool()` — a segmentation-specific signal on a service the other session owns. Every tool added from here would either pile onto that service or invent its own flag, and the stage would end up asking four different questions to decide who owns the pointer. One service answers it once.

**Files:**
- Create: `app/src/app/services/tool.service.ts`
- Test: `app/src/app/services/tool.service.spec.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type ToolId = 'move' | 'crop' | 'eyedropper' | 'text'`
  - `ToolService.active: WritableSignal<ToolId>` — defaults to `'move'`
  - `ToolService.claimsPointer: Signal<boolean>`
  - `ToolService.select(id: ToolId): void`
  - `ToolService.reset(): void`

- [ ] **Step 1: Write the failing test**

Create `app/src/app/services/tool.service.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { ToolService } from './tool.service';

/**
 * The tool model, as the one question the stage asks before every gesture:
 * does something own this pointer, or does the transform gesture get it?
 */
describe('ToolService', () => {
  let tool: ToolService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    tool = TestBed.inject(ToolService);
  });

  it('starts on move, because move is the absence of a tool', () => {
    expect(tool.active()).toBe('move');
    expect(tool.claimsPointer()).toBe(false);
  });

  it('lets crop and eyedropper take the pointer', () => {
    tool.select('crop');
    expect(tool.claimsPointer()).toBe(true);

    tool.select('eyedropper');
    expect(tool.claimsPointer()).toBe(true);
  });

  it('leaves the pointer to the transform gesture for move and text', () => {
    // Text edits through its sheet, not by claiming the canvas -- a text layer
    // is still dragged and scaled while the text sheet is open.
    tool.select('text');
    expect(tool.claimsPointer()).toBe(false);
  });

  it('resets to move', () => {
    tool.select('crop');
    tool.reset();
    expect(tool.active()).toBe('move');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix app test -- --watch=false`
Expected: FAIL — `Cannot find module './tool.service'`.

- [ ] **Step 3: Write the service**

Create `app/src/app/services/tool.service.ts`:

```ts
import { Injectable, computed, signal } from '@angular/core';

/**
 * Every tool the editor can arm.
 *
 * `move` is the NULL TOOL, not a mode: it is what "no tool armed" is called, so
 * the stage never has to branch on null. Hand and Zoom are deliberately absent
 * -- they are gestures here, always available, and making them modal would take
 * pinch away from every other tool. See docs/PHOTOSHOP-TOOLS.md.
 */
export type ToolId = 'move' | 'crop' | 'eyedropper' | 'text';

/**
 * The tools that take the SINGLE-pointer path away from `arbitrate`.
 *
 * Two-pointer gestures are never claimed by anything: a pinch has to keep
 * working while a tool is armed, which is the rule canvas-stage.ts already
 * follows for the cut-out tool and states in its own comment.
 */
const CLAIMS_POINTER: ReadonlyArray<ToolId> = ['crop', 'eyedropper'];

@Injectable({ providedIn: 'root' })
export class ToolService {
  readonly active = signal<ToolId>('move');

  /** Whether a single-pointer down belongs to the tool rather than to a drag. */
  readonly claimsPointer = computed(() => CLAIMS_POINTER.includes(this.active()));

  select(id: ToolId): void {
    this.active.set(id);
  }

  reset(): void {
    this.active.set('move');
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm --prefix app test -- --watch=false`
Expected: PASS — four new specs green, every existing spec still green.

- [ ] **Step 5: Commit**

```bash
git commit -- app/src/app/services/tool.service.ts app/src/app/services/tool.service.spec.ts \
  -m "Give the editor one owner of which tool is armed"
```

---

## Task 2: ColorService — the foreground/background pair

Gate 3 from the spec. Small, and every painting tool in Plans 2 and 4 reads it, so it goes in first.

**Files:**
- Create: `app/src/app/services/color.service.ts`
- Test: `app/src/app/services/color.service.spec.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `normaliseHex(value: string): string | null` — exported free function
  - `DEFAULT_FOREGROUND = '#000000'`, `DEFAULT_BACKGROUND = '#ffffff'`
  - `ColorService.foreground: WritableSignal<string>`
  - `ColorService.background: WritableSignal<string>`
  - `ColorService.setForeground(hex: string): boolean`
  - `ColorService.setBackground(hex: string): boolean`
  - `ColorService.swap(): void`
  - `ColorService.reset(): void`

- [ ] **Step 1: Write the failing test**

Create `app/src/app/services/color.service.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { ColorService, normaliseHex } from './color.service';

describe('normaliseHex', () => {
  it('expands the three-digit form', () => {
    expect(normaliseHex('#f0a')).toBe('#ff00aa');
  });

  it('lower-cases and keeps the six-digit form', () => {
    expect(normaliseHex('#AABBCC')).toBe('#aabbcc');
  });

  it('refuses anything else rather than guessing', () => {
    // An eyedropper over a transparent pixel, a hand-typed value, a paste --
    // all reach here. Returning null makes the caller decide; returning black
    // would silently paint with a colour nobody chose.
    expect(normaliseHex('aabbcc')).toBeNull();
    expect(normaliseHex('#gg0000')).toBeNull();
    expect(normaliseHex('')).toBeNull();
  });
});

describe('ColorService', () => {
  let color: ColorService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    color = TestBed.inject(ColorService);
  });

  it('starts on black over white', () => {
    expect(color.foreground()).toBe('#000000');
    expect(color.background()).toBe('#ffffff');
  });

  it('swaps the pair', () => {
    color.setForeground('#ff0000');
    color.swap();
    expect(color.foreground()).toBe('#ffffff');
    expect(color.background()).toBe('#ff0000');
  });

  it('resets to black and white', () => {
    color.setForeground('#123456');
    color.setBackground('#654321');
    color.reset();
    expect(color.foreground()).toBe('#000000');
    expect(color.background()).toBe('#ffffff');
  });

  it('reports a refused colour instead of storing it', () => {
    color.setForeground('#00ff00');
    expect(color.setForeground('nonsense')).toBe(false);
    expect(color.foreground()).toBe('#00ff00');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix app test -- --watch=false`
Expected: FAIL — `Cannot find module './color.service'`.

- [ ] **Step 3: Write the service**

Create `app/src/app/services/color.service.ts`:

```ts
import { Injectable, signal } from '@angular/core';

export const DEFAULT_FOREGROUND = '#000000';
export const DEFAULT_BACKGROUND = '#ffffff';

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * `#rgb` or `#rrggbb` in, canonical lower-case `#rrggbb` out -- or null.
 *
 * NULL RATHER THAN A FALLBACK. Every caller has a better answer than a
 * substituted colour: the eyedropper over a transparent pixel should leave the
 * swatch alone, and a rejected paste should leave the field showing what the
 * user typed. A silent black is the one outcome nobody can see is wrong.
 */
export function normaliseHex(value: string): string | null {
  const text = String(value ?? '').trim().toLowerCase();
  if (!HEX.test(text)) return null;
  if (text.length === 4)
    return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
  return text;
}

/**
 * The document's foreground and background colours.
 *
 * Photoshop's most-used control and the prerequisite for every painting tool:
 * Brush, Eraser, Paint Bucket, Gradient and Quick Mask all read this pair. It
 * is deliberately NOT per layer and NOT part of the project -- it is editor
 * state, so it survives closing one document and opening another, and it never
 * enters the undo history.
 */
@Injectable({ providedIn: 'root' })
export class ColorService {
  readonly foreground = signal(DEFAULT_FOREGROUND);
  readonly background = signal(DEFAULT_BACKGROUND);

  /** @returns whether the value was accepted. */
  setForeground(hex: string): boolean {
    const value = normaliseHex(hex);
    if (!value) return false;
    this.foreground.set(value);
    return true;
  }

  /** @returns whether the value was accepted. */
  setBackground(hex: string): boolean {
    const value = normaliseHex(hex);
    if (!value) return false;
    this.background.set(value);
    return true;
  }

  /** Photoshop's `X`. */
  swap(): void {
    const previous = this.foreground();
    this.foreground.set(this.background());
    this.background.set(previous);
  }

  /** Photoshop's `D`. */
  reset(): void {
    this.foreground.set(DEFAULT_FOREGROUND);
    this.background.set(DEFAULT_BACKGROUND);
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm --prefix app test -- --watch=false`
Expected: PASS — seven new specs green.

- [ ] **Step 5: Commit**

```bash
git commit -- app/src/app/services/color.service.ts app/src/app/services/color.service.spec.ts \
  -m "Add the foreground and background colour pair"
```

---

## Task 3: StageSurfaceService — sampling a composited pixel

The eyedropper needs the colour of the **composited** result, not of one layer's data — what is on screen is what the user is pointing at. Only the stage's canvas has that. Putting the registry and the sampling in a service keeps all of the logic testable and leaves the stage edit (Task 7) at six lines.

**Files:**
- Create: `app/src/app/services/stage-surface.service.ts`
- Test: `app/src/app/services/stage-surface.service.spec.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `StageSurfaceService.register(canvas: HTMLCanvasElement | null): void`
  - `StageSurfaceService.sampleDoc(docX: number, docY: number, renderScale: number): string | null`

- [ ] **Step 1: Write the failing test**

Create `app/src/app/services/stage-surface.service.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { StageSurfaceService } from './stage-surface.service';

/** A 10x10 canvas: opaque red left half, fully transparent right half. */
function canvasFixture(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 10;
  canvas.height = 10;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#ff0000';
  context.fillRect(0, 0, 5, 10);
  return canvas;
}

describe('StageSurfaceService', () => {
  let surface: StageSurfaceService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    surface = TestBed.inject(StageSurfaceService);
  });

  it('has nothing to sample before the stage registers a canvas', () => {
    expect(surface.sampleDoc(1, 1, 1)).toBeNull();
  });

  it('reads the composited colour as canonical hex', () => {
    surface.register(canvasFixture());
    expect(surface.sampleDoc(2, 2, 1)).toBe('#ff0000');
  });

  it('scales document coordinates by the render scale', () => {
    // The stage draws a proxy. Document x=8 is in the transparent half at 1:1
    // but lands on canvas x=4 -- red -- at half scale. Asserting BOTH
    // directions is what proves the scale is applied rather than ignored;
    // a single assertion here passes just as well when it is dropped.
    surface.register(halfRed());
    expect(surface.sampleDoc(8, 4, 0.5)).toBe('#ff0000');
    expect(surface.sampleDoc(8, 4, 1)).toBeNull();
  });

  it('returns null outside the canvas rather than clamping to an edge pixel', () => {
    surface.register(canvasFixture());
    expect(surface.sampleDoc(50, 50, 1)).toBeNull();
    expect(surface.sampleDoc(-1, 2, 1)).toBeNull();
  });

  it('returns null on a fully transparent pixel', () => {
    // Transparent is not a colour. Sampling it should leave the swatch alone,
    // not set it to the black that getImageData reports for rgba(0,0,0,0).
    surface.register(canvasFixture());
    expect(surface.sampleDoc(8, 2, 1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix app test -- --watch=false`
Expected: FAIL — `Cannot find module './stage-surface.service'`.

- [ ] **Step 3: Write the service**

Create `app/src/app/services/stage-surface.service.ts`:

```ts
import { Injectable } from '@angular/core';

const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;

/**
 * The stage's canvas, reachable by things that are not the stage.
 *
 * The eyedropper wants the COMPOSITED colour -- what is actually on screen
 * under the finger -- and only this canvas has it. A registry keeps the
 * knowledge of how to read a pixel out of canvas-stage.ts, which is a large
 * file held by another session, and makes all of it testable without rendering
 * a component.
 */
@Injectable({ providedIn: 'root' })
export class StageSurfaceService {
  private canvas: HTMLCanvasElement | null = null;

  /** Called once by the stage, and again with null when it tears down. */
  register(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas;
  }

  /**
   * The colour at a DOCUMENT point, as `#rrggbb`.
   *
   * Null in three different cases, all of which mean "do not paint with this":
   * no canvas yet, the point is off the canvas, or the pixel is fully
   * transparent. Transparent matters most -- `getImageData` reports
   * rgba(0,0,0,0) there, and treating that as a colour makes an eyedropper over
   * empty space silently set the foreground to black.
   *
   * @param renderScale  what the stage is currently drawing at, from
   *                     `renderScaleFor(view, project.proxyScale)`.
   */
  sampleDoc(docX: number, docY: number, renderScale: number): string | null {
    const canvas = this.canvas;
    if (!canvas || !(renderScale > 0)) return null;

    const x = Math.floor(docX * renderScale);
    const y = Math.floor(docY * renderScale);
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;

    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;

    const [r, g, b, a] = context.getImageData(x, y, 1, 1).data;
    return a === 0 ? null : hex(r, g, b);
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm --prefix app test -- --watch=false`
Expected: PASS — five new specs green.

- [ ] **Step 5: Commit**

```bash
git commit -- app/src/app/services/stage-surface.service.ts app/src/app/services/stage-surface.service.spec.ts \
  -m "Let the eyedropper read the composited canvas"
```

---

## Task 4: ProjectService — the two crop wrappers

`ProjectService.setFrame` already exists (line 415) and works. Crop needs two more engine calls behind the same guard-and-bump pattern every other method here uses.

**Files:**
- Modify: `app/src/app/services/project.service.ts`
- Test: `app/src/app/services/project.service.spec.ts` (append to the existing suite)

**Interfaces:**
- Consumes: `ProjectService.project`, `ProjectService.version` (existing)
- Produces:
  - `ProjectService.setRatio(ratio: string, coalesceKey?: string): void`
  - `ProjectService.framingReport(frame?: Rect): FramingReport | null`
  - `type FramingReport = { outside: any[]; clipped: any[]; warnings: string[] }`

**The engine already writes the sentence.** `framingReport` (`src/frame/frame.js:223`) returns the two **layer arrays** plus a `warnings` array of finished prose — *"2 layers fall outside the current frame and are not drawn. They are not deleted — widening the frame or undoing the crop brings them back whole."* Do not re-derive that wording in the app. Surface `warnings`; the reassurance in the second sentence is the part a re-implementation would drop.

- [ ] **Step 1: Read the existing method to match the pattern**

Run: `sed -n '405,440p' app/src/app/services/project.service.ts`

Every mutator here guards on a null project, calls the engine, then bumps `version`. Match it exactly — a method that forgets the bump leaves the canvas showing the old frame.

- [ ] **Step 2: Write the failing test**

Append to `app/src/app/services/project.service.spec.ts`:

```ts
describe('crop', () => {
  it('locks the frame to a named ratio', () => {
    const svc = TestBed.inject(ProjectService);
    svc.project.set(makeProject([{}, {}]));
    const before = svc.version();

    svc.setRatio('1:1');

    const frame = svc.project()!.frame;
    expect(frame.width).toBe(frame.height);
    expect(svc.version()).toBeGreaterThan(before);
  });

  it('reports what a crop would cost, for a frame not yet applied', () => {
    const svc = TestBed.inject(ProjectService);
    svc.project.set(makeProject([{}, {}]));

    // A one-pixel frame in the corner: nothing can be fully inside it.
    const report = svc.framingReport({ x: 0, y: 0, width: 1, height: 1 });

    expect(report).not.toBeNull();
    expect(Array.isArray(report!.outside)).toBe(true);
    expect(Array.isArray(report!.warnings)).toBe(true);
  });

  it('reports nothing when no document is open', () => {
    const svc = TestBed.inject(ProjectService);
    svc.project.set(null);
    expect(svc.framingReport()).toBeNull();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npm --prefix app test -- --watch=false`
Expected: FAIL — `svc.setRatio is not a function`.

- [ ] **Step 4: Add the two methods**

Add the import at the top of `app/src/app/services/project.service.ts`, beside the existing `@engine/` imports:

```ts
import {
  setRatio as engineSetRatio,
  framingReport as engineFramingReport,
} from '@engine/frame/index.js';
```

Add the two methods next to `setFrame`:

```ts
  /**
   * Lock the crop frame to a named aspect ratio.
   *
   * The engine picks the largest centred rect of that ratio that still fits, so
   * a ratio can never produce a frame outside the document.
   */
  setRatio(ratio: string, coalesceKey?: string): void {
    const project = this.project();
    if (!project) return;
    engineSetRatio(project, ratio, coalesceKey);
    this.version.update((n) => n + 1);
  }

  /**
   * What a frame costs, for the crop sheet to say out loud BEFORE Apply.
   *
   * `frame` is optional so the sheet can ask about the PENDING rect rather than
   * the committed one -- a warning that only appears after the crop has already
   * happened is not a warning.
   */
  framingReport(frame?: any): { outside: any[]; clipped: any[]; warnings: string[] } | null {
    const project = this.project();
    if (!project) return null;
    return frame ? engineFramingReport(project, frame) : engineFramingReport(project);
  }
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npm --prefix app test -- --watch=false`
Expected: PASS. If `framingReport` returns a different shape than `{outside, clipped}`, read `src/frame/frame.js:223` and fix the **test's** expectation and the return type here to match the engine — the engine is the authority, not this plan.

- [ ] **Step 6: Commit**

```bash
git commit -- app/src/app/services/project.service.ts app/src/app/services/project.service.spec.ts \
  -m "Reach the engine ratio lock and framing report from the app"
```

---

## Task 5: The crop overlay

The crop rect, its four handles, and the dimming outside it. It sits over the stage and — critically — is `pointer-events-none` except on the rect body and the handles, so **pinch and pan keep working while cropping** and `canvas-stage.ts` needs no change.

**The drag maths is entirely the engine's, including the clamping.** `handleAt` picks the corner; `moveRect(rect, dx, dy, bounds)` slides and keeps the result inside `bounds`; `resizeRect(rect, handle, docX, docY, {bounds, ratio, min})` drags a corner against its anchor, honours a locked ratio, and refuses to go below `MIN_FRAME_SIZE`.

So there is only **one** piece of genuinely new logic here, and it is the one most likely to be wrong: `handleAt` wants `{x, y, w, h}` while `moveRect`/`resizeRect` want `{x, y, width, height}`. That adaptation is what this task tests.

**Files:**
- Create: `app/src/app/editor/crop-overlay.ts`
- Test: `app/src/app/editor/crop-overlay.spec.ts`

**Interfaces:**
- Consumes: `ProjectService` (existing), `@engine/frame/index.js` (`frameOf`, `moveRect`, `resizeRect`, `MIN_FRAME_SIZE`), `@engine/gesture.js` (`handleAt`, `HANDLE_HIT_CSS_PX`), `@engine/view.js` (`viewToDoc`, `docToView`)
- Produces:
  - `type Rect = { x: number; y: number; width: number; height: number }`
  - `cropDrag(start: Rect, handle: string | null, from: Point, to: Point, bounds: Rect, ratio: number | null): Rect` — exported free function
  - `type Point = { x: number; y: number }`
  - `CropOverlay.rect: WritableSignal<Rect>` — the **pending** frame, uncommitted
  - `CropOverlay.ratio: WritableSignal<number | null>` — set by the crop sheet
  - `CropOverlay.reset(): void`

- [ ] **Step 1: Write the failing test**

Create `app/src/app/editor/crop-overlay.spec.ts`:

```ts
import { cropDrag } from './crop-overlay';

const DOC = { x: 0, y: 0, width: 100, height: 100 };

/**
 * The crop drag, which is one adaptation over two engine functions.
 *
 * `handleAt` speaks `{x,y,w,h}` because it was written for layers; `moveRect`
 * and `resizeRect` speak `{x,y,width,height}` because they were written for
 * frames. Both shapes are live in this codebase and a silent mix reads as a
 * crop rect that jumps on first touch, so the conversion gets pinned here
 * rather than trusted.
 */
describe('cropDrag', () => {
  const start = { x: 20, y: 20, width: 40, height: 30 };

  it('moves the whole rect when no handle was grabbed', () => {
    expect(cropDrag(start, null, { x: 30, y: 30 }, { x: 45, y: 35 }, DOC, null))
      .toEqual({ x: 35, y: 25, width: 40, height: 30 });
  });

  it('keeps a moved rect inside the document', () => {
    // Dragging far past the right edge slides the rect back rather than
    // shrinking it -- the user is positioning a rect whose size they chose.
    expect(cropDrag(start, null, { x: 30, y: 30 }, { x: 500, y: 30 }, DOC, null))
      .toEqual({ x: 60, y: 20, width: 40, height: 30 });
  });

  it('drags one corner against its opposite anchor', () => {
    const out = cropDrag(start, 'se', { x: 60, y: 50 }, { x: 70, y: 60 }, DOC, null);
    expect(out).toEqual({ x: 20, y: 20, width: 50, height: 40 });
  });

  it('holds a locked ratio while resizing', () => {
    const out = cropDrag(start, 'se', { x: 60, y: 50 }, { x: 80, y: 90 }, DOC, 1);
    expect(out.width).toBe(out.height);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix app test -- --watch=false`
Expected: FAIL — `Cannot find module './crop-overlay'`.

- [ ] **Step 3: Write the component and the helper**

Create `app/src/app/editor/crop-overlay.ts`:

```ts
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { ProjectService } from '../services/project.service';
import { frameOf, moveRect, resizeRect, MIN_FRAME_SIZE } from '@engine/frame/index.js';
import { handleAt, HANDLE_HIT_CSS_PX } from '@engine/gesture.js';
import { viewToDoc, docToView } from '@engine/view.js';

export type Rect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

/**
 * One drag of the crop rect.
 *
 * Both branches are the engine's, including the clamping: `moveRect` slides
 * against `bounds` and `resizeRect` caps against the dragged corner's anchor,
 * honours a locked ratio and refuses to go under MIN_FRAME_SIZE. Nothing here
 * re-derives any of that -- the value of this function is that it is the ONE
 * place the two rect shapes meet, and it is tested.
 */
export function cropDrag(
  start: Rect,
  handle: string | null,
  from: Point,
  to: Point,
  bounds: Rect,
  ratio: number | null,
): Rect {
  if (!handle) return moveRect(start, to.x - from.x, to.y - from.y, bounds);
  return resizeRect(start, handle, to.x, to.y, { bounds, ratio, min: MIN_FRAME_SIZE });
}

/**
 * The crop rect over the stage.
 *
 * POINTER-EVENTS-NONE EXCEPT ON ITSELF. The host covers the whole stage so the
 * dimming can, but only the rect body and the four handles accept a pointer --
 * so a pinch that starts anywhere else still reaches the stage, and cropping
 * does not cost you zoom. This is also why canvas-stage.ts needs no change for
 * this tool.
 *
 * The rect here is PENDING: nothing is committed until the crop sheet's Apply.
 * Cropping live would put a history entry behind every drag frame and make
 * Cancel a stack of undos.
 */
@Component({
  selector: 'app-crop-overlay',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pointer-events-none absolute inset-0' },
  template: `
    @if (box(); as b) {
      <!-- Four dimming panels rather than one box-shadow: a shadow that large
           is a repaint of the whole stage on every drag frame. -->
      <div class="absolute inset-x-0 top-0 bg-black/50" [style.height.px]="b.top"></div>
      <div class="absolute inset-x-0 bottom-0 bg-black/50" [style.top.px]="b.top + b.height"></div>
      <div class="absolute bg-black/50" [style.top.px]="b.top" [style.left.px]="0"
           [style.width.px]="b.left" [style.height.px]="b.height"></div>
      <div class="absolute bg-black/50" [style.top.px]="b.top" [style.left.px]="b.left + b.width"
           [style.right.px]="0" [style.height.px]="b.height"></div>

      <div
        class="pointer-events-auto absolute border border-sky-400 touch-none"
        [style.left.px]="b.left" [style.top.px]="b.top"
        [style.width.px]="b.width" [style.height.px]="b.height"
        (pointerdown)="onDown($event)"
        (pointermove)="onMove($event)"
        (pointerup)="onUp($event)"
        (pointercancel)="onUp($event)"
      ></div>

      @for (h of handlePoints(); track h.id) {
        <div
          class="pointer-events-auto absolute -ml-3 -mt-3 h-6 w-6 rounded-[3px] border-2 border-sky-500 bg-white touch-none"
          [style.left.px]="h.left" [style.top.px]="h.top"
          (pointerdown)="onDown($event)"
          (pointermove)="onMove($event)"
          (pointerup)="onUp($event)"
          (pointercancel)="onUp($event)"
        ></div>
      }
    }
  `,
})
export class CropOverlay {
  protected readonly svc = inject(ProjectService);

  /** The pending crop, in document units. Committed only by the crop sheet. */
  readonly rect = signal<Rect>({ x: 0, y: 0, width: 0, height: 0 });

  /** Set by the crop sheet's ratio segments. Null is free-form. */
  readonly ratio = signal<number | null>(null);

  private drag: { handle: string | null; startDoc: { x: number; y: number }; startRect: Rect } | null = null;

  constructor() {
    // Opening a document, or reopening the tool, starts from the current frame.
    effect(() => {
      const project = this.svc.project();
      this.svc.version();
      if (project) this.rect.set({ ...frameOf(project) });
    });
  }

  reset(): void {
    const project = this.svc.project();
    if (project) this.rect.set({ ...frameOf(project) });
  }

  /** The pending rect in CSS pixels, for positioning. */
  protected readonly box = computed(() => {
    const project = this.svc.project();
    if (!project) return null;
    const view = this.svc.view();
    const viewport = this.viewport();
    const r = this.rect();
    const topLeft = docToView(view, r.x, r.y, viewport);
    const bottomRight = docToView(view, r.x + r.width, r.y + r.height, viewport);
    return {
      left: topLeft.x,
      top: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    };
  });

  protected readonly handlePoints = computed(() => {
    const b = this.box();
    if (!b) return [];
    return [
      { id: 'nw', left: b.left, top: b.top },
      { id: 'ne', left: b.left + b.width, top: b.top },
      { id: 'se', left: b.left + b.width, top: b.top + b.height },
      { id: 'sw', left: b.left, top: b.top + b.height },
    ];
  });

  private viewport(): DOMRect {
    return (this.hostElement()?.getBoundingClientRect() ?? new DOMRect()) as DOMRect;
  }

  private hostElement(): HTMLElement | null {
    return this.host ?? null;
  }

  private host: HTMLElement | null = null;

  protected onDown(event: PointerEvent): void {
    const target = event.currentTarget as HTMLElement;
    this.host = target.offsetParent as HTMLElement;
    target.setPointerCapture(event.pointerId);

    const view = this.svc.view();
    const startDoc = viewToDoc(view, event.clientX, event.clientY, this.viewport());
    const r = this.rect();
    this.drag = {
      // `handleAt` is gesture.js and speaks {x,y,w,h}. The rect is a FRAME and
      // speaks {x,y,width,height}. This line is the conversion; cropDrag is the
      // other one. There are exactly two, and both are deliberate.
      handle: handleAt(
        { x: r.x, y: r.y, w: r.width, h: r.height },
        startDoc.x, startDoc.y,
        HANDLE_HIT_CSS_PX / view.docScale,
      ),
      startDoc,
      startRect: r,
    };
    event.stopPropagation();
  }

  protected onMove(event: PointerEvent): void {
    const drag = this.drag;
    const project = this.svc.project();
    if (!drag || !project) return;

    const now = viewToDoc(this.svc.view(), event.clientX, event.clientY, this.viewport());
    this.rect.set(cropDrag(
      drag.startRect,
      drag.handle,
      drag.startDoc,
      now,
      { x: 0, y: 0, width: project.width, height: project.height },
      this.ratio(),
    ));
    event.stopPropagation();
  }

  protected onUp(event: PointerEvent): void {
    this.drag = null;
    event.stopPropagation();
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm --prefix app test -- --watch=false`
Expected: PASS — four new specs green.

If the ratio spec fails, read `usableRatio` in `src/frame/rect.js` — `resizeRect` may expect a ratio as `width / height` in a different form than the plain `1` used here. Fix the **test** to match the engine, never the engine to match the test.

- [ ] **Step 5: Commit**

```bash
git commit -- app/src/app/editor/crop-overlay.ts app/src/app/editor/crop-overlay.spec.ts \
  -m "Add the crop rect overlay, claiming the pointer only on itself"
```

---

## Task 6: The crop sheet

Ratios, the cost of the crop stated before it happens, and Apply / Cancel.

**Files:**
- Create: `app/src/app/editor/crop-sheet.ts`
- Test: `app/src/app/editor/crop-sheet.spec.ts`

**Interfaces:**
- Consumes: `ProjectService.setFrame`, `ProjectService.framingReport` (Task 4); `CropOverlay.rect` and `CropOverlay.ratio` (Task 5); `ASPECT_RATIOS`, `RATIO_IDS`, `ratioOf` from `@engine/frame/index.js`
- Produces:
  - `CropSheet.warnings: Signal<string[]>` — the engine's own sentences about the **pending** rect, empty when the crop costs nothing
  - `CropSheet.overlayRect: WritableSignal<Rect>`
  - `CropSheet.apply(): void`
  - `CropSheet.cancel(): void`

`ProjectService.setRatio` is **not** used here. It commits a ratio to the live frame, which is the wrong verb for a pending crop — the sheet writes `CropOverlay.ratio` instead and lets the next drag honour it. `setRatio` stays on the service for a future Canvas Size sheet, which does commit directly.

- [ ] **Step 1: Write the failing test**

Create `app/src/app/editor/crop-sheet.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { CropSheet } from './crop-sheet';
import { ProjectService } from '../services/project.service';
import { makeProject } from '../../testing/project-fixture';

/**
 * The sheet, as logic rather than markup -- the same trade sync-sheet.spec
 * makes. What is worth asserting is the one thing this component decides:
 * turning a framing report into a sentence a person acts on.
 */
describe('CropSheet', () => {
  let sheet: any;
  let svc: ProjectService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    svc = TestBed.inject(ProjectService);
    svc.project.set(makeProject([{}, {}]));
    sheet = TestBed.runInInjectionContext(() => new CropSheet());
  });

  it('says nothing when the crop costs nothing', () => {
    spyOn(svc, 'framingReport').and.returnValue({ outside: [], clipped: [], warnings: [] });
    expect(sheet.warnings()).toEqual([]);
  });

  it('passes the engine sentence through rather than writing its own', () => {
    // The engine's wording says the layers are NOT DELETED and how to get them
    // back. Re-deriving "2 layers will be dropped" here would lose exactly the
    // half of that sentence a worried user needs.
    const sentence = '2 layers fall outside the current frame and are not drawn. '
      + 'They are not deleted — widening the frame or undoing the crop brings them back whole.';
    spyOn(svc, 'framingReport').and.returnValue({ outside: [1, 2], clipped: [], warnings: [sentence] });
    expect(sheet.warnings()).toEqual([sentence]);
  });

  it('asks about the pending rect, not the committed frame', () => {
    // A warning that only appears after Apply is not a warning.
    const report = spyOn(svc, 'framingReport').and.returnValue({ outside: [], clipped: [], warnings: [] });
    sheet.overlayRect.set({ x: 4, y: 6, width: 20, height: 10 });
    sheet.warnings();
    expect(report).toHaveBeenCalledWith({ x: 4, y: 6, width: 20, height: 10 });
  });

  it('commits the pending rect on apply', () => {
    const setFrame = spyOn(svc, 'setFrame');
    sheet.overlayRect.set({ x: 4, y: 6, width: 20, height: 10 });
    sheet.apply();
    expect(setFrame).toHaveBeenCalledWith({ x: 4, y: 6, width: 20, height: 10 });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix app test -- --watch=false`
Expected: FAIL — `Cannot find module './crop-sheet'`.

- [ ] **Step 3: Write the sheet**

Create `app/src/app/editor/crop-sheet.ts`. Wire the ratio segmented control through the existing `Segmented` component (`./segmented`) and the shell through `./sheet-shell`, matching `overlay-sheet.ts`. The logic the test pins:

```ts
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ProjectService } from '../services/project.service';
import { ToolService } from '../services/tool.service';
import type { Rect } from './crop-overlay';

@Component({
  selector: 'app-crop-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `...`, // ratio segments, the warning line, Apply / Cancel
})
export class CropSheet {
  private readonly svc = inject(ProjectService);
  private readonly tool = inject(ToolService);

  /** The overlay's pending rect, handed in by the editor page. */
  readonly overlayRect = signal<Rect>({ x: 0, y: 0, width: 0, height: 0 });

  /**
   * What this crop would cost, asked about the PENDING rect.
   *
   * The sentences are the engine's, verbatim. It already gets the singular
   * right, already separates "dropped" from "clipped", and already says the
   * layers are recoverable -- which is the half a re-implementation loses.
   */
  readonly warnings = computed<string[]>(() => {
    this.svc.version();
    return this.svc.framingReport(this.overlayRect())?.warnings ?? [];
  });

  apply(): void {
    this.svc.setFrame(this.overlayRect());
    this.tool.reset();
  }

  /** Nothing was committed, so cancelling is just leaving. */
  cancel(): void {
    this.tool.reset();
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm --prefix app test -- --watch=false`
Expected: PASS — five new specs green.

- [ ] **Step 5: Mount the tool in the editor page**

In `app/src/app/editor/editor.page.ts` (not contested):

1. `inject(ToolService)` and `inject(ColorService)`.
2. Add a compact tool strip to the **header**, beside the existing Select control — the header, not the rail, for the reason already written at `editor.page.ts:153-156`: it is the one place a control keeps working while a sheet is open. Entries: Move, Crop, Eyedropper.
3. Add the two colour swatches with a swap button next to them.
4. Render `<app-crop-overlay>` inside the stage container and `<app-crop-sheet>` when `tool.active() === 'crop'`, binding the overlay's `rect` into the sheet's `overlayRect`.
5. Add the icon paths for `move`, `crop`, `eyedropper` and `swap` to `icon.ts`.

**Do not add Hand or Zoom buttons.** See "Two tools we should not build".

- [ ] **Step 6: Commit**

```bash
git commit -- app/src/app/editor/crop-sheet.ts app/src/app/editor/crop-sheet.spec.ts \
  app/src/app/editor/editor.page.ts app/src/app/editor/icon.ts \
  -m "Ship the Crop tool the engine has always supported"
```

---

## Task 7: The eyedropper's pointer branch — CONTESTED

**⚠️ Coordinate with the other session before starting.** `canvas-stage.ts` is in their working tree. This is the only task in the plan that touches it, and it is last so the other six ship regardless.

The stage already has exactly this branch for the cut-out tool at `canvas-stage.ts:368`. This adds a sibling and does not touch theirs.

**Files:**
- Modify: `app/src/app/editor/canvas-stage.ts` — one branch in `onPointerDown`

**Interfaces:**
- Consumes: `ToolService.active` (Task 1), `ColorService.setForeground` (Task 2), `StageSurfaceService.register` / `.sampleDoc` (Task 3)
- Produces: nothing

- [ ] **Step 1: Confirm the file is safe to touch**

```bash
git status --short app/src/app/editor/canvas-stage.ts
```

If it still shows ` M`, **stop and coordinate.** Do not edit it and do not stage it.

- [ ] **Step 2: Register the canvas**

Wherever the stage first has its canvas element, add:

```ts
this.surface.register(canvasElement);
```

and in its teardown, `this.surface.register(null);` — with `private readonly surface = inject(StageSurfaceService);` beside the other injects.

- [ ] **Step 3: Add the branch**

Immediately **after** the existing cut-out tool branch (so the two-pointer pinch check still runs first, for the reason that branch's own comment gives):

```ts
    /*
     * The eyedropper samples and is done -- no drag, no gesture state. Placed
     * beside the cut-out branch and after the pinch check for the same reason:
     * picking a colour off a small detail means zooming into it first.
     */
    if (this.tool.active() === 'eyedropper') {
      const point = viewToDoc(this.svc.view(), event.clientX, event.clientY, this.rect);
      const project = this.svc.project();
      if (project) {
        const scale = renderScaleFor(this.svc.view(), project.proxyScale);
        const hex = this.surface.sampleDoc(point.x, point.y, scale);
        // Null means transparent or off-canvas. Leaving the swatch alone is the
        // right answer for both -- see ColorService.
        if (hex) this.color.setForeground(hex);
      }
      return;
    }
```

- [ ] **Step 4: Run the full suite**

Run: `npm --prefix app test -- --watch=false`
Expected: PASS, with every existing canvas-stage spec still green. The transform gesture must be unchanged when `tool.active()` is `'move'`.

- [ ] **Step 5: Commit — exact paths only**

```bash
git status --short
git diff --staged
git commit -- app/src/app/editor/canvas-stage.ts \
  -m "Let the eyedropper claim a single pointer on the stage"
```

Read the diff before committing. It should be one import line, one inject, one register call, one teardown call and one branch — nothing else. **A hunk you cannot explain is not ready to commit.**

---

## What this plan does not do

Stated so the next session does not have to infer it.

- **No Hand or Zoom tool.** Deliberate — they are gestures, and the refusal is argued above.
- **No Gradient.** Plan 2 — it is a real piece of work over the existing `overlay` engine, not a checkbox.
- **No Brush, Eraser, Magic Eraser or Paint Bucket.** All four need Gate 2 (raster undo) designed first. Plan 4.
- **No Shapes and no Direct Selection.** Both need Gate 5 (a vector path model). Plan 5.
- **No document-level selection.** Gate 1, Plan 3 — Magic Eraser and Paint Bucket both want it, and it is the cheapest of the gates.
- **No canvas rotation.** `view.js` has no rotation term and adding one touches every hit-test.
- **Crop does not resize the canvas.** `resizeCanvas` and its nine anchors exist and are tested; exposing them is a second sheet, not part of the crop rect.
