import React from 'react'
import * as THREE from 'three'
import './threact.css'

declare const window: Window;
declare const document: Document;

let renderer: THREE.WebGLRenderer;
let compositeScene: THREE.Scene;
let compositeCamera: THREE.OrthographicCamera;
const views: Set<Threact> = new Set();

function init() {
    //NB:: I should consider the implications of having these values determined in a global GL context, 
    //and how they may be configured in an application (probably require app to call init with arguments).
    //renderer = new THREE.WebGLRenderer({antialias: true, logarithmicDepthBuffer: true});
    renderer = new THREE.WebGLRenderer();
    compositeScene = new THREE.Scene();
    const w = window.innerWidth, h = window.innerHeight;
    compositeCamera = new THREE.OrthographicCamera(0, w, h, 0);
    compositeCamera.position.z = 0.4;
    
    window.addEventListener('resize', resize, false);
    renderer.setSize(w, h);
    const el = renderer.domElement;
    document.body.appendChild(el);
    el.id = "threact_main_canvas";

    animate();
}


function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    compositeCamera.right = w;
    compositeCamera.top = h;
    compositeCamera.updateProjectionMatrix();
    renderer.setSize(w, h);
}

function animate() {
    requestAnimationFrame(animate);
    renderer.domElement.style.transform = `translateY(${window.scrollY}px)`;
    views.forEach(v => v.updateLayout());
    renderer.setClearColor(0x308080);
    renderer.autoClear = false;
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(compositeScene, compositeCamera);
}

init();

export class Threact extends React.Component<any, any> {
    composite: THREE.Mesh;
    private mount?: HTMLDivElement;
    renderTarget: THREE.WebGLRenderTarget;
    scene: THREE.Scene;
    camera: THREE.Camera;
    color: THREE.Color;
    hue: number;
    constructor(props: any) {
        super(props);
        this.scene = new THREE.Scene();
        this.color = new THREE.Color();
        this.hue = Math.random();
        this.color.setHSL(this.hue, 0.9, 0.4);
        this.renderTarget = new THREE.WebGLRenderTarget(250, 250);
        this.camera = new THREE.PerspectiveCamera();
        this.camera.position.set(0, 0, -10);
        this.camera.lookAt(0, 0, 0);
        
        const geo = new THREE.PlaneBufferGeometry(250, 250, 1, 1); //TODO: something more efficient / reusable.
        //const mat = new THREE.MeshBasicMaterial({map: this.renderTarget.texture});
        const mat = new THREE.MeshBasicMaterial({color: this.color});
        this.composite = new THREE.Mesh(geo, mat);
        this.addBox();
    }
    addBox() {
        const geo = new THREE.BoxGeometry();
        const mat = new THREE.MeshNormalMaterial();
        const mesh = new THREE.Mesh(geo, mat);
        this.scene.add(mesh);
    }
    componentDidMount() {
        //will any component with THREE content will be expected to have a render target that it updates as necessary?
        //may be more optimal for it to render into main, but this is premature optimization and may be less debug-friendly.
        compositeScene.add(this.composite);
        views.add(this);
    }
    componentWillUnmount() {
        compositeScene.remove(this.composite);
        views.delete(this);
    }
    updateLayout() {
        if (!this.mount) return;
        const rect = this.mount.getBoundingClientRect();
        //TODO: don't render if off screen.
        const w = rect.width;
        const h = rect.height;
        const left = rect.left + w/2;
        const bottom = (renderer.domElement.clientHeight - rect.bottom) + h/2;
        this.composite.position.x = left;
        this.composite.position.y = bottom;
        //this.composite.scale.x = w;
        //this.composite.scale.y = h;

        this.composite.updateMatrix();
        //this.renderGL();
    }
    renderGL() {
        const rt = renderer.getRenderTarget();
        renderer.setRenderTarget(this.renderTarget);
        renderer.setClearColor(this.color);
        renderer.clear();
        renderer.render(this.scene, this.camera);
        renderer.setRenderTarget(rt);
    }
    render() {
        return <div className='threact_view_proxy' ref={(mount) => this.mount = mount as HTMLDivElement}>
            {this.hue}
            </div>
    }
}