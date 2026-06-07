import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatDuration,
  formatMetricsSummary,
  ingestMetricsRates,
  type IngestMetrics,
} from './metrics.ts';

describe('metrics', () => {
  it('formats bytes and duration', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KiB');
    expect(formatDuration(500)).toBe('500 ms');
    expect(formatDuration(65000)).toBe('1m 5s');
  });

  it('computes rates and summary', () => {
    const metrics: IngestMetrics = {
      region: { kind: 'grid-ref', gridRef: 'SP51' },
      regionLabel: 'SP51',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:10:00.000Z',
      elapsedMs: 600_000,
      cellCount: 1,
      groupCount: 4,
      leafChunks: 100,
      sourceZipBytes: 40_000_000,
      outputBytes: 8_000_000,
      encodeMs: 500_000,
      mergeMs: 100_000,
      cells: [],
    };
    const rates = ingestMetricsRates(metrics);
    expect(rates.msPerGroup).toBe(150_000);
    expect(rates.outputBytesPerLeafChunk).toBe(80_000);
    expect(formatMetricsSummary(metrics)).toContain('SP51');
    expect(formatMetricsSummary(metrics)).toContain('10m 0s');
  });
});
