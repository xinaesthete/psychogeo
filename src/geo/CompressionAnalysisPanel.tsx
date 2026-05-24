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
  compressionBlendModeIndex,
  compressionBlendModes,
  type CompressionBlendMode,
  formatCompressionLoadStatus,
  getLossyCompressionRatio,
  setLossyCompressionRatio,
  startLossyRecode,
  syncCompressionExperiment,
  useCompressionLoadStatus,
  useCompressionRecodeReport,
} from './compressionExperiment';
import {
  formatBytes,
  formatNormHeight,
  formatPercent,
  formatQuality,
} from './compressionFormat';
import { tileShaderUniforms } from './tileShaderRuntime';
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

function blendModeFromUniform(): CompressionBlendMode {
  const idx = tileShaderUniforms.compressionBlendMode?.value ?? 0;
  return compressionBlendModes.find((m) => compressionBlendModeIndex[m] === idx) ?? 'mix';
}

function parseCompressionBlendMode(value: string): CompressionBlendMode {
  return compressionBlendModes.find((m) => m === value) ?? 'mix';
}

function uniformNumber(name: string, fallback: number): number {
  const value = tileShaderUniforms[name]?.value;
  return typeof value === 'number' ? value : fallback;
}

function setUniformNumber(name: string, value: number): void {
  const uniform = tileShaderUniforms[name];
  if (uniform) uniform.value = value;
}

export function CompressionAnalysisPanel({
  enabled,
  onEnabledChange,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const loadStatus = useCompressionLoadStatus();
  const report = useCompressionRecodeReport();

  const [quality, setQuality] = useState(() => getLossyCompressionRatio());
  const [qualitySlider, setQualitySlider] = useState(() => sliderFromQuality(getLossyCompressionRatio()));
  const [qualityText, setQualityText] = useState(() => formatQuality(getLossyCompressionRatio()));
  const [heightBlend, setHeightBlend] = useState(() => uniformNumber('heightBlend', 0));
  const [blendMode, setBlendMode] = useState<CompressionBlendMode>(() => blendModeFromUniform());
  const [waveAmp, setWaveAmp] = useState(() => uniformNumber('compressionWaveAmp', 1));
  const [waveFreq, setWaveFreq] = useState(() => uniformNumber('compressionWaveFreq', 12));
  const [waveSpeed, setWaveSpeed] = useState(() => uniformNumber('compressionWaveSpeed', 0.5));
  const [deltaScale, setDeltaScale] = useState(() => uniformNumber('compressionDeltaScale', 80));
  const [heightGain, setHeightGain] = useState(() => uniformNumber('compressionHeightGain', 1));

  const setEnabled = useCallback((next: boolean) => {
    onEnabledChange(next);
    syncCompressionExperiment(next);
    if (next) startLossyRecode();
  }, [onEnabledChange]);

  const updateQualityState = useCallback((q: number) => {
    const clamped = clampLossyQuality(q);
    setQuality(clamped);
    setQualitySlider(sliderFromQuality(clamped));
    setQualityText(formatQuality(clamped));
    setLossyCompressionRatio(clamped);
    return clamped;
  }, []);

  const applyQuality = useCallback((q: number) => {
    updateQualityState(q);
    if (enabled) startLossyRecode();
  }, [enabled, updateQualityState]);

  const previewQuality = useCallback((q: number) => {
    updateQualityState(q);
  }, [updateQualityState]);

  const commitCurrentQuality = useCallback(() => {
    if (enabled) startLossyRecode();
  }, [enabled]);

  const updateHeightBlend = useCallback((value: number) => {
    setHeightBlend(value);
    setUniformNumber('heightBlend', value);
  }, []);

  const updateBlendMode = useCallback((mode: CompressionBlendMode) => {
    setBlendMode(mode);
    setUniformNumber('compressionBlendMode', compressionBlendModeIndex[mode]);
  }, []);

  const updateWaveAmp = useCallback((value: number) => {
    setWaveAmp(value);
    setUniformNumber('compressionWaveAmp', value);
  }, []);

  const updateWaveFreq = useCallback((value: number) => {
    setWaveFreq(value);
    setUniformNumber('compressionWaveFreq', value);
  }, []);

  const updateWaveSpeed = useCallback((value: number) => {
    setWaveSpeed(value);
    setUniformNumber('compressionWaveSpeed', value);
  }, []);

  const updateDeltaScale = useCallback((value: number) => {
    setDeltaScale(value);
    setUniformNumber('compressionDeltaScale', value);
  }, []);

  const updateHeightGain = useCallback((value: number) => {
    setHeightGain(value);
    setUniformNumber('compressionHeightGain', value);
  }, []);

  const onQualitySlider = useCallback(
    (slider: number) => {
      previewQuality(qualityFromSlider(slider));
    },
    [previewQuality],
  );

  const commitQualityText = useCallback(() => {
    const parsed = Number.parseFloat(qualityText);
    if (Number.isFinite(parsed)) {
      applyQuality(parsed);
    } else {
      setQualityText(formatQuality(quality));
    }
  }, [applyQuality, quality, qualityText]);

  useEffect(() => {
    if (loadStatus.recodePhase === 'running' || loadStatus.recodePhase === 'done') {
      setQuality(getLossyCompressionRatio());
      setHeightBlend(uniformNumber('heightBlend', 0));
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
        <div className="CompressionAnalysisPanel-headerTop">
          <h2 className="CompressionAnalysisPanel-title">Compression analysis</h2>
          <label className="CompressionAnalysisPanel-switch">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enabled
          </label>
        </div>
        <span className="CompressionAnalysisPanel-meta">{statusLine}</span>
      </header>

      {enabled && (
        <>
          <p className="CompressionAnalysisPanel-lead">
            Runtime HTJ2K recode for DEFRA height tiles (DSM and 10m DTM). <em>q</em>=0 is near-lossless; higher{' '}
            <em>q</em> → smaller files and more height error — compare against full decode for morphology experiments.
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
                onPointerUp={commitCurrentQuality}
                onKeyUp={(e) => {
                  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
                    commitCurrentQuality();
                  }
                }}
                onBlur={commitCurrentQuality}
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
          </fieldset>

          <fieldset className="CompressionAnalysisPanel-fieldset">
            <legend>Blend</legend>
            <label className="CompressionAnalysisPanel-label">
              Mode
              <select
                className="CompressionAnalysisPanel-select"
                value={blendMode}
                onChange={(e) => updateBlendMode(parseCompressionBlendMode(e.target.value))}
              >
                {compressionBlendModes.map((mode) => (
                  <option key={mode} value={mode}>{mode}</option>
                ))}
              </select>
            </label>
            <label className="CompressionAnalysisPanel-label">
              Blend toward lossy
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={heightBlend}
                onChange={(e) => updateHeightBlend(Number(e.target.value))}
              />
            </label>
            <label className="CompressionAnalysisPanel-label">
              Wave amplitude
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={waveAmp}
                onChange={(e) => updateWaveAmp(Number(e.target.value))}
              />
            </label>
            <label className="CompressionAnalysisPanel-label">
              Wave frequency
              <input
                type="range"
                min={0.5}
                max={80}
                step={0.5}
                value={waveFreq}
                onChange={(e) => updateWaveFreq(Number(e.target.value))}
              />
            </label>
            <label className="CompressionAnalysisPanel-label">
              Wave speed
              <input
                type="range"
                min={0}
                max={5}
                step={0.05}
                value={waveSpeed}
                onChange={(e) => updateWaveSpeed(Number(e.target.value))}
              />
            </label>
            <label className="CompressionAnalysisPanel-label">
              Delta emissive
              <input
                type="range"
                min={0}
                max={500}
                step={1}
                value={deltaScale}
                onChange={(e) => updateDeltaScale(Number(e.target.value))}
              />
            </label>
            <label className="CompressionAnalysisPanel-label">
              Height exaggeration
              <input
                type="range"
                min={1}
                max={50}
                step={0.5}
                value={heightGain}
                onChange={(e) => updateHeightGain(Number(e.target.value))}
              />
            </label>
          </fieldset>
        </>
      )}

      {enabled && report.tileCount > 0 && (
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
