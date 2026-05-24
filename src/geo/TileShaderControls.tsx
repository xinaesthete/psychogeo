import { useControls } from 'leva';
import * as THREE from 'three';
import { tileShaderUniforms } from './tileShaderRuntime';

function vec3ToColor(v: THREE.Vector3): string {
  return `#${new THREE.Color(v.x, v.y, v.z).getHexString()}`;
}

function setVec3FromColor(v: THREE.Vector3, hex: string): void {
  const c = new THREE.Color(hex);
  v.set(c.r, c.g, c.b);
}

/**
 * Leva panel for shared terrain shader uniforms (live, no recompile).
 */
export function TileShaderControls() {
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

  return null;
}
