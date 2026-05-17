import { useControls } from 'leva';
import * as THREE from 'three';
import {
  compressionBlendModeIndex,
  type CompressionBlendMode,
} from './compressionExperiment';
import { tileShaderUniforms } from './tileShaderRuntime';

function vec3ToColor(v: THREE.Vector3): string {
  return `#${new THREE.Color(v.x, v.y, v.z).getHexString()}`;
}

function setVec3FromColor(v: THREE.Vector3, hex: string): void {
  const c = new THREE.Color(hex);
  v.set(c.r, c.g, c.b);
}

const blendModeOptions = Object.keys(compressionBlendModeIndex) as CompressionBlendMode[];

function blendModeFromUniform(): CompressionBlendMode {
  const idx = tileShaderUniforms.compressionBlendMode?.value ?? 0;
  return blendModeOptions.find((m) => compressionBlendModeIndex[m] === idx) ?? 'mix';
}

/**
 * Leva panel for shared terrain shader uniforms (live, no recompile).
 */
export function TileShaderControls({
  compressionShaderOn = false,
}: {
  compressionShaderOn?: boolean;
}) {
  const u = tileShaderUniforms;
  const contourEmissive = u.contourEmissive.value;
  const majorContourEmissive = u.majorContourEmissive.value;

  useControls('Terrain shader', {
    contourSpeed: {
      value: u.contourSpeed.value,
      min: 0,
      max: 20,
      step: 0.1,
      onChange: (v: number) => {
        u.contourSpeed.value = v;
      },
    },
    contourInterval: {
      value: u.contourInterval.value,
      min: 0.5,
      max: 50,
      step: 0.5,
      onChange: (v: number) => {
        u.contourInterval.value = v;
      },
    },
    majorContourInterval: {
      value: u.majorContourInterval.value,
      min: 1,
      max: 100,
      step: 0.5,
      onChange: (v: number) => {
        u.majorContourInterval.value = v;
      },
    },
    contourStrength: {
      value: u.contourStrength.value,
      min: 0,
      max: 1,
      step: 0.01,
      onChange: (v: number) => {
        u.contourStrength.value = v;
      },
    },
    heightEmissiveScale: {
      value: u.heightEmissiveScale.value,
      min: 0,
      max: 0.01,
      step: 0.0001,
      label: 'height emissive',
      onChange: (v: number) => {
        u.heightEmissiveScale.value = v;
      },
    },
    lodSat: {
      value: u.lodSat.value,
      min: 0,
      max: 1,
      step: 0.01,
      onChange: (v: number) => {
        u.lodSat.value = v;
      },
    },
    lodVal: {
      value: u.lodVal.value,
      min: 0,
      max: 1,
      step: 0.01,
      onChange: (v: number) => {
        u.lodVal.value = v;
      },
    },
    contourEmissive: {
      value: vec3ToColor(contourEmissive),
      onChange: (hex: string) => {
        setVec3FromColor(contourEmissive, hex);
      },
    },
    majorContourEmissive: {
      value: vec3ToColor(majorContourEmissive),
      onChange: (hex: string) => {
        setVec3FromColor(majorContourEmissive, hex);
      },
    },
  });

  useControls(
    'Compression blend',
    compressionShaderOn
      ? {
          heightBlend: {
            value: u.heightBlend?.value ?? 0,
            min: 0,
            max: 1,
            step: 0.01,
            label: 'blend toward lossy',
            onChange: (v: number) => {
              if (u.heightBlend) u.heightBlend.value = v;
            },
          },
          blendMode: {
            value: blendModeFromUniform(),
            options: blendModeOptions,
            onChange: (mode: CompressionBlendMode) => {
              if (u.compressionBlendMode) {
                u.compressionBlendMode.value = compressionBlendModeIndex[mode];
              }
            },
          },
          waveAmp: {
            value: u.compressionWaveAmp?.value ?? 1,
            min: 0,
            max: 2,
            step: 0.05,
            onChange: (v: number) => {
              if (u.compressionWaveAmp) u.compressionWaveAmp.value = v;
            },
          },
          waveFreq: {
            value: u.compressionWaveFreq?.value ?? 12,
            min: 0.5,
            max: 80,
            step: 0.5,
            onChange: (v: number) => {
              if (u.compressionWaveFreq) u.compressionWaveFreq.value = v;
            },
          },
          waveSpeed: {
            value: u.compressionWaveSpeed?.value ?? 0.5,
            min: 0,
            max: 5,
            step: 0.05,
            onChange: (v: number) => {
              if (u.compressionWaveSpeed) u.compressionWaveSpeed.value = v;
            },
          },
          deltaScale: {
            value: u.compressionDeltaScale?.value ?? 80,
            min: 0,
            max: 500,
            step: 1,
            label: 'delta emissive',
            onChange: (v: number) => {
              if (u.compressionDeltaScale) u.compressionDeltaScale.value = v;
            },
          },
          heightGain: {
            value: u.compressionHeightGain?.value ?? 1,
            min: 1,
            max: 50,
            step: 0.5,
            label: 'height exaggeration',
            onChange: (v: number) => {
              if (u.compressionHeightGain) u.compressionHeightGain.value = v;
            },
          },
        }
      : {
          hint: {
            value: 'Enable experiment in Leva → Compression',
            editable: false,
          },
        },
    { collapsed: true },
    [compressionShaderOn],
  );

  return null;
}
