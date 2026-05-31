import * as THREE from 'three';

type HiddenObject = {
  object: THREE.Object3D;
  visible: boolean;
};

type SwappedMesh = {
  mesh: THREE.Mesh;
  material: THREE.Material | THREE.Material[];
};

const pickTarget = new THREE.WebGLRenderTarget(1, 1, {
  depthBuffer: true,
  format: THREE.RGBAFormat,
  magFilter: THREE.NearestFilter,
  minFilter: THREE.NearestFilter,
  stencilBuffer: false,
  type: THREE.FloatType,
});
pickTarget.texture.name = 'terrain-world-pick';

const pickPixel = new Float32Array(4);
const pickCamera = new THREE.PerspectiveCamera();
const pickOrigin = new THREE.Vector3();
const pickedWorld = new THREE.Vector3();
const previousClearColor = new THREE.Color();
const previousViewport = new THREE.Vector4();
const previousScissor = new THREE.Vector4();

export function createGeometryWorldPickMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      pickOrigin: { value: new THREE.Vector3() },
    },
    side: THREE.DoubleSide,
    vertexShader: `
      varying vec3 vPickWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vPickWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform vec3 pickOrigin;
      varying vec3 vPickWorld;
      void main() {
        gl_FragColor = vec4(vPickWorld - pickOrigin, 1.0);
      }
    `,
  });
}

function terrainPickMaterial(mesh: THREE.Mesh): THREE.ShaderMaterial | null {
  const material = mesh.userData.terrainPickMaterial;
  return material instanceof THREE.ShaderMaterial ? material : null;
}

function setPickOrigin(material: THREE.ShaderMaterial, origin: THREE.Vector3): void {
  const uniform = material.uniforms.pickOrigin;
  if (uniform?.value instanceof THREE.Vector3) {
    uniform.value.copy(origin);
  }
}

function prepareSceneForTerrainPick(
  scene: THREE.Scene,
  roots: THREE.Object3D[],
): { hidden: HiddenObject[]; swapped: SwappedMesh[] } {
  const candidates = new Set<THREE.Mesh>();
  for (const root of roots) {
    if (!root.visible) continue;
    root.traverse((object) => {
      if (object instanceof THREE.Mesh && object.visible) {
        candidates.add(object);
      }
    });
  }

  const hidden: HiddenObject[] = [];
  const swapped: SwappedMesh[] = [];

  scene.traverse((object) => {
    if (!object.visible) return;
    if (!(object instanceof THREE.Mesh)) {
      if (
        object instanceof THREE.Line ||
        object instanceof THREE.Points ||
        object instanceof THREE.Sprite
      ) {
        hidden.push({ object, visible: object.visible });
        object.visible = false;
      }
      return;
    }
    const material = terrainPickMaterial(object);
    if (!candidates.has(object) || !material) {
      hidden.push({ object, visible: object.visible });
      object.visible = false;
      return;
    }
    setPickOrigin(material, pickOrigin);
    swapped.push({ mesh: object, material: object.material });
    object.material = material;
  });

  return { hidden, swapped };
}

function restoreSceneAfterTerrainPick(
  hidden: HiddenObject[],
  swapped: SwappedMesh[],
): void {
  for (const entry of swapped) {
    entry.mesh.material = entry.material;
  }
  for (const entry of hidden) {
    entry.object.visible = entry.visible;
  }
}

export function pickTerrainWorldAtClient(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  domElement: HTMLElement,
  roots: THREE.Object3D[],
  clientX: number,
  clientY: number,
): THREE.Vector3 | null {
  const rect = domElement.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  if (
    clientX < rect.left ||
    clientX > rect.right ||
    clientY < rect.top ||
    clientY > rect.bottom
  ) {
    return null;
  }

  const x = Math.min(
    rect.width - 1,
    Math.max(0, Math.floor(clientX - rect.left)),
  );
  const y = Math.min(
    rect.height - 1,
    Math.max(0, Math.floor(clientY - rect.top)),
  );

  pickCamera.copy(camera);
  pickCamera.setViewOffset(rect.width, rect.height, x, y, 1, 1);
  pickCamera.updateProjectionMatrix();
  pickCamera.updateMatrixWorld();

  pickOrigin.copy(camera.position);
  const { hidden, swapped } = prepareSceneForTerrainPick(scene, roots);
  if (swapped.length === 0) {
    restoreSceneAfterTerrainPick(hidden, swapped);
    return null;
  }

  const previousTarget = renderer.getRenderTarget();
  const previousClearAlpha = renderer.getClearAlpha();
  renderer.getClearColor(previousClearColor);
  renderer.getViewport(previousViewport);
  renderer.getScissor(previousScissor);
  const previousScissorTest = renderer.getScissorTest();

  try {
    renderer.setRenderTarget(pickTarget);
    renderer.setViewport(0, 0, 1, 1);
    renderer.setScissorTest(false);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, pickCamera);
    renderer.readRenderTargetPixels(pickTarget, 0, 0, 1, 1, pickPixel);
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.setViewport(previousViewport);
    renderer.setScissor(previousScissor);
    renderer.setScissorTest(previousScissorTest);
    renderer.setClearColor(previousClearColor, previousClearAlpha);
    pickCamera.clearViewOffset();
    restoreSceneAfterTerrainPick(hidden, swapped);
  }

  if (pickPixel[3] <= 0 || !Number.isFinite(pickPixel[0])) return null;
  return pickedWorld
    .set(pickPixel[0], pickPixel[1], pickPixel[2])
    .add(pickOrigin)
    .clone();
}
