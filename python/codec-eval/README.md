# codec-eval

Compares candidate array codecs against the encoding the terrain pipeline
currently ships, on real DEFRA source tiles.

The shipped `height.dsm.fz` chunks are uint16-normalised per chunk and then
HTJ2K encoded **losslessly**, so all the precision we lose today happens at the
normalisation step. That is the number any alternative has to beat — or match
while removing the per-chunk metadata the Zarr store has to carry alongside its
arrays (see [../../docs/planning/zarr-transcode.md](../../docs/planning/zarr-transcode.md)).

zfp is the first alternative under test because it compresses floats directly.

## Run

```bash
cd python/codec-eval
uv run codec-eval --zip "L:/GIS/DEFRA/composite-zips/LIDAR-FZ_DSM-1m-2022-SU42ne.zip" --tiles 4
```

`--tolerances` sets the zfp fixed-accuracy sweep in metres.

Windows are the same 1 km cuts the pipeline makes, ordered most-populated
first, so nodata does not dominate the comparison.

## Results so far

Per 1 km window, 1000² float32 (4.00 MB raw). SU42ne is Hampshire chalk
downland, NT70se is Southern Uplands.

| Encoding | SU42ne r0c0 | NT70se r0c0 | Max error |
|----------|-------------|-------------|-----------|
| uint16 **per-chunk** + lossless J2K (as shipped) | 1.020 MB | 1.163 MB | 0.8–1.6 mm |
| uint16 **global** −10..1400 m + lossless J2K | **0.574 MB** | **0.801 MB** | 10.8 mm |
| zfp reversible | 2.425 MB | 2.513 MB | exact |
| zfp accuracy 0.05 m | 1.019 MB | 1.260 MB | 13–14 mm |
| zfp accuracy 0.01 m | 1.269 MB | 1.510 MB | 3.2–3.4 mm |

Two findings, both consistent across lowland and upland tiles:

**zfp is dominated on this data.** At matched error it is consistently larger:
zfp needs 1.26 MB to reach 14 mm on NT70se, where global uint16 + J2K reaches
10.8 mm in 0.80 MB — 36% smaller at slightly better accuracy. The reason is
structural: the per-sample height range of a 1 km tile is ~100–200 m, so 16
bits is a very good fit, and zfp has to carry float32's exponent range it
cannot exploit.

**Per-chunk normalisation is costing 31–44% in size to preserve precision the
data does not have.** A ~1.4 mm quantisation step is roughly 100× finer than
DEFRA LIDAR's ~±150 mm vertical accuracy, so a large share of those bits are
encoding sensor noise losslessly. Dropping to one national scale/offset gives a
~21 mm step — still an order of magnitude inside the sensor's accuracy — and
the files get substantially *smaller* while `encoding/scale` and
`encoding/offset` disappear entirely.

That makes the interoperable option and the cheap option the same option, which
is not how these usually go.

**Reaching it from the shipped data costs almost nothing.** Requantising what is
already on disk, rather than going back to the TIFFs, adds only the existing
quantiser's own error on top:

| | from source | from shipped | Δ |
|---|---|---|---|
| max error | 10.77 mm | 11.56 mm | +0.79 mm |
| rms error | 6.21 mm | 6.23 mm | +0.02 mm |
| encoded size | 0.574 MB | 0.574 MB | — |

Which is exactly the composition you would predict: max error goes as
`(s₁+s₂)/2` — the window ships at 0.84 mm and gains 0.79 mm — and rms in
quadrature, `√(6.21² + 0.48²) = 6.229` against 6.23 measured. About 1.8% of
samples land one uint16 level away from where the direct route puts them.

So the re-encode does not need the source zips. What it does need is CPU: it is
a decode and re-encode of every chunk rather than the byte copy the repack was.
Going back to source would only be worth it for the things requantisation
cannot recover — real nodata sentinels instead of the reserved `0`, or
revisiting the 1 km windowing and apron.

Caveats: five windows from two 5 km tiles, all 100% valid, both in England /
southern Scotland. Nodata behaviour under global normalisation is untested, and
a wider sample would firm up the percentages.

## Dithering

`uv run codec-dither --zip <...>` asks whether the coarser global step needs
dither, measured where it shows: the shading normal, not the height.

| | size | rms | normal err mean | p95 | flat 3×3 |
|---|---|---|---|---|---|
| per-chunk (1.4 mm step) | 1.020 MB | 0.48 mm | 0.02° | 0.04° | 0.000% |
| global plain (21.5 mm) | 0.574 MB | 6.21 mm | 0.27° | 0.55° | 0.025% |
| global + TPDF dither | 0.589 MB | 10.76 mm | 0.46° | 0.99° | 0.006% |

The surface is often smoother than the step — 24–59% of samples have less than
one step of local roughness, and the 1st percentile is a quarter of a
millimetre — so the data does **not** reliably dither itself. But actual
terraces are rare: 0.02–0.05% of 3×3 neighbourhoods quantise flat, and dither
cuts that by 4–8× for +0.4–2.6% in size.

The trade is structure against magnitude. Dither roughly doubles the normal
error while decorrelating it, and structured banding is perceptually worse than
noise at equal amplitude. At a p95 of 0.5° undithered, both are close enough to
the visibility threshold that no further statistic will settle it — it wants an
eyeball test in the renderer, which is why the renormalisation pass takes dither
as a flag rather than a decision.

## Caveat

The lossless J2K baseline is encoded here with OpenJPEG rather than the
pipeline's OpenJPH, because there is no HTJ2K encoder in `imagecodecs`. Lossless
J2K and lossless HTJ2K are close but not identical, so treat that row as
indicative of the shipped size and the real `.j2c` files on disk as ground
truth.
