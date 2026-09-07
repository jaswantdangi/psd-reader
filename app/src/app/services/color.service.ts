import { Injectable, signal } from '@angular/core';

export const DEFAULT_FOREGROUND = '#000000';
export const DEFAULT_BACKGROUND = '#ffffff';

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * `#rgb` or `#rrggbb` in, canonical lower-case `#rrggbb` out — or null.
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
 * Photoshop's most-used control, and the prerequisite for every painting tool:
 * Brush, Eraser, Paint Bucket, Gradient and Quick Mask all read this pair.
 *
 * Deliberately NOT per layer and NOT part of the project — it is editor state,
 * so it survives closing one document and opening another, and it never enters
 * the undo history. A colour you picked is not an edit you can undo.
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
