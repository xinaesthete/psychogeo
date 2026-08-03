# Zarr transcode (`transcode-zarr`)

Repacks an existing `psychogeo.terrain.v2` / `tc-dsm-pyramid` dataset into a
sharded **Zarr v3** store. First pass, implemented on `feat/zarr-transcode`.

## Related docs

- [v2-pyramid-pipeline.md](v2-pyramid-pipeline.md) — the source format.
- [storage-and-pipeline-v2.md](storage-and-pipeline-v2.md) § _Zarr and GIS ecosystem_ — where this sits in the roadmap.
- [../server-side.md](../server-side.md) § 6 — the original evaluation checklist.

## What it is for

Two goals, in order:

1. **File count.** `terra-cognita-winchester` is **160,750 files / 144 GB**, of
   which 150,474 are `.j2c` and 8,772 are `manifest.json`. A full directory walk
   takes 134 s. Every one of those files is an object to host, an HTTP request
   to make, and an allocation unit to waste.
2. **Somewhere to put the other channels.** DTM, an FZ−LZ foliage measure and
   temporal survey years are all coming. Adding each as another bespoke
   directory tree multiplies the problem above; adding each as another array in
   one store does not.

GIS-ecosystem interop is explicitly **not** a goal of this pass, which is what
makes keeping HTJ2K viable.

## The transcode does not decode anything

The existing `.j2c` codestreams become Zarr chunks **verbatim**. A shard is the
inner chunks laid end to end followed by a ZEP2 index of `(offset, nbytes)`
uint64 pairs; nothing is decompressed, resampled or re-encoded. The transcode is
therefore I/O bound, and the result is bit-identical to the source — which the
verifier checks rather than assumes.

Reading uses `zarrextra`'s `experimental.openjph_htj2k` codec (openjph-wasm)
from [SpatialData.js](https://github.com/Taylor-CCB-Group/SpatialData.js).

**zarrita writes nothing here.** It reads sharded arrays
(`createShardedChunkGetter`) but `indexing/set.ts` throws
`UnsupportedError("set on sharded arrays")`, so [zarr/shardWriter.ts](../../scripts/pipelines/defra-terrain/zarr/shardWriter.ts)
emits the shard format directly. CRC-32C likewise: zarrita's crc32c codec is
decode-only, so [zarr/crc32c.ts](../../scripts/pipelines/defra-terrain/zarr/crc32c.ts) carries the table.

## Store layout

```
store.zarr/
  zarr.json                          # group
  height.dsm.fz/
    zarr.json                        # multiscales + psychogeo.grid affine
    0/ 1/ 2/ 3/ 4/                   # uint16 arrays, one per pyramid level
      c/{shardY}/{shardX}            # sharded levels: one object per shard
    encoding/
      scale/{level}                  # float64, one value per chunk
      offset/{level}
```

Arrays are sized to the **whole National Grid sheet** (700 km × 1300 km),
not to the ingested extent. Absent chunks cost nothing in Zarr, so an
England-only store gains Scotland later without a reshape.

| Level | Chunk | Chunk px | Resolution | Shard | Chunks/shard |
|-------|-------|----------|------------|-------|--------------|
| 0 | 1 km | 1000² | 1 m | 10 km | 100 |
| 1 | 5 km | 625² | 8 m | 100 km | 400 |
| 2 | 10 km | 313² | 31.949 m | 100 km | 100 |
| 3 | 100 km | 800² | 125 m | — | — |
| 4 | 100 km | 200² | 500 m | — | — |

Shard sizes are chosen so an object is tens to ~100 MB: big enough to collapse
the file count, small enough to write, resume and range-read comfortably. The
100 km tier is already one chunk per square, so wrapping it in a shard index
would buy nothing.

### Three things the source format forced

**Per-chunk scale/offset.** Every chunk is uint16 normalised over its own
min/max (`value = raw * scale + offset`, raw 0 reserved for nodata, so
`min = offset + scale` and `max = offset + 65535 * scale`). Zarr's dtype
semantics are array-level and have no room for this, so it travels alongside in
`encoding/scale/{level}` and `encoding/offset/{level}` — one float64 per chunk,
NaN where there is no data. A float-native codec would remove the need entirely.

**Row 0 is the north edge.** The stored codestreams are north-first (the tile
shader flips `v` when sampling), so the array's `y` axis has to run south for
the bytes to pass through untouched. `psychogeo.grid` records the affine:
`east = x * res`, `north = 1300000 − y * res`.

**Level 2 is not really 32 m.** `pixelDimensions` rounds, so a 10 km chunk at a
nominal 32 m is 313 px — 31.949 m. `levelGrid` reports the resolution the pixels
actually have and puts that in the coordinate transform, rather than resampling
to make the number tidy. Regenerating level 2 at 31.25 m (320 px) would make it
an exact divisor, but that is a pipeline change, not a transcode.

## CLI

```bash
pnpm pipeline:defra -- transcode-zarr --dataset <v2-dataset-dir> --out <zarr-dir> [--region <gridRef>] [--progress]
```

`--region` takes any OSGB prefix (`SU`, `SU42`) and filters by node grid ref,
which is how you transcode one cell for a trial run.

## Verification

[scripts/verify-zarr-transcode.mjs](../../scripts/verify-zarr-transcode.mjs)
checks a transcoded store three ways. It deliberately re-derives chunk
coordinates by hand instead of importing the pipeline's own modules, so it is a
cross-check and not a restatement.

```bash
node scripts/verify-zarr-transcode.mjs <zarr-dir> <v2-dataset-dir> <gridRef>
```

Results for SU42 (105 chunks, 3 objects, 121.77 MiB):

| Check | Result |
|-------|--------|
| Byte identity — every chunk pulled back out via the shard index | 100/100 identical |
| Read path — zarrita + zarrextra decode a 1000² window | uint16, raw 1..65535 → 94.85..185.94 m, matching the manifest scalars |
| Orientation — mean \|Δh\| across a chunk seam | **0.097 m**, against a control of **39.578 m** for rows 1 km apart |

The orientation control matters: byte identity says nothing about which way up
the array is, and without a control a small seam difference is not evidence of
anything. A 400× separation is.

## Open

- **zfp** as a second codec to prototype. It compresses floats directly, so it
  would delete the `encoding/` companion arrays rather than work around them —
  the per-chunk normalisation exists only because uint16 needs a range. Cost is
  the HTJ2K investment and the compression experiment's subject.
- **Browser loader** — nothing in `src/` reads the store yet. `zarrextra/workers`
  + `@fideus-labs/fizarrita` is the intended path for off-main-thread decode.
- **National run** — only SU42 has been transcoded. 144 GB at I/O speed.
- **Retiring the bespoke index** was not a goal of this pass, so
  `metadata.json` and the 8,772 node manifests remain the source of truth.
  Most of what `derive.ts` computes is chunk-key arithmetic in this layout.
- **`index_location`** is `end`, so a cold read costs a suffix request before
  the first chunk. `start` would trade that for a rewrite on append.
