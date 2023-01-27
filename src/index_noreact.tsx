import * as THREE from 'three'
import { convertWgsToOSGB } from "./geo/Coordinates";
import { TerrainRenderer } from "./geo/TileLoaderUK";

const winchester = convertWgsToOSGB({ lat: 51.064, lon: -1.3098227 });
const options = {
    defra10mDTMLayer: true,
    defraDSMLayer: false,
    osTerr50Layer: false,
    camZ: 3000,
    tracks: []
};
const renderer = new THREE.WebGLRenderer({antialias: true});
document.body.prepend(renderer.domElement);

const terrain = new TerrainRenderer(winchester, options);
terrain.dom = renderer.domElement;
///// oh FFS why are the simple things complicated?
terrain.initThree(renderer.domElement);
// terrain.camera.near = 1;
// terrain.camera.far = 2000000;
document.body.style.margin = "0px";

renderer.setSize(window.innerWidth, window.innerHeight);

function animate() {
    requestAnimationFrame(animate);
    terrain.update();
    renderer.render(terrain.scene, terrain.camera);
}

animate();