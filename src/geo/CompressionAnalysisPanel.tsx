import React, { useCallback, useEffect, useState } from 'react';
import {
  clampLossyQuality,
  DEFAULT_LOSSY_COMPRESSION_RATIO,
  MAX_LOSSY_COMPRESSION_RATIO,
  MIN_LOSSY_COMPRESSION_RATIO,
  qualityFromSlider,
  sliderFromQuality,
} from '../openjpegjs/jp2kloader';
import {
  formatCompressionLoadStatus,
  getCompressionLoadStatus,
  getLossyCompressionRatio,
  restartLossyRecodeAfterQualityChange,
  setLossyCompressionRatio,
  startLossyRecode,
  useCompressionLoadStatus,
  useCompressionRecodeReport,
} from './compressionExperiment';
import {
  formatBytes,
  formatNormHeight,
  formatPercent,
  formatQuality,
} from './compressionFormat';
import './CompressionAnalysisPanel.css';

function presetIsActive(current: number, preset: number): boolean {
  const span = MAX_LOSSY_COMPRESSION_RATIO - MIN_LOSSY_COMPRESSION_RATIO;
  const tol = Math.max(span * 0.02, preset === 0 ? 1e-9 : preset * 0.05);
  return Math.abs(current - preset) <= tol;
}

const QUALITY_PRESETS: { label: string; quality: number }[] = [
  { label: 'Lossless', quality: 0 },
  { label: 'Light', quality: 0.01 },
  { label: 'Medium', quality: 0.1 },
  { label: 'High', quality: 0.3 },
  { label: 'Heavy', quality: DEFAULT_LOSSY_COMPRESSION_RATIO },
  { label: 'Max', quality: MAX_LOSSY_COMPRESSION_RATIO },
];

export function CompressionAnalysisPanel() {
  const loadStatus = useCompressionLoadStatus();
  const report = useCompressionRecodeReport();

  const [quality, setQuality] = useState(() => getLossyCompressionRatio());
  const [qualitySlider, setQualitySlider] = useState(() => sliderFromQuality(getLossyCompressionRatio()));
  const [qualityText, setQualityText] = useState(() => formatQuality(getLossyCompressionRatio()));

  const applyQuality = useCallback((q: number) => {
    const clamped = clampLossyQuality(q);
    const prev = getLossyCompressionRatio();
    setQuality(clamped);
    setQualitySlider(sliderFromQuality(clamped));
    setQualityText(formatQuality(clamped));
    setLossyCompressionRatio(clamped);
    const st = getCompressionLoadStatus();
    if (st.shaderEnabled && st.recodePhase !== 'idle' && clamped !== prev) {
      restartLossyRecodeAfterQualityChange();
    }
  }, []);

  const onQualitySlider = useCallback(
    (slider: number) => {
      applyQuality(qualityFromSlider(slider));
    },
    [applyQuality],
  );

  const commitQualityText = useCallback(() => {
    const parsed = Number.parseFloat(qualityText);
    if (Number.isFinite(parsed)) {
      applyQuality(parsed);
    } else {
      setQualityText(formatQuality(quality));
    }
  }, [applyQuality, quality, qualityText]);

  const runRecode = useCallback(() => {
    setLossyCompressionRatio(quality);
    startLossyRecode();
  }, [quality]);

  useEffect(() => {
    if (loadStatus.recodePhase === 'done') {
      setQuality(getLossyCompressionRatio());
    }
  }, [loadStatus.recodePhase, loadStatus.completed]);

  const statusLine = formatCompressionLoadStatus(loadStatus);
  const savings =
    report.totalSourceBytes > 0
      ? 1 - report.aggregateCompressionVsSource
      : 0;

  return (
    <aside className="CompressionAnalysisPanel" aria-label="HTJ2K compression analysis">
      <header className="CompressionAnalysisPanel-header">
        <h2 className="CompressionAnalysisPanel-title">Compression analysis</h2>
        <span className="CompressionAnalysisPanel-meta">{statusLine}</span>
      </header>

      <p className="CompressionAnalysisPanel-lead">
        Runtime HTJ2K recode for DEFRA height tiles (DSM and 10m DTM). <em>q</em>=0 is near-lossless; higher{' '}
        <em>q</em> → smaller
        files and more height error — compare against full decode for morphology experiments.
      </p>

      <fieldset className="CompressionAnalysisPanel-fieldset">
        <legend>HTJ2K quality</legend>
        <p className="CompressionAnalysisPanel-hint">
          Encoder <code>setQuality(false, q)</code> — q=0 ≈ lossless, higher q → more compression (OpenJPH
          practical max ~{formatQuality(MAX_LOSSY_COMPRESSION_RATIO)}).
        </p>

        <div className="CompressionAnalysisPanel-presets" role="group" aria-label="Quality presets">
          {QUALITY_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className={
                presetIsActive(quality, p.quality)
                  ? 'CompressionAnalysisPanel-preset CompressionAnalysisPanel-preset--active'
                  : 'CompressionAnalysisPanel-preset'
              }
              onClick={() => applyQuality(p.quality)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <label className="CompressionAnalysisPanel-label">
          0 (lossless) ←——→ {formatQuality(MAX_LOSSY_COMPRESSION_RATIO)} (max compression)
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={qualitySlider}
            onChange={(e) => onQualitySlider(Number(e.target.value))}
          />
        </label>

        <label className="CompressionAnalysisPanel-label">
          Quality <em>q</em>
          <input
            type="text"
            className="CompressionAnalysisPanel-qualityInput"
            value={qualityText}
            onChange={(e) => setQualityText(e.target.value)}
            onBlur={commitQualityText}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitQualityText();
            }}
          />
        </label>

        <button
          type="button"
          className="CompressionAnalysisPanel-primary"
          disabled={loadStatus.recodePhase === 'running'}
          onClick={runRecode}
        >
          {loadStatus.recodePhase === 'running' ? 'Recoding…' : 'Start recode'}
        </button>
      </fieldset>

      {report.tileCount > 0 && (
        <section className="CompressionAnalysisPanel-stats">
          <h3 className="CompressionAnalysisPanel-statsTitle">Aggregate ({report.tileCount} tiles)</h3>
          <dl className="CompressionAnalysisPanel-dl">
            <div>
              <dt>Quality used</dt>
              <dd>{formatQuality(report.quality)}</dd>
            </div>
            <div>
              <dt>Source JP2 total</dt>
              <dd>{formatBytes(report.totalSourceBytes)}</dd>
            </div>
            <div>
              <dt>Recoded JP2 total</dt>
              <dd>{formatBytes(report.totalEncodedBytes)}</dd>
            </div>
            <div>
              <dt>Size vs source</dt>
              <dd>
                {formatPercent(report.aggregateCompressionVsSource)} of original
                {savings > 0 ? ` (−${formatPercent(savings)} saved)` : ''}
              </dd>
            </div>
            <div>
              <dt>Mean height RMSE</dt>
              <dd title="After decode: full vs recoded-decode, normalized to 16-bit range">
                {formatNormHeight(report.meanRmseNorm)}
              </dd>
            </div>
            <div>
              <dt>Max height |Δ|</dt>
              <dd>{formatNormHeight(report.maxAbsNorm)}</dd>
            </div>
            <div>
              <dt>Identical pixels (mean)</dt>
              <dd>{formatPercent(report.meanIdenticalFraction)}</dd>
            </div>
            {report.failedCount > 0 && (
              <div>
                <dt>Failed tiles</dt>
                <dd>{report.failedCount}</dd>
              </div>
            )}
          </dl>

          <details className="CompressionAnalysisPanel-details">
            <summary>Per-tile breakdown</summary>
            <div className="CompressionAnalysisPanel-tableWrap">
              <table className="CompressionAnalysisPanel-table">
                <thead>
                  <tr>
                    <th scope="col">Tile</th>
                    <th scope="col">Source</th>
                    <th scope="col">Recoded</th>
                    <th scope="col">Ratio</th>
                    <th scope="col">RMSE</th>
                    <th scope="col">Max |Δ|</th>
                  </tr>
                </thead>
                <tbody>
                  {report.tiles.map((t) => (
                    <tr key={t.url}>
                      <td title={t.url}>{t.tileLabel}</td>
                      <td>{formatBytes(t.sourceBytes)}</td>
                      <td>{formatBytes(t.encodedBytes)}</td>
                      <td>{formatPercent(t.compressionVsSource)}</td>
                      <td>{formatNormHeight(t.rmseNorm)}</td>
                      <td>{formatNormHeight(t.maxAbsNorm)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
      )}
    </aside>
  );
}
