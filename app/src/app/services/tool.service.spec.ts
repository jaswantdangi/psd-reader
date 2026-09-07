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
    // Text edits through its sheet, not by claiming the canvas — a text layer
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
