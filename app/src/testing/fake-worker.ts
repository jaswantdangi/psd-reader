/**
 * A stand-in for `Worker`, because jsdom has none.
 *
 * The services under test own a worker's LIFETIME and its message protocol —
 * which messages they send, which replies they act on, and when they call
 * `terminate()`. That is the whole of their behaviour, and all of it is
 * observable from this side of the boundary. What runs INSIDE the worker is the
 * engine, which its own suite covers in Node.
 *
 * Deliberately not a spy on a real Worker: `terminate()` is the app's only real
 * cancellation (see `psd-export.worker.ts`), so a test has to be able to prove
 * it happened AND that nothing arriving afterwards is still acted on.
 */
export class FakeWorker {
  static instances: FakeWorker[] = [];

  static get last(): FakeWorker {
    const worker = FakeWorker.instances[FakeWorker.instances.length - 1];
    if (!worker) throw new Error('no worker was constructed');
    return worker;
  }

  static reset(): void {
    FakeWorker.instances = [];
  }

  onmessage: ((event: { data: any }) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onmessageerror: ((event: any) => void) | null = null;

  /** Every payload the service posted, in order. */
  readonly posted: any[] = [];
  /** The transfer list handed with each post, or null. */
  readonly transfers: (any[] | null)[] = [];
  terminated = 0;

  constructor(readonly url: unknown) {
    FakeWorker.instances.push(this);
  }

  postMessage(data: any, transfer?: any[]): void {
    this.posted.push(data);
    this.transfers.push(transfer ?? null);
  }

  terminate(): void {
    this.terminated++;
  }

  addEventListener(): void {}
  removeEventListener(): void {}

  // ---- the worker's side of the conversation ------------------------------

  /** Deliver a message, exactly as the real worker's `postMessage` would. */
  emit(data: any): void {
    this.onmessage?.({ data });
  }

  /** An `error` event: the worker script itself failed. */
  fail(message?: string): void {
    this.onerror?.({ message });
  }

  /** A `messageerror`: a reply that could not be deserialised. */
  garble(): void {
    this.onmessageerror?.({});
  }
}

/**
 * Install `FakeWorker` as the global `Worker` for one test.
 *
 * @returns the restore function; call it in `afterEach`.
 */
export function installFakeWorker(): () => void {
  const scope = globalThis as any;
  const had = 'Worker' in scope;
  const previous = scope.Worker;
  FakeWorker.reset();
  scope.Worker = FakeWorker;
  return () => {
    if (had) scope.Worker = previous;
    else delete scope.Worker;
    FakeWorker.reset();
  };
}
