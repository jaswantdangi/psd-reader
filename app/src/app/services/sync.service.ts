import { Injectable, computed, inject, signal } from '@angular/core';
import { ProjectService } from './project.service';
import { matchLayers } from '@engine/sync/identity.js';
import { errorFrame, parseMessage, translateEvent } from '@engine/sync/protocol.js';

/**
 * The app half of Photoshop sync.
 *
 * The relay routes frames and the UXP plugin sends them; this is what receives
 * them. Sync moves EVENTS, NOT DOCUMENTS — both sides open the same file
 * independently, so nothing here ever transfers a PSD.
 *
 * The order is fixed and the whole design rests on it:
 *
 *   hello(app) -> pair(code) -> [person types the code into Photoshop]
 *   -> paired -> tree -> matchLayers, pinned -> event, event, event…
 *
 * An `event` that arrives before a `tree` is REFUSED, not queued and not
 * applied. Without a mapping "layer 7 moved" names nothing, and the failure
 * mode of guessing is the one the identity model exists to prevent: a real
 * change applied to the wrong layer, which reads as the app corrupting the
 * user's document.
 */

/**
 * The engine is plain JavaScript, so TypeScript reads its JSDoc as the
 * signature, and two of them do not narrow:
 *
 * - `parseMessage`'s failure branch infers as `ok: boolean` rather than
 *   `ok: false`, so `ok` is not a discriminant and neither branch narrows.
 * - `translateEvent`'s refusal carries `change` and `layerID`, which its
 *   `@returns` tag does not list — the refusal is spread from `refuse(...)`.
 *
 * Re-stating both ONCE here beats an `any` at every call site. It is the same
 * trade `ProjectService` makes for `setLayer`, for the same reason, and this
 * is the only place in `app/` that knows about the discrepancy.
 */
type ParsedFrame =
  | { ok: true; message: any }
  | { ok: false; error: { code: string; message: string } };
const parseFrame = parseMessage as unknown as (text: string) => ParsedFrame;

type Translated =
  | { ok: true; command: any }
  | { ok: false; reason: string; requiresPixels: boolean; change?: string; layerID?: number | string | null };
const translate = translateEvent as unknown as (event: any, mapping: any, options?: any) => Translated;

export type SyncStatus = 'idle' | 'connecting' | 'waiting' | 'paired' | 'live' | 'failed';

/** The minimum of `WebSocket` this service uses, so a test can supply one. */
export interface SyncSocket {
  send(data: string): void;
  close(): void;
  onopen: ((this: any, ev: any) => any) | null;
  onmessage: ((this: any, ev: { data: any }) => any) | null;
  onclose: ((this: any, ev: any) => any) | null;
  onerror: ((this: any, ev: any) => any) | null;
}

export interface RefusedEvent {
  reason: string;
  change: string | null;
  layerID: number | string | null;
}

export interface UnmatchedLayer {
  side: string;
  name: string;
  kind: string;
  reason: string;
}

const APP_VERSION = '1.0.0';

@Injectable({ providedIn: 'root' })
export class SyncService {
  private projects = inject(ProjectService);

  /**
   * How a socket is made. Overridden in tests — jsdom's `WebSocket` would need
   * a real server, and a real server in a unit test buys nothing here: the
   * relay's own suite already drives a real one on a real port.
   */
  socketFactory: (url: string) => SyncSocket = (url) => new WebSocket(url) as unknown as SyncSocket;

  readonly status = signal<SyncStatus>('idle');
  /** The six-character code, shown to the person so they can type it into Photoshop. */
  readonly code = signal<string | null>(null);
  readonly message = signal('');

  /** What `matchLayers` reconciled, pinned at pairing and never recomputed. */
  readonly matched = signal(0);
  readonly unmatched = signal<UnmatchedLayer[]>([]);
  /** Set when Photoshop's document does not look like the one that is open here. */
  readonly documentMismatch = signal<string | null>(null);

  readonly applied = signal(0);
  readonly refused = signal<RefusedEvent[]>([]);

  readonly connected = computed(() => {
    const s = this.status();
    return s === 'waiting' || s === 'paired' || s === 'live';
  });

  private socket: SyncSocket | null = null;
  /** The pinned mapping. Null until a `tree` has been reconciled. */
  private mapping: any = null;

  // ------------------------------------------------------------- lifecycle

  connect(url: string): void {
    if (this.socket) return;
    this.reset();
    this.status.set('connecting');
    this.message.set('Connecting to the relay…');

    const socket = this.socketFactory(url);
    this.socket = socket;

    socket.onopen = () => {
      this.send({ type: 'hello', role: 'app', version: APP_VERSION });
    };
    socket.onmessage = (ev) => this.receive(String(ev.data));
    socket.onclose = () => {
      // Only meaningful if we did not close it ourselves — `disconnect` clears
      // `this.socket` first, so this cannot fight with a deliberate teardown.
      if (this.socket === socket) this.finish('idle', 'Disconnected.');
    };
    socket.onerror = () => {
      if (this.socket === socket) this.finish('failed', 'Could not reach the relay.');
    };
  }

  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close();
    this.finish('idle', '');
  }

  private finish(status: SyncStatus, message: string): void {
    this.socket = null;
    this.mapping = null;
    this.code.set(null);
    this.status.set(status);
    this.message.set(message);
  }

  private reset(): void {
    this.mapping = null;
    this.code.set(null);
    this.matched.set(0);
    this.unmatched.set([]);
    this.documentMismatch.set(null);
    this.applied.set(0);
    this.refused.set([]);
  }

  private send(frame: any): void {
    this.socket?.send(JSON.stringify(frame));
  }

  // ---------------------------------------------------------------- frames

  /**
   * One inbound frame.
   *
   * Parsed through the ENGINE's `parseMessage`, not `JSON.parse`, so the app
   * sees only fields the protocol declares. Anything the far side invented is
   * gone before it reaches this file.
   */
  private receive(text: string): void {
    const parsed = parseFrame(text);
    if (!parsed.ok) {
      // Not fatal. A frame we cannot read is the relay's or the plugin's
      // problem to fix, and dropping the session over one would lose the rest.
      this.sendRefusal(parsed.error.code, parsed.error.message);
      return;
    }

    const frame = parsed.message;
    if (frame.type === 'pair') return this.onPair(frame);
    if (frame.type === 'paired') return this.onPaired();
    if (frame.type === 'tree') return this.onTree(frame);
    if (frame.type === 'event') return this.onEvent(frame);
    if (frame.type === 'error') return this.onError(frame);
  }

  private onPair(frame: any): void {
    this.code.set(frame.code);
    this.status.set('waiting');
    this.message.set('Type this code into the Photoshop panel.');
  }

  private onPaired(): void {
    this.status.set('paired');
    this.message.set('Paired. Waiting for Photoshop to send its layers…');
  }

  /**
   * Reconcile once, and pin it.
   *
   * `matchLayers` is deliberately not re-run per event. Photoshop's layer ids
   * are stable for the session, and re-matching against a document the events
   * have already changed would move the mapping under its own feet.
   */
  private onTree(frame: any): void {
    const project = this.projects.project();
    if (!project) {
      this.sendRefusal('no-document', 'no document is open in the app');
      this.message.set('Photoshop sent its layers, but no file is open here.');
      return;
    }

    this.documentMismatch.set(this.mismatchAgainst(frame.document, project));

    const result = matchLayers(frame.layers, project.layers);
    this.mapping = result;
    this.matched.set(result.matched.length);
    this.unmatched.set(result.unmatched.map((u: any) => ({
      side: u.side,
      name: u.name,
      kind: u.kind,
      reason: u.reason,
    })));

    this.status.set('live');
    this.message.set(`Live — ${result.matched.length} of ${frame.layers.length} layers matched.`);
  }

  /**
   * Do the two sides have the same file open?
   *
   * Nothing enforces it, because nothing can: sync never transfers a document,
   * so this is the only evidence there is. A mismatch is not made fatal —
   * a wrong file matches nothing, so it is already self-limiting — but it has
   * to be SAID, or "0 of 12 matched" reads as a broken matcher rather than as
   * the wrong file being open.
   */
  private mismatchAgainst(document: any, project: any): string | null {
    if (document.width !== project.width || document.height !== project.height) {
      return `Photoshop has ${document.name} at ${document.width}x${document.height};`
        + ` this is ${project.width}x${project.height}. That is probably a different file.`;
    }
    return null;
  }

  private onEvent(frame: any): void {
    if (!this.mapping) {
      // The ordering rule, enforced. Queuing these instead would mean applying
      // them against a mapping that did not exist when they were sent.
      this.note({ reason: 'not-reconciled', change: frame.change, layerID: frame.layerID ?? null });
      this.sendRefusal('not-reconciled', 'send the layer tree before events');
      return;
    }

    const project = this.projects.project();
    if (!project) {
      this.note({ reason: 'no-document', change: frame.change, layerID: frame.layerID ?? null });
      return;
    }

    const order = project.layers.map((l: any) => l.id);
    const result = translate(frame, this.mapping, { order });

    if (!result.ok) {
      this.note({ reason: result.reason, change: result.change ?? frame.change, layerID: result.layerID ?? null });
      // Told back to Photoshop, which is why `error` is the one frame the relay
      // routes BOTH ways. A change the app silently dropped is worse than one
      // the panel can show as not applied.
      this.sendRefusal(result.reason, `${frame.change} was not applied: ${result.reason}`);
      return;
    }

    if (this.apply(result.command)) this.applied.update((n) => n + 1);
    else this.note({ reason: 'not-applied', change: frame.change, layerID: frame.layerID ?? null });
  }

  private onError(frame: any): void {
    // The relay's own refusals — `rate-limited`, `no-such-code`, `session-cap`
    // — are all things the person at the keyboard can act on, so they are shown
    // rather than swallowed.
    this.status.set('failed');
    this.message.set(`${frame.message} (${frame.code})`);
  }

  // --------------------------------------------------------------- applying

  /**
   * Run one translated command.
   *
   * Every branch goes through `ProjectService`, never the engine directly:
   * that service is where every mutation in the app funnels so the signals
   * move with it, and a second path around it would update the document
   * without updating the screen.
   */
  private apply(command: any): boolean {
    switch (command.type) {
      case 'set':
        this.projects.setLayer(command.id, command.to);
        return true;
      case 'reorder':
        this.projects.reorder(command.from, command.to);
        return true;
      case 'remove':
        return this.projects.removeLayer(command.id);
      case 'frame':
        this.projects.setFrame(command.to);
        return true;
      default:
        return false;
    }
  }

  private note(entry: RefusedEvent): void {
    this.refused.update((list) => [...list, entry]);
  }

  private sendRefusal(code: string, message: string): void {
    this.send(errorFrame(code, message));
  }
}
