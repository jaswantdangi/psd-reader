import { Injectable, computed, signal } from '@angular/core';

/**
 * Every tool the editor can arm.
 *
 * `move` is the NULL TOOL, not a mode: it is what "no tool armed" is called, so
 * the stage never has to branch on null. Hand and Zoom are deliberately absent —
 * they are gestures here, always available, and making them modal would take
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
