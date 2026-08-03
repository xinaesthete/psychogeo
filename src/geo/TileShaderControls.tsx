import { folder, useControls } from 'leva';
import type { Schema } from 'leva/plugin';
import * as THREE from 'three';
import {
  CONTOUR_SET_COUNT,
  CONTOUR_SET_DEFAULTS,
  readContourColour,
  readContourNumber,
  writeContourNumber,
} from './contourSets';
import { tileShaderUniforms } from './tileShaderRuntime';

function vec3ToColor(v: THREE.Vector3): string {
  return `#${new THREE.Color(v.x, v.y, v.z).getHexString()}`;
}

function setVec3FromColor(v: THREE.Vector3, hex: string): void {
  const c = new THREE.Color(hex);
  v.set(c.r, c.g, c.b);
}

type SliderSpec = { key: string; label: string; min: number; max: number; step: number };

/**
 * Per-set contour controls. Every set is independent: give two of them
 * different speeds and they slide through each other, which is the interference
 * look rather than a fault to be locked out.
 */
const CONTOUR_SLIDERS: SliderSpec[] = [
  { key: 'contourGain', label: 'gain', min: 0, max: 2, step: 0.01 },
  // 0 is a meaningful interval — one line, at the anchor.
  { key: 'contourInterval', label: 'interval (m)', min: 0, max: 200, step: 0.5 },
  { key: 'contourAnchor', label: 'anchor (m)', min: -100, max: 1400, step: 0.5 },
  { key: 'contourSpeed', label: 'speed (m/s)', min: -20, max: 20, step: 0.1 },
  { key: 'contourWidthPx', label: 'width (px)', min: 0, max: 12, step: 0.1 },
  { key: 'contourFalloff', label: 'falloff (m)', min: 0, max: 100, step: 0.5 },
  // Two ends of the same thing: lines too crowded to separate, and lines whose
  // own position the height field cannot pin down.
  { key: 'contourFadeCrowded', label: 'fade crowded', min: 0, max: 1, step: 0.01 },
  { key: 'contourFadeFlat', label: 'fade flat', min: 0, max: 1, step: 0.01 },
];

function contourSetSchema(index: number): Schema {
  const u = tileShaderUniforms;
  const schema: Schema = {};
  // Leva needs keys unique across the whole store, folders included, so the
  // set index goes in the key and the readable name in the label.
  for (const spec of CONTOUR_SLIDERS) {
    schema[`${spec.key}${index}`] = {
      value: readContourNumber(u, spec.key, index),
      label: spec.label,
      min: spec.min,
      max: spec.max,
      step: spec.step,
      onChange: (v: number) => {
        writeContourNumber(u, spec.key, index, v);
      },
    };
  }
  schema[`contourFollowPick${index}`] = {
    value: readContourNumber(u, 'contourFollowPick', index) > 0,
    label: 'follow pick',
    onChange: (v: boolean) => {
      writeContourNumber(u, 'contourFollowPick', index, v ? 1 : 0);
    },
  };
  const colour = readContourColour(u, index);
  if (colour) {
    schema[`contourEmissive${index}`] = {
      value: vec3ToColor(colour),
      label: 'colour',
      onChange: (hex: string) => {
        setVec3FromColor(colour, hex);
      },
    };
  }
  return schema;
}

function contourSchema(): Schema {
  const u = tileShaderUniforms;
  const schema: Schema = {
    contourStrength: {
      value: u.contourStrength.value,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'strength (all)',
      onChange: (v: number) => {
        u.contourStrength.value = v;
      },
    },
  };
  for (let i = 0; i < CONTOUR_SET_COUNT; i++) {
    const label = CONTOUR_SET_DEFAULTS[i]?.label ?? `set ${i}`;
    schema[`${i} ${label}`] = folder(contourSetSchema(i), { collapsed: i > 1 });
  }
  return schema;
}

/**
 * Leva panel for shared terrain shader uniforms (live, no recompile).
 */
export function TileShaderControls() {
  const u = tileShaderUniforms;

  useControls('Terrain shader', {
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
  });

  useControls('Contours', contourSchema);

  return null;
}
