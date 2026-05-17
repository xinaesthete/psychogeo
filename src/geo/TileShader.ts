import * as THREE from 'three'
import { globalUniforms } from '../threact/threact';
import { glsl } from '../threact/threexample';
import {
    installTileShaderImpl,
    type TileShaderImpl,
    type TileUniformBag,
} from './tileShaderRuntime';

// stop press: https://www.donmccurdy.com/2019/03/17/three-nodematerial-introduction/

type CompiledShader = Parameters<NonNullable<THREE.Material['onBeforeCompile']>>[0];

function createTileLoadingMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
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
}

// 'frankenShader': MeshStandardMaterial + onBeforeCompile patches (see attributeless in TileLoaderUK).
/** thar be dragons */
function patchShaderBeforeCompile(uniforms: TileUniformBag) {
    // Unity surface-shader style: procedural PBR inputs, standard shader does lighting.
    // https://stackoverflow.com/questions/30287170/combining-shaders-in-three-js
    return (shader: CompiledShader) => {
        // Not using UniformsUtils.merge — keep shared refs (iTime, tileShaderUniforms, etc.)
        for (const n in uniforms) shader.uniforms[n] = uniforms[n];
        shader.vertexShader = patchVertexShader(shader.vertexShader);
        shader.fragmentShader = patchFragmentShader(shader.fragmentShader);
    };
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
    // Whitespace before #include was suspected to break the preprocessor; doesn't seem to be the case.
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
    float mapHeight(float h) {
        return heightMin + h * (heightMax - heightMin);
    }
    float getNormalisedHeight(vec2 uv) {
        uv.y = 1. - uv.y;
        vec4 v = texture2D(heightFeild, uv);
        // Single channel; v.g is zero at time of writing but kept for 16-bit decode path.
        float h = v.r + (v.g / 256.);
        return h;
    }
    float getHeight(vec2 uv) {
        return mapHeight(getNormalisedHeight(uv));
    }
    vec4 computePos(vec2 uv) {
        return vec4(uv - 0.5, getNormalisedHeight(uv), 1.0);
    }
    vec3 computeNormal(vec2 uv, vec4 pos) {
        // what about the edges?
        vec3 p = pos.xyz;
        vec3 dx = normalize(computePos(uv + vec2(EPS.x, 0.)).xyz - p);
        vec3 dy = normalize(computePos(uv + vec2(0., EPS.y)).xyz - p);
        return normalize(cross(dx, dy)).xyz;
    }
`;

const uv_pars_vertexChunk = glsl`
    varying vec2 vUv;
    uniform mat3 uvTransform;
    vec2 uvFromVertID() {
        uint id = uint(gl_VertexID);
        uint x = id / gridSizeY;
        uint y = id % gridSizeX;
        // NB: OF version used +0.5; without it, fewer artefacts except with DOF (review).
        // return vec2(float(x)+0.5, float(y)+0.5) * EPS;
        vec2 uv = vec2(float(x), float(y)) * EPS;
        return (uvTransform * vec3(uv, 1.)).xy; // sub-tiles
    }
`;

// Injected at start of main — position before dependent chunks (normals, etc.).
const uv_vertexChunk = glsl`
    vUv = uvFromVertID();
    vec4 p = computePos(vUv);
`;

// No vertex normal attribute; prepend so standard normal path still works.
const beginnormal_vertexChunk = glsl`
    vec3 normal = computeNormal(vUv, p);
`;

const project_vertexChunk = glsl`
    //vNormal = computeNormal(vUv, p);
    transformed = p.xyz; // model space; not yet multiplied by modelViewMatrix
    p = modelViewMatrix * p;
    vec4 mvPosition = p;
    gl_Position = projectionMatrix * p;
`;

const emissivemap_fragmentChunk = glsl`
    float h = getHeight(vUv);
    totalEmissiveRadiance.rgb += vec3(h) * heightEmissiveScale;
    totalEmissiveRadiance.rgb += computeContour(h) * contourEmissive * contourStrength;
    totalEmissiveRadiance.rgb += contour(h, 0., majorContourInterval) * majorContourEmissive * contourStrength;
    vec3 lodCol = vec3(LOD, lodSat, lodVal); // hue from per-tile LOD; sat/val from Leva
    totalEmissiveRadiance.rgb += hsv2rgb(lodCol);
    // totalEmissiveRadiance.rgb = computeNormal(vUv, computePos(vUv));
`;


function patchVertexShader(vertexShader: string) {
    vertexShader = vertexPreamble + vertexShader;
    // Synthesise position from gl_VertexID; also affects shadowmap_vertex, fog_vertex, etc.
    vertexShader = substituteInclude('uv_pars_vertex', uv_pars_vertexChunk, vertexShader);
    vertexShader = substituteInclude('uv_vertex', uv_vertexChunk, vertexShader);
    // vertexShader = substituteInclude('uv2_vertex', `vUv2 = uv;`, vertexShader); // shadowMap != lightMap
    vertexShader = substituteInclude('beginnormal_vertex', beginnormal_vertexChunk, vertexShader, SubstitutionType.PREPEND);
    vertexShader = substituteInclude('project_vertex', project_vertexChunk, vertexShader);
    return vertexShader;
}

function patchFragmentShader(fragmentShader: string) {
    fragmentShader = '#define USE_UV\n' + fragmentShader;
    const fragPreamble = glsl`//---- heightmap frag preamble ----
    precision highp float;
    uniform sampler2D heightFeild;
    //uniform vec2 EPS; //! don't use in fragment — fragments can be finer than the grid
    uniform float heightMin, heightMax;
    uniform float iTime;
    uniform float LOD;
    uniform float contourSpeed;
    uniform float contourInterval;
    uniform float contourStrength;
    uniform float majorContourInterval;
    uniform float heightEmissiveScale;
    uniform float lodSat;
    uniform float lodVal;
    uniform vec3 contourEmissive;
    uniform vec3 majorContourEmissive;
    float bias(float t, float b) { return pow(t, log(b) / log(0.5)); }
    float gain(float t, float g) {
    if (t < 0.5)
        return bias(2. * t, 1. - g) / 2.;
    else
        return 1. - bias(2. - 2. * t, 1. - g) / 2.;
    }
    vec2 gain(vec2 t, float g) { return vec2(gain(t.x, g), gain(t.y, g)); }
    vec2 gain(vec2 t, vec2 g) { return vec2(gain(t.x, g.x), gain(t.y, g.y)); }

    // https://cis700-procedural-graphics.github.io/files/toolbox_functions.pdf
    // http://lolengine.net/blog/2013/07/27/rgb-to-hsv-in-glsl
    vec3 hsv2rgb(in vec3 c) {
        vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
        vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
        vec3 pp = c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
        return clamp(pp, 0.0, 1.0);
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
        // what about the edges?
        vec3 p = pos.xyz;
        ivec2 s = textureSize(heightFeild, 0); // no mipmaps → LOD 0
        vec2 d = vec2(1./float(s.x), 1./float(s.y));
        vec3 dx = normalize(computePos(uv + vec2(d.x, 0.)).xyz - p);
        vec3 dy = normalize(computePos(uv + vec2(0., d.y)).xyz - p);
        return normalize(cross(dx, dy)).xyz;
    }
    float computeContour(float h) {
        float afwidth = length(vec2(dFdx(h), dFdy(h))) * 0.70710678118654757;
        // contourSpeed / contourInterval from Leva; consider prefers-reduced-motion
        h = mod(h + contourSpeed * iTime, contourInterval) / contourInterval;
        float sm = 0.2*afwidth;
        h = max(smoothstep(1.-sm, 1.0, h), smoothstep(sm, 0., h));
        return h;
    }
    float contour(in float h, float speed, float interval) {
        float afwidth = length(vec2(dFdx(h), dFdy(h))) * 0.70710678118654757;
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
        float afwidth = length(vec2(dFdx(h), dFdy(h))) * 0.70710678118654757;
        float t = iTime*speed*interval;
        float c = mod(h+t, interval)/interval;
        float sm = afwidth;
        float fall = fallOff(h, majorInterval);
        c = max(smoothstep(1.-sm, 1.0, c), smoothstep(sm, 0., c));
        c *= max(0.,1.-fall*falloff);
        return c;
    }
    // Good for surfacing artefacts; vNormal undefined in depth/distance passes if copied blindly
    float computeSteepness() {
        float h = getHeight(vUv);
        float afwidth = length(vec2(dFdx(h), dFdy(h))) * 0.70710678118654757;
        return afwidth;
    }
    ///----------------------------------
    `;
    // Append preamble before main(); inject emissive chunk into standard PBR path
    // TODO: derive lighting normals from heightfield samples, not interpolated verts
    fragmentShader = substituteInclude("clipping_planes_pars_fragment", fragPreamble, fragmentShader, SubstitutionType.APPEND);
    fragmentShader = substituteInclude("emissivemap_fragment", emissivemap_fragmentChunk, fragmentShader, SubstitutionType.PREPEND);

    return fragmentShader;

}

/** Mesh geometry (not heightmap) — earth curvature for viewshed-style distance. */
function applyCustomDepthForViewshed(mesh: THREE.Mesh) {
    // http://mapaspects.org/content/effects-curvature-earth-refraction-light-air-and-fuzzy-viewsheds-arcgis-92/index.html
    const dist = mesh.customDistanceMaterial = new THREE.MeshDistanceMaterial();
    dist.onBeforeCompile = earthCurveVert;
}

function earthCurveVert(shader: CompiledShader) {
    shader.vertexShader = substituteInclude(
        'begin_vertex',
        glsl`
        // 'camera' = viewpoint on/near surface for which we compute viewshed
        {
            vec4 camPos = modelViewMatrix * vec4(vec3(0.), 1.);
            vec4 origin = vec4(vec3(0.), 1.);
            // float earthRad = 6371000.0;
            float earthRad = 10.0;
            vec2 dGrid = transformed.xy - origin.xy;
            float d = length(dGrid);
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
        }
        `, shader.vertexShader, SubstitutionType.APPEND);
}

// Installed into tileShaderRuntime; module may hot-reload without invalidating the terrain stack.
const tileShaderImpl: TileShaderImpl = {
    patchShaderBeforeCompile,
    createTileLoadingMaterial,
    applyCustomDepthForViewshed,
};

installTileShaderImpl(tileShaderImpl);

if (import.meta.hot) {
    import.meta.hot.accept();
}
