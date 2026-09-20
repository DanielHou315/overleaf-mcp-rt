/**
 * Small seeded PRNG for randomized tests (mulberry32). Returns an integer in [0, n).
 *
 * Do not swap this for a one-line LCG: `(seed * 1103515245 + 12345) & 0x7fffffff`
 * overflows double precision in JavaScript, which zeroes the low bits — `% 2` and
 * `% 4` then return 0 almost every time, and a "randomized interleaving" test
 * quietly stops interleaving. That is how this file came to exist.
 */
export function prng(seed: number): (n: number) => number {
  let a = seed | 0
  return (n: number) => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) % n
  }
}
