import { TestBed } from '@angular/core/testing';
import { SyncSheet } from './sync-sheet';
import { SyncService } from '../services/sync.service';
import { installFakeWorker } from '../../testing/fake-worker';

/**
 * The sync sheet, as logic rather than as markup.
 *
 * Built through the injector but never rendered — the same trade the layers
 * sheet makes. What is worth asserting here is the two things this component
 * decides rather than displays: how a stream of refusals becomes something a
 * person can read, and how a pairing code is spelled out for a screen reader.
 * Everything else on screen is a signal from `SyncService`, which has its own
 * suite.
 */
describe('SyncSheet', () => {
  let sheet: any;
  let sync: SyncService;
  let restoreWorker: () => void;

  beforeEach(() => {
    restoreWorker = installFakeWorker();
    TestBed.configureTestingModule({});
    sync = TestBed.inject(SyncService);
    sheet = TestBed.runInInjectionContext(() => new SyncSheet());
  });

  afterEach(() => restoreWorker());

  describe('what is not syncing', () => {
    it('counts refusals by reason instead of listing every one', () => {
      // One brush stroke is dozens of refused events. Listing them buries the
      // only thing worth reading, which is that brush strokes do not sync.
      sync.refused.set([
        { reason: 'needs-pixels', change: 'brush', layerID: 7 },
        { reason: 'needs-pixels', change: 'brush', layerID: 7 },
        { reason: 'needs-pixels', change: 'filter', layerID: 9 },
        { reason: 'unknown-layer', change: 'move', layerID: 99 },
      ]);

      expect(sheet.unsyncable()).toEqual([
        { reason: 'needs-pixels', count: 3, label: 'Brush, filter, adjustment and effect changes' },
        { reason: 'unknown-layer', count: 1, label: 'Changes to layers that never matched' },
      ]);
    });

    it('names a reason it has no wording for rather than dropping the row', () => {
      // A protocol reason with no label is still a change that did not arrive.
      // Showing the raw reason is worse writing and better disclosure.
      sync.refused.set([{ reason: 'some-future-reason', change: 'move', layerID: 1 }]);

      expect(sheet.unsyncable()).toEqual([
        { reason: 'some-future-reason', count: 1, label: 'some-future-reason' },
      ]);
    });

    it('is empty when nothing has been refused', () => {
      expect(sheet.unsyncable()).toEqual([]);
    });
  });

  describe('the pairing code', () => {
    it('is spelled out character by character for a screen reader', () => {
      // Read aloud, "K7M2PQ" is a word. Spaced, it is six characters someone
      // can actually transcribe into another machine.
      sync.code.set('K7M2PQ');
      expect(sheet.spelled()).toBe('K 7 M 2 P Q');
    });

    it('is an empty string rather than "null" before one is issued', () => {
      expect(sheet.spelled()).toBe('');
    });
  });

  describe('connecting', () => {
    it('trims the relay address, because a pasted URL usually carries a space', () => {
      let asked = '';
      sync.connect = (url: string) => { asked = url; };
      sheet.relay.set('  ws://localhost:8787  ');

      sheet.connect();

      expect(asked).toBe('ws://localhost:8787');
    });
  });
});
