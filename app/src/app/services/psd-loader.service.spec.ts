import { TestBed } from '@angular/core/testing';
import { PsdLoaderService } from './psd-loader.service';
import { FakeWorker, installFakeWorker } from '../../testing/fake-worker';
import { makeProject } from '../../testing/project-fixture';

/**
 * The decode worker's protocol, from the main thread's side.
 *
 * The guard itself is the engine's (`src/budget.js`, covered in Node). What is
 * covered here is the part that only exists in `app/`: WHEN a worker is
 * started, what crosses to it, and the fact that every one of the four ways a
 * decode can end settles the promise. A promise that never settles leaves the
 * screen on "reading…" forever, which is the same silent failure as the blank
 * screen the size guard exists to prevent.
 */
describe('PsdLoaderService', () => {
  let svc: PsdLoaderService;
  let restoreWorker: () => void;

  beforeEach(() => {
    restoreWorker = installFakeWorker();
    TestBed.configureTestingModule({});
    svc = TestBed.inject(PsdLoaderService);
  });

  afterEach(() => restoreWorker());

  /** `memoryBudgetBytes` reads this; jsdom's navigator does not carry it. */
  function withDeviceMemory<T>(gb: number, run: () => T): T {
    Object.defineProperty(navigator, 'deviceMemory', { value: gb, configurable: true });
    try {
      return run();
    } finally {
      delete (navigator as any).deviceMemory;
    }
  }

  describe('the size guard', () => {
    /**
     * The refusal has to happen BEFORE a worker exists. Starting one and then
     * refusing would allocate the very thing the guard is avoiding.
     */
    it('refuses an oversized file without starting a worker', async () => {
      const result: any = await withDeviceMemory(0.001, () =>
        svc.load(new Uint8Array(500_000), 'huge.psd', 'file://huge.psd'),
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('guard');
      expect(result.message).toContain('MB');
      expect(FakeWorker.instances.length).toBe(0);
    });

    it('starts a worker for a file inside the budget', () => {
      svc.load(new Uint8Array(64), 'ok.psd', 'file://ok.psd');
      expect(FakeWorker.instances.length).toBe(1);
    });
  });

  describe('what crosses to the worker', () => {
    it('transfers the bytes rather than copying them', () => {
      const bytes = new Uint8Array(64);
      svc.load(bytes, 'a.psd', 'file://a.psd');

      const worker = FakeWorker.last;
      expect(worker.posted[0].fileName).toBe('a.psd');
      expect(worker.posted[0].proxyEdge).toBe(1024);
      expect(worker.posted[0].source).toEqual({ uri: 'file://a.psd', name: 'a.psd', size: 64 });
      expect(worker.transfers[0]).toEqual([bytes.buffer]);
    });

    /**
     * The VIEW, not the raw buffer. A partial view — a subarray, or a Capacitor
     * Filesystem read — loses its byteOffset/byteLength if re-wrapped, and the
     * decoder is then handed the wrong byte range.
     */
    it('posts the view, so a partial one keeps its offset and length', () => {
      const backing = new Uint8Array(128);
      const view = backing.subarray(32, 96);
      svc.load(view, 'b.psd', 'file://b.psd');

      const posted = FakeWorker.last.posted[0].bytes;
      expect(posted).toBe(view);
      expect(posted.byteOffset).toBe(32);
      expect(posted.byteLength).toBe(64);
      // ...and the size reported to the engine is the view's, not the buffer's.
      expect(FakeWorker.last.posted[0].source.size).toBe(64);
    });

    it('resets the progress signals at the start of each load', () => {
      svc.progress.set(30);
      svc.total.set(48);
      svc.load(new Uint8Array(8), 'c.psd', 'file://c.psd');
      expect(svc.progress()).toBe(0);
      expect(svc.total()).toBe(0);
    });
  });

  describe('progress', () => {
    it('publishes decoded and total so the bar can be determinate', () => {
      svc.load(new Uint8Array(8), 'a.psd', 'file://a.psd');
      FakeWorker.last.emit({ type: 'progress', decoded: 3, total: 48 });

      expect(svc.progress()).toBe(3);
      expect(svc.total()).toBe(48);
    });

    it('keeps the known total when a later message omits it', () => {
      svc.load(new Uint8Array(8), 'a.psd', 'file://a.psd');
      FakeWorker.last.emit({ type: 'progress', decoded: 3, total: 48 });
      FakeWorker.last.emit({ type: 'progress', decoded: 4, total: 0 });

      expect(svc.progress()).toBe(4);
      expect(svc.total()).toBe(48);
    });

    it('does not settle the promise on progress', async () => {
      let settled = false;
      const promise = svc.load(new Uint8Array(8), 'a.psd', 'file://a.psd');
      promise.then(() => { settled = true; });

      FakeWorker.last.emit({ type: 'progress', decoded: 1, total: 2 });
      await Promise.resolve();

      expect(settled).toBe(false);
      expect(FakeWorker.last.terminated).toBe(0);
    });
  });

  describe('the four ways a decode ends', () => {
    it('resolves with the project and terminates on done', async () => {
      const project = makeProject([{}]);
      const promise = svc.load(new Uint8Array(8), 'a.psd', 'file://a.psd');
      FakeWorker.last.emit({ type: 'done', project });

      const result: any = await promise;
      expect(result.ok).toBe(true);
      expect(result.project).toBe(project);
      expect(FakeWorker.last.terminated).toBe(1);
    });

    it('resolves as a decode failure, distinct from a guard refusal', async () => {
      const promise = svc.load(new Uint8Array(8), 'a.psd', 'file://a.psd');
      FakeWorker.last.emit({ type: 'error', message: 'not a PSD' });

      const result: any = await promise;
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('decode');
      expect(result.message).toBe('not a PSD');
      expect(FakeWorker.last.terminated).toBe(1);
    });

    it('resolves when the worker script itself errors', async () => {
      const promise = svc.load(new Uint8Array(8), 'a.psd', 'file://a.psd');
      FakeWorker.last.fail('boom');

      const result: any = await promise;
      expect(result).toEqual({ ok: false, reason: 'decode', message: 'boom' });
    });

    it('names the failure when the error event carries no message', async () => {
      const promise = svc.load(new Uint8Array(8), 'a.psd', 'file://a.psd');
      FakeWorker.last.fail('');

      const result: any = await promise;
      expect(result.message).toBe('Decode worker failed');
    });

    /**
     * A worker killed mid-decode — the out-of-memory failure this whole
     * pipeline exists to avoid — often raises no `error` event at all. Without
     * this the promise never settles and the screen hangs on "reading…".
     */
    it('resolves when the worker is killed and only messageerror fires', async () => {
      const promise = svc.load(new Uint8Array(8), 'a.psd', 'file://a.psd');
      FakeWorker.last.garble();

      const result: any = await promise;
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('decode');
      expect(result.message).toContain('stopped responding');
      expect(FakeWorker.last.terminated).toBe(1);
    });
  });
});
