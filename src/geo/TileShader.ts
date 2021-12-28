import * as THREE from 'three'
import { globalUniforms } from '../threact/threact';
import { glsl } from '../threact/threexample';

// stop press: https://www.donmccurdy.com/2019/03/17/three-nodematerial-introduction/


export const tileLoadingMat = new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    uniforms: globalUniforms,
    fragmentShader: glsl`
    uniform float iTime;
    void main() {
        float t = iTime + 1.5;
        float v = 0.3 + 0.3*sin(t);
        float g = 0.7 + 0.2*sin(t * 0.3);
        float b = 0.7 + 0.2*sin(t * 0.5);
        gl_FragColor = vec4(0., g, b, v);
    }
    `
});

//currently debugging, 'frankenShader' here means start with StandardMaterial & modify
//false for ShaderMaterial (not Raw, but not Standard)
//see also 'attributeless' in TileLoaderUK for using standard displacement map.
//const frankenShader = true; //not maintaining non-franken code.

export function getTileMaterial(uniforms: any) {
    const mat = new THREE.MeshStandardMaterial({flatShading: false});
    // --- note: having these may have detrimental effect on shadows (& is pointless).
    // mat.side = THREE.DoubleSide; //probably not really needed
    // mat.shadowSide = THREE.DoubleSide;
    mat.onBeforeCompile = patchShaderBeforeCompile(uniforms);
    return mat;
}

/** thar be dragons */
function patchShaderBeforeCompile(uniforms: any) {
    //https://stackoverflow.com/questions/30287170/combining-shaders-in-three-js
    //"The solution in my case was to add lights: yes to ShaderMaterial"
    //maybe I should stop trying to take an existing shader & modify it, but use ShaderMaterial & add where necessary.
    //that is probably closer to the way threejs is designed and intended to be used.

    //or loose the attribute-less approach, with something closer to StandardMaterial & displacement map
    //perhaps swapping geometry onBeforeRender for LOD

    //I want something a bit more like a Unity surface shader, where I write some code to procedurally determine
    //what the properties of the standard PBR material will be & let standard shader do the shading.
    return (shader: THREE.Shader) => {
        //nb, I'm *not* using UniformsUtils to merge, because I want to keep a common reference to eg iTime
        for (let n in uniforms) shader.uniforms[n] = uniforms[n];
        shader.vertexShader = patchVertexShader(shader.vertexShader);
        shader.fragmentShader = patchFragmentShader(shader.fragmentShader);
    }
}
enum SubstitutionType { APPEND, PREPEND, REPLACE };
function substituteInclude(sectionName: string, newCode: string, code: string, behaviour = SubstitutionType.REPLACE) {
    const toReplace = `#include <${sectionName}>`;
    switch (behaviour) {
        case SubstitutionType.APPEND:
            newCode = toReplace + '\n' + newCode;
            break;
        case SubstitutionType.PREPEND:
            newCode = newCode + '\n' + toReplace;
            break;
        case SubstitutionType.REPLACE:
            break;
    }
    //thought that maybe whitespace before #include was stopping three preprocessor from working, doesn't seem to be the case.
    newCode = `// ---------------------- <${sectionName}> -------------------
${newCode}
    // -----------------</${sectionName}> --------------------`;
    return code.replace(toReplace, newCode);
}


const vertexPreamble = glsl`
#define USE_UV
    uniform float iTime;
    uniform uint gridSizeX, gridSizeY;
    uniform vec2 EPS;
    uniform float heightMin, heightMax;
    uniform sampler2D heightFeild;
    // varying vec3 v_modelSpacePosition;
    // varying vec3 v_worldSpacePosition;
    // varying vec3 v_viewSpacePosition;
    // varying vec3 v_normal;
    float mapHeight(float h) {
        return heightMin + h * (heightMax - heightMin);
    }
    float getNormalisedHeight(vec2 uv) {
        uv.y = 1. - uv.y;
        vec4 v = texture2D(heightFeild, uv);
        //now using single channel so v.g is irrelevant, but at time of writing it's zero, so may as well leave in shader.
        float h = v.r + (v.g / 256.);
        return h;
    }
    //not used?
    float getHeight(vec2 uv) {
        return mapHeight(getNormalisedHeight(uv));
    }
    vec4 computePos(vec2 uv) {
        return vec4(uv - 0.5, getNormalisedHeight(uv), 1.0);
    }
    vec3 computeNormal(vec2 uv, vec4 pos) {
        //what about the edges?
        vec3 p = pos.xyz;
        vec3 dx = normalize(computePos(uv + vec2(EPS.x, 0.)).xyz - p);
        vec3 dy = normalize(computePos(uv + vec2(0., EPS.y)).xyz - p);
        return normalize(cross(dx, dy)).xyz;
        // return vec3(0.,0.,1.);
    }
`;

const uv_pars_vertexChunk = glsl`
    varying vec2 vUv;
    uniform mat3 uvTransform;
    vec2 uvFromVertID() {
        uint id = uint(gl_VertexID);
        uint x = id / gridSizeY;
        uint y = id % gridSizeX;
        //NB: when I was doing this in OF, I didn't include the +0.5
        //I think this version is correct... see some odd artefacts otherwise.
        // return vec2(float(x)+0.5, float(y)+0.5) * EPS;
        //XXX: seeing odd artefacts with DOF, so taking out 0.5 offset. 
        //Other artefacts were fairly subtle on small details like trees IIRC - should review that.
        //// adding use of uvTransform for sub-tiles
        vec2 uv = vec2(float(x), float(y)) * EPS;
        return (uvTransform * vec3(uv, 1.)).xy;
    }
`;

//this happens at start of main function...
//if we use that as a place to put a lot of our code, we don't need to worry about e.g.
//normal code coming before position code (but depending on position being known) etc.
const uv_vertexChunk = glsl`
    vUv = uvFromVertID();
    vec4 p = computePos(vUv);
`;

//when we don't have vertex attribute 'normal', we prepend this to beginnormal_vertex
//everything else to do with normals should then behave as-per standard shader.
const beginnormal_vertexChunk = glsl`
    vec3 normal = computeNormal(vUv, p);
`;

const project_vertexChunk = glsl`
    //vNormal = computeNormal(vUv, p);
    transformed = p.xyz; // standard threejs variable, not 'transformed' by modelViewMatrix
    p = modelViewMatrix * p;
    vec4 mvPosition = p;
    gl_Position = projectionMatrix * p;
`;

//Do I actually need to change anything in here if all relevant variables are set in the way it expects?
//We need to account for "transformedNormal" & "worldPosition"

//https://github.com/mrdoob/three.js/blob/dev/src/renderers/shaders/ShaderChunk/shadowmap_vertex.glsl.js
const shadowmap_vertexChunk = glsl`

`;

const emissivemap_fragmentChunk = glsl`
    float h = getNormalisedHeight(vUv);
    totalEmissiveRadiance.rgb += vec3(h/2000.);
    totalEmissiveRadiance.g += min(computeSteepness() * 0.01, 0.1);
    float majorContour = 10., minorContour = 0.2, speed = 1.;
    vec3 col = vec3(0.1, 0.5, 0.7);
    totalEmissiveRadiance.rgb += computeContour(h) * vec3(0.3, 0.5, 0.7) * 0.3;
    totalEmissiveRadiance.rgb += contour(h, 0., majorContour) * vec3(0.8, 0.5, 0.7) * 0.3;
    // totalEmissiveRadiance.rgb += contour(h, speed, minorContour, majorContour, 1.) * col * 0.3;
    vec3 lodCol = vec3(LOD, 0.8, 0.1);
    totalEmissiveRadiance.rgb += hsv2rgb(lodCol);
    // totalEmissiveRadiance.rgb = computeNormal(vUv, computePos(vUv));
`;


function patchVertexShader(vertexShader: string) {
    vertexShader = vertexPreamble + vertexShader;
    
    //replace standard vertex-attribute based position with our code to synthesise from gl_VertexID.
    //pretty rough hack, if following this path need to consider more importantly other parts of shader.
    //<shadowmap_vertex>, <fog_vertex> etc.
    
    //more logical way of replacing attributes with attributu-less: replace the chunk where the attributes are declared.
    //Declare & initialise them in 'uv_vertex', fairly similar to now, but in a way that means other parts of code need less change.
    //however, since there are lots of <*_pars_vertex>, it's a bit long-winded.

    vertexShader = substituteInclude('uv_pars_vertex', uv_pars_vertexChunk, vertexShader);
    vertexShader = substituteInclude('uv_vertex', uv_vertexChunk, vertexShader);
    // vertexShader = substituteInclude('uv2_vertex', `vUv2 = uv;`, vertexShader); //red herring: shadowMap != lightMap
    vertexShader = substituteInclude('beginnormal_vertex', beginnormal_vertexChunk, vertexShader, SubstitutionType.PREPEND);
    vertexShader = substituteInclude('project_vertex', project_vertexChunk, vertexShader);
    return vertexShader;
}

function patchFragmentShader(fragmentShader: string) {
    fragmentShader = '#define USE_UV\n' + fragmentShader;
    const fragPreamble = glsl`//---- heightmap frag preamble ----
    precision highp float;
    //out vec4 col;
    uniform sampler2D heightFeild;
    uniform vec2 EPS;
    uniform float heightMin, heightMax;
    uniform float iTime;
    uniform float LOD;
    // https://cis700-procedural-graphics.github.io/files/toolbox_functions.pdf
    //(nb, switched arguments)
    float bias(float t, float b) { return pow(t, log(b) / log(0.5)); }
    float gain(float t, float g) {
    if (t < 0.5)
        return bias(2. * t, 1. - g) / 2.;
    else
        return 1. - bias(2. - 2. * t, 1. - g) / 2.;
    }
    vec2 gain(vec2 t, float g) { return vec2(gain(t.x, g), gain(t.y, g)); }
    vec2 gain(vec2 t, vec2 g) { return vec2(gain(t.x, g.x), gain(t.y, g.y)); }

    // http://lolengine.net/blog/2013/07/27/rgb-to-hsv-in-glsl
    vec3 hsv2rgb(in vec3 c) {
        vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
        vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
        vec3 pp = c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
        return clamp(
            pp, 0.0,
            1.0); // added sjpt 30 July 2015, can probably remove other clamp???
    }
    vec3 rgb2hsv(in vec3 c) {
        vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
        vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
        vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));

        float d = q.x - min(q.w, q.y);
        float e = 1.0e-10;
        return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
    }
    float mapHeight(float h) {
        return heightMin + h * (heightMax - heightMin);
    }
    float getNormalisedHeight(vec2 uv) {
        uv.y = 1. - uv.y;
        vec4 v = texture2D(heightFeild, uv);
        float h = v.r + (v.g / 256.);
        return h;
    }
    float getHeight(vec2 uv) {
        return mapHeight(getNormalisedHeight(uv));
    }
    float aastep(float threshold, float value) {
        float afwidth = length(vec2(dFdx(value), dFdy(value))) * 0.70710678118654757;
        return smoothstep(threshold-afwidth, threshold+afwidth, value);
    }
    vec4 computePos(vec2 uv) {
        return vec4(uv - 0.5, getNormalisedHeight(uv), 1.0);
    }
    vec3 computeNormal(vec2 uv, vec4 pos) {
        //what about the edges?
        vec3 p = pos.xyz;
        vec3 dx = normalize(computePos(uv + vec2(EPS.x, 0.)).xyz - p);
        vec3 dy = normalize(computePos(uv + vec2(0., EPS.y)).xyz - p);
        return normalize(cross(dx, dy)).xyz;
        // return vec3(0.,0.,1.);
    }
    float computeContour(float h) {
        // float h = getHeight(vUv);
        float afwidth = length(vec2(dFdx(h), dFdy(h))) * 0.70710678118654757;
        
        //should be user-controllable - consider 'prefers-reduced-motion' etc as well as general sliders?
        h = mod(h+3.*iTime, 5.)/5.; 
        float sm = 0.2*afwidth;// 0.2;
        h = max(smoothstep(1.-sm, 1.0, h), smoothstep(sm, 0., h));
        // h = aastep(0.5, h);
        return h;
    }
    float contour(in float h, float speed, float interval) {
        float afwidth = length(vec2(dFdx(h), dFdy(h)) * 0.70710678118654757);
        float t = iTime*speed*interval;
        float c = h = mod(h+t, interval)/interval;
        float sm = .2*afwidth;
        c = mod(c, interval);
        c = max(smoothstep(1.-sm, 1.0, c), smoothstep(sm, 0., c));
        return c;
    }
    float fallOff(in float h, float interval) {
        float c = mod(h, interval)/interval;
        return 1.-c;
    }
    float contour(in float h, float speed, float interval, float majorInterval, float falloff) {
        float afwidth = length(vec2(dFdx(h), dFdy(h)) * 0.70710678118654757);
        float t = iTime*speed*interval;
        float c = mod(h+t, interval)/interval;
        float sm = afwidth;
        // c = mod(c, interval);
        float fall = fallOff(h, majorInterval);
        c = max(smoothstep(1.-sm, 1.0, c), smoothstep(sm, 0., c));
        c *= max(0.,1.-fall*falloff);
        return c;
    }
    //this function seems quite good at showing up certain artefacts...
    float computeSteepness() {
        // return pow(1.-abs(dot(vec3(0.,0.,1.), computeNormal())), 0.5);
        //XXX: copying this into depth/distance shader (where it's not used) lead to compiler error
        //vNormal not defined.
        // vec3 normal = computeNormal(vUv, computePos(vUv));
        // return 1.-pow(dot(vec3(0.,0.,1.), normal), 0.02);
        float h = getHeight(vUv);
        float afwidth = length(vec2(dFdx(h), dFdy(h))) * 0.70710678118654757;
        return afwidth;
    }
    ///----------------------------------
    `;
    //fragmentShader = fragPreamble + fragmentShader;
    //appending 'preamble' to that last #include before main()
    //TODO: ensure that position & normal used for computing light etc are as accurate as possible
    //(not based on interpolated vertex values).
    fragmentShader = substituteInclude("clipping_planes_pars_fragment", fragPreamble, fragmentShader, SubstitutionType.APPEND);
    fragmentShader = substituteInclude("emissivemap_fragment", emissivemap_fragmentChunk, fragmentShader, SubstitutionType.PREPEND);

    return fragmentShader;

}
/** still not working quite right? this is for heightmap based tiles */
export function applyCustomDepth(mesh: THREE.Mesh, uniforms: any) {
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const depth = mesh.customDepthMaterial = new THREE.MeshDepthMaterial();
    const dist = mesh.customDistanceMaterial = new THREE.MeshDistanceMaterial();
    if (mat && mat.displacementMap !== null) {
        depth.displacementMap = dist.displacementMap = mat.displacementMap;
        depth.displacementScale = dist.displacementScale = mat.displacementScale;
        depth.displacementBias = dist.displacementBias = mat.displacementBias;
    } else {
        depth.onBeforeCompile = patchShaderBeforeCompile(uniforms);
        dist.onBeforeCompile = patchShaderBeforeCompile(uniforms);
        // depth.onBeforeCompile = (shader) => {
        //     //what about <logdepth_vertex>?
        //     shader.vertexShader = patchVertexShader(shader.vertexShader);
        // }
        // dist.onBeforeCompile = (shader) => {
        //     shader.vertexShader = patchVertexShader(shader.vertexShader);
        // }
    }
}

/** at time of writing, this is a first go at hacking in something to work with mesh geometry, not heightmap,
 * such that curvature of Earth and potentially other factors relevant to viewshed analysis can be modeled.
 */
export function applyCustomDepthForViewshed(mesh: THREE.Mesh) {
    //this link collects more in-depth info,
    //http://mapaspects.org/content/effects-curvature-earth-refraction-light-air-and-fuzzy-viewsheds-arcgis-92/index.html
    // I should just use some basic trig
    //https://dizzib.github.io/earth/curve-calc/?d0=48.28032000002595&h0=1000&unit=metric
    //const depth = mesh.customDepthMaterial = new THREE.MeshDepthMaterial();
    const dist = mesh.customDistanceMaterial = new THREE.MeshDistanceMaterial();
    dist.onBeforeCompile = earthCurveVert;
    //no :)
    // if (mesh.material instanceof THREE.Material) mesh.material.onBeforeCompile = earthCurveVert;
}

function earthCurveVert(shader: THREE.Shader) {
    shader.vertexShader = substituteInclude(
        'begin_vertex',
        glsl`
        // where is 'transformed' (vert in model space) in relation to camera?
        //--- where 'camera' is another point somewhere near the surface, for which we are computing viewshed ---
        {
            //this is a local scope, for local varaibles. We won't have any accidental name collisions, here.
            vec4 camPos = modelViewMatrix * vec4(vec3(0.), 1.);
            vec4 origin = vec4(vec3(0.), 1.);
            // float earthRad = 6371000.0;
            float earthRad = 10.0;
            // vec2 dGrid = camPos.xy - transformed.xy;
            vec2 dGrid = transformed.xy - origin.xy;
            float d = length(dGrid);
            // dGrid /= d;
            float theta = PI - (d / earthRad);
            float phi = -atan(dGrid.y, dGrid.x) / earthRad;
            vec3 _t = vec3(0., 0., -earthRad);
            mat3 m = mat3(cos(theta), -sin(theta), 0.,
                        sin(theta), cos(theta), 0.,
                        0., 0., 1.);
            _t = m * _t;
            m = mat3(cos(phi), 0., sin(phi),
                    0., 1., 0.,
                    -sin(phi), 0., cos(phi));
            _t = m * _t;
            _t.z += earthRad + transformed.z;
            // transformed = _t;
            // transformed.z += d;
        }
        `, shader.vertexShader, SubstitutionType.APPEND);    
}
