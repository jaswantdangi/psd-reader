import { TestBed } from '@angular/core/testing';
import { ValueDial } from './value-dial';

/**
 * The dial's arc, as arithmetic.
 *
 * Built through the injector and never rendered — the same trade sync-sheet's
 * spec makes. What is worth asserting is the geometry: an arc that winds the
 * wrong way for negative values, or that measures against the wrong span, is
 * wrong in a way that looks plausible on screen.
 */
describe('ValueDial', () => {
  const CIRCUMFERENCE = 2 * Math.PI * 18;

  /** The component with its inputs set, since inputs are signals. */
  function dial(inputs: Record<string, unknown>): any {
    const ref = TestBed.createComponent(ValueDial);
    ref.componentRef.setInput('label', 'Exposure');
    ref.componentRef.setInput('value', 0);
    for (const [key, value] of Object.entries(inputs)) {
      ref.componentRef.setInput(key, value);
    }
    return ref.componentInstance;
  }

  beforeEach(() => TestBed.configureTestingModule({}));

  it('draws no arc at the neutral value', () => {
    // Untouched is the ABSENCE of ink, not a badge that has to be read.
    expect(dial({ value: 0 }).neutral()).toBe(true);
  });

  it('draws an arc as soon as the value leaves neutral', () => {
    expect(dial({ value: 1 }).neutral()).toBe(false);
  });

  it('measures the arc against the furthest the control can go', () => {
    // +50 of a possible 100 is half the ring.
    const half = dial({ value: 50, min: -100, max: 100 }).dash();
    expect(half).toBe(`${0.5 * CIRCUMFERENCE} ${CIRCUMFERENCE}`);
  });

  it('starts a positive arc at the top', () => {
    expect(dial({ value: 50 }).spin()).toBe('rotate(-90 22 22)');
  });

  it('winds a negative arc the other way from the top', () => {
    // Same shape as sweeping clockwise from a start rolled back by the arc's
    // own length: -90 - 180 for a half ring. Getting this backwards makes -50
    // and +50 draw the identical picture.
    expect(dial({ value: -50 }).spin()).toBe('rotate(-270 22 22)');
  });

  it('never overruns the ring', () => {
    // A value outside the declared range should fill the ring, not wrap past
    // it and read as a smaller number than it is.
    const over = dial({ value: 500, min: -100, max: 100 }).dash();
    expect(over).toBe(`${CIRCUMFERENCE} ${CIRCUMFERENCE}`);
  });

  it('measures against the longer side of an off-centre range', () => {
    // Range 0..100 with neutral 0: the whole span is on one side, so 50 is
    // half. Measuring against (max-min)/2 would call it a full ring.
    expect(dial({ value: 50, min: 0, max: 100, neutralValue: 0 }).dash())
      .toBe(`${0.5 * CIRCUMFERENCE} ${CIRCUMFERENCE}`);
  });
});
