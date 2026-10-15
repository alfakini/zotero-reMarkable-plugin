/**
 * A small least-recently-used cache bounded by total weight. Without `weigh`
 * every entry weighs 1, so `maxWeight` is then an entry count. An entry heavier
 * than `maxWeight` is not stored. Zotero-free so Node tests can import it.
 */
export class LruCache<K, V> {
  // A Map iterates in insertion order, so the first key is the least recent.
  private entries = new Map<K, V>();
  private total = 0;

  constructor(
    private maxWeight: number,
    private weigh: (value: V) => number = () => 1,
  ) {}

  /** Number of entries. */
  get size() {
    return this.entries.size;
  }

  /** Sum of the weights of the entries. */
  get weight() {
    return this.total;
  }

  /** The cached value, marking it as most recently used. */
  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V) {
    this.delete(key);
    const w = this.weigh(value);
    if (w > this.maxWeight) return;
    this.entries.set(key, value);
    this.total += w;
    for (const [oldest, old] of this.entries) {
      if (this.total <= this.maxWeight) break;
      this.entries.delete(oldest);
      this.total -= this.weigh(old);
    }
  }

  delete(key: K) {
    if (!this.entries.has(key)) return;
    this.total -= this.weigh(this.entries.get(key) as V);
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
    this.total = 0;
  }
}
