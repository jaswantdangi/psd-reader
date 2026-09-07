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
    // An eyedropper over a transparent pixel, a hand-typed value, a paste —
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
