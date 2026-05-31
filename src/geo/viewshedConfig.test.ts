import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_VIEWSHED_EFFECTIVE_EARTH_RADIUS,
  DEFAULT_VIEWSHED_REFRACTION_FACTOR,
  DEFAULT_VIEWSHED_SHADOW_MAP_SIZE,
  DEFAULT_VIEWSHED_SHADOW_NEAR_SCALE,
  DEFAULT_VIEWSHED_SHADOW_RADIUS,
  DEFAULT_VIEWSHED_SOURCE_HEIGHT,
  resolveViewshedGeoidProjectionConfig,
  resolveViewshedShadowConfig,
  viewshedAwareLodDistance,
} from './viewshedConfig';

test('resolveViewshedShadowConfig returns viewshed defaults', () => {
  assert.deepEqual(resolveViewshedShadowConfig(), {
    radius: DEFAULT_VIEWSHED_SHADOW_RADIUS,
    mapSize: DEFAULT_VIEWSHED_SHADOW_MAP_SIZE,
    near: DEFAULT_VIEWSHED_SOURCE_HEIGHT * DEFAULT_VIEWSHED_SHADOW_NEAR_SCALE,
    nearScale: DEFAULT_VIEWSHED_SHADOW_NEAR_SCALE,
  });
});

test('resolveViewshedShadowConfig derives near from source height and scale', () => {
  assert.deepEqual(
    resolveViewshedShadowConfig({ sourceHeight: 3, nearScale: 0.75 }),
    {
      radius: DEFAULT_VIEWSHED_SHADOW_RADIUS,
      mapSize: DEFAULT_VIEWSHED_SHADOW_MAP_SIZE,
      near: 2.25,
      nearScale: 0.75,
    },
  );
});

test('resolveViewshedShadowConfig clamps unsafe shadow values', () => {
  assert.deepEqual(
    resolveViewshedShadowConfig({ radius: 1, mapSize: 32, near: 100 }),
    {
      radius: 10,
      mapSize: 256,
      near: 5,
      nearScale: DEFAULT_VIEWSHED_SHADOW_NEAR_SCALE,
    },
  );
});

test('resolveViewshedGeoidProjectionConfig returns disabled earth defaults', () => {
  assert.deepEqual(resolveViewshedGeoidProjectionConfig(), {
    enabled: false,
    earthRadius: DEFAULT_VIEWSHED_EFFECTIVE_EARTH_RADIUS,
    refractionFactor: DEFAULT_VIEWSHED_REFRACTION_FACTOR,
    effectiveRadius:
      DEFAULT_VIEWSHED_EFFECTIVE_EARTH_RADIUS *
      DEFAULT_VIEWSHED_REFRACTION_FACTOR,
  });
});

test('resolveViewshedGeoidProjectionConfig clamps unsafe values', () => {
  assert.deepEqual(
    resolveViewshedGeoidProjectionConfig({
      enabled: true,
      effectiveEarthRadius: -1,
      refractionFactor: 0,
    }),
    {
      enabled: true,
      earthRadius: 1000,
      refractionFactor: 0.1,
      effectiveRadius: 100,
    },
  );
});

test('resolveViewshedGeoidProjectionConfig preserves enabled radius inputs', () => {
  assert.deepEqual(
    resolveViewshedGeoidProjectionConfig({
      enabled: true,
      effectiveEarthRadius: 7_000_000,
      refractionFactor: 1.3,
    }),
    {
      enabled: true,
      earthRadius: 7_000_000,
      refractionFactor: 1.3,
      effectiveRadius: 9_100_000,
    },
  );
});

test('viewshedAwareLodDistance uses the more detailed observer distance inside radius', () => {
  assert.equal(viewshedAwareLodDistance(5000, 120, 1000), 120);
});

test('viewshedAwareLodDistance ignores the observer outside radius', () => {
  assert.equal(viewshedAwareLodDistance(5000, 1200, 1000), 5000);
});
