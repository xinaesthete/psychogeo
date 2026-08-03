import * as THREE from 'three';

/**
 * Which texture format decoded height chunks are uploaded in.
 *
 * The pipeline is 16-bit fixed point from end to end: ingest writes
 * `height = offset + code * scale` with codes in 1…65535, and the HTJ2K codec
 * decodes back to those codes exactly. Uploading them as `R16` unorm carries
 * that through untouched.
 *
 * The half-float path is the fallback, and it is lossy: a half carries 11 bits
 * of mantissa against the code's 16, and the loss scales with the value, so a
 * tile's own elevation range decides how bad it is — around 1mm near the bottom
 * of a 33m tile against 16mm near the top. That showed up as contours breaking
 * into rows of separate marks on gentle ground.
 */
export type HeightTextureFormat = 'r16' | 'half';

/** Highest code the ingest emits; see scripts/pipelines/defra-terrain/encoding.ts. */
export const HEIGHT_CODE_MAX = 65535;

/** Relative quantisation of a half float: 11 bits of mantissa. */
const HALF_FLOAT_RELATIVE_QUANTUM = 2 ** -11;

/** three looks internal formats up by name on the context; this is EXT_texture_norm16's. */
const R16_INTERNAL_FORMAT_NAME = 'R16_EXT';

let supported: boolean | null = null;

/**
 * Whether this browser can take the lossless path. Probed on a throwaway
 * context because the answer is a property of the browser and GPU, and the
 * decode workers need it before the app's renderer necessarily exists.
 */
function detectR16Support(): boolean {
  if (supported !== null) return supported;
  supported = false;
  if (typeof document === 'undefined') return supported;
  try {
    const probe = document.createElement('canvas').getContext('webgl2');
    supported = !!probe?.getExtension('EXT_texture_norm16');
  } catch {
    supported = false;
  }
  return supported;
}

export function heightTextureFormat(): HeightTextureFormat {
  return detectR16Support() ? 'r16' : 'half';
}

/**
 * Enable the extension on the context that will actually sample these textures,
 * and put its `R16_EXT` enum where three will find it.
 *
 * three resolves `texture.internalFormat` as `gl[name]`, but WebGL hangs
 * extension enums off the extension object rather than the context, so `R16` is
 * otherwise unreachable through the documented hook. Registering the name is
 * the smallest way in; the alternative is managing the GL texture ourselves
 * through ExternalTexture and taking over its lifetime from the tile cache.
 *
 * Idempotent, and safe to call every frame. Must run before the first height
 * texture uploads, which is why it sits at the top of the terrain render.
 */
export function configureHeightTextureFormat(renderer: THREE.WebGLRenderer): void {
  if (!detectR16Support()) return;
  const gl = renderer.getContext();
  if (!(gl instanceof WebGL2RenderingContext)) return;
  if (R16_INTERNAL_FORMAT_NAME in gl) return;
  const ext = gl.getExtension('EXT_texture_norm16');
  if (!ext) {
    // The real context disagrees with the probe. Fall back rather than upload
    // something the driver will reject.
    supported = false;
    console.warn('EXT_texture_norm16 missing on the render context; heights stay half-float');
    return;
  }
  Object.defineProperty(gl, R16_INTERNAL_FORMAT_NAME, { value: ext.R16_EXT });
}

/** Apply the type/internal format for a decoded height chunk. */
export function applyHeightTextureFormat(
  texture: THREE.DataTexture,
  format: HeightTextureFormat,
): void {
  if (format === 'r16') {
    texture.type = THREE.UnsignedShortType;
    // three types internalFormat as its own union of core WebGL2 formats, which
    // cannot name one that arrives with an extension. The runtime only ever
    // looks the string up on the context, where configureHeightTextureFormat
    // has put it.
    Object.assign(texture, { internalFormat: R16_INTERNAL_FORMAT_NAME });
  } else {
    texture.type = THREE.HalfFloatType;
    texture.internalFormat = null;
  }
}

/**
 * The two terms the shader needs to know how coarsely height reaches it:
 * `quantum = abs + rel * (h - heightMin)`. Fixed point is uniform across the
 * range so it is all in `abs`; a half float's step grows with the value, so it
 * is all in `rel`.
 */
export function heightQuantumTerms(
  format: HeightTextureFormat,
  heightMin: number,
  heightMax: number,
): { abs: number; rel: number } {
  if (format === 'r16') {
    return { abs: Math.abs(heightMax - heightMin) / HEIGHT_CODE_MAX, rel: 0 };
  }
  return { abs: 0, rel: HALF_FLOAT_RELATIVE_QUANTUM };
}
