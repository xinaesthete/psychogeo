export type TimingSnapshot = {
  readonly count: number;
  readonly meanMs: number;
  readonly minMs: number;
  readonly maxMs: number;
};

/**
 * Rolling aggregate for timing samples.
 *
 * Keeps no per-sample history: the obvious `times.push(ms)` plus
 * `Math.min(...times)` on every sample is quadratic in work and spreads an
 * ever-growing array, which overflows the stack somewhere around a hundred
 * thousand samples — reachable in one session at this tile count.
 */
export class TimingStats {
  private samples = 0;
  private totalMs = 0;
  private smallestMs = Infinity;
  private largestMs = 0;

  record(ms: number): void {
    if (!Number.isFinite(ms)) return;
    this.samples += 1;
    this.totalMs += ms;
    if (ms < this.smallestMs) this.smallestMs = ms;
    if (ms > this.largestMs) this.largestMs = ms;
  }

  snapshot(): TimingSnapshot {
    return {
      count: this.samples,
      meanMs: this.samples > 0 ? this.totalMs / this.samples : 0,
      minMs: this.samples > 0 ? this.smallestMs : 0,
      maxMs: this.largestMs,
    };
  }

  reset(): void {
    this.samples = 0;
    this.totalMs = 0;
    this.smallestMs = Infinity;
    this.largestMs = 0;
  }

  toString(): string {
    const s = this.snapshot();
    if (s.count === 0) return 'no samples';
    return `n=${s.count} mean=${s.meanMs.toFixed(1)}ms min=${s.minMs}ms max=${s.maxMs}ms`;
  }
}
