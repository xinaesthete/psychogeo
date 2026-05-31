import * as THREE from 'three'
import { globalUniforms } from '../threact/threact';
import { glsl } from '../threact/threexample';
import { advanceCompressionTransitions, ensureCompressionShaderUniforms } from './compressionExperiment';
import {
    installTileShaderModule,
    type TileShaderFrameContext,
    type TileShaderModule,
    type TileUniformBag,
} from './tileShaderRuntime';

// stop press: https://www.donmccurdy.com/2019/03/17/three-nodematerial-introduction/

type CompiledShader = Parameters<NonNullable<THREE.Material['onBeforeCompile']>>[0];

function ensureUniform(
    shared: Record<string, THREE.IUniform>,
    key: string,
    create: () => THREE.IUniform,
): void {
    if (!(key in shared)) shared[key] = create();
}

/** Add missing keys only — preserves Leva tweaks and contourPhase across HMR. */
function ensureUniforms(shared: Record<string, THREE.IUniform>): void {
    ensureUniform(shared, 'contourPhase', () => ({ value: 0 }));
    ensureUniform(shared, 'contourSpeed', () => ({ value: 3.0 }));
    ensureUniform(shared, 'contourInterval', () => ({ value: 5.0 }));
    ensureUniform(shared, 'contourEmissive', () => ({ value: new THREE.Vector3(0.3, 0.5, 0.7) }));
    ensureUniform(shared, 'majorContourInterval', () => ({ value: 10.0 }));
    ensureUniform(shared, 'majorContourEmissive', () => ({ value: new THREE.Vector3(0.8, 0.5, 0.7) }));
    ensureUniform(shared, 'heightEmissiveScale', () => ({ value: 0 / 2000 }));
    ensureUniform(shared, 'lodSat', () => ({ value: 0.8 }));
    ensureUniform(shared, 'lodVal', () => ({ value: 0.0 }));
    ensureUniform(shared, 'contourStrength', () => ({ value: 0.3 }));
    ensureCompressionShaderUniforms(shared);
}

function updateFrame({ uniforms, dt }: TileShaderFrameContext): void {
    const phase = uniforms.contourPhase;
    const speed = uniforms.contourSpeed;
    if (phase && speed) {
        phase.value += speed.value * dt;
    }
    advanceCompressionTransitions(dt);
}

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

function createTerrainPickMaterial(uniforms: TileUniformBag): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
        uniforms: {
            ...uniforms,
            pickOrigin: { value: new THREE.Vector3() },
        },
        side: THREE.DoubleSide,
        vertexShader: vertexPreamble + uv_pars_vertexChunk + glsl`
            varying vec3 vPickWorld;
            void main() {
                vec2 uv = uvFromVertID();
                vec4 p = computePos(uv);
                vec4 world = modelMatrix * p;
                vPickWorld = world.xyz;
                gl_Position = projectionMatrix * viewMatrix * world;
            }
        `,
        fragmentShader: glsl`
            precision highp float;
            uniform vec3 pickOrigin;
            varying vec3 vPickWorld;
            void main() {
                gl_FragColor = vec4(vPickWorld - pickOrigin, 1.0);
            }
        `,
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
        if (!shader.uniforms.heightFeildLossy && uniforms.heightFeild) {
            if (!uniforms.heightFeildLossy) {
                uniforms.heightFeildLossy = { value: uniforms.heightFeild.value };
            }
            shader.uniforms.heightFeildLossy = uniforms.heightFeildLossy;
        }
        if (!shader.uniforms.heightFeildLossyNext && uniforms.heightFeildLossy) {
            if (!uniforms.heightFeildLossyNext) {
                uniforms.heightFeildLossyNext = { value: uniforms.heightFeildLossy.value };
            }
            shader.uniforms.heightFeildLossyNext = uniforms.heightFeildLossyNext;
        }
        if (!shader.uniforms.compressionLossyMorph) {
            uniforms.compressionLossyMorph ??= { value: 0 };
            shader.uniforms.compressionLossyMorph = uniforms.compressionLossyMorph;
        }
        if (!shader.uniforms.compressionLoading) {
            uniforms.compressionLoading ??= { value: 0 };
            shader.uniforms.compressionLoading = uniforms.compressionLoading;
        }
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


const heightSamplingGlsl = glsl`
    float mapHeight(float h) {
        return heightMin + h * (heightMax - heightMin);
    }
    float sampleHeightTex(sampler2D tex, vec2 uv) {
        uv.y = 1. - uv.y;
        // RedFormat + HalfFloatType: height is IEEE half in .r only (not 8-bit high/low split).
        return texture2D(tex, uv).r;
    }
    float sampleLossyHeight(vec2 uv) {
        float current = sampleHeightTex(heightFeildLossy, uv);
        if (compressionLossyMorph <= 0.) return current;
        float next = sampleHeightTex(heightFeildLossyNext, uv);
        return mix(current, next, clamp(compressionLossyMorph, 0., 1.));
    }
    float compressionBlendFactor(vec2 uv) {
        if (compressionEnabled < 0.5) return 0.;
        float t = heightBlend;
        if (compressionBlendMode > 0.5 && compressionBlendMode < 1.5) {
            float wave = sin(dot(uv, vec2(1., 0.7)) * compressionWaveFreq + iTime * compressionWaveSpeed);
            t *= 0.5 + 0.5 * wave * compressionWaveAmp;
        } else if (compressionBlendMode > 1.5 && compressionBlendMode < 2.5) {
            t = uv.x < heightBlend ? 1. : 0.;
        } else if (compressionBlendMode > 2.5) {
            return 0.;
        }
        return clamp(t, 0., 1.);
    }
    float getNormalisedHeight(vec2 uv) {
        float hFull = sampleHeightTex(heightFeild, uv);
        if (compressionEnabled < 0.5) return hFull;
        float hLossy = sampleLossyHeight(uv);
        float blend = compressionBlendFactor(uv);
        float delta = hLossy - hFull;
        return hFull + delta * blend * max(compressionHeightGain, 1.);
    }
    float getHeight(vec2 uv) {
        return mapHeight(getNormalisedHeight(uv));
    }
`;

const vertexPreamble = glsl`
#define USE_UV
    uniform float iTime;
    uniform uint gridSizeX, gridSizeY;
    uniform vec2 EPS;
    uniform float heightMin, heightMax;
    uniform sampler2D heightFeild;
    uniform sampler2D heightFeildLossy;
    uniform sampler2D heightFeildLossyNext;
    uniform float compressionEnabled;
    uniform float heightBlend;
    uniform float compressionWaveAmp;
    uniform float compressionWaveFreq;
    uniform float compressionWaveSpeed;
    uniform float compressionBlendMode;
    uniform float compressionHeightGain;
    uniform float compressionLossyMorph;
    uniform float compressionLoading;
    ${heightSamplingGlsl}
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
    if (compressionEnabled > 0.5 && compressionBlendMode > 2.5) {
        float d = abs(sampleHeightTex(heightFeild, vUv) - sampleLossyHeight(vUv));
        totalEmissiveRadiance.rgb += vec3(d * compressionDeltaScale);
    }
    if (compressionLoading > 0.5) {
        float pulse = 0.45 + 0.55 * sin(iTime * 7.0 + dot(vUv, vec2(13.0, 7.0)));
        totalEmissiveRadiance.rgb += vec3(0.05, 0.12, 0.08) * pulse * compressionLoading;
    }
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
    uniform sampler2D heightFeildLossy;
    uniform sampler2D heightFeildLossyNext;
    //uniform vec2 EPS; //! don't use in fragment — fragments can be finer than the grid
    uniform float heightMin, heightMax;
    uniform float iTime;
    uniform float LOD;
    uniform float contourPhase;
    uniform float contourInterval;
    uniform float contourStrength;
    uniform float majorContourInterval;
    uniform float heightEmissiveScale;
    uniform float lodSat;
    uniform float lodVal;
    uniform vec3 contourEmissive;
    uniform vec3 majorContourEmissive;
    uniform float compressionEnabled;
    uniform float heightBlend;
    uniform float compressionWaveAmp;
    uniform float compressionWaveFreq;
    uniform float compressionWaveSpeed;
    uniform float compressionBlendMode;
    uniform float compressionHeightGain;
    uniform float compressionDeltaScale;
    uniform float compressionLossyMorph;
    uniform float compressionLoading;
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
    ${heightSamplingGlsl}
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
        // contourPhase advanced in JS from contourSpeed; interval from Leva
        h = mod(h + contourPhase, contourInterval) / contourInterval;
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

// Installed into tileShaderRuntime; whole module hot-reloads via installTileShaderModule.
const tileShaderModule: TileShaderModule = {
    ensureUniforms,
    updateFrame,
    patchShaderBeforeCompile,
    createTileLoadingMaterial,
    createTerrainPickMaterial,
    applyCustomDepthForViewshed,
};

installTileShaderModule(tileShaderModule);

if (import.meta.hot) {
    import.meta.hot.accept();
}
