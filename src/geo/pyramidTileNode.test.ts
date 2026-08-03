import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PyramidTileNode } from './PyramidTileTree';
import { COVERAGE_MASK_RESOLUTION } from './tileRetention';

const descriptor = {
  gridRef: 'SU40',
  level: 2,
  eastMin: 400_000,
  northMin: 100_000,
  url: 'chunk.j2c',
  encoding: { min: 0, max: 100, scale: 1, offset: 0 },
  width: 312,
  height: 312,
  extentMetres: 10_000,
};

/** Stand-in for the GeoLOD built by buildGeoLodMesh, with its uniform pair. */
function attachMesh(node: PyramidTileNode): {
  coverageMask: THREE.IUniform;
  coverageMaskEnabled: THREE.IUniform;
} {
  const uniforms = {
    coverageMask: { value: 'placeholder' as unknown },
    coverageMaskEnabled: { value: 0 },
  };
  const mesh = new THREE.Object3D();
  mesh.userData.coverageMaskUniforms = uniforms;
  node.userData.geoLod = mesh;
  return uniforms;
}

function fullMask(): Uint8Array {
  const mask = new Uint8Array(COVERAGE_MASK_RESOLUTION * COVERAGE_MASK_RESOLUTION);
  mask.fill(255);
  return mask;
}

describe('PyramidTileNode.setCoverageMask', () => {
  it('binds the mask texture and switches masking on', () => {
    const node = new PyramidTileNode(descriptor as never);
    const uniforms = attachMesh(node);
    node.setCoverageMask(fullMask());
    expect(uniforms.coverageMask.value).toBeInstanceOf(THREE.DataTexture);
    expect(uniforms.coverageMaskEnabled.value).toBe(1);
  });

  it('rebinds after the mesh is rebuilt, not just on first use', () => {
    // A tile off screen long enough to be unloaded gets a fresh mesh — and
    // fresh uniforms pointing at the empty placeholder — when it reloads.
    // Binding only on texture creation left masking switched on while the
    // sampler still read 1x1 zeroes, so the tile drew in full.
    const node = new PyramidTileNode(descriptor as never);
    attachMesh(node);
    node.setCoverageMask(fullMask());

    const rebuilt = attachMesh(node);
    node.setCoverageMask(fullMask());

    expect(rebuilt.coverageMask.value).toBeInstanceOf(THREE.DataTexture);
    expect(rebuilt.coverageMaskEnabled.value).toBe(1);
  });

  it('reuses one texture across rebuilds rather than leaking a new one', () => {
    const node = new PyramidTileNode(descriptor as never);
    const first = attachMesh(node);
    node.setCoverageMask(fullMask());
    const texture = first.coverageMask.value;

    const rebuilt = attachMesh(node);
    node.setCoverageMask(fullMask());
    expect(rebuilt.coverageMask.value).toBe(texture);
  });

  it('carries the mask contents through to the bound texture', () => {
    const node = new PyramidTileNode(descriptor as never);
    const uniforms = attachMesh(node);
    const mask = new Uint8Array(COVERAGE_MASK_RESOLUTION * COVERAGE_MASK_RESOLUTION);
    mask[7] = 255;
    node.setCoverageMask(mask);
    const data = (uniforms.coverageMask.value as THREE.DataTexture).image.data as Uint8Array;
    expect(data[7]).toBe(255);
    expect(data[8]).toBe(0);
  });

  it('switches masking off without disturbing the bound texture', () => {
    const node = new PyramidTileNode(descriptor as never);
    const uniforms = attachMesh(node);
    node.setCoverageMask(fullMask());
    const texture = uniforms.coverageMask.value;
    node.setCoverageMask(null);
    expect(uniforms.coverageMaskEnabled.value).toBe(0);
    expect(uniforms.coverageMask.value).toBe(texture);
  });
});
