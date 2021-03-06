import * as THREE from 'three'
import { globalUniforms } from '../threact/threact';
import { glsl } from '../threact/threexample';
import { convertWgsToOSGB, EastNorth } from './Coordinates'
import parseGPX from './GpxParser';
import { Gpx, GpxTrackpoint } from './gpxtypes';
import { TerrainRenderer } from './TileLoaderUK';


const lineVert = glsl`
attribute float time;
uniform float startTime;
uniform float endTime;
uniform float iTime;
varying float vTime;
void main() {
    vTime = time / (endTime-startTime);
    float v = smoothstep(0.9, 1.0, mod(vTime - (0.02*iTime), 1.0));
    vec3 p = vec3(position.xy, position.z + 100. * v);
    //logDepth?
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const lineFrag = glsl`
uniform float iTime;
uniform vec3 color;
varying float vTime;
void main() {
    float v = smoothstep(0.9, 1.0, mod(vTime - (0.02*iTime), 1.0));
    gl_FragColor.rgb = mix(1.-color, color, v);
    gl_FragColor.a = 1.;
}
`

export async function loadGpxGeometry(url: string, eleOffset = 30, color = 0xffffff) {
    // const origin = context.coord;
    const data = await fetch(url);
    const gpx = parseGPX(await data.text());
    const tracks = gpx.tracks?? gpx.routes?? undefined;
    if (!tracks) throw new Error(`couldn't load gpx track '${url}'`);
    const track = tracks[0].segments.flat(1);
    const pos = track.flatMap(tp => {
        const lat = tp.lat, lon = tp.lon;
        const en = convertWgsToOSGB({lat, lon});
        return [en.east, en.north, eleOffset + (tp.altitude || 0)];
    });
    const s = track[0].time!.getTime();
    const time = track.map(tp => (tp.time!.getTime() - s)/1000 || 0);
    const posAttr = new THREE.BufferAttribute(new Float32Array(pos), 3);
    const timeAttr = new THREE.BufferAttribute(new Float32Array(time), 1);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', posAttr);
    geo.setAttribute('time', timeAttr);
    const uniforms = {
        startTime: {value: 0},
        endTime: {value: Math.max(...time)},
        color: {value: new THREE.Color(color)},
        iTime: globalUniforms.iTime
    }
    const lineGeo = new THREE.LineLoop(geo, new THREE.ShaderMaterial({
        vertexShader: lineVert, fragmentShader: lineFrag, uniforms: uniforms
    }));
    //quite a lot of noise related to light setup etc, should be refactored once working ok.
    const g = new  THREE.Group();
    g.add(lineGeo);
    
    const l = new THREE.PointLight(color);
    const target = new THREE.Object3D();
    l.intensity = 3;
    l.power = 100;
    l.decay = 0.1;
    // l.target = target;
    //consider smaller vertical angle.
    // l.shadow.radius = 0.5;
    l.updateMatrix();
    l.updateMatrixWorld();
    g.add(l);
    const n = track.length;
    
    const m = new THREE.Mesh(new THREE.SphereBufferGeometry(15, 15, 30, 30), new THREE.MeshBasicMaterial({transparent: true, opacity: 0.6, color: color}));
    m.frustumCulled = false;
    g.add(m);
    m.matrixAutoUpdate = true;
    l.matrixAutoUpdate = true;
    l.castShadow = true;
    l.shadow.mapSize.width = 1024;
    l.shadow.mapSize.height = 1024;
    l.shadow.camera.matrixAutoUpdate = true;
    l.matrixAutoUpdate = true;
    //l.shadow.radius = 1000;
    // l.angle = Math.PI / 4;
    let debugStarted = false;
    l.shadow.bias = -0.0002; //large values result in near objects being lit when they shouldn't
    l.shadow.camera.near = 1;
    // //I would expect less artefacts with low values, but perhaps more important is relationship to other camera?
    l.shadow.camera.far = 200000; 
    const helper = new THREE.CameraHelper( l.shadow.camera );
    // g.add(helper);
    g.add(target);
    g.castShadow = true;
    
    //TODO interpolate, and look up based on time rather than index
    function getPos(i: number, out: THREE.Vector3) {
        const p = pos.slice(i*3, i*3 + 3);
        out.set(p[0], p[1], p[2]);
    }
    
    const tPos = new THREE.Vector3(), tNPos = new THREE.Vector3(), tt = new THREE.Vector3();
    m.onBeforeRender = () => {
        if (!debugStarted) {
            // context.debugTexture((l.shadow.map as any).texture);
            debugStarted = true;
        }
        const t = globalUniforms.iTime.value * 0.02;
        const iF = n*t % n;
        const i = Math.floor(iF);
        const a = iF - i;

        getPos(i, tPos);
        getPos(i+1 % n, tNPos);
        tPos.lerpVectors(tPos, tNPos, a);
        
        //could crudely approximate Earth's curvature... but this wouldn't account for mountains
        //short of actually rendering with proper curvature, I ought to be able to modify depth / distance shaders.
        //l.shadow.camera.far = ... some trig based on tPos.z
        
        tNPos.set(0,0,0);
        const nSmooth = 10;
        for (let j=1; j<nSmooth; j++) {
            getPos(i+j*3 % n, tt);
            tNPos.add(tt);
        }
        tNPos.multiplyScalar(1/(nSmooth-1));
        l.position.copy(tPos);
        target.position.copy(tNPos);
        // target.updateMatrix();
        l.updateMatrix();
        //l.lookAt(tNPos); //no, it looks at its .target
        m.position.copy(tPos);

        
        l.matrixWorldNeedsUpdate = true;
    }

    return g;
}


