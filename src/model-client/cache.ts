/**
 * Content-hash cache for semantic responses.
 *
 * The key is a hash of everything that can change the answer: evaluator id, prompt version,
 * model id, and the exact request payload. A change to any of those misses the cache, which is
 * what makes cached runs reproducible rather than merely fast.
 */
export interface SemanticCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  readonly size: number;
  readonly hits: number;
  readonly misses: number;
}

export class MemorySemanticCache<T> implements SemanticCache<T> {
  readonly #map = new Map<string, T>();
  readonly #maxEntries: number;
  #hits = 0;
  #misses = 0;

  constructor(maxEntries = 2000) {
    this.#maxEntries = maxEntries;
  }

  get(key: string): T | undefined {
    const value = this.#map.get(key);
    if (value === undefined) {
      this.#misses += 1;
      return undefined;
    }
    this.#hits += 1;
    // Refresh insertion order so eviction is least-recently-used.
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }

  set(key: string, value: T): void {
    if (this.#map.has(key)) this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.#maxEntries) {
      const oldest = this.#map.keys().next();
      if (oldest.done === true) break;
      this.#map.delete(oldest.value);
    }
  }

  get size(): number {
    return this.#map.size;
  }

  get hits(): number {
    return this.#hits;
  }

  get misses(): number {
    return this.#misses;
  }
}

/** A cache that stores nothing. Used when caching is disabled. */
export class NullSemanticCache<T> implements SemanticCache<T> {
  get(_key: string): T | undefined {
    return undefined;
  }
  set(_key: string, _value: T): void {
    // intentionally empty
  }
  readonly size = 0;
  readonly hits = 0;
  #misses = 0;
  get misses(): number {
    return this.#misses;
  }
}
