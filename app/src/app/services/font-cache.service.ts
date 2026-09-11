import { Injectable, signal } from '@angular/core';

/**
 * Font files synced from Photoshop, kept on this device.
 *
 * The user asked for this so a second session does not send the same fonts
 * again. It is a CACHE: IndexedDB can be cleared by the OS under storage
 * pressure, and every failure here is a cache miss, never an exception --
 * the fonts simply get requested again.
 *
 * Metadata and bytes are separate stores, so listing what is cached (and how
 * big it is) never loads 150 MB of fonts into memory to answer.
 *
 * Only synced fonts come here. Hand-picked files still leave with the tab --
 * that is `FontsService`'s recorded decision, and changing it is left open in
 * docs/superpowers/specs/2026-09-11-font-sync-design.md.
 */
export interface FontMeta {
  name: string;
  fileName: string;
  size: number;
  usedAt: number;
}

export interface FontCacheBackend {
  list(): Promise<FontMeta[]>;
  read(name: string): Promise<ArrayBuffer | null>;
  /** Writes the metadata, and the bytes when given. */
  write(meta: FontMeta, bytes?: ArrayBuffer): Promise<void>;
  remove(name: string): Promise<void>;
  clear(): Promise<void>;
}

export interface CachedFont {
  name: string;
  fileName: string;
  bytes: ArrayBuffer;
}

export const FONT_CACHE_CAP_BYTES = 150 * 1024 * 1024;

@Injectable({ providedIn: 'root' })
export class FontCacheService {
  /** IndexedDB where there is one; memory otherwise (tests, and very old WebViews). */
  backend: FontCacheBackend = typeof indexedDB === 'undefined' ? memoryFontBackend() : indexedDbFontBackend();
  cap = FONT_CACHE_CAP_BYTES;
  now = () => Date.now();

  /** Bytes held. Updated on every write, and by `refresh()` when a screen opens. */
  readonly totalBytes = signal(0);

  /** The cached fonts among `names`. Each one returned counts as a use, for eviction. */
  async get(names: string[]): Promise<CachedFont[]> {
    try {
      const wanted = new Set(names);
      const out: CachedFont[] = [];
      for (const meta of (await this.backend.list()).filter((m) => wanted.has(m.name))) {
        const bytes = await this.backend.read(meta.name);
        if (!bytes) continue;
        await this.backend.write({ ...meta, usedAt: this.now() });
        out.push({ name: meta.name, fileName: meta.fileName, bytes });
      }
      return out;
    } catch {
      return [];
    }
  }

  /** @returns false when the file was not kept -- too big for the cache, or the store failed */
  async put(name: string, fileName: string, bytes: ArrayBuffer): Promise<boolean> {
    if (bytes.byteLength > this.cap) return false;
    try {
      await this.backend.write({ name, fileName, size: bytes.byteLength, usedAt: this.now() }, bytes);
      await this.evict();
      return true;
    } catch {
      return false;
    }
  }

  async clear(): Promise<void> {
    try { await this.backend.clear(); } catch { /* nothing left to clear */ }
    this.totalBytes.set(0);
  }

  async refresh(): Promise<void> {
    try {
      const all = await this.backend.list();
      this.totalBytes.set(all.reduce((sum, m) => sum + m.size, 0));
    } catch {
      this.totalBytes.set(0);
    }
  }

  /** Least recently used first, until what is left fits. */
  private async evict(): Promise<void> {
    const all = (await this.backend.list()).sort((a, b) => a.usedAt - b.usedAt);
    let total = all.reduce((sum, m) => sum + m.size, 0);
    for (const meta of all) {
      if (total <= this.cap) break;
      await this.backend.remove(meta.name);
      total -= meta.size;
    }
    this.totalBytes.set(total);
  }
}

export function memoryFontBackend(): FontCacheBackend {
  const metas = new Map<string, FontMeta>();
  const blobs = new Map<string, ArrayBuffer>();
  return {
    list: async () => [...metas.values()].map((m) => ({ ...m })),
    read: async (name) => blobs.get(name) ?? null,
    write: async (meta, bytes) => {
      metas.set(meta.name, { ...meta });
      if (bytes) blobs.set(meta.name, bytes);
    },
    remove: async (name) => { metas.delete(name); blobs.delete(name); },
    clear: async () => { metas.clear(); blobs.clear(); },
  };
}

function indexedDbFontBackend(): FontCacheBackend {
  let db: Promise<IDBDatabase> | null = null;
  const open = () => (db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('psd-sync-fonts', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('meta', { keyPath: 'name' });
      req.result.createObjectStore('bytes');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { db = null; reject(req.error); };
  }));

  /** One transaction over both stores; resolves with `req`'s result once it commits. */
  const tx = <T>(mode: IDBTransactionMode, body: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> =>
    open().then((d) => new Promise<T | undefined>((resolve, reject) => {
      const t = d.transaction(['meta', 'bytes'], mode);
      const req = body(t);
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));

  return {
    list: async () => (await tx<FontMeta[]>('readonly', (t) => t.objectStore('meta').getAll())) ?? [],
    read: async (name) => (await tx<ArrayBuffer>('readonly', (t) => t.objectStore('bytes').get(name))) ?? null,
    write: async (meta, bytes) => {
      await tx('readwrite', (t) => {
        t.objectStore('meta').put(meta);
        if (bytes) t.objectStore('bytes').put(bytes, meta.name);
      });
    },
    remove: async (name) => {
      await tx('readwrite', (t) => { t.objectStore('meta').delete(name); t.objectStore('bytes').delete(name); });
    },
    clear: async () => {
      await tx('readwrite', (t) => { t.objectStore('meta').clear(); t.objectStore('bytes').clear(); });
    },
  };
}
