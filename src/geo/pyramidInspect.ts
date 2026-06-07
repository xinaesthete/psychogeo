import * as THREE from 'three';
import { chunkKey } from './pyramidCatalog';
import type { ChunkFetchDescriptor } from './pyramidTypes';
import type { RasterChannelState, TileNode } from './tileLayerTypes';

export const PRIMARY_HEIGHT_CHANNEL_ID = 'height.primary';

export type PyramidInspectableNode = TileNode & {
  readonly sceneInspectObject: THREE.Mesh;
  descriptorSnapshot(): ChunkFetchDescriptor;
};

export const inspectBoundsMaterial = new THREE.MeshBasicMaterial({
  wireframe: true,
  transparent: true,
  opacity: 0.55,
  color: 0x44ff88,
  depthWrite: false,
});

export const selectedInspectBoundsMaterial = new THREE.MeshBasicMaterial({
  wireframe: true,
  transparent: true,
  opacity: 0.95,
  color: 0xffcc44,
  depthWrite: false,
});

/** Invisible solid box used for shift+click picking when wireframes are hidden. */
export const inspectPickMaterial = new THREE.MeshBasicMaterial({
  transparent: true,
  opacity: 0,
  depthWrite: false,
});

const scratchNdc = new THREE.Vector2();
const scratchRaycaster = new THREE.Raycaster();

export function pickInspectTileKey(params: {
  camera: THREE.Camera;
  dom: HTMLElement;
  clientX: number;
  clientY: number;
  targets: readonly THREE.Object3D[];
}): string | null {
  const { camera, dom, clientX, clientY, targets } = params;
  if (targets.length === 0) return null;
  const rect = dom.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  scratchNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  scratchNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  scratchRaycaster.setFromCamera(scratchNdc, camera);
  const hits = scratchRaycaster.intersectObjects(targets as THREE.Object3D[], false);
  for (const hit of hits) {
    const key = hit.object.userData.chunkKey;
    if (typeof key === 'string') return key;
  }
  return null;
}

export function buildTileLabelLines(node: PyramidInspectableNode): string[] {
  const descriptor = node.descriptorSnapshot();
  const channelState = node.channels.get(PRIMARY_HEIGHT_CHANNEL_ID);
  const status = channelState?.status ?? 'missing';
  return [
    `L${descriptor.level} ${descriptor.gridRef}`,
    `${status} · geoLod ${node.visibility.lodLevel}${node.visibility.inFrustum ? '' : ' · culled'}`,
    `@${descriptor.eastMin}, ${descriptor.northMin}`,
  ];
}

export function createTileLabelSprite(lines: readonly string[]): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false }));
  }

  const fontSize = 22;
  const lineHeight = 26;
  const padding = 10;
  ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const width = Math.max(...lines.map((line) => ctx.measureText(line).width)) + padding * 2;
  const height = lines.length * lineHeight + padding * 2;
  canvas.width = Math.ceil(width);
  canvas.height = Math.ceil(height);

  ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.fillStyle = 'rgba(8, 12, 18, 0.82)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(68, 255, 136, 0.85)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
  ctx.fillStyle = '#e8f6ee';
  lines.forEach((line, index) => {
    ctx.fillText(line, padding, padding + fontSize + index * lineHeight);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 9000;
  sprite.userData.labelCanvas = canvas;
  sprite.userData.labelTexture = texture;
  return sprite;
}

export function disposeTileLabelSprite(sprite: THREE.Sprite): void {
  const texture = sprite.userData.labelTexture;
  if (texture instanceof THREE.Texture) {
    texture.dispose();
  }
  const material = sprite.material;
  if (!Array.isArray(material)) {
    material.dispose();
  }
}

export function shortPayloadUrl(url: string): string {
  const slash = url.lastIndexOf('/');
  const tail = slash >= 0 ? url.slice(slash + 1) : url;
  return tail.length > 48 ? `${tail.slice(0, 45)}…` : tail;
}

export function formatPyramidTileNodeName(
  descriptor: ChunkFetchDescriptor,
  channelStatus: RasterChannelState['status'] | 'missing' = 'missing',
  inFrustum = false,
): string {
  const key = chunkKey(descriptor);
  const cull = inFrustum ? '' : ' cull';
  return `[L${descriptor.level}] ${descriptor.gridRef} @${descriptor.eastMin},${descriptor.northMin}${cull} | ${channelStatus} | ${shortPayloadUrl(descriptor.url)} [${key}]`;
}

export function attachPyramidTileDebugHooks(
  node: PyramidInspectableNode,
  descriptor: ChunkFetchDescriptor,
): void {
  const key = chunkKey(descriptor);
  node.userData.chunkKey = key;
  node.userData.gridRef = descriptor.gridRef;
  node.userData.descriptor = descriptor;
  node.sceneInspectObject.userData.chunkKey = key;
  node.sceneInspectObject.userData.inspectPickTarget = true;
  node.userData.syncDebugLabel = () => {
    syncPyramidTileNodeLabels(node);
    if ('updateLabel' in node && typeof node.updateLabel === 'function') {
      node.updateLabel();
    }
  };
  syncPyramidTileNodeLabels(node);
}

export function syncPyramidTileNodeLabels(node: PyramidInspectableNode): void {
  const descriptor = node.descriptorSnapshot();
  const channelState = node.channels.get(PRIMARY_HEIGHT_CHANNEL_ID);
  const status = channelState?.status ?? 'missing';
  const label = formatPyramidTileNodeName(descriptor, status, node.visibility.inFrustum);
  node.name = label;

  const placeholder = node.userData.placeholder;
  if (placeholder instanceof THREE.Object3D) {
    placeholder.name = `placeholder ${label}`;
  }

  node.sceneInspectObject.name = `inspect-bounds ${label}`;

  const geoLod = node.userData.geoLod;
  if (geoLod instanceof THREE.Object3D) {
    geoLod.name = `GeoLodMesh ${label}`;
  }
}

export function tileMatchesQuery(node: TileNode, query: string): boolean {
  const q = query.toLowerCase();
  const chunkKeyValue = node.userData.chunkKey;
  if (typeof chunkKeyValue === 'string' && chunkKeyValue === query) {
    return true;
  }
  const descriptor = node.userData.descriptor;
  if (
    descriptor &&
    typeof descriptor === 'object' &&
    'gridRef' in descriptor &&
    typeof descriptor.gridRef === 'string' &&
    descriptor.gridRef.toLowerCase().includes(q)
  ) {
    return true;
  }
  const payloadUrl = node.userData.payloadUrl;
  if (typeof payloadUrl === 'string' && payloadUrl.toLowerCase().includes(q)) {
    return true;
  }
  return node.name.toLowerCase().includes(q);
}
