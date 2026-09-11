import { TestBed } from '@angular/core/testing';
import { FontCacheService, memoryFontBackend, type FontCacheBackend } from './font-cache.service';

/**
 * Fonts synced from Photoshop, kept on this device.
 *
 * Run against the in-memory backend: this environment has no IndexedDB, and
 * the service's own rules -- which names come back, what gets evicted, what a
 * broken store costs -- are the same whichever backend holds the bytes.
 */
const bytes = (n: number) => new Uint8Array(n).buffer;

describe('FontCacheService', () => {
  let cache: FontCacheService;
  let clock = 0;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    cache = TestBed.inject(FontCacheService);
    cache.backend = memoryFontBackend();
    clock = 0;
    cache.now = () => ++clock;
  });

  it('gives back what it was given, for the names asked', async () => {
    await cache.put('A-Regular', 'A-Regular.otf', bytes(10));
    await cache.put('B-Bold', 'B-Bold.otf', bytes(20));
    const hits = await cache.get(['A-Regular', 'Nope']);
    expect(hits.map((h) => [h.name, h.fileName, h.bytes.byteLength])).toEqual([['A-Regular', 'A-Regular.otf', 10]]);
    expect(cache.totalBytes()).toBe(30);
  });

  it('evicts the least recently USED font once over the cap', async () => {
    cache.cap = 100;
    await cache.put('a', 'a.ttf', bytes(60));
    await cache.put('b', 'b.ttf', bytes(30));
    await cache.get(['a']);
    await cache.put('c', 'c.ttf', bytes(30));
    expect((await cache.get(['a', 'b', 'c'])).map((h) => h.name).sort()).toEqual(['a', 'c']);
    expect(cache.totalBytes()).toBe(90);
  });

  it('does not keep a file bigger than the whole cache', async () => {
    cache.cap = 100;
    expect(await cache.put('huge', 'huge.ttf', bytes(101))).toBe(false);
    expect(await cache.get(['huge'])).toEqual([]);
  });

  it('forgets everything on clear', async () => {
    await cache.put('a', 'a.ttf', bytes(10));
    await cache.clear();
    expect(await cache.get(['a'])).toEqual([]);
    expect(cache.totalBytes()).toBe(0);
  });

  it('a broken store costs a cache miss, never an exception', async () => {
    const fail = () => Promise.reject(new Error('quota'));
    const broken: FontCacheBackend = { list: fail, read: fail, write: fail, remove: fail, clear: fail };
    cache.backend = broken;
    expect(await cache.get(['a'])).toEqual([]);
    expect(await cache.put('a', 'a.ttf', bytes(1))).toBe(false);
  });
});
