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

/** Vertical error in physical units, scaled to stay readable across the range. */
export function formatMetres(metres: number): string {
  if (!Number.isFinite(metres)) return '—';
  const abs = Math.abs(metres);
  if (abs < 0.01) return `${(metres * 1000).toFixed(2)} mm`;
  if (abs < 1) return `${(metres * 100).toFixed(2)} cm`;
  return `${metres.toFixed(3)} m`;
}

export type RawErrorStats = {
  readonly rmseRaw: number;
  readonly meanAbsRaw: number;
  readonly maxAbsRaw: number;
};

export type MetreErrorStats = {
  readonly rmseMetres: number;
  readonly meanAbsMetres: number;
  readonly maxAbsMetres: number;
};

/**
 * Convert recode error from raw uint16 sample counts to metres.
 *
 * A v2 pyramid chunk stores height as `offset + scale * sample`, so `scale` is
 * exactly the metres-per-sample factor. Only applies to tiles decoded through
 * the plain uint16 path — the /ttile/ DTM path reports error in metres already.
 */
export function metreErrorFromRawSamples(
  stats: RawErrorStats,
  metresPerSample: number | undefined,
): MetreErrorStats | undefined {
  if (metresPerSample === undefined) return undefined;
  if (!Number.isFinite(metresPerSample) || metresPerSample <= 0) return undefined;
  return {
    rmseMetres: stats.rmseRaw * metresPerSample,
    meanAbsMetres: stats.meanAbsRaw * metresPerSample,
    maxAbsMetres: stats.maxAbsRaw * metresPerSample,
  };
}
