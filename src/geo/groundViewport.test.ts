import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  boundsChangedSignificantly,
  groundViewportBounds,
  snapBoundsToGrid,
  viewportSpanMetres,
} from './groundViewport';

describe('groundViewport', () => {
  it('returns fallback bounds when camera looks parallel to ground', () => {
    const camera = new THREE.PerspectiveCamera(60, 1, 1, 100000);
    camera.position.set(455000, 215000, 500);
    camera.up.set(0, 0, 1);
    camera.lookAt(455000, 215000, 0);
    camera.updateMatrixWorld(true);

    const bounds = groundViewportBounds(camera);
    expect(bounds.eastMax - bounds.eastMin).toBeGreaterThan(0);
    expect(bounds.northMax - bounds.northMin).toBeGreaterThan(0);
    expect(viewportSpanMetres(bounds)).toBeGreaterThan(0);
  });

  it('detects significant bounds change', () => {
    const previous = { eastMin: 450000, eastMax: 460000, northMin: 210000, northMax: 220000 };
    const shifted = { eastMin: 470000, eastMax: 480000, northMin: 210000, northMax: 220000 };
    expect(boundsChangedSignificantly(previous, shifted)).toBe(true);
    expect(boundsChangedSignificantly(previous, previous)).toBe(false);
  });

  it('snaps bounds to chunk grid', () => {
    const snapped = snapBoundsToGrid(
      { eastMin: 455150, eastMax: 456050, northMin: 215120, northMax: 215880 },
      1000,
    );
    expect(snapped).toEqual({
      eastMin: 455000,
      eastMax: 457000,
      northMin: 215000,
      northMax: 216000,
    });
  });

  it('intersects frustum corners to ground plane when elevated', () => {
    const camera = new THREE.PerspectiveCamera(60, 1, 1, 100000);
    camera.position.set(455000, 215000, 8000);
    camera.up.set(0, 0, 1);
    camera.lookAt(455000, 215000, 0);
    camera.updateMatrixWorld(true);

    const bounds = groundViewportBounds(camera);
    expect(bounds.eastMin).toBeLessThan(455000);
    expect(bounds.eastMax).toBeGreaterThan(455000);
    expect(bounds.northMin).toBeLessThan(215000);
    expect(bounds.northMax).toBeGreaterThan(215000);
  });

  it('extends bounds toward the horizon when the camera is pitched low', () => {
    const camera = new THREE.PerspectiveCamera(60, 1.6, 1, 100000);
    camera.position.set(455000, 215000, 500);
    camera.up.set(0, 0, 1);
    camera.lookAt(455000, 225000, 0);
    camera.updateMatrixWorld(true);

    const bounds = groundViewportBounds(camera);
    expect(bounds.northMax).toBeGreaterThan(camera.position.y);
    expect(viewportSpanMetres(bounds)).toBeGreaterThan(1000);
  });

  it('keeps a wider span for oblique views than a nearby nadir strip', () => {
    const oblique = new THREE.PerspectiveCamera(60, 1.6, 1, 100000);
    oblique.position.set(455000, 215000, 500);
    oblique.up.set(0, 0, 1);
    oblique.lookAt(455000, 225000, 0);
    oblique.updateMatrixWorld(true);

    const nadir = new THREE.PerspectiveCamera(60, 1.6, 1, 100000);
    nadir.position.set(455000, 215000, 500);
    nadir.up.set(0, 0, 1);
    nadir.lookAt(455000, 215000, 0);
    nadir.updateMatrixWorld(true);

    const obliqueSpan = viewportSpanMetres(groundViewportBounds(oblique));
    const nadirSpan = viewportSpanMetres(groundViewportBounds(nadir));
    expect(obliqueSpan).toBeGreaterThan(nadirSpan * 0.5);
  });
});
