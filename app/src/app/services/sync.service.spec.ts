import { TestBed } from '@angular/core/testing';
import { SyncService, type SyncSocket } from './sync.service';
import { ProjectService } from './project.service';
import { makeProject } from '../../testing/project-fixture';
import { installFakeWorker } from '../../testing/fake-worker';

/**
 * The app half of Photoshop sync.
 *
 * The socket is faked and NOTHING ELSE IS. Every frame below goes through the
 * engine's real `parseMessage`, `matchLayers` and `translateEvent`, and every
 * command that survives is applied by the real `ProjectService` to a real
 * project — so a test here fails when the app diverges from the engine, not
 * when it diverges from a second copy of the engine living in `app/`.
 *
 * The relay is not faked either, in the sense that matters: its own suite
 * drives a real server on a real port. What is left for this file is the half
 * that suite cannot see — what the app DOES with a frame once it arrives.
 */

/** A socket that records what was sent and lets a test push frames in. */
function fakeSocket() {
  const sent: any[] = [];
  const socket: SyncSocket & { sent: any[]; closed: boolean } = {
    sent,
    closed: false,
    send: (data: string) => sent.push(JSON.parse(data)),
    close: () => { socket.closed = true; },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  return socket;
}

const psLayer = (layerID: number, name: string, kind: string, [left, top, right, bottom]: number[], groupPath: string[] = []) =>
  ({ layerID, name, kind, bounds: { left, top, right, bottom }, groupPath });

describe('SyncService', () => {
  let sync: SyncService;
  let projects: ProjectService;
  let socket: ReturnType<typeof fakeSocket>;
  let restoreWorker: () => void;

  /** Connect and consume the handshake up to, but not including, the tree. */
  const pair = () => {
    sync.connect('ws://relay.test');
    socket.onopen!({});
    deliver({ type: 'pair', code: 'K7M2PQ' });
    deliver({ type: 'paired', sessionId: 's1', peer: { role: 'plugin', version: '0.1.0' } });
  };

  const deliver = (frame: any) => socket.onmessage!({ data: JSON.stringify(frame) });

  beforeEach(() => {
    restoreWorker = installFakeWorker();
    TestBed.configureTestingModule({});
    sync = TestBed.inject(SyncService);
    projects = TestBed.inject(ProjectService);
    socket = fakeSocket();
    sync.socketFactory = () => socket;
  });

  afterEach(() => restoreWorker());

  // ------------------------------------------------------------- handshake

  describe('the handshake', () => {
    it('says hello as the app, because the relay issues the code to that role', () => {
      sync.connect('ws://relay.test');
      socket.onopen!({});
      expect(socket.sent).toEqual([{ type: 'hello', role: 'app', version: '1.0.0' }]);
    });

    it('surfaces the pairing code, which is the only thing the person has to carry', () => {
      sync.connect('ws://relay.test');
      socket.onopen!({});
      deliver({ type: 'pair', code: 'K7M2PQ' });

      expect(sync.code()).toBe('K7M2PQ');
      expect(sync.status()).toBe('waiting');
    });

    it('is not live until the layer tree has been reconciled', () => {
      pair();
      // Paired is a socket fact. Live is a document fact, and they are not the
      // same moment: between them the app knows who it is talking to and
      // nothing about what.
      expect(sync.status()).toBe('paired');
    });
  });

  // ------------------------------------------------------------ the mapping

  describe('reconciling the tree', () => {
    it('matches Photoshop layers to app layers and pins the result', () => {
      const project = makeProject([
        { name: 'Background', x: 0, y: 0, w: 100, h: 100 },
        { name: 'Headline', x: 10, y: 10, w: 80, h: 30 },
      ]);
      projects.project.set(project);
      pair();

      deliver({
        type: 'tree',
        document: { name: 'poster.psd', width: project.width, height: project.height },
        layers: [
          psLayer(7, 'Background', 'pixel', [0, 0, 100, 100]),
          psLayer(9, 'Headline', 'pixel', [10, 10, 90, 40]),
        ],
      });

      expect(sync.status()).toBe('live');
      expect(sync.matched()).toBe(2);
      expect(sync.unmatched()).toEqual([]);
    });

    it('reports what it could not match rather than going quiet', () => {
      const project = makeProject([{ name: 'Background', x: 0, y: 0, w: 100, h: 100 }]);
      projects.project.set(project);
      pair();

      deliver({
        type: 'tree',
        document: { name: 'poster.psd', width: project.width, height: project.height },
        layers: [
          psLayer(7, 'Background', 'pixel', [0, 0, 100, 100]),
          psLayer(8, 'Curves 1', 'adjustment', [0, 0, 100, 100]),
        ],
      });

      expect(sync.matched()).toBe(1);
      expect(sync.unmatched()).toEqual([
        { side: 'photoshop', name: 'Curves 1', kind: 'adjustment', reason: 'adjustment' },
      ]);
    });

    it('says when the two sides look like different files', () => {
      // Nothing can enforce this — sync never transfers a document, so the
      // dimensions are the only evidence there is. Without saying it,
      // "0 of 12 matched" reads as a broken matcher.
      const project = makeProject([{ name: 'Background', x: 0, y: 0, w: 100, h: 100 }]);
      projects.project.set(project);
      pair();

      deliver({
        type: 'tree',
        document: { name: 'something-else.psd', width: 4000, height: 3000 },
        layers: [psLayer(7, 'Background', 'pixel', [0, 0, 100, 100])],
      });

      expect(sync.documentMismatch()).toMatch(/something-else\.psd at 4000x3000/);
      expect(sync.documentMismatch()).toMatch(/probably a different file/);
    });

    it('refuses a tree when nothing is open here, and says so to Photoshop', () => {
      pair();
      deliver({ type: 'tree', document: { name: 'p.psd', width: 10, height: 10 }, layers: [] });

      expect(sync.status()).toBe('paired');
      expect(socket.sent.at(-1)).toEqual({ type: 'error', code: 'no-document', message: 'no document is open in the app' });
    });
  });

  // ------------------------------------------------------------- applying

  describe('applying events', () => {
    let project: any;

    /** A live session over a two-layer document, tree already reconciled. */
    const live = () => {
      project = makeProject([
        { name: 'Background', x: 0, y: 0, w: 100, h: 100 },
        { name: 'Headline', x: 10, y: 10, w: 80, h: 30 },
      ]);
      projects.project.set(project);
      pair();
      deliver({
        type: 'tree',
        document: { name: 'poster.psd', width: project.width, height: project.height },
        layers: [
          psLayer(7, 'Background', 'pixel', [0, 0, 100, 100]),
          psLayer(9, 'Headline', 'pixel', [10, 10, 90, 40]),
        ],
      });
      socket.sent.length = 0;
    };

    beforeEach(live);

    it('moves the layer the event names, resolved through the mapping', () => {
      deliver({ type: 'event', change: 'move', layerID: 9, props: { x: 40, y: 12 } });

      const headline = project.layers.find((l: any) => l.name === 'Headline');
      expect([headline.x, headline.y]).toEqual([40, 12]);
      expect(sync.applied()).toBe(1);
    });

    it('goes through ProjectService, so the screen moves with the document', () => {
      // A second path straight into the engine would change the project and
      // leave the UI showing the old one.
      const before = projects.version();
      deliver({ type: 'event', change: 'opacity', layerID: 7, props: { opacity: 0.25 } });

      expect(projects.version()).toBe(before + 1);
      expect(project.layers.find((l: any) => l.name === 'Background').opacity).toBe(0.25);
    });

    it('applies visibility, blend mode and rename', () => {
      deliver({ type: 'event', change: 'visibility', layerID: 7, props: { visible: false } });
      deliver({ type: 'event', change: 'blendMode', layerID: 7, props: { blendMode: 'multiply' } });
      deliver({ type: 'event', change: 'rename', layerID: 7, props: { name: 'Sky' } });

      const layer = project.layers[0];
      expect(layer.visible).toBe(false);
      expect(layer.blendMode).toBe('multiply');
      expect(layer.name).toBe('Sky');
      expect(sync.applied()).toBe(3);
    });

    it('removes a layer, and undo puts it back', () => {
      deliver({ type: 'event', change: 'delete', layerID: 9, props: {} });
      expect(project.layers.map((l: any) => l.name)).toEqual(['Background']);

      projects.undo();
      expect(project.layers.map((l: any) => l.name)).toEqual(['Background', 'Headline']);
    });

    it('crops the document without needing a layer at all', () => {
      deliver({ type: 'event', change: 'crop', props: { x: 5, y: 5, width: 50, height: 40 } });

      expect(project.frame).toEqual({ x: 5, y: 5, width: 50, height: 40 });
      expect(sync.applied()).toBe(1);
    });
  });

  // ------------------------------------------------------------- refusals

  describe('what it refuses', () => {
    it('refuses an event that arrives before the tree, and does not queue it', () => {
      // Without a mapping, "layer 7 moved" names nothing. Queuing would mean
      // applying it later against a mapping that did not exist when it was sent.
      const project = makeProject([{ name: 'Background', x: 0, y: 0, w: 100, h: 100 }]);
      projects.project.set(project);
      pair();
      socket.sent.length = 0;

      deliver({ type: 'event', change: 'move', layerID: 7, props: { x: 40, y: 12 } });

      expect(sync.applied()).toBe(0);
      expect(sync.refused()).toEqual([{ reason: 'not-reconciled', change: 'move', layerID: 7 }]);
      expect(socket.sent.at(-1).code).toBe('not-reconciled');
    });

    it('refuses an event for a layer that never matched, rather than picking one', () => {
      const project = makeProject([{ name: 'Background', x: 0, y: 0, w: 100, h: 100 }]);
      projects.project.set(project);
      pair();
      deliver({
        type: 'tree',
        document: { name: 'poster.psd', width: project.width, height: project.height },
        layers: [psLayer(7, 'Background', 'pixel', [0, 0, 100, 100])],
      });
      socket.sent.length = 0;

      deliver({ type: 'event', change: 'move', layerID: 999, props: { x: 40, y: 12 } });

      expect(sync.refused()).toEqual([{ reason: 'unknown-layer', change: 'move', layerID: 999 }]);
      expect(project.layers[0].x).toBe(0);
    });

    it('tells Photoshop what it could not apply — error is the one frame that travels both ways', () => {
      const project = makeProject([{ name: 'Background', x: 0, y: 0, w: 100, h: 100 }]);
      projects.project.set(project);
      pair();
      deliver({
        type: 'tree',
        document: { name: 'poster.psd', width: project.width, height: project.height },
        layers: [psLayer(7, 'Background', 'pixel', [0, 0, 100, 100])],
      });
      socket.sent.length = 0;

      deliver({ type: 'event', change: 'brush', layerID: 7, props: {} });

      expect(socket.sent.at(-1)).toEqual({
        type: 'error', code: 'needs-pixels', message: 'brush was not applied: needs-pixels',
      });
      expect(sync.refused()[0].reason).toBe('needs-pixels');
    });

    it('survives a frame it cannot parse instead of dropping the session', () => {
      pair();
      socket.sent.length = 0;

      socket.onmessage!({ data: 'this is not JSON' });

      expect(sync.status()).toBe('paired');
      expect(socket.sent.at(-1).code).toBe('bad-json');
    });

    it('shows the relay\'s own refusals, which are the ones a person can act on', () => {
      sync.connect('ws://relay.test');
      socket.onopen!({});
      deliver({ type: 'error', code: 'rate-limited', message: 'too many pairing attempts' });

      expect(sync.status()).toBe('failed');
      expect(sync.message()).toBe('too many pairing attempts (rate-limited)');
    });
  });

  // ------------------------------------------------------------ lifecycle

  describe('lifecycle', () => {
    it('closing clears the code, so a spent one is never left on screen', () => {
      // A code is single use and lives five minutes. Showing a dead one invites
      // it to be typed in.
      pair();
      sync.disconnect();

      expect(socket.closed).toBe(true);
      expect(sync.code()).toBeNull();
      expect(sync.status()).toBe('idle');
    });

    it('a deliberate close does not report itself as a failure', () => {
      pair();
      sync.disconnect();
      socket.onclose!({});

      expect(sync.status()).toBe('idle');
    });

    it('an unreachable relay says so', () => {
      sync.connect('ws://relay.test');
      socket.onerror!({});

      expect(sync.status()).toBe('failed');
      expect(sync.message()).toMatch(/Could not reach the relay/);
    });

    it('reconnecting starts from a clean slate', () => {
      pair();
      sync.disconnect();
      socket = fakeSocket();
      sync.socketFactory = () => socket;

      sync.connect('ws://relay.test');

      expect(sync.applied()).toBe(0);
      expect(sync.refused()).toEqual([]);
      expect(sync.unmatched()).toEqual([]);
      expect(sync.documentMismatch()).toBeNull();
    });
  });
});
