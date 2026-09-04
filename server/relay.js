/**
 * The Photoshop -> app relay: pair two sockets, route validated frames between
 * them, and clean up when either one goes away.
 *
 * # What this file is NOT allowed to do
 *
 * **It must never understand a PSD.** Everything that parses, renders or edits
 * a document lives in `src/` and is pinned by the existing suite. This file
 * moves opaque JSON between two sockets. If it ever grows a second
 * implementation of anything in `src/`, that is the defect -- two
 * implementations of one thing is the failure mode this project keeps hitting.
 * The wire format and its validation come from `src/sync/protocol.js`; none of
 * it is restated here.
 *
 * **Nothing at rest.** Frames live in RAM for as long as it takes to write them
 * to the peer. Nothing is written to disk, and no message payload reaches the
 * log -- lifecycle lines carry a session id and byte counts, never content. A
 * breach of this process exposes no user artwork.
 *
 * # Backpressure, which is the only hard part
 *
 * `ws` buffers without bound if you write faster than the peer reads. A browser
 * tab that stops draining its socket would otherwise make this process hold the
 * whole stream on that tab's behalf. So: after every write, if the destination's
 * `bufferedAmount` is past the high water mark, the SOURCE socket is paused --
 * which pauses its TCP socket, closes the receive window, and pushes the
 * backlog back to the sender where it belongs. The send callback resumes it
 * once the buffer drains. Peak memory per session is one chunk, not one stream,
 * which is the same discipline `loadProjectProxy` applies to decoding.
 */
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { parseMessage, errorFrame } from '../src/sync/protocol.js';
import { resolveConfig } from './config.js';
import { createPairingDesk } from './pairing.js';

/** Close codes. 1001 going away, 1008 policy violation. */
const GOING_AWAY = 1001;
const POLICY = 1008;

export function createRelay(options = {}) {
  const { log = (line) => console.log(line), ...rest } = options;
  const config = resolveConfig(rest);

  const desk = createPairingDesk({
    ttlMs: config.pairTtlMs,
    rateLimitMax: config.rateLimitMax,
    rateLimitWindowMs: config.rateLimitWindowMs,
  });

  /** Every live socket, paired or not. */
  const connections = new Set();
  /** Every live pairing. */
  const sessions = new Set();

  let wss = null;
  let sweeper = null;
  let closed = false;

  // ------------------------------------------------------------- framing

  const isOpen = (conn) => conn.ws.readyState === WebSocket.OPEN;

  /** Send a relay-authored frame. Never echoes anything a peer sent. */
  function tell(conn, frame) {
    if (isOpen(conn)) conn.ws.send(JSON.stringify(frame));
  }

  /**
   * Refuse one frame. The reason travels back to the sender that caused it and
   * nowhere else -- in particular not to the log, because a validation message
   * can quote the bytes that failed.
   */
  function refuse(conn, code, message) {
    tell(conn, errorFrame(code, message));
  }

  // ---------------------------------------------------------- session I/O

  const peerOf = (conn) => (conn.session ? (conn.session.app === conn ? conn.session.plugin : conn.session.app) : null);

  function pauseReader(session, from) {
    if (from.ws.isPaused) return;
    from.ws.pause();
    session.pauses += 1;
    session.senderPaused = true;
  }

  function resumeReader(session, from) {
    if (!from.ws.isPaused) return;
    from.ws.resume();
    session.senderPaused = false;
  }

  /**
   * Move one validated frame to the peer, under both caps and backpressure.
   *
   * The frame written is the one `validateMessage` REBUILT, not the object that
   * arrived, so fields the sender invented never reach the other side.
   */
  function forward(conn, frame) {
    const session = conn.session;
    const to = peerOf(conn);
    if (session.closing) return;
    if (!to || !isOpen(to)) {
      endSession(session, 'peer-gone', 'the paired peer is no longer connected');
      return;
    }

    const text = JSON.stringify(frame);
    const bytes = Buffer.byteLength(text);
    if (session.bytes + bytes > config.maxSessionBytes) {
      endSession(session, 'session-cap', `session byte cap of ${config.maxSessionBytes} reached`, POLICY);
      return;
    }
    session.bytes += bytes;

    to.ws.send(text, (err) => {
      // A failed write means the peer went away; its close handler tears the
      // session down. Resuming here would only read more frames with nowhere
      // to put them.
      if (err || session.closing) return;
      if (to.ws.bufferedAmount <= config.highWaterBytes) resumeReader(session, conn);
    });

    const buffered = to.ws.bufferedAmount;
    if (buffered > session.peakBufferedBytes) session.peakBufferedBytes = buffered;
    if (buffered > config.highWaterBytes) pauseReader(session, conn);
  }

  function createSession(appConn, pluginConn) {
    const session = {
      id: randomUUID(),
      app: appConn,
      plugin: pluginConn,
      bytes: 0,
      framesRead: 0,
      pauses: 0,
      peakBufferedBytes: 0,
      senderPaused: false,
      lastActivity: Date.now(),
      closing: false,
    };
    sessions.add(session);
    appConn.session = session;
    pluginConn.session = session;
    tell(appConn, { type: 'paired', sessionId: session.id, peer: { role: 'plugin', version: pluginConn.version } });
    tell(pluginConn, { type: 'paired', sessionId: session.id, peer: { role: 'app', version: appConn.version } });
    log(`session ${session.id} opened`);
    return session;
  }

  /**
   * Tear a session down, telling whoever is still there why.
   *
   * Idempotent, because it is reached from three directions at once: a socket
   * closing, a cap being hit, and the sweeper.
   */
  function endSession(session, code, message, closeCode = GOING_AWAY) {
    if (session.closing) return;
    session.closing = true;
    sessions.delete(session);
    log(`session ${session.id} closed ${code} frames=${session.framesRead} bytes=${session.bytes} pauses=${session.pauses}`);
    for (const conn of [session.app, session.plugin]) {
      conn.session = null;
      if (conn.ws.isPaused) conn.ws.resume(); // a paused socket cannot flush its own close
      if (isOpen(conn)) {
        tell(conn, errorFrame(code, message));
        conn.ws.close(closeCode, code);
      }
    }
  }

  // ------------------------------------------------------------- handlers

  function onHello(conn, frame) {
    if (conn.role) return refuse(conn, 'unexpected-hello', 'this socket has already introduced itself');
    conn.role = frame.role;
    conn.version = frame.version;
    if (conn.role === 'app') tell(conn, { type: 'pair', code: desk.issue(conn) });
  }

  function onPair(conn, frame) {
    if (conn.role !== 'plugin') return refuse(conn, 'unexpected-pair', 'only a plugin redeems a pairing code');
    if (conn.session) return refuse(conn, 'already-paired', 'this socket is already in a session');
    const result = desk.redeem(frame.code, conn.ip);
    if (!result.ok) return refuse(conn, result.code, result.message);
    const appConn = result.owner;
    if (!isOpen(appConn) || appConn.session) {
      return refuse(conn, 'no-such-code', 'that pairing code is not valid');
    }
    createSession(appConn, conn);
  }

  function onEvent(conn, frame) {
    if (!conn.session) return refuse(conn, 'not-paired', 'pair before sending events');
    // Rescoped: Photoshop is authoritative and events travel one way. An app
    // pushing events back would need conflict resolution that neither side has.
    if (conn.role !== 'plugin') return refuse(conn, 'wrong-direction', 'events travel Photoshop -> app only');
    forward(conn, frame);
  }

  function onError(conn, frame) {
    if (!conn.session) return refuse(conn, 'not-paired', 'pair before reporting errors');
    // Both ways: the app has to be able to say what it could not apply.
    forward(conn, frame);
  }

  function onMessage(conn, data, isBinary) {
    if (isBinary) return refuse(conn, 'binary-refused', 'the relay routes JSON frames only');

    const parsed = parseMessage(data.toString());
    if (!parsed.ok) return refuse(conn, parsed.error.code, parsed.error.message);
    const frame = parsed.message;

    if (conn.session) {
      conn.session.framesRead += 1;
      conn.session.lastActivity = Date.now();
    }

    switch (frame.type) {
      case 'hello': return onHello(conn, frame);
      case 'pair':
        if (!conn.role) {
          refuse(conn, 'expected-hello', 'send hello before pair');
          conn.ws.close(POLICY, 'expected-hello');
          return;
        }
        return onPair(conn, frame);
      case 'event': return onEvent(conn, frame);
      case 'error': return onError(conn, frame);
      default:
        return refuse(conn, 'unexpected-frame', `a client does not send "${frame.type}"`);
    }
  }

  function onClose(conn) {
    connections.delete(conn);
    desk.revokeFor(conn);
    if (conn.session) endSession(conn.session, 'peer-gone', 'the paired peer disconnected');
  }

  function onConnection(ws, req) {
    const conn = { ws, ip: req.socket.remoteAddress ?? 'unknown', role: null, version: null, session: null };
    connections.add(conn);
    ws.on('message', (data, isBinary) => {
      try { onMessage(conn, data, isBinary); }
      catch { refuse(conn, 'internal', 'the relay could not handle that frame'); }
    });
    ws.on('close', () => onClose(conn));
    // Never log a socket error: the message can carry the frame that caused it.
    ws.on('error', () => { try { ws.terminate(); } catch { /* already gone */ } });
  }

  function sweep() {
    desk.sweep();
    const now = Date.now();
    for (const session of [...sessions]) {
      if (now - session.lastActivity > config.sessionTtlMs) {
        endSession(session, 'session-expired', 'the session was idle too long');
      }
    }
  }

  // ---------------------------------------------------------------- public

  function listen() {
    return new Promise((resolve, reject) => {
      wss = new WebSocketServer({
        host: config.host,
        port: config.port,
        // The hard per-message cap. `ws` refuses an oversize frame at the
        // protocol level and closes with 1009, so it is never assembled in RAM.
        maxPayload: config.maxMessageBytes,
        // Compression would buffer per-connection state and give a sender a
        // cheap way to make the relay do expensive work. Off.
        perMessageDeflate: false,
      });
      wss.on('connection', onConnection);
      wss.once('error', reject);
      wss.once('listening', () => {
        wss.removeListener('error', reject);
        wss.on('error', () => {});
        sweeper = setInterval(sweep, config.sweepMs);
        sweeper.unref();
        const { address, port } = wss.address();
        resolve(`ws://${address}:${port}`);
      });
    });
  }

  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    if (sweeper) clearInterval(sweeper);
    for (const session of [...sessions]) endSession(session, 'relay-closing', 'the relay is shutting down');
    for (const conn of [...connections]) { try { conn.ws.terminate(); } catch { /* already gone */ } }
    connections.clear();
    log('relay closed');
    return new Promise((resolve) => { if (wss) wss.close(() => resolve()); else resolve(); });
  }

  /** Counts only. No payloads, no peer identities beyond the session id. */
  function stats() {
    return {
      connections: connections.size,
      pendingCodes: desk.size(),
      sessions: [...sessions].map((s) => ({
        id: s.id,
        framesRead: s.framesRead,
        bytes: s.bytes,
        pauses: s.pauses,
        peakBufferedBytes: s.peakBufferedBytes,
        senderPaused: s.senderPaused,
      })),
    };
  }

  return { config, listen, close, stats };
}
