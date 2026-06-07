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
});
