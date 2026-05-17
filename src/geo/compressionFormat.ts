/** Human-readable byte sizes for compression analysis UI. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

export function formatQuality(q: number): string {
  if (q === 0) return '0';
  if (q >= 10) return q.toFixed(1);
  if (q >= 1) return q.toFixed(2);
  if (q >= 0.001) return q.toFixed(4);
  return q.toExponential(2);
}

export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export function formatNormHeight(n: number): string {
  return `${(n * 100).toFixed(4)}% of 16-bit range`;
}
