import * as THREE from 'three'
import { globalUniforms } from '../threact/threact';
import { glsl } from '../threact/threexample';
import { convertWgsToOSGB, EastNorth } from './Coordinates'
import { GpxTrackpoint } from './gpxtypes';


const lineVert = glsl`
attribute float time;
uniform float startTime;
uniform float endTime;
uniform float iTime;
varying float vTime;
void main() {
    vTime = time / (endTime-startTime);
    float v = smoothstep(0.9, 1.0, mod(vTime - (0.1*iTime), 1.0));
    vec3 p = vec3(position.xy, position.z + 100. * v);
    p.z += 100.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const lineFrag = glsl`
uniform float iTime;
varying float vTime;
void main() {
    float v = smoothstep(0.9, 1.0, mod(vTime - (0.1*iTime), 1.0));
    gl_FragColor = vec4(v, 0.4, 0.4, 1.);
}
`

export async function loadGpxGeometry(url: string, origin: EastNorth) {
    const data = await fetch(url);
    const track = parseGPX(await data.text());
    
    const pos = track.flatMap(tp => {
        const lat = tp.lat, lon = tp.lon;
        const en = convertWgsToOSGB({lat, lon});
        return [en.east - origin.east, en.north - origin.north, 2 + (tp.altitude || 0)];
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
        iTime: globalUniforms.iTime
    }
    const lineGeo = new THREE.LineLoop(geo, new THREE.ShaderMaterial({
        vertexShader: lineVert, fragmentShader: lineFrag, uniforms: uniforms
    }));
    //quite a lot of noise related to light setup etc, should be refactored once working ok.
    const g = new  THREE.Group();
    g.add(lineGeo);
    
    const l = new THREE.SpotLight();
    //consider smaller vertical angle.
    l.up.set(0,0,1);
    l.updateMatrix();
    l.updateMatrixWorld();
    g.add(l);
    const n = track.length;
    
    const m = new THREE.Mesh(new THREE.SphereBufferGeometry(15, 15, 30, 30), new THREE.MeshBasicMaterial({transparent: true, opacity: 0.6, color: 0x00FFFF}));
    m.frustumCulled = false;
    g.add(m);
    m.matrixAutoUpdate = true;
    l.matrixAutoUpdate = true;
    l.castShadow = true;
    l.shadow.mapSize.width = 4096;
    l.shadow.mapSize.height = 4096;
    l.shadow.camera.matrixAutoUpdate = true;
    l.matrixAutoUpdate = true;
    //l.shadow.radius = 1000;
    l.angle = Math.PI / 4;
    l.shadow.camera.near = 1;
    //I actually want this to be much higher, but if it triggers in loading lots of tiles then we crash.
    l.shadow.camera.far = 5000; 
    const helper = new THREE.CameraHelper( l.shadow.camera );
    g.add(helper);
    g.castShadow = true;

    //TODO interpolate, and look up based on time rather than index
    function getPos(i: number, out: THREE.Vector3) {
        const p = pos.slice(i*3, i*3 + 3);
        out.set(p[0], p[1], p[2]);
    }

    const tPos = new THREE.Vector3(), tNPos = new THREE.Vector3();
    m.onBeforeRender = () => {
        const t = globalUniforms.iTime.value * 0.001;
        const i = Math.floor(n*t % n);
        getPos(i, tPos);
        getPos(i+1 % n, tNPos);
        l.position.copy(tPos);
        l.lookAt(tNPos);
        l.updateMatrixWorld();
        l.shadow.camera.position.copy(tPos);
        l.shadow.camera.lookAt(tNPos);
        l.shadow.camera.updateMatrixWorld();
        m.position.copy(tPos);
        //helper looks sensible, but shadow doesn't.
        // ----- let's get some more debug visuals going ----
        helper.update();

        
        l.matrixWorldNeedsUpdate = true;
    }

    return g;
}


const F = Number.parseFloat;

function parseGPX(source: string) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(source, 'text/html');

    const segsRaw = [...xml.getElementsByTagName('trkseg')];
    const segsParsed = segsRaw.map(trksegProcess)[0];
    
    return segsParsed;
}

function trksegProcess(trkseg: Element): GpxTrackpoint[] {
    //turn into a point[] with a lat/lon, time, ele

    //https://stackoverflow.com/questions/53441292/why-downleveliteration-is-not-on-by-default
    //was worried create-react-app might interfere, but it doesn't seem to so far:
    //something to check if this gives compiler error in future.
    const pointsRaw = [...trkseg.getElementsByTagName('trkpt')];
    const points: GpxTrackpoint[] = pointsRaw.map(p => {
        return {
            lat: F(p.attributes.getNamedItem('lat')!.value),
            lon: F(p.attributes.getNamedItem('lon')!.value),
            altitude: F(p.getElementsByTagName('ele')[0].innerHTML),
            time: new Date(p.getElementsByTagName('time')[0].innerHTML)
        }
    });
    return points;
}

