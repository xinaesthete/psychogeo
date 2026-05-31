import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_VIEWSHED_SHADOW_MAP_SIZE,
  DEFAULT_VIEWSHED_SHADOW_NEAR,
  DEFAULT_VIEWSHED_SHADOW_RADIUS,
  resolveViewshedShadowConfig,
  viewshedAwareLodDistance,
} from './viewshedConfig';

test('resolveViewshedShadowConfig returns viewshed defaults', () => {
  assert.deepEqual(resolveViewshedShadowConfig(), {
    radius: DEFAULT_VIEWSHED_SHADOW_RADIUS,
    mapSize: DEFAULT_VIEWSHED_SHADOW_MAP_SIZE,
    near: DEFAULT_VIEWSHED_SHADOW_NEAR,
  });
});

test('resolveViewshedShadowConfig clamps unsafe shadow values', () => {
  assert.deepEqual(
    resolveViewshedShadowConfig({ radius: 1, mapSize: 32, near: 100 }),
    {
      radius: 10,
      mapSize: 256,
      near: 5,
    },
  );
});

test('viewshedAwareLodDistance uses the more detailed observer distance inside radius', () => {
  assert.equal(viewshedAwareLodDistance(5000, 120, 1000), 120);
});

test('viewshedAwareLodDistance ignores the observer outside radius', () => {
  assert.equal(viewshedAwareLodDistance(5000, 1200, 1000), 5000);
});
