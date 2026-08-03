/**
 * CRC-32C (Castagnoli), needed to write Zarr v3 shard indices.
 *
 * zarrita ships a crc32c codec but only implements decode
 * (`codecs/crc32c.ts` — `unimplementedEncode`), and we are the writer here, so
 * the table lives with us.
 */

const POLYNOMIAL = 0x82f63b78; // Castagnoli, bit-reflected

let table: Uint32Array | undefined;

function crcTable(): Uint32Array {
  if (table) return table;
  const next = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ POLYNOMIAL : crc >>> 1;
    }
    next[i] = crc >>> 0;
  }
  table = next;
  return next;
}

export function crc32c(bytes: Uint8Array): number {
  const lookup = crcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc >>> 8) ^ lookup[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Little-endian, matching the trailing checksum the crc32c codec appends. */
export function crc32cBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, crc32c(bytes), true);
  return out;
}
