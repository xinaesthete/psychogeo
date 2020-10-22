import * as THREE from 'three'
import { globalUniforms } from '../threact/threact';
import { glsl } from '../threact/threexample';


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

/** thar be dragons */
export function patchShaderBeforeCompile(uniforms: any) {
    //https://stackoverflow.com/questions/30287170/combining-shaders-in-three-js
    //"The solution in my case was to add lights: yes to ShaderMaterial"
    //maybe I should stop trying to take an existing shader & modify it, but use ShaderMaterial & add where necessary.
    //that is probably closer to the way threejs is designed and intended to be used.
    //I want something a bit more like a Unity surface shader, where I write some code to procedurally determine
    //what the properties of the standard PBR material will be & let standard shader do the shading.
    return (shader: THREE.Shader) => {
        //nb, I'm *not* using UniformsUtils to merge, because I want to keep a common reference to eg iTime
        for (let n in uniforms) shader.uniforms[n] = uniforms[n];
        shader.vertexShader = patchVertexShader(shader.vertexShader);
        //shader.fragmentShader = patchFragmentShader(shader.fragmentShader);
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
    newCode = `// ---------------------- <${sectionName}> -------------------
    ${newCode}
    // -----------------</${sectionName}> --------------------`;
    return code.replace(toReplace, newCode);
}

//// this is what vertexShader for StandardMaterial looks like before preprocessor:
/*
#define STANDARD
varying vec3 vViewPosition;
#ifndef FLAT_SHADED
	varying vec3 vNormal;
	#ifdef USE_TANGENT
		varying vec3 vTangent;
		varying vec3 vBitangent;
	#endif
#endif
#include <common>
#include <uv_pars_vertex>
#include <uv2_pars_vertex>
#include <displacementmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main {
	#include <uv_vertex>
	#include <uv2_vertex>
	#include <color_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
#ifndef FLAT_SHADED
	vNormal = normalize( transformedNormal );
	#ifdef USE_TANGENT
		vTangent = normalize( transformedTangent );
		vBitangent = normalize( cross( vNormal, vTangent ) * tangent.w );
	#endif
#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
    #include <fog_vertex>
}
*/

const vertexPreamble = glsl`
    uniform float iTime;
    uniform uint gridSizeX, gridSizeY;
    uniform vec2 EPS;
    uniform float heightMin, heightMax;
    uniform float horizontalScale;
    uniform sampler2D heightFeild;
    varying vec2 v_Uv;
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

const project_vertexChunk = glsl`
    vec2 _uv = uvFromVertID();
    v_Uv = _uv;
    vec4 p = computePos(v_Uv);
    //probably better to put this somewhere in 
    vNormal = computeNormal(_uv, p);
    normalisedHeight = p.z;
    p = modelViewMatrix * p;
    transformed = p.xyz; // standard threejs variable
    vec4 mvPosition = p;
    gl_Position = projectionMatrix * p;
`;

//https://github.com/mrdoob/three.js/blob/dev/src/renderers/shaders/ShaderChunk/shadowmap_vertex.glsl.js
const shadowmap_vertexChunk = glsl`


`;

function patchVertexShader(vertexShader: string) {
    vertexShader = vertexPreamble + vertexShader;
    
    //replace standard vertex-attribute based position with our code to synthesise from gl_VertexID.
    //pretty rough hack, if following this path need to consider more importantly other parts of shader.
    //<shadowmap_vertex>, <fog_vertex> etc.
    vertexShader = substituteInclude('project_vertex', project_vertexChunk, vertexShader);
    return vertexShader;
}

function patchFragmentShader(fragmentShader: string) {
    const fragPreamble = glsl`//---- heightmap frag preamble ----

    precision highp float;
    //out vec4 col;
    uniform sampler2D heightFeild;
    uniform float heightMin, heightMax;
    uniform float iTime;
    varying vec2 v_Uv;
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
        return pow(1.-abs(dot(vec3(0.,0.,1.), vNormal)), 0.5);
    }
    float computeContour() {
        float h = getHeight(v_Uv);
        h = mod(h-3.*iTime, 5.)/5.;
        h = max(smoothstep(0.98, 1.0, h), smoothstep(0.02, 0., h));
        //h = aastep(0.5, h);
        return h;
    }
    ///----------------------------------
    `;
    fragmentShader = fragPreamble + fragmentShader;


    return fragmentShader;

}
