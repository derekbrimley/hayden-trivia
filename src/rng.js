/**
 * Tiny seeded RNG so that a given seed always produces the same question deck.
 * Deterministic decks make the generator testable and let the host "reroll"
 * a single question by simply advancing the seed.
 */

/** mulberry32: fast, good-enough 32-bit PRNG. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Turn any string or number into a 32-bit seed. */
export function hashSeed(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value) >>> 0;
  const str = String(value ?? '');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A small helper API around a seeded stream of randomness. */
export function makeRng(seed) {
  const next = mulberry32(hashSeed(seed));
  const int = (n) => Math.floor(next() * n);
  const pick = (list) => list[int(list.length)];
  const shuffle = (list) => {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const sample = (list, n) => shuffle(list).slice(0, n);
  return { next, int, pick, shuffle, sample };
}
