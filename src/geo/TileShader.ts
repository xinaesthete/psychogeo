import * as THREE from 'three'
import { glsl } from '../threact/threexample';


/** thar be dragons */
export function patchShaderBeforeCompile(uniforms: any) {
    return (shader: THREE.Shader) => {
        //nb, I'm *not* using UniformsUtils to merge, because I want to keep a common reference to eg iTime
        for (let n in uniforms) shader.uniforms[n] = uniforms[n];
        shader.vertexShader = patchVertexShader(shader.vertexShader);
        //shader.fragmentShader = patchFragmentShader(shader.fragmentShader);
    }
}

function patchVertexShader(vertexShader: string) {
    const vertexPreamble = glsl`//---- heightmap vertex preamble ---
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
    }
    //--------------------------------
    `;

    vertexShader = vertexPreamble + vertexShader;
    
    //replace standard vertex-attribute based position with our code to synthesise from gl_VertexID.
    const toReplace = '#include <project_vertex>';
    vertexShader = vertexShader.replace(toReplace, glsl`//---- alternative <project_vertex> ---
    vec2 _uv = uvFromVertID();
    v_Uv = _uv;
    // float h = getNormalisedHeight(v_Uv);
    // normalisedHeight = h;
    vec4 p = computePos(v_Uv);
    vNormal = computeNormal(_uv, p);
    normalisedHeight = p.z;
    // v_modelSpacePosition = p.xyz;
    // p = modelMatrix * p;
    // v_worldSpacePosition = p.xyz;
    // p = viewMatrix * p;
    // v_viewSpacePosition = p.xyz;
    p = modelViewMatrix * p;
    transformed = p.xyz; // standard threejs variable
    vec4 mvPosition = p;
    gl_Position = projectionMatrix * p;
    ///----------------------------------
    `);

    const toReplace2 = '#include <worldpos_vertex>';
    //copying this from CSynth, not sure if it's needed.
    vertexShader = vertexShader.replace(toReplace2, "vec4 worldPosition = vec4( transformed, 1.0 ); //---- alternative <worldpos_vertex>");

    return vertexShader;
}

function patchFragmentShader(fragmentShader: string) {
    const fragPreamble = glsl`//---- heightmap frag preamble ----

    precision highp float;
    //out vec4 col;
    uniform sampler2D heightFeild;
    uniform float heightMin, heightMax;
    uniform float iTime;
    varying vec3 v_modelSpacePosition;
    varying vec3 v_worldSpacePosition;
    varying vec3 v_viewSpacePosition;
    varying vec2 v_Uv;
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
        float h = getHeight(v_Uv);// v_worldSpacePosition.z;
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
