import { decode, encode } from 'openjph-wasm';

/**
 * HTJ2K round trip for the renormalisation pass.
 *
 * The repack could copy codestreams verbatim; renormalising cannot — every
 * chunk has to come back to metres to be requantised against the national
 * scale. openjph-wasm does both directions, so the pass uses it rather than
 * pairing the pipeline's existing OpenJPH encoder with a separate decoder.
 */

export type DecodedChunk = {
  readonly raw: Uint16Array;
  readonly width: number;
  readonly height: number;
};

export async function decodeChunk(codestream: Uint8Array): Promise<DecodedChunk> {
  const image = await decode(codestream);
  if (image.components !== 1) {
    throw new Error(`expected a single-component height chunk, got ${image.components}`);
  }
  if (!(image.data instanceof Uint16Array)) {
    throw new Error(`expected uint16 samples, got ${image.data.constructor.name}`);
  }
  return { raw: image.data, width: image.width, height: image.height };
}

/** Lossless, matching `lossyQuality: 0.` on the source channel. */
export async function encodeChunk(
  raw: Uint16Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  return encode({ data: raw, width, height, components: 1, reversible: true });
}
