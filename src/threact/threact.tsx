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
    renderer = new THREE.WebGLRenderer({antialias: true, logarithmicDepthBuffer: true});
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
    //renderer.domElement.style.transform = `translate(${window.scrollX}px, ${window.scrollY}px)`;
    views.forEach(v => v.updateLayout());
    renderer.setClearColor(0x305050);
    renderer.autoClear = false;
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(compositeScene, compositeCamera);
}

init();

export interface IThree {
    scene: THREE.Scene;
    camera: THREE.Camera;
    initThree(dom: HTMLElement): void;
    update(): void;
    disposeThree(): void;
}


export interface IThreact {
    gfx: IThree;
}

/**
 * React documentation & general conventions strongly favour composition over inheritence, for sound reasons.
 * However, it seems as though this represents a sufficiently different kind of component that it may make sense
 * to make the parts responsible for compositing related boilerplate abstract.
 * I'm still very new to React and it may well be that having an appropriate type of Prop will allow any behaviour
 * I might reasonably want.
 * Indeed, a decent design is probably to have a prop interface with methods for update, cleanup, whatever.
 */
export class Threact extends React.Component<IThreact, any> {
    composite: THREE.Mesh;
    private mount?: HTMLDivElement;
    renderTarget: THREE.WebGLRenderTarget;
    color = 0x808080;
    constructor(props: any) {
        super(props);
        this.state = {
            frameCount: 0
        }
        this.renderTarget = new THREE.WebGLRenderTarget(250, 250);
        
        const geo = new THREE.PlaneBufferGeometry(250, 250, 1, 1); //TODO: something more efficient / reusable.
        const mat = new THREE.MeshBasicMaterial({map: this.renderTarget.texture});
        //const mat = new THREE.MeshBasicMaterial({color: this.color});
        this.composite = new THREE.Mesh(geo, mat);
    }
    componentDidMount() {
        //will any component with THREE content will be expected to have a render target that it updates as necessary?
        //may be more optimal for it to render into main, but this is premature optimization and may be less debug-friendly.
        compositeScene.add(this.composite);
        views.add(this);
        this.props.gfx.initThree(this.mount!);
    }
    componentWillUnmount() {
        compositeScene.remove(this.composite);
        views.delete(this);
    }
    updateLayout() {
        if (!this.mount) return;
        //nb: it could be possible to use something other than bounding rect, in cases with odd CSS transform.
        //but that's a bit of a tangent. Not sure if there's a simple way to e.g. get a matrix representing arbitrary transform
        const rect = this.mount.getBoundingClientRect(); //"Forced Reflow is likely a performance bottleneck"

        //TODO: don't render if off screen.
        const w = rect.width, cw = renderer.domElement.clientWidth;
        const h = rect.height, ch = renderer.domElement.clientHeight;
        const left = rect.left + w/2;
        const bottom = (ch - rect.bottom) + h/2;
        this.composite.position.x = left;
        this.composite.position.y = bottom;
        //this.composite.scale.x = w;
        //this.composite.scale.y = h;

        //this.composite.updateMatrix();
        if (rect.bottom < 0 || rect.top > ch || rect.right < 0 || rect.left > cw) return;
        this.renderGL();
    }
    renderGL() {
        //this can be a significant performance bottleneck here, understandably:
        //this.setState({frameCount: this.state.frameCount+1})
        //::: this also demonstrates that using 'state' for things unrelated to React rendering is ill-advised.
        //be clear about what causes Three things to need rendering, and what causes React things need rendering.
        const rt = renderer.getRenderTarget();
        renderer.setRenderTarget(this.renderTarget);
        //renderer.setViewport //alternative to renderTarget...
        renderer.setClearColor(this.color);
        renderer.clear();
        this.props.gfx.update();
        renderer.render(this.props.gfx.scene, this.props.gfx.camera);
        renderer.setRenderTarget(rt);
    }
    render() {
        return <div className='threact_view_proxy' ref={(mount) => this.mount = mount as HTMLDivElement} />
    }
}