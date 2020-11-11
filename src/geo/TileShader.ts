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
const frankenShader = true;

export function getTileMaterial(uniforms: any) {
    if (frankenShader) return getTileMaterialX(uniforms);
    const mat = new THREE.ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        uniforms: uniforms,
        //lights: true //if experimenting with this, need to combine uniforms
    });
    return mat;
}
export function getTileMaterialX(uniforms: any) {
    const mat = new THREE.MeshStandardMaterial({flatShading: true});
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
    uniform float horizontalScale;
    uniform sampler2D heightFeild;
    varying float normalisedHeight;
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
    float getHeight(vec2 uv) {
        return mapHeight(getNormalisedHeight(uv));
    }
    vec2 uvFromVertID() {
        uint id = uint(gl_VertexID);
        uint x = id / gridSizeY;
        uint y = id % gridSizeX;
        //NB: when I was doing this in OF, I didn't include the +0.5
        //I think this version is correct... see some odd artefacts otherwise.
        return vec2(float(x)+0.5, float(y)+0.5) * EPS;
    }
    vec4 computePos(vec2 uv) {
        return vec4((uv) * horizontalScale, getNormalisedHeight(uv), 1.0);
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
    normalisedHeight = p.z;
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
    totalEmissiveRadiance.gb += vec2(computeContour() * 0.7);
`;


function patchVertexShader(vertexShader: string) {
    vertexShader = vertexPreamble + vertexShader;
    
    //replace standard vertex-attribute based position with our code to synthesise from gl_VertexID.
    //pretty rough hack, if following this path need to consider more importantly other parts of shader.
    //<shadowmap_vertex>, <fog_vertex> etc.
    
    //more logical way of replacing attributes with attributu-less: replace the chunk where the attributes are declared.
    //Declare & initialise them in 'uv_vertex', fairly similar to now, but in a way that means other parts of code need less change.
    //however, since there are lots of <*_pars_vertex>, it's a bit long-winded.

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
    uniform float heightMin, heightMax;
    uniform float iTime;
    varying float normalisedHeight;
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
    //this function seems quite good at showing up certain artefacts...
    float computeSteepness() {
        // return pow(1.-abs(dot(vec3(0.,0.,1.), computeNormal())), 0.5);
        //XXX: copying this into depth/distance shader (where it's not used) lead to compiler error
        //vNormal not defined.
        return 0.; //pow(1.-abs(dot(vec3(0.,0.,1.), vNormal)), 0.5);
    }
    float computeContour() {
        float h = getHeight(vUv);
        h = mod(h-3.*iTime, 5.)/5.;
        h = max(smoothstep(0.98, 1.0, h), smoothstep(0.02, 0., h));
        //h = aastep(0.5, h);
        return h;
    }
    ///----------------------------------
    `;
    //fragmentShader = fragPreamble + fragmentShader;
    //appending 'preamble' to that last #include before main()
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


const vert = glsl`
//uniform mat4 projectionMatrix, modelViewMatrix;
uniform float iTime;
uniform uint gridSizeX, gridSizeY;
uniform vec2 EPS;
uniform float heightMin, heightMax;
uniform float horizontalScale;
uniform sampler2D heightFeild;
varying vec2 vUv;
varying float normalisedHeight;
varying vec3 v_modelSpacePosition;
varying vec3 v_worldSpacePosition;
varying vec3 v_viewSpacePosition;
varying vec3 v_normal;
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
vec2 uvFromVertID() {
    uint id = uint(gl_VertexID);
    uint x = id / gridSizeY;
    uint y = id % gridSizeX;
    //NB: when I was doing this in OF, I didn't include the +0.5
    //I think this version is correct... see some odd artefacts otherwise.
    return vec2(float(x)+0.5, float(y)+0.5) * EPS;
}
vec4 computePos(vec2 uv) {
    return vec4((uv) * horizontalScale, getNormalisedHeight(uv), 1.0);
}
vec3 computeNormal(vec2 uv, vec4 pos) {
    //what about the edges?
    vec3 p = pos.xyz;
    vec3 dx = normalize(computePos(uv + vec2(EPS.x, 0.)).xyz - p);
    vec3 dy = normalize(computePos(uv + vec2(0., EPS.y)).xyz - p);
    return normalize(cross(dx, dy)).xyz;
}
void main() {
    vec2 uv = uvFromVertID();
    vUv = uv;
    // float h = getNormalisedHeight(vUv);
    // normalisedHeight = h;
    vec4 p = computePos(vUv);
    v_normal = computeNormal(uv, p);
    normalisedHeight = p.z;
    v_modelSpacePosition = p.xyz;
    p = modelMatrix * p;
    v_worldSpacePosition = p.xyz;
    p = viewMatrix * p;
    v_viewSpacePosition = p.xyz;
    gl_Position = projectionMatrix * p;
}
`;
const frag = glsl`//#version 300 es
precision highp float;
//out vec4 col;
uniform sampler2D heightFeild;
uniform float heightMin, heightMax;
uniform float iTime;
varying vec3 v_modelSpacePosition;
varying vec3 v_worldSpacePosition;
varying vec3 v_viewSpacePosition;
varying vec2 vUv;
varying float normalisedHeight;
varying vec3 v_normal;
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
vec3 computeNormal() {
    vec3 p = v_worldSpacePosition;
    vec3 dx = dFdx(p);
    vec3 dy = dFdy(p);
    return normalize(cross(dx, dy));
}
//this function seems quite good at showing up certain artefacts...
float computeSteepness() {
    // return pow(1.-abs(dot(vec3(0.,0.,1.), computeNormal())), 0.5);
    return pow(1.-abs(dot(vec3(0.,0.,1.), v_normal)), 0.5);
}
float computeContour() {
    float h = getHeight(vUv);// v_worldSpacePosition.z;
    h = mod(h-3.*iTime, 5.)/5.;
    h = max(smoothstep(0.98, 1.0, h), smoothstep(0.02, 0., h));
    //h = aastep(0.5, h);
    return h;
}
void main() {
    float h = computeContour();
    float s = computeSteepness();
    // float v = normalisedHeight;
    float v = abs(getHeight(vUv) - v_worldSpacePosition.z);
    vec4 col = vec4(vec3(0.2, s*0.7, v), 1.0);
    col.rg *= vec2(h);
    // col.rg = vUv;
    gl_FragColor = col;
}
`;
