import { describe, expect, it } from 'vitest';
import { formatMetres, metreErrorFromRawSamples } from './compressionFormat';

const raw = { rmseRaw: 10, meanAbsRaw: 4, maxAbsRaw: 250 };

describe('metreErrorFromRawSamples', () => {
  it('scales raw uint16 sample error by metres per sample', () => {
    // A v2 chunk spanning 65.536 m encodes at 0.001 m per sample.
    const metres = metreErrorFromRawSamples(raw, 0.001);
    expect(metres?.rmseMetres).toBeCloseTo(0.01, 12);
    expect(metres?.meanAbsMetres).toBeCloseTo(0.004, 12);
    expect(metres?.maxAbsMetres).toBeCloseTo(0.25, 12);
  });

  it('agrees with the chunk height span over the 16-bit range', () => {
    // encoding.scale is metres per sample, so span = scale * 65536; a full
    // scale error must come back as the whole span.
    const scale = 0.0032;
    const span = scale * 65536;
    const metres = metreErrorFromRawSamples({ rmseRaw: 65536, meanAbsRaw: 0, maxAbsRaw: 0 }, scale);
    expect(metres?.rmseMetres).toBeCloseTo(span, 9);
  });

  it('returns undefined when the tile declares no scale', () => {
    expect(metreErrorFromRawSamples(raw, undefined)).toBeUndefined();
  });

  it('rejects a nonsensical scale rather than reporting zero error', () => {
    expect(metreErrorFromRawSamples(raw, 0)).toBeUndefined();
    expect(metreErrorFromRawSamples(raw, -1)).toBeUndefined();
    expect(metreErrorFromRawSamples(raw, Number.NaN)).toBeUndefined();
    expect(metreErrorFromRawSamples(raw, Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe('formatMetres', () => {
  it('picks a readable unit for the magnitude', () => {
    expect(formatMetres(0.0004)).toBe('0.40 mm');
    expect(formatMetres(0.052)).toBe('5.20 cm');
    expect(formatMetres(2.5)).toBe('2.500 m');
  });

  it('handles non-finite input', () => {
    expect(formatMetres(Number.NaN)).toBe('—');
  });
});
