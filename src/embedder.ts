/**
 * Optional embedding support.
 *
 * The core package never performs network calls. An `Embedder` is injected by
 * the host (a local model, a remote API, anything) and is used purely as an
 * *additional* retrieval signal on top of SQLite FTS5 lexical search.
 */
export interface Embedder {
  /** Stable identifier for the model, persisted alongside each vector. */
  readonly id: string;
  /** Vector length, when known and fixed. */
  readonly dimensions?: number;
  /** Embed a batch of texts. Must return one vector per input text. */
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface HashEmbedderOptions {
  /** Model identifier stored with vectors. Defaults to "hash-embedder-v1". */
  id?: string;
  /** Vector length. Defaults to 256. */
  dimensions?: number;
}

/**
 * A deterministic, dependency-free, fully local embedder.
 *
 * It hashes tokens into a fixed-width signed bag-of-words vector and L2
 * normalizes the result. It is not a semantic model — it is a stand-in that
 * exercises the embedding code path (and gives tests something deterministic)
 * without any network access. Swap in a real `Embedder` for production.
 */
export class HashEmbedder implements Embedder {
  readonly id: string;
  readonly dimensions: number;

  constructor(options: HashEmbedderOptions = {}) {
    this.dimensions = Math.max(8, Math.floor(options.dimensions ?? 256));
    this.id = options.id ?? `hash-embedder-v1:${this.dimensions}`;
  }

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return texts.map((text) => this.embedOne(text));
  }

  embedOne(text: string): number[] {
    const vector = new Float32Array(this.dimensions);
    for (const token of tokenize(text)) {
      const hash = hash32(token);
      const index = hash % this.dimensions;
      const sign = (hash & 0x80000000) === 0 ? 1 : -1;
      vector[index] = (vector[index] ?? 0) + sign;
    }
    normalize(vector);
    return Array.from(vector);
  }
}

export interface FunctionEmbedderOptions {
  id?: string;
  dimensions?: number;
}

/** Wrap a plain `(text) => vector` function as an `Embedder`. */
export function embedderFromFunction(
  fn: (text: string) => number[] | Promise<number[]>,
  options: FunctionEmbedderOptions = {},
): Embedder {
  return {
    id: options.id ?? "custom-embedder",
    dimensions: options.dimensions,
    async embed(texts) {
      const out: number[][] = [];
      for (const text of texts) {
        out.push(await fn(text));
      }
      return out;
    },
  };
}

/** Cosine similarity in [-1, 1]; returns 0 for zero-length vectors. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalize(vector: Float32Array): void {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) {
    const v = vector[i] ?? 0;
    sum += v * v;
  }
  if (sum === 0) return;
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < vector.length; i += 1) {
    vector[i] = (vector[i] ?? 0) * inv;
  }
}
