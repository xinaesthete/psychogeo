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
pnpm pipeline:defra -- transcode-zarr --dataset <v2-dataset|.zip> --out <zarr-dir> [--region <gridRef>] [--progress]
```

`--region` takes any OSGB prefix (`SU`, `SU42`) and filters by node grid ref,
which is how you transcode one cell for a trial run. It must be a whole
grid reference: `SU` and `SU42` work, `SU4` is rejected.

## Reading the source in place

`--dataset` takes the `.zip` as readily as an extracted directory, and at
national scale the archive is the better source.

`terra-cognita-winchester.zip` holds 160,750 files. Extracted onto the exFAT
volume it lives on it occupies **239 GiB for 144 GiB of data** — the allocation
unit is 1 MiB, 8,772 of the files are ~2.9 KB manifests, and 6,556 of the
level-0 tiles are sub-3 KB all-nodata. The directory walk that finds the node
manifests takes over two minutes before the first chunk is read. Reading the
archive in place costs 3.2 s to parse the 181,039-entry central directory,
after which existence and size are index lookups rather than syscalls, and a
chunk read is ~10 ms for ~1.1 MB — 18% of the per-chunk budget.

Deflate is doing nothing on the payloads (143.0 GiB archive against 143.97 GiB
logical), so nothing is lost by leaving them compressed; `.j2c` is already
entropy-coded.

[zarr/sourceStore.ts](../../scripts/pipelines/defra-terrain/zarr/sourceStore.ts)
is the seam. It stays small because the passes only ever want four things from
a source: the metadata, the node manifests, the level-0 codestreams, and
whether a given codestream exists. `nodeDirs()` sorts, so the shard sequence is
a function of the dataset and not of the filesystem — which is what makes the
resume comparison below meaningful.

Extracting also invites a trap worth knowing about: macOS writes an AppleDouble
`._name.j2c` beside every file on a volume with no native xattrs, so an exFAT
extraction has one per chunk. They match the suffix and sort first. The passes
are immune because they construct exact filenames, but both verifiers globbed
and had to be taught to skip them.

## What the codec actually costs

The pass is one decode plus one re-encode per chunk, and the earlier estimate
of ~0.5 s each — "even at half a second a chunk that is a full day" — was out
by roughly 9×. Measured over 40 level-0 tiles spread across the archive:

| Stage | ms/chunk | |
|-------|----------|---|
| read (ranged read + inflate) | 10.0 | 18% |
| decode | 12.8 | 23% |
| requantise | 14.8 | 27% |
| encode | 17.8 | 32% |
| **total** | **55.4** | |

Confirmed end to end on NT: 1,330 level-0 chunks and 105 coarse ones in 90 s,
or 68 ms per level-0 chunk including the pyramid and the archive index.

That reframes the `worker_threads` pool as an optimisation rather than a
prerequisite. It is still worth having — the run sits at ~170% CPU, so there
are cores idle — but it is not what stood between this pass and a national
store.

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

## Renormalisation pass (`renormalise-zarr`)

The repack keeps the source encoding. This pass replaces it: one national
scale/offset, and a rebuilt pyramid.

```bash
pnpm pipeline:defra -- renormalise-zarr --dataset <v2-dir> --out <zarr-dir> [--region SU42] [--dither] [--progress]
```

**Encoding.** `height = raw * scale + offset` with `scale = 21.516 mm`,
`offset = -10.0215 m` over −10..1400 m, raw 0 reserved for nodata. Two numbers
in the array attributes instead of two companion arrays, so the `encoding/`
group is gone.

**Levels.** Uniform 1000² chunks, resolution ×4 per level: 1, 4, 16, 64, 256 m,
chunks covering 1, 4, 16, 64, 256 km. Every coarse chunk is exactly 4×4 of the
level below, sharing the north-west origin, which removes the 313 px rounding
and the varying chunk shapes in one go. 4× rather than 2× keeps pyramid
overhead near 7% instead of 33%.

Level 0→1 reduces by mean-of-block-maxes at a 4 px block — the ~4 m peak
surface — and every coarser level area-averages that same surface, so adjacent
levels stay statistically consistent. Level 1 therefore reads about a canopy
above an area mean, by design.

**Dither** (`--dither`) applies ±1 level TPDF noise, deterministic in
`(seed, chunk coordinate)`, and costs +1.8% in size (74.18 MiB against
72.85 MiB on SU42).

Whether it earns that depends entirely on the contour interval, which the
statistics in [python/codec-eval](../../python/codec-eval/README.md) could not
have told us:

| Contour interval | Quantisation steps per contour | Visible difference |
|------------------|-------------------------------|--------------------|
| 2 m (typical) | ~93 | none — the two renders are indistinguishable |
| 0.1 m | ~5 | large — undithered contours break into axis-aligned staircase segments; dithered stay smooth curves |

So it is still a flag, but the rule is now concrete: **off for normal use**,
on if fine-interval contours are wanted. The undithered store is the default
because at 2–5 m intervals the +1.8% buys nothing visible.

Worth knowing that the artefact is in the *contours*, not the shading. Shaded
relief over open farmland shows no terracing at the 21.5 mm step at any camera
tried; it is the contour shader, differentiating the height field, that turns a
sub-visible height step into a visible line.

**Result on SU42** — 100 leaf chunks, 5 levels:

| Level | Res | Chunks | Objects | Size |
|-------|-----|--------|---------|------|
| 0 | 1 m | 100 | 1 | 66.98 MiB |
| 1 | 4 m | 9 | 1 | 5.40 MiB |
| 2 | 16 m | 2 | 1 | 441.1 KiB |
| 3 | 64 m | 2 | 1 | 39.7 KiB |
| 4 | 256 m | 1 | 1 | 5.7 KiB |

**72.85 MiB for the whole pyramid, from 119.45 MiB of level-0 source — 39%
smaller**, with a deeper pyramid and no per-chunk metadata. Level 0 alone is 44%
down; pyramid overhead is 8.8%.

Verified by [scripts/verify-zarr-renormalise.mjs](../../scripts/verify-zarr-renormalise.mjs):

| Check | Result |
|-------|--------|
| Heights vs the source chunk | max 10.76 mm, rms 6.21 mm, bound 11.31 mm |
| Orientation across a chunk seam | 0.408 m vs 31.875 m control |
| Level 1 alignment | best shift (0,0) at 1.077 m, nearest wrong shift 12.561 m |

The rms matches `codec-eval`'s independent Python measurement to three
significant figures. Both the orientation and alignment checks score a
deliberately wrong alternative alongside the right one, because a shifted
pyramid level looks entirely plausible on its own.

Reproduced from the archive rather than an extracted tree: every figure above,
and every level's byte count, comes out identical.

NT60 verifies too, 480 km further north — max 10.78 mm, rms 6.21 mm against a
bound of 11.11 mm; orientation 0.131 m against a 7.249 m control; alignment
best at (0,0), 0.231 m against 14.925 m for the nearest wrong shift. The same
rms in both places is the requantisation being uniform, as intended.

Getting that second data point needed a fix to the verifier. NT60 is mostly
sea, `findLeaf` took the first chunk it found, and the run reported
`REQUANTISATION OK` over **zero samples** — max error 0.00 mm because there
was no error to find. It now picks the largest leaf across the node's quads
and reports `NOT TESTED` rather than `OK` when nothing overlaps. A check that
cannot fail is worse than no check, because it reads as evidence.

### The streaming writer

The open question was whether the shard-at-a-time rewrite still produced the
store the level-at-a-time version did. There was no pre-rewrite store left to
diff against, so the check is a stronger one: **an interrupted run resumes to a
byte-identical store**.

On NT — 1,330 chunks, 16 level-0 shards, 21 objects across 5 levels — a run
killed after 5 shards and resumed, and a second run with 11 of 16 shards
deleted, both produce output that `diff -r` cannot distinguish from the
single-shot run. That covers the writer and the resume predicate together, and
it is only meaningful because `nodeDirs()` sorts.

That did surface a real defect. A resumed run reported only what that
invocation wrote — 414.01 MiB from 739.65 MiB of source, where the store on
disk was 533.21 MiB from 959.97 MiB. Skipped shards now count towards the
level, and the source total comes from the scan, which knows every leaf's size
without reading it.

## Open

- **zfp was prototyped and lost** — see [python/codec-eval](../../python/codec-eval/README.md).
  At matched error it is 30–40% larger than uint16 + lossless J2K, because a
  1 km height tile spans ~100–200 m and 16 bits fits that far better than
  float32 with an exponent range zfp cannot exploit. HTJ2K stays, which also
  keeps the codestream's wavelet subbands available for analysis.
- **Dither** is settled for normal use (off) — see above. What is not settled is
  whether fine-interval contours are a mode worth supporting, since that is the
  only case where it pays.
- **Browser loader** — nothing in `src/` reads either store yet.
  `zarrextra/workers` + `@fideus-labs/fizarrita` is the intended path for
  off-main-thread decode.
- **Parallelise the codec.** Deferred rather than blocking, now that a serial
  national run is ~3 h rather than a day. The pass sits at ~170% CPU on a
  12-core machine and every millisecond of it is openjph, so a
  `worker_threads` pool should take it to well under an hour. That matters
  once DTM, the FZ−LZ foliage measure and the survey years each want a run of
  their own.
- **Nodata** is still the reserved raw 0 rather than a real sentinel; only a
  re-encode from the source TIFFs could change that.
- **Which store wins.** The repack and the renormalisation both exist; if the
  renormalised one holds up in the viewer there is little reason to keep the
  repack beyond its value as a byte-identity reference.
- **AppleDouble sidecars.** macOS writes a `._` file beside every object
  written to exFAT, which doubles the store's file count and costs a 1 MiB
  allocation unit each. `dot_clean` removes them; a store destined for object
  hosting should not carry them.
- **Retiring the bespoke index** was not a goal of this pass, so
  `metadata.json` and the 8,772 node manifests remain the source of truth.
  Most of what `derive.ts` computes is chunk-key arithmetic in this layout.
- **`index_location`** is `end`, so a cold read costs a suffix request before
  the first chunk. `start` would trade that for a rewrite on append.
