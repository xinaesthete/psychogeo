import * as THREE from "three";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls";
import { IThree } from "./threact";

export class DefaultCube implements IThree {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera();
    trackCtrl?: TrackballControls;
    initThree(dom: HTMLElement): void {
        const geo = new THREE.BoxGeometry();
        const mat = new THREE.MeshNormalMaterial();
        const mesh = new THREE.Mesh(geo, mat);
        this.scene.add(mesh);
        this.camera.position.set(0, 0, -3);
        this.camera.lookAt(0, 0, 0);
        this.trackCtrl = new TrackballControls(this.camera, dom);
    }
    update(): void {
        this.trackCtrl!.update();
    }
    disposeThree(): void {
    }
}
