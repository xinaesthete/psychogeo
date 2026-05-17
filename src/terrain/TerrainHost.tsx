/**
 * React shell for a long-lived TerrainRenderer.
 *
 * Render-path evaluation (phase 2):
 * - Threact: one WebGL context, multi-view composite — useful only if we need 2+ 3D panes on one page sharing tiles.
 * - R3F: simpler single-viewport model; shared GL via Canvas `gl` prop is possible but layout/composite is DIY.
 * - Current app uses one full-viewport view; Threact kept as default until WebGPU experiment.
 * - Prefer consolidating controls in mapControls.ts; avoid duplicating init paths.
 */
import { Canvas, useFrame, useGraph, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import {
  configureTerrainZoomLimits,
  enhanceMapStyleControls,
  mapStyleOrbitProps,
  setTerrainCameraTarget,
} from '../camera/mapControls';
import { EastNorth } from '../geo/Coordinates';
import { TerrainOptions, TerrainRenderer } from '../geo/TileLoaderUK';
import { useTerrain } from '../TerrainContext';
import { DomAttributes, Threact } from '../threact/threact';

export type TerrainRenderMode = 'threact' | 'r3f';

const domAttributes: DomAttributes = {
  style: { height: '100%', width: '100%' },
};

function trackSelectionKey(tracks: TerrainOptions['tracks']): string {
  return tracks?.map((t) => t.url).join('|') ?? '';
}

function useTerrainRenderer(coord: EastNorth, options: TerrainOptions) {
  const renderer = useMemo(
    () => new TerrainRenderer(coord, options),
    [coord.east, coord.north],
  );
  const locationKey = `${coord.east},${coord.north}`;
  const tracksKey = trackSelectionKey(options.tracks);

  useEffect(() => {
    renderer.updateOptions(options);
  }, [
    renderer,
    options.defra10mDTMLayer,
    options.defraDSMLayer,
    options.osTerr50Layer,
    options.sun,
    options.camZ,
    options.externalControls,
    tracksKey,
  ]);

  return { renderer, locationKey };
}

function MapStyleOrbitControls({
  coord,
  camZ,
}: {
  coord: EastNorth;
  camZ: number;
}) {
  const ref = useRef<OrbitControlsImpl>(null);
  const { camera, gl } = useThree();
  const enhancedRef = useRef(false);

  useEffect(() => {
    const controls = ref.current;
    if (!controls || !(camera instanceof THREE.PerspectiveCamera) || enhancedRef.current) {
      return;
    }
    enhancedRef.current = true;
    const detach = enhanceMapStyleControls(controls, camera, gl.domElement, camZ);
    return () => {
      enhancedRef.current = false;
      detach();
    };
  }, [camera, gl, camZ]);

  useEffect(() => {
    const controls = ref.current;
    if (!controls || !(camera instanceof THREE.PerspectiveCamera)) return;
    configureTerrainZoomLimits(controls, camZ);
    setTerrainCameraTarget(controls, camera, coord, camZ);
  }, [camera, coord.east, coord.north, camZ]);

  return (
    <OrbitControls
      ref={ref}
      target={[coord.east, coord.north, 0]}
      {...mapStyleOrbitProps}
    />
  );
}

function TerrainR3FScene({
  coord,
  options,
}: {
  coord: EastNorth;
  options: TerrainOptions;
}) {
  const camZ = options.camZ;
  const renderer = useTerrain(coord, { ...options, externalControls: true, camZ });
  useGraph(renderer.scene);
  useLayoutEffect(() => {
    renderer.ensureTerrainInit();
  }, [renderer]);
  const tracksKey = trackSelectionKey(options.tracks);
  useEffect(() => {
    renderer.updateOptions({ ...options, externalControls: true, camZ });
  }, [
    renderer,
    options.defra10mDTMLayer,
    options.defraDSMLayer,
    options.osTerr50Layer,
    options.sun,
    camZ,
    tracksKey,
  ]);
  useFrame(() => {
    renderer.update();
  });
  return (
    <>
      <MapStyleOrbitControls coord={coord} camZ={camZ} />
      <primitive object={renderer.scene} />
    </>
  );
}

function TerrainThreactView({
  coord,
  options,
}: {
  coord: EastNorth;
  options: TerrainOptions;
}) {
  const { renderer, locationKey } = useTerrainRenderer(coord, options);
  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <Threact key={locationKey} gfx={renderer} domAttributes={domAttributes} />
    </div>
  );
}

export function TerrainHost({
  coord,
  options,
  renderMode,
}: {
  coord: EastNorth;
  options: TerrainOptions;
  renderMode: TerrainRenderMode;
}) {
  if (renderMode === 'r3f') {
    return (
      <Canvas camera={{ up: [0, 0, 1] }}>
        <TerrainR3FScene coord={coord} options={options} />
      </Canvas>
    );
  }
  return <TerrainThreactView coord={coord} options={options} />;
}
