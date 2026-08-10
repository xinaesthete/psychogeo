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

   Settled: the renormalised national store is **1,655 objects / 74.58 GiB**.
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

### The national store

Built from the archive in place, serial, no dither:

```bash
pnpm pipeline:defra -- renormalise-zarr \
  --dataset /Volumes/CrucialOx9/terra-cognita-winchester.zip \
  --out /Volumes/CrucialOx9/terra-cognita.zarr --progress
```

| Level | Res | Chunks | Objects | Size |
|-------|-----|--------|---------|------|
| 0 | 1 m | 143,185 | 1,503 | 68.14 GiB |
| 1 | 4 m | 9,232 | 119 | 5.92 GiB |
| 2 | 16 m | 641 | 16 | 492.23 MiB |
| 3 | 64 m | 59 | 3 | 35.98 MiB |
| 4 | 256 m | 7 | 7 | 2.63 MiB |

**74.58 GiB in 1,655 objects, from 141.12 GiB of level-0 source — 47.2%
smaller.** Pyramid overhead is 9.4%. 2 h 43 min after the scan, on one thread.

That is the file-count goal met: **160,750 files becomes 1,655**, a 97×
reduction, and on this volume's 1 MiB allocation unit the 239 GiB an extracted
tree would occupy becomes 76 GiB. Level 0 comes out at exactly one shard per
OSGB 10 km cell — 1,503 of them, matching the 1,503 cells in the source.

The dataset is not the Winchester of its name: 143,185 level-0 tiles across 26
hundred-km squares, `NT` and `NU` among them, so the store already reaches the
Scottish border. Sizing the arrays to the whole sheet rather than the ingested
extent is doing real work here.

Verified at three widely separated cells, against source chunks extracted from
the archive:

| Cell | Samples | Heights | Orientation | Level 1 alignment |
|------|---------|---------|-------------|-------------------|
| SU42 Hampshire | 1,000,000 | max 10.76 mm, rms 6.21 mm (bound 11.32) | 2.752 m vs 11.868 m | (0,0) 5.543 m vs 13.845 m |
| NT60 Borders | 1,000,000 | max 10.78 mm, rms 6.21 mm (bound 11.11) | 0.131 m vs 7.249 m | (0,0) 0.231 m vs 14.925 m |
| SY08 Dorset | 1,000,000 | max 10.76 mm, rms 6.21 mm (bound 11.26) | 3.084 m vs 31.193 m | (0,0) 3.926 m vs 23.011 m |

The same 6.21 mm rms in all three is the point of renormalising to one national
scale: the error is now a property of the encoding rather than of whatever
range a particular chunk happened to span.

### Reading it in the browser

[src/geo/zarrPyramid.ts](../../src/geo/zarrPyramid.ts) reads the renormalised
store: shard indices by suffix request, then each chunk as a `#bytes=` range
the texture worker turns into a `Range` header. No zarr library at runtime.

Pointed at the national store it draws the whole country, descending all five
levels in one view — 1 m underfoot to 256 m at the skyline, in about 110
requests over 97 objects. The only gap is the known one in the North Yorkshire
Moors. Before this it had only ever seen SU42, where every coarse level held a
single chunk.

The root group names its channels, and the reader uses that rather than
guessing:

```
psychogeo.channels: ["height.dsm.fz"]
```

A Zarr group does not record its children and a store served as static files
has no listing to ask for, so a reader either finds the channels named or
assumes one. It previously assumed `height.dsm.fz` — which is indistinguishable
from working code until a second channel exists, and DTM, foliage and the
survey years are all meant to arrive as siblings.

Selecting a channel needs no new syntax, because a group carrying
`multiscales` *is* a channel and anything else is a root:

```
/terra-cognita.zarr/zarr.json                 first channel the root declares
/terra-cognita.zarr/height.dsm.fz/zarr.json   that channel, no root fetch
```

### Hosting

What the store is, as a hosting problem:

| | |
|---|---|
| Objects | 1,655 |
| Total | 74.58 GiB |
| Level-0 shards | 1,503, mean 46.4 MiB, max 88.3 MiB |
| Largest object | 97.2 MiB (a level-1 shard) |
| Per level-0 chunk | ~499 KiB |
| Whole shard-index layer | 2.4 MiB |

**Range requests are not optional.** Reading one chunk is a suffix request for
the shard index (`bytes=-1604`) and then a ranged read inside the shard. A host
that does not serve `Range` on static objects cannot serve this store at all,
and one that does not serve *suffix* ranges cannot either. `express.static`
does both, which is what the local dev proxy relies on. CORS is needed if the
store is not same-origin.

Object count and size rule out the git-adjacent options — GitHub Pages and
Releases, Netlify, Vercel — on size before anything else.

**Storage is nothing; egress is the bill.** 75 GiB costs a couple of pounds a
month anywhere. A user flying around at 1 m pulls tens of MiB per view, and
that is the number that scales with interest. So the choice is mostly about the
egress model: **Cloudflare R2** (zero egress, S3 API) or **Backblaze B2 behind
Cloudflare** (free egress via the Bandwidth Alliance) if traffic is
unpredictable; **S3 + CloudFront** if per-byte billing is acceptable;
**Source Cooperative** if the data can be public, since it exists for exactly
this shape of open geospatial data; a plain box running **nginx** if flat-rate
bandwidth and full control are preferred. Verify pricing directly — it moves.

**The gotcha to test first.** Several CDNs satisfy a range request by fetching
and caching the *whole* object, and cap the size of object they will cache. At
46–97 MiB per shard this store may sit near or above that cap, which would turn
every chunk read into an origin fetch and quietly undo the caching. Test one
real level-0 shard against the chosen CDN before committing to it.

Everything here is write-once, so `Cache-Control: public, max-age=31536000,
immutable` is honest.

**One object answers the metadata.** See _The consolidated index_ below: the
level ladder and all 1,641 shard indices in a single 1.01 MiB gzipped file, so
a cold reader makes one request rather than one per level plus one per shard
touched. It is the same bytes to serve however far a viewer roams, and being
immutable it caches once.

### The consolidated index

```bash
pnpm pipeline:defra -- index-zarr --store <zarr-dir>
```

Everything a reader needs to know before it can ask for a chunk, in one
object: the channel list, the level ladder, the encoding, and the slot table
of every shard.

| | |
|---|---|
| Size | 1.27 MiB, **1.01 MiB gzipped** |
| Covers | 153,124 chunks in 1,641 shards |
| Build time | under 2 s, reading the store |

Without it a cold reader pays a request per level and then a suffix request
for each shard's index before the first chunk in it. Against the national
store that is **16 requests down to 1** for the same 130 tiles, and the
per-shard round trip disappears for the rest of the session. Unsharded levels
list their present coordinates, which also retires the HEAD probe the reader
used to make per absent chunk.

Two things keep it honest:

**It is additive.** The per-node `zarr.json` and the trailing shard indices are
untouched, so zarrita and any other Zarr reader see the store exactly as
before. Every parse failure — missing, truncated, wrong version, unknown magic
— falls back to reading the store directly, which is also the path for a store
that was never indexed. Verified by hiding the file: 16 requests, same 130
tiles.

**It is derived.** It is built by reading what is on disk rather than
remembering what was written, so a resumed or partially rebuilt store still
indexes correctly, and a stale one is fixed by running the command again.

`uint32` pairs rather than the `uint64` the shard format uses, which halves
it — the largest shard is 97 MiB and the largest chunk 1.3 MB.

### Slot order

Building the index turned up something worth fixing. The offsets could not be
derived from a running total, because chunks were written in the order the pass
produced them — source-node order, which bears no relation to the shard's own
grid — and only **3 of 1,641** shards happened to come out in slot order.

The consequence is not really the index. It is that spatial neighbours are not
adjacent inside a shard, so a viewport of nine neighbouring chunks is nine
scattered ranges rather than a coalesced read, however clever the client is.

`writeShard` now sorts by slot before writing, which fixes every future run for
one line. The store already on disk did **not** need a re-run: the payload is
opaque HTJ2K, and a chunk's bytes do not depend on where in the file they sit,
so putting a shard in order is a permutation of byte ranges plus a fresh index —
disk speed rather than codec speed. `resort-zarr` does exactly that, shard by
shard, and is idempotent, so an interrupted pass resumes by being run again.

Each rewrite goes to a sibling temp file and is checked before it replaces the
original: the new file's own trailing index is read back and compared against
what the pass intended, and with `--verify` every chunk is read out through that
new index and checksummed against what went in. A bug in the offset arithmetic
costs a failed run rather than a corrupted store.

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

## Channels from the source rasters (`channel-zarr`)

The second channel, and so the first real test of the claim that this layout
makes siblings rather than parallel directory trees.

It cannot be transcoded like the heights: the v2 archive is FZ only — 150,474
codestreams, one channel — so the difference has to be taken back at the DEFRA
source, from the matched FZ/LZ composite zips. All 5,735 FZ quads have an LZ
partner, so dz coverage will equal height coverage exactly. Each quad is a 5 km
1 m GeoTIFF, which divides into exactly 25 store chunks, and since the sheet
origin is a multiple of 10 km a quad never straddles two shards — checked at run
time rather than assumed, because half a quad written into the wrong shard would
look like nothing at all.

Levels 1 upward are the same pyramid the heights use, so that half moved into
`pyramidBuild.ts` and both passes share it. The extraction is proved
byte-identical: NT60 renormalised before and after, `diff -r` clean.

**dz is not a canopy height model**, and the numbers say so plainly. A fifth to
a third of samples are negative, down to −30 m, because the composite merges
surveys flown at different times and LZ can sit above FZ over the same ground.
Those negatives are kept rather than clamped, so survey disagreement stays
visible instead of reading as flat bare ground. Coarse levels use plain area
mean, not the peak-preserving reduction the heights use: the mean of a
difference is the difference of the means, which keeps a coarse dz readable as
mean structure height, and peak-preserving would amplify exactly those outliers.

Verified on SU42 by reading 2M samples back out of the store and comparing
against FZ − LZ recomputed from the source rasters — which checks placement and
encoding together, since a chunk written to the wrong coordinate still decodes
perfectly. RMSE 1.4–2.0 cm per quad, worst case exactly half a step, nodata
agreeing exactly.

### Store LZ, not dz

dz was predicated on a difference being cheap to store. It is not — it costs
~58% of what the heights cost, because a difference of two surfaces is
noise-dominated where terrain is not. That premise gone, the question becomes
whether to store the last-return *surface* instead and let dz be derived.

The answer is yes, and not marginally. Because both surfaces sit on the height
channel's scale and offset, the offset cancels:

```
fz − lz = (fz_raw − lz_raw) × scale
```

so dz comes back in raw code space with no extra machinery. Measured on SU42,
against dz recomputed from the float source:

| | RMSE | worst | nodata |
|---|---|---|---|
| stored `height.aux.dz` @ 10 cm | 1.56–2.03 cm | 5.00 cm | exact |
| derived from FZ and LZ | **0.66–0.72 cm** | **2.18–2.22 cm** | exact |

Derived dz is **2.3× more accurate than the layer built to hold it**, bounded by
two half-steps of 10.8 mm rather than one half-step of 50 mm. Nodata is exactly
right because each surface carries its own reserved code and the intersection
falls out. So LZ does not merely replace dz — it strictly dominates it, and adds
a real surface that renders and can be analysed in its own right.

Same 100 chunks of SU42, level 0:

| | size |
|---|---|
| `height.dsm.fz` | 66.98 MiB |
| `height.dsm.lz` | **56.76 MiB** |
| `height.aux.dz` | 38.68 MiB |

LZ costs 47% more than dz, and 85% of what FZ costs — it is a terrain-like
surface and compresses like one. Nationally that projects to ~63 GiB against
~43 GiB for dz. It also runs faster, 22 s against 35 s for the same cell, since
it reads one raster per quad rather than two, and it covers more ground: 5,875
quads carry LZ against the 5,735 that carry both.

One constraint this creates. FZ and LZ **must** be reduced identically going up
the pyramid, or their difference stops meaning anything above level 0 — a
peak-reduced FZ measured against a mean-reduced LZ is not a canopy height. Both
use `heightReduction`, and that sharing is the reason it lives in
`pyramidBuild.ts` rather than in either pass.

`height.aux.dz` is kept as an option in the pass because the comparison is the
argument, but it is not the one to build.

### Lossy encoding is not worth it for dz

The v1 manifest always described dz as low-precision and gave it
`lossyQuality: 0.2`, so irreversible coding was the obvious lever once dz turned
out to cost nearly as much as the heights. Measured on six real chunks — two
wooded, two mixed, two mostly nodata — it is the wrong lever.

Matched on accuracy, plain lossless at a coarser scalar step beats irreversible
HTJ2K on every axis:

| RMSE | lossless step | size | p99.9 | lossy | size | p99.9 |
|---|---|---|---|---|---|---|
| ~1.0 cm | 5 cm | **427 KiB** | **2.5 cm** | 1 cm @ 5e-5 | 479 KiB | 4.3 cm |
| ~1.8 cm | 10 cm | **366 KiB** | **5.0 cm** | 2 cm @ 5e-5 | 409 KiB | 8.1 cm |
| ~3.5 cm | 20 cm | **306 KiB** | **10.0 cm** | 2 cm @ 1e-4 | 340 KiB | 16.2 cm |
| ~8.6 cm | 50 cm | **229 KiB** | **25.0 cm** | 20 cm @ 2e-5 | 272 KiB | 40.5 cm |

Consistently 10–16% smaller with a tail 1.6–2× tighter. Three reasons, and the
third is on its own decisive:

- The reversible 5/3 integer transform simply costs fewer bits than
  irreversible 9/7 at fine quantisation. Below qstep 2e-5 the lossy codestream
  is *larger* than the lossless one — 126% of it at 5e-6 — while still being
  less accurate.
- Scalar pre-quantisation has a bounded, uniform error of exactly half a step.
  Lossy has a long tail: p99.9 runs 4–8× the RMSE, and the ringing concentrates
  at building edges, which is precisely where dz carries its signal.
- **Nodata is a reserved code and the codec has no idea.** Raw 0 means "no
  measurement"; irreversible coding smears it. At the mildest useful setting
  that is already ~250 pixels per chunk with their nodata status wrong, rising
  to thousands. There is no quality setting that fixes this, because the
  problem is categorical rather than numerical.

So dz stays lossless, and the size knob is the step. At the current 10 cm the
national projection is ~58 GiB and ~14 h serial; 20 cm would take it to ~48 GiB
with a bounded 10 cm worst case, still comfortably inside the composite's own
~±15 cm vertical accuracy. 50 cm is where the error starts to exceed the
accuracy of the source and stops being free.

### Lossy is not worth it for LZ either, for different reasons

The dz result does not carry over and should not be assumed to: dz is a
noise-dominated difference, LZ is a smooth terrain surface, and irreversible 9/7
is built for the latter. Measured separately, lossy does genuinely compress LZ —
33% off at qstep 5e-5, where dz got nothing useful. It is still the wrong call.

| qstep | KiB/chunk | vs lossless | LZ worst | derived dz worst | bare ground still exactly 0 | nodata broken |
|---|---|---|---|---|---|---|
| lossless | 589 | 100% | 1.1 cm | **2.2 cm** | **100%** | 0 |
| 5e-6 | 743 | 126% | 3.2 cm | 4.2 cm | 100% | 0 |
| 1e-5 | 633 | 107% | 3.2 cm | 4.3 cm | 93.8% | 5 |
| 2e-5 | 524 | 89% | 5.7 cm | 6.6 cm | 68.4% | 188 |
| 5e-5 | 397 | 67% | 15.3 cm | 15.3 cm | 40.3% | 1,268 |
| 1e-4 | 311 | 53% | 35.1 cm | 34.2 cm | 28.0% | 2,991 |

**It forfeits the reason LZ was chosen.** At the setting that saves 33%, derived
dz is 15.3 cm worst — three times worse than the stored dz layer rejected above
at 5 cm, which costs about the same (43 GiB against 42). Lossy LZ is dominated
by the thing it replaced.

**The bare-ground collapse is the real damage, and RMSE hides it.** FZ and LZ
are the same measurement over open ground, so lossless coding makes dz there
*exactly* zero across about a fifth of the country. At the first setting that
saves anything at all — 11% — a third of those pixels stop agreeing, and dz
becomes low-amplitude speckle over fields instead of clean zero. That is a
change in what the layer looks like, not a shift in an error average.

**Nodata breaks categorically**, as it does for dz.

And as with dz, lossy is *larger* than lossless until qstep 2e-5: the first two
settings cost 26% and 7% extra for strictly worse output.

One lever is closed off here that was open for dz. dz could be shrunk by
coarsening its scalar step; LZ cannot, because it has to share FZ's scale or the
offsets stop cancelling and the raw-space subtraction goes away. Lossless at the
height scale is effectively the only configuration that keeps derived dz cheap
and exact.

**National LZ is therefore ~63 GiB lossless**, taking the store to ~138 GiB. If
that is too much to host, the honest lever is coverage rather than fidelity.

### The national LZ run, and a correction

Built in one attempt, 16:37 to 21:53 — 5h17m, no retries.

| level | chunks | objects | size |
|---|---|---|---|
| 0 (1 m) | 141,823 | 1,542 | 62.19 GiB |
| 1 (4 m) | 9,078 | 126 | 5.69 GiB |
| 2 (16 m) | 641 | 18 | 406.98 MiB |
| 3 (64 m) | 61 | 4 | 359.6 KiB |
| 4 (256 m) | 5 | 7 | 45.2 KiB |
| **total** | | | **68.27 GiB** |

Store now 145 GB over three channels; the consolidated index is 2.57 MiB
covering 302,817 chunks in 3,335 shards.

Derived dz verified on four widely separated cells — NT60ne, SJ69sw, TQ28ne,
SW62nw — at 0.58–0.74 cm RMSE. Two figures quoted earlier from SU42 alone do
not survive contact with the country:

- **Worst case is ~2.26 cm, not the 2.15 cm bound**, and
- **bare ground is exactly zero for 97.2–99.4% of samples, not 100%.**

One cause for both. LZ is written straight from the source raster and matches a
direct quantisation of it *exactly* — 0.00% of samples differ, worst 0 codes.
FZ came through the v2 archive, which normalises every chunk over its own
min/max before the national step is applied on top, and that double rounding
moves 0.56% of FZ samples by one code. One code is 2.152 cm, so the practical
worst drifts a little past `scale` and a few bare-ground pixels stop agreeing.

Worth knowing rather than fixing today, but it does mean **the stored dz layer
was better at exactly one thing**: computed from the source in one step, its
bare ground is exactly zero everywhere. Derived dz wins on accuracy by more than
2× and loses this by 1–3%. Rebuilding FZ from the source rasters rather than
from the v2 archive would give both, and would make FZ match LZ's provenance —
which is the natural thing to do anyway when a channel is next rebuilt.

### Existence is not completeness

The LZ store's coarse levels came out nearly empty and nothing reported it. At
level 3 the shard covering most of England and Wales held **2 chunks where it
should hold 55**, and the closing summary said "61 chunks" because it counted
coordinates rather than writes.

The two surviving chunks were `(18,6)` and `(18,7)` — exactly where SU42 lands.
They are the leftovers of a `--region SU42` test run made an hour earlier. That
run correctly wrote a level-3 shard containing the two chunks a 10 km cell
reaches; the national run then found the file present and skipped the whole
shard. Levels 1, 2 and 4 were poisoned the same way; level 3 was simply the most
visible, because one of its shards is 640 km across.

The predicate was `fileSize(shard) !== undefined`, on the reasoning that a shard
is renamed into place only once complete. That is true, and it is not the
question. **A shard is complete only relative to an expectation**, and a run with
a wider scope than the one that wrote it has a larger expectation. Nothing
failed, nothing was logged, and from the run's own point of view the shard was
finished — the worst shape a bug can take.

`shardIsComplete` now reads the shard's trailing index and checks that every
chunk *this* run wants is actually in it. One suffix read against a shard that
is ~100 MB of payload.

Deliberately **not** applied to level 0, where the old predicate is sound and the
new one would be wrong. A level-0 shard is a 10 km square and the smallest
region filter is a 10 km cell, so any run that touches one writes all of it. Its
contents are also data-dependent — an all-nodata chunk is legitimately never
written — so there is no fixed expectation to check against. Coarse levels have
neither property: a 10 km run reaches a 640 km level-3 shard, and every parent
coordinate is derived rather than data-dependent.

The repair rebuilt LZ's coarse levels in 6m47s with `--threads 10`, of which the
first 90 s was scanning level 0 to skip it. Level 3 shard `c/1/0` now holds 54 of 100 slots at 34.11 MiB against FZ's
55 at 35.71 MiB, slot-ordered; levels 1, 2 and 4 are comparable to FZ throughout.
The two stores' occupancy differs by a handful of coarse chunks in both
directions — three at level 3 — which is coverage, not damage: FZ came from the
v2 archive and LZ from the composite zips, and their footprints are not identical
at the edges.

Level 4 was still wrong after all that, and the reason is the same mistake one
layer down. `shardIsComplete` skipped unsharded levels outright — *"an unsharded
level is one chunk per object, so the file being there is the whole of the
claim"* — which is the fallacy the function exists to prevent, written into the
function itself. Level 4 is the first unsharded level (6x3 chunks, under the
10x10 shard threshold), so its objects were skipped on existence and LZ kept the
`--region SU42` run's leftovers: `4/c/4/1` still dated Aug 8 11:36 at 5,797 bytes
where FZ has 836,361. At the coarsest zoom the store showed one block of the
Pennines and a corner of Cornwall.

An unsharded object has no index, so nothing about the file distinguishes a chunk
reduced from two children from one reduced from sixteen. There is no local test.
What settles it is **whether anything below was rewritten**, which now propagates
up the pyramid level by level: a coarse object may be skipped only if it is
complete *and* nothing among its children changed. That also closes the case the
slot check cannot see — a present slot does not prove its contents were reduced
from every child that exists now. Callers report which level-0 coords they
re-encoded rather than which they requested, and the default is to treat
everything as rebuilt, so a caller that has not thought about it gets a correct
pyramid rather than a quietly stale one.

Worth naming the pattern, since it has now caused three separate faults in one
store: **every "it exists, so it must be finished" shortcut in this pipeline has
been wrong.** Finished is a claim about an expectation, and the expectation lives
in the run, not on the disk.

**Rebuilding data is not publishing it.** The repair was run by hand rather than
through the weekend script, and the manual path does not chain `dot_clean -m` and
`index-zarr` the way the script does. So the bytes were correct at 18:44 and the
viewer still showed the old broken coarse levels, because the consolidated index
it reads was a day stale and still carried the two-slot offsets. Same shape as
the bug above: nothing failed, nothing was logged, and the visible symptom
outlived its cause. Verified in the viewer afterwards — LZ renders as ground with
canopy and buildings gone, and zooms out through the coarse levels to a regional
view with no holes.

### A failing tile must not abort the run

Learned the hard way on the first national LZ attempt, which died 1h46m in on
`SJ69se` and then burned its five retries hitting the same file. Two separate
faults, both in the first 1,600 of 5,874 uncurated source quads:

- **`OV00sw` cannot be placed.** The grid library rejects the bottom row of the
  O square (OU, OV, OW) and DEFRA ships an OV00 quad. Offshore, 2.58 MB for a
  5 km tile, so near enough all nodata.
- **`LZ SJ69se` is a corrupt download.** `unzip -t` reports a bad CRC on the
  `.tif` entry, and the zip is 63.6 MB against its neighbours' 66–68 MB. Its FZ
  twin and all four neighbouring quads read fine, so it is one bad file rather
  than a parser limitation — it can be re-fetched.

Neither is interesting in itself. What matters is that either one could end a
six-hour pass, so the rule is now general across the passes: **a tile that
cannot be read, placed or decoded costs its own ground and nothing more.** It is
counted, named with its reason on its own log line, and repeated in the closing
summary, because a store with holes must not look like a store without them.
This covers the source-channel quad read, the renormalise level-0 chunk read —
which used to throw `vanished from` — and each child decode in the coarse-level
builder.

Verified byte-identical on NT60 against a baseline captured before any of it, so
the happy path is untouched.

One consequence to remember when repairing a source file: the shard containing
the hole is already written, and resume skips whole shards. Re-fetching
`SJ69se` means deleting `height.dsm.lz/0/c/90/36` before re-running, or the pass
will never look at it again.

## The codec pool (`--threads`)

Deferred twice, and the second deferral was wrong: three national passes in a
row wanted one. Node `worker_threads`, with the worker as a second rollup entry
rather than a bundler chunk, because `new Worker()` needs a file it can address
and an emitted chunk name is not something the pool can predict.

Size 0 runs inline on the calling thread, and that is also the fallback when the
worker file is absent — running from source, or a build that did not emit it. So
there is no second code path to keep in step and tests do not spawn threads.

Reads stay on the main thread, where the archive handle, the shard reader's
index cache and the resume logic already live. Only the codec crosses: decode,
requantise, downsample, encode.

On NT (1,330 level-0 chunks, 105 coarse), twelve-core machine, ten threads:

| | wall | speedup |
|---|---|---|
| inline | 103.9 s | — |
| level 0 pooled only | 60.6 s | 1.72x |
| level 0 and coarse pooled | **36.4 s** | **2.85x** |

The first number is the lesson. Parallelising level 0 alone looked disappointing
until it was clear the coarse levels are nearly half the work — 105 coarse
chunks each decode up to 16 children, so they carry as many decodes as level 0
does. Amdahl, arrived at empirically.

Byte-identical to the serial baseline at every step, which is only safe because
`writeShard` sorts by slot: chunks may complete in any order without changing
what lands on disk. Dither had to become a seed rather than a closure so it
survives crossing a thread boundary.

### The FZ rebuild, measured

19:53:57 → 02:31:31, **6h37m**, one attempt, no unreadable quads, no retries.
Level 0 took 6h21m of that; all four coarse levels took 16 minutes.

| | old (archive transcode) | rebuilt (composite zips) |
|---|---|---|
| L0 | 1,503 shards, 143,185 chunks, 69,772.5 MiB | 1,503 shards, **136,650** chunks, 69,754.9 MiB |
| L1 | 119 shards, 9,232 chunks, 6,060.7 MiB | 119 shards, 8,850 chunks, 6,059.7 MiB |
| L2 | 16 shards, 641 chunks, 492.2 MiB | 16 shards, 623 chunks, 492.2 MiB |
| L3 | 3 shards, 59 chunks, 36.0 MiB | 3 shards, 57 chunks, 36.0 MiB |
| L4 | 7 chunks, 2.63 MiB | 7 chunks, 2.43 MiB |

Same shards, near-identical bytes, **6,535 fewer chunks**. Every one of those is
exactly 2,463 bytes — the all-nodata chunk, a constant size because the payload is
uniform. The v2 archive carried them (the walk that found "6,556 sub-3 KB
all-nodata level-0 tiles" is the same population); the source-raster pass drops a
chunk with no finite sample, so 15.3 MiB of empty objects goes away. The rebuild
has nothing the transcode lacks, in either direction.

Agreement, over 501 million samples across seven level-0 shards sampled evenly
through the row-ordered list:

- **0.96%** of samples differ, ranging 0.69%–1.92% by shard
- every difference is **exactly one code** — 2.152 cm
- **zero** nodata mismatches: the two agree exactly on where data is

That is the double quantisation and nothing else, which is what the rebuild was
for. (NT60 alone measured 2.50%, so the single-cell figure quoted when the spec
landed is not representative — 0.96% is the national number.)

### The smoke test poisoned the tile the fix would have saved

The rebuilt FZ came out with its northernmost coarse tile, level-4 `4/c/2/1`,
holding **589 valid samples** where LZ has 156,094 — 4,635 bytes against 218,274.
Everything below it was healthy: the six level-3 children under that tile carry
81k–880k valid samples each, and level 0 has 10,071 chunks in its footprint.
Rebuilding level 4 from the same on-disk level 3 gives 151,121 valid samples, so
nothing was ever unreadable.

It is the unsharded-level fault again, and the chain is entirely self-inflicted:

- The `--region NT60` smoke test, run twice while getting the launcher working,
  wrote `4/c/2/1` from one 10 km cell. NT60 lands in level-4 row 2, column 1 —
  that tile and no other.
- The national run started at 19:53:57 from a CLI snapshot taken at **19:49:28**.
  The fix for exactly this was committed at **22:14:50**, two and a half hours
  later. The snapshot has no `rebuiltCoords` and no `nextDirty`.
- So the run found the object present, called it complete, and skipped it.

The other six level-4 tiles came back **byte-identical** on rebuild, which is the
proof that only the smoke-tested one was affected. The sharded levels were never
at risk: `shardIsComplete` predates the snapshot, so levels 1–3 saw NT60's shards
as short against a national expectation and rebuilt them.

Two things worth keeping. A snapshot pinned for stability is also a snapshot
pinned against fixes, and the window between taking one and finding a bug is
exactly when that hurts. And **a smoke test writes to the store it smokes** — the
NT60 trial was the right call and it left a landmine, because it wrote into the
channel the national run was about to resume into.

### The swap

The swap is a rename plus two metadata edits: `height.dsm.fz` →
`height.dsm.fz.v2archive`, the rebuild into its place, `channelId` and the
multiscales `name` repointed, and the root channel list left naming three
channels. The parked copy stays on disk but **out of `psychogeo.channels`**,
which is what the index and the viewer's picker enumerate — so it is neither
indexed nor offered, and reinstating it is one line of JSON. The index went from
449,216 chunks over 4 channels to 296,092 over 3.

**Do not carry 2.85× over to a source-raster pass.** That table is the
renormalise pass, which reads chunks from an archive; a channel pass reads four
5000² float32 GeoTIFFs — ~400 MB — out of a zip per quad, and that is main-thread
I/O the pool cannot touch. The national FZ rebuild measures **3.31 s/quad on ten
threads against 4.14 s/quad serial: 1.25×**, at ~123% CPU. It is disk-bound off
the USB volume, and threads past a handful buy nothing. I estimated 1.8–2× before
measuring and was wrong; the coarse levels still parallelise as the table says,
they are just a small share of a level-0-dominated run.

### Co-chunking channels does not help

The idea was that FZ and LZ are the same measurement over bare ground and differ
only by what stands on it, so a codec ought to be able to exploit the
correlation. Measured over four chunks, lossless throughout:

| layout | mean KiB per chunk-pair | vs separate |
|---|---|---|
| separate 1-component codestreams | 1334 | — |
| one 2-component codestream | 1334 | **−0.0%** |
| FZ + dz at the height scale | 1300 | −2.6% |

**Multi-component is byte-for-byte identical to separate**, and the reason is
worth pinning down, because "add a third channel and it will kick in" is the
obvious next thought.

Decisive test: encode the *same* band three times. With a reversible colour
transform running, `Y1 = C2 - C1 = 0` and `Y2 = C0 - C1 = 0`, so two of three
bands are entirely zero and the result should collapse to about 1x one band. It
comes out at **3.00x** — 951 KiB against 2854 KiB. openjph applies no
multi-component transform at all, at any component count.

Nor would it pay if it did. Part 1 defines the transform as a *fixed* one over
components 0, 1, 2 — built for RGB to luma-chroma, not a general decorrelator.
Feed it (FZ, LZ, FZ) and `Y1 = Y2 = dz`: the same difference band twice, plus a
mean, so the redundant duplicate is paid for twice over. Measured directly, the
padded three-component layout costs **+52.5%** against storing FZ and LZ
separately.

Part 2 (15444-2) does define generalised multiple component transforms —
arbitrary component counts, array-based decorrelation, a wavelet across the
component axis — which is the thing that would genuinely suit correlated height
surfaces. Worth checking against the standard rather than taking on trust here;
OpenJPH targets Part 1 plus Part 15's block coder.

So the correlation is real and worth money — dz codes ~30% cheaper than LZ over
bare rural ground — but no codec path in this toolchain reaches it. The only
lever that does is choosing what to store.

Difference coding does reach the correlation, but the mean hides the spread:
NT94nw −30.6% where dz is near zero over bare rural ground, but SU42ne **+2.2%**
and SU42sw **+3.8%** where canopy and buildings make dz expensive. And it would
cost every reader that wants one channel the bytes of two, where sibling groups
let a reader fetch only what it asked for. Channels stay siblings.

## Open

- **The SJ69se hole is not in the final summary.** The flag fired on the run
  that hit it, but the restart resumed past the already-written shard, so the
  run that produced the closing summary never saw it. Per-run reporting is not
  the same as a store-level record of what is missing, and only the latter
  survives a resume.
- **`LZ SJ69se` is a corrupt source download**, leaving a 5 km hole in LZ where
  FZ has data. Re-fetch, delete `height.dsm.lz/0/c/90/36`, re-run.
- **LZ nationally.** Only SU42 exists so far, ~22 s for a 10 km cell, so roughly
  9 h serial for 5,875 quads — the same argument for the worker pool the height
  pass already makes.
- **Whether to keep the stored dz layer at all.** SU42 has one, 42 MiB, now
  superseded by derived dz. Left in place rather than deleted because it is the
  evidence for the comparison and rebuilds in 35 s.
- **Deriving dz in the reader.** The subtraction is exact and cheap but nothing
  in the browser does it yet; the tile pipeline fetches one channel per tile.
- **zfp was prototyped and lost** — see [python/codec-eval](../../python/codec-eval/README.md).
  At matched error it is 30–40% larger than uint16 + lossless J2K, because a
  1 km height tile spans ~100–200 m and 16 bits fits that far better than
  float32 with an exponent range zfp cannot exploit. HTJ2K stays, which also
  keeps the codestream's wavelet subbands available for analysis.
- **Dither** is settled for normal use (off) — see above. What is not settled is
  whether fine-interval contours are a mode worth supporting, since that is the
  only case where it pays.
- **Why a load fails in the first place.** Retrying recovers it, but nothing
  yet says what the transient failure *is*. A terminal failure now warns with
  the URL, so the next occurrence should name itself.
- **Whether a refined chunk should keep its ancestor.** `descend()` replaces a
  coarse chunk with its children outright, on the reasoning that a sparse
  pyramid should show a hole rather than two levels fighting for the same
  ground. The tree's retained pool and coverage mask cover the case where the
  coarse tile was already drawn, but not a camera jump into cold ground. No
  artefact has been traced to this — the holes that looked like it were the
  retry bug, and the coarse-over-fine that looked like it was the mask
  resolution — so it stays a design question rather than a known defect.
- **Parallelise the codec.** Deferred rather than blocking: the serial national
  run took 2 h 43 min at ~170% CPU on a 12-core machine, and every millisecond
  of it is openjph, so a `worker_threads` pool should take it to well under an
  hour. That matters once DTM, the FZ−LZ foliage measure and the survey years
  each want a run of their own — this pass is going to be run several more
  times, not once.
- **The other channels.** The store has one array group and the layout was
  chosen so DTM, foliage and survey years become siblings rather than parallel
  directory trees. Nothing has tested that claim yet; the second channel is
  what will.
- **Nodata** is still the reserved raw 0 rather than a real sentinel; only a
  re-encode from the source TIFFs could change that.
- **Which store wins.** The repack and the renormalisation both exist; if the
  renormalised one holds up in the viewer there is little reason to keep the
  repack beyond its value as a byte-identity reference.
- **AppleDouble sidecars.** macOS writes a `._` file beside every object
  written to exFAT. The national run accumulated 1,759 of them against 1,655
  real objects, each costing a 1 MiB allocation unit. `dot_clean -m <store>`
  clears them in about a second and has been run; anything that copies the
  store onward should run it again.
- **Coalescing the reads slot order now allows.** The store is in slot order, so
  a run of adjacent chunks is a run of adjacent bytes, but the reader still asks
  for each chunk as its own `Range`. Merging neighbouring ranges within a shard
  is the payoff and has not been written yet.
- **Deriving shard offsets from lengths.** In an ordered, gap-free shard the
  offset of a slot is the sum of the lengths before it, so the consolidated
  index could carry lengths alone and halve again. Left as it is because storing
  offsets keeps the index able to describe *any* store, ordered or not, and the
  saving is under a megabyte.
- **Retiring the bespoke index** was not a goal of this pass, so
  `metadata.json` and the 8,772 node manifests remain the source of truth.
  Most of what `derive.ts` computes is chunk-key arithmetic in this layout.
- **`index_location`** is `end`, so a cold read costs a suffix request before
  the first chunk. `start` would trade that for a rewrite on append.
