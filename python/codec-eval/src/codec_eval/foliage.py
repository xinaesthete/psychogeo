"""Candidate encodings for a compact foliage layer derived from dz = FZ - LZ.

`height.aux.dz` stored the difference at 1 m and 10 cm, and cost ~58% of what
the heights cost, because canopy penetration at 1 m is close to a random draw
from a stand-level distribution: neighbouring pixels under the same tree differ
by metres. That is real measurement, but it is not the information a foliage
layer needs, and a lossless codec has to pay for all of it.

This module measures what a low-pass costs and what it buys, against the
products a foliage layer actually consumes: mean penetration depth and canopy
cover fraction over a rendering-scale block.
"""

from __future__ import annotations

import io
import os
import zipfile
from dataclasses import dataclass
from pathlib import Path

import imagecodecs
import numpy as np
import tifffile

def _zip_root() -> Path:
    """Where the matched FZ/LZ composite zips live.

    Taken from the environment rather than hard-coded: a worktree does not
    inherit the main checkout's `.env`, and a wrong absolute path here fails by
    finding nothing rather than by saying so.
    """
    explicit = os.environ.get("TERRACOGNITA_DEFRA_COMPOSITE_ZIPS")
    if explicit:
        return Path(explicit)
    gis = os.environ.get("MAPSYNTH_GIS_ROOT")
    if gis:
        return Path(gis) / "DEFRA" / "composite-zips"
    raise SystemExit(
        "Set TERRACOGNITA_DEFRA_COMPOSITE_ZIPS (or MAPSYNTH_GIS_ROOT) to the "
        "directory holding LIDAR-FZ_DSM-1m-2022-*.zip. See .env.example."
    )


ZIP_ROOT = None  # resolved per run, so an unset root reports itself

# As in compare.py: these rasters disagree about the sentinel, and nothing real
# in Britain sits a kilometre below sea level.
NODATA_BELOW = -1000.0

CHUNK_PIXELS = 1000  # the store's level-0 chunk, 1 km at 1 m

# A pixel is called canopy when the beam got more than this far past the first
# return. Below it, first and last return are the same opaque surface.
COVER_THRESHOLD_M = 1.0


def read_quad(cell: str, kind: str, zip_root: Path | None = None) -> np.ndarray:
    """One 5 km 1 m composite quad as float32, sentinels left as they came."""
    root = zip_root if zip_root is not None else _zip_root()
    path = root / f"LIDAR-{kind}_DSM-1m-2022-{cell}.zip"
    with zipfile.ZipFile(path) as archive:
        name = next(n for n in archive.namelist() if n.lower().endswith(".tif"))
        with archive.open(name) as handle:
            data = tifffile.imread(io.BytesIO(handle.read()))
    return np.asarray(data, dtype=np.float32)


def difference(first: np.ndarray, last: np.ndarray) -> np.ndarray:
    """FZ - LZ with either side missing making the difference missing (NaN)."""
    valid = (
        np.isfinite(first)
        & np.isfinite(last)
        & (first > NODATA_BELOW)
        & (last > NODATA_BELOW)
    )
    return np.where(valid, first - last, np.nan).astype(np.float32)


def windows(quad: np.ndarray, size: int = CHUNK_PIXELS):
    """The store's chunk cuts, as (row, col, view) triples."""
    rows = quad.shape[0] // size
    cols = quad.shape[1] // size
    for r in range(rows):
        for c in range(cols):
            yield r, c, quad[r * size : (r + 1) * size, c * size : (c + 1) * size]


# --- block reductions -------------------------------------------------------


def block_view(values: np.ndarray, block: int) -> np.ndarray:
    """Reshape HxW into (H/b, W/b, b*b) so a reduction is one axis."""
    h, w = values.shape
    return (
        values.reshape(h // block, block, w // block, block)
        .swapaxes(1, 2)
        .reshape(h // block, w // block, block * block)
    )


def block_mean(values: np.ndarray, block: int) -> np.ndarray:
    """NaN-skipping block mean; a block with no valid sample stays NaN."""
    cells = block_view(values, block)
    with np.errstate(invalid="ignore"):
        return np.nanmean(cells, axis=2)


def block_fraction_above(values: np.ndarray, block: int, threshold: float) -> np.ndarray:
    """Fraction of a block's *valid* samples above a threshold."""
    cells = block_view(values, block)
    valid = np.isfinite(cells)
    count = valid.sum(axis=2)
    hits = (valid & (cells > threshold)).sum(axis=2)
    with np.errstate(invalid="ignore"):
        return np.where(count > 0, hits / np.maximum(count, 1), np.nan)


def block_percentile(values: np.ndarray, block: int, q: float) -> np.ndarray:
    cells = block_view(values, block)
    with np.errstate(invalid="ignore"):
        return np.nanpercentile(cells, q, axis=2)


# --- reference products -----------------------------------------------------


@dataclass(frozen=True)
class Reference:
    """What a foliage layer is for, computed from the float source."""

    scale: int
    depth: np.ndarray  # mean of max(dz, 0) over the block, metres
    cover: np.ndarray  # fraction of valid samples with dz > COVER_THRESHOLD_M
    top: np.ndarray  # p90 of dz over the block, a canopy-top proxy


def reference(dz: np.ndarray, scale: int) -> Reference:
    positive = np.where(np.isfinite(dz), np.maximum(dz, 0.0), np.nan)
    return Reference(
        scale=scale,
        depth=block_mean(positive, scale),
        cover=block_fraction_above(dz, scale, COVER_THRESHOLD_M),
        top=block_percentile(positive, scale, 90.0),
    )


# --- encoding ---------------------------------------------------------------


def encode_htj2k(raw: np.ndarray) -> bytes:
    """Lossless HTJ2K, matching `encodeChunk`: one component, reversible."""
    return imagecodecs.htj2k_encode(np.ascontiguousarray(raw), reversible=True)


def quantise(values: np.ndarray, step: float, lo: float, dtype) -> np.ndarray:
    """Scalar quantisation with raw 0 reserved for nodata, as the store does."""
    top = np.iinfo(dtype).max
    raw = np.zeros(values.shape, dtype=dtype)
    finite = np.isfinite(values)
    level = np.rint((values[finite] - lo) / step) + 1
    raw[finite] = np.clip(level, 1, top).astype(dtype)
    return raw


def dequantise(raw: np.ndarray, step: float, lo: float) -> np.ndarray:
    out = (raw.astype(np.float64) - 1.0) * step + lo
    return np.where(raw == 0, np.nan, out)


# --- candidates -------------------------------------------------------------

DEPTH_MAX_M = 64.0  # a block *mean* penetration; the deepest woodland is well inside this
DZ_MIN_M = -40.0
DZ_MAX_M = 400.0


@dataclass(frozen=True)
class Encoded:
    """What one candidate produced for one chunk."""

    name: str
    nbytes: int
    field: np.ndarray  # decoded penetration depth, metres, NaN nodata
    field_scale: int  # metres per pixel of `field`
    cover: np.ndarray | None = None  # decoded cover fraction, when carried
    cover_scale: int = 0


def relu(dz: np.ndarray) -> np.ndarray:
    return np.where(np.isfinite(dz), np.maximum(dz, 0.0), np.nan)


def box_blur(values: np.ndarray, radius: int) -> np.ndarray:
    """NaN-skipping box mean over a (2r+1)² window, via summed-area tables."""
    finite = np.isfinite(values)
    filled = np.where(finite, values, 0.0).astype(np.float64)
    weight = finite.astype(np.float64)

    def windowed(plane: np.ndarray) -> np.ndarray:
        padded = np.pad(plane, radius, mode="edge")
        table = padded.cumsum(0).cumsum(1)
        table = np.pad(table, ((1, 0), (1, 0)))
        h, w = values.shape
        size = 2 * radius + 1
        return (
            table[size:, size:]
            - table[:-size, size:]
            - table[size:, :-size]
            + table[:-size, :-size]
        )

    total = windowed(filled)
    count = windowed(weight)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(count > 0, total / np.maximum(count, 1e-9), np.nan)


def median_filter3(values: np.ndarray) -> np.ndarray:
    """3x3 median, NaN-preserving. Kills isolated single-pixel penetrations."""
    padded = np.pad(values, 1, mode="edge")
    stack = np.stack(
        [padded[r : r + values.shape[0], c : c + values.shape[1]] for r in range(3) for c in range(3)]
    )
    with np.errstate(invalid="ignore"):
        out = np.nanmedian(stack, axis=0)
    return np.where(np.isfinite(values), out, np.nan)


def binary_reduce(mask: np.ndarray, radius: int, how: str) -> np.ndarray:
    """Binary erosion (`min`) or dilation (`max`) over a (2r+1)² square."""
    padded = np.pad(mask, radius, mode="edge")
    span = 2 * radius + 1
    out: np.ndarray | None = None
    for r in range(span):
        for c in range(span):
            window = padded[r : r + mask.shape[0], c : c + mask.shape[1]]
            out = window if out is None else (out & window if how == "min" else out | window)
    assert out is not None
    return out


def opening(mask: np.ndarray, radius: int) -> np.ndarray:
    """Erode then dilate: anything thinner than the element disappears, blobs stay."""
    return binary_reduce(binary_reduce(mask, radius, "min"), radius, "max")


def canopy_mask(dz: np.ndarray, radius: int) -> np.ndarray:
    """Where the beam got past the first return *and* the neighbourhood agrees.

    A roof is opaque, so a building's interior has dz ~ 0 — but its *perimeter*
    does not: the first return is the roof edge and the last is the ground
    beside it, so a one-pixel outline of every building in the country reads as
    several metres of canopy. It is thin, and canopy is not, so an opening
    separates them. Hedgerows survive it: at 1 m a hedge is 2-4 pixels of
    overhanging crown, not a line.
    """
    return opening(np.isfinite(dz) & (dz > COVER_THRESHOLD_M), radius)


def compand(depth: np.ndarray, levels: int = 255, ceiling: float = DEPTH_MAX_M) -> np.ndarray:
    """Square-root companding to `levels` codes: fine near zero, coarse in the canopy.

    A mean penetration depth needs centimetres of resolution around the
    bare-ground/canopy boundary and nothing like that at 30 m, so a linear step
    spends most of its codes where nothing happens.
    """
    raw = np.zeros(depth.shape, dtype=np.uint8)
    finite = np.isfinite(depth)
    normalised = np.sqrt(np.clip(depth[finite], 0.0, ceiling) / ceiling)
    raw[finite] = np.clip(np.rint(normalised * levels) + 1, 1, levels + 1).astype(np.uint8)
    return raw


def expand(raw: np.ndarray, levels: int = 255, ceiling: float = DEPTH_MAX_M) -> np.ndarray:
    normalised = (raw.astype(np.float64) - 1.0) / levels
    return np.where(raw == 0, np.nan, normalised * normalised * ceiling)


def candidate_stored_dz(dz: np.ndarray, step: float) -> Encoded:
    """The shipped `height.aux.dz`: signed difference at 1 m, lossless."""
    raw = quantise(dz, step, DZ_MIN_M, np.uint16)
    payload = encode_htj2k(raw)
    return Encoded(f"dz 1 m @ {step * 100:.0f} cm", len(payload), relu(dequantise(raw, step, DZ_MIN_M)), 1)


def candidate_relu_dz(dz: np.ndarray, step: float) -> Encoded:
    """Negatives clamped, still 1 m. Isolates what the sign costs on its own."""
    raw = quantise(relu(dz), step, 0.0, np.uint16)
    payload = encode_htj2k(raw)
    return Encoded(f"relu(dz) 1 m @ {step * 100:.0f} cm", len(payload), dequantise(raw, step, 0.0), 1)


def candidate_blur(dz: np.ndarray, radius: int, step: float) -> Encoded:
    """Low-pass with no decimation. Isolates what smoothing costs on its own."""
    raw = quantise(box_blur(relu(dz), radius), step, 0.0, np.uint16)
    payload = encode_htj2k(raw)
    return Encoded(
        f"blur r{radius} 1 m @ {step * 100:.0f} cm", len(payload), dequantise(raw, step, 0.0), 1
    )


def candidate_mean(
    dz: np.ndarray,
    block: int,
    *,
    step: float | None = None,
    dtype=np.uint8,
    deadband: float = 0.0,
    prefilter: str | None = None,
    lossy: float | None = None,
) -> Encoded:
    """Block-mean penetration depth at `block` metres, with an optional deadband.

    The block mean *is* the low-pass and the decimation in one operation, and
    for a mean-depth product it is exactly the right one: the mean of a mean
    over aligned blocks is the mean over the union, so the value a coarser
    level wants is already what a finer level holds.

    `deadband` floors everything below it to exactly zero. Bare ground is not
    silent — first and last return disagree by a few millimetres of float noise
    — and the block mean of `relu` turns that into a small positive number that
    differs in every cell. That costs real bits and says nothing, because
    sub-decimetre penetration is not foliage.
    """
    depth = relu(dz)
    label_prefilter = ""
    if prefilter == "median":
        depth = median_filter3(depth)
        label_prefilter = " med3"
    coarse = block_mean(depth, block)

    label_dead = ""
    if deadband > 0:
        coarse = np.where(np.isfinite(coarse) & (coarse < deadband), 0.0, coarse)
        label_dead = f" dead{deadband * 100:.0f}"

    if step is None:
        raw = compand(coarse)
        field = expand(raw)
        label_code = "u8 sqrt"
    else:
        raw = quantise(coarse, step, 0.0, dtype)
        field = dequantise(raw, step, 0.0)
        label_code = f"{np.dtype(dtype).name} @ {step * 100:.0f} cm"

    if lossy is None:
        payload = encode_htj2k(raw)
        label_mode = ""
    else:
        payload = imagecodecs.htj2k_encode(
            np.ascontiguousarray(raw), reversible=False, level=lossy
        )
        field = _decode_like(payload, raw, step)
        label_mode = f" lossy{lossy}"

    name = f"mean{label_prefilter} {block} m{label_dead} {label_code}{label_mode}"
    return Encoded(name, len(payload), field, block)


def _decode_like(payload: bytes, raw: np.ndarray, step: float | None) -> np.ndarray:
    decoded = imagecodecs.htj2k_decode(payload).astype(raw.dtype)
    return expand(decoded) if step is None else dequantise(decoded, step, 0.0)


def candidate_reduction(dz: np.ndarray, block: int, how: str, levels: int = 255) -> Encoded:
    """Something other than the mean over the block.

    A mean penetration depth is not a canopy top: under a closed stand the mean
    is pulled down by every beam that stopped in the crown. A high percentile
    is closer to what a renderer wants to stand a tree on.
    """
    depth = relu(dz)
    if how == "mean":
        coarse = block_mean(depth, block)
    elif how == "max":
        with np.errstate(invalid="ignore"):
            coarse = np.nanmax(block_view(depth, block), axis=2)
    else:
        coarse = block_percentile(depth, block, float(how))
    raw = compand(coarse, levels=levels)
    payload = encode_htj2k(raw)
    return Encoded(f"{how} {block} m u8/{levels + 1}", len(payload), expand(raw, levels=levels), block)


def candidate_conditional(dz: np.ndarray, block: int, cover_block: int, cover_levels: int) -> Encoded:
    """Cover fraction, plus the mean depth *of the covered pixels only*.

    depth = cover x conditional_depth, and the conditional depth is roughly the
    stand's canopy thickness — near constant inside a wood, where the product
    swings from 0 to 20 m across every edge. If that is true it should code
    much more cheaply than the product does.
    """
    cover = block_fraction_above(dz, block if cover_block == 0 else cover_block, COVER_THRESHOLD_M)
    canopy = np.where(np.isfinite(dz) & (dz > COVER_THRESHOLD_M), dz, np.nan)
    cells = block_view(canopy, block)
    counts = np.isfinite(cells).sum(axis=2)
    with np.errstate(invalid="ignore"):
        conditional = np.where(counts > 0, np.nansum(cells, axis=2) / np.maximum(counts, 1), np.nan)
    # A block with no canopy has no conditional depth; zero is the cheapest fill
    # and the cover plane already says to ignore it.
    conditional = np.where(np.isfinite(conditional), conditional, 0.0)
    conditional = np.where(np.isfinite(block_mean(dz, block)), conditional, np.nan)

    cover_raw = quantise(cover, 1.0 / cover_levels, 0.0, np.uint8)
    depth_raw = compand(conditional)
    payload = len(encode_htj2k(cover_raw)) + len(encode_htj2k(depth_raw))

    cover_hat = dequantise(cover_raw, 1.0 / cover_levels, 0.0)
    if cover_block and cover_block != block:
        factor = cover_block // block
        cover_hat = np.repeat(np.repeat(cover_hat, factor, axis=0), factor, axis=1)
    field = np.where(np.isfinite(cover_hat), cover_hat * expand(depth_raw), np.nan)
    label = f"cover({cover_levels})@{cover_block or block}m x cond {block} m"
    return Encoded(label, payload, field, block, cover=cover_hat, cover_scale=block)


def candidate_foliage(
    dz: np.ndarray,
    *,
    block: int = 4,
    radius: int = 1,
    step: float = 0.25,
    deadband: float = 0.25,
) -> Encoded:
    """The whole proposed pass: de-edge, block mean, deadband, 8-bit, lossless."""
    depth = relu(dz)
    label = f"foliage {block} m"
    if radius:
        keep = canopy_mask(dz, radius)
        depth = np.where(keep, depth, np.where(np.isfinite(dz), 0.0, np.nan))
        label += f" open{radius}"
    coarse = block_mean(depth, block)
    coarse = np.where(np.isfinite(coarse) & (coarse < deadband), 0.0, coarse)
    raw = quantise(coarse, step, 0.0, np.uint8)
    return Encoded(label, len(encode_htj2k(raw)), dequantise(raw, step, 0.0), block)


def candidate_cover_and_depth(
    dz: np.ndarray, block: int, *, deadband: float = 0.0, cover_levels: int = 254
) -> Encoded:
    """Two planes: canopy cover fraction, and mean penetration depth.

    Cover is the thing a mean depth cannot express — half a block of 6 m canopy
    and a whole block of 3 m scrub reduce to the same number — so the question
    is whether that distinction is worth a second plane.
    """
    cover = block_fraction_above(dz, block, COVER_THRESHOLD_M)
    depth = block_mean(relu(dz), block)
    if deadband > 0:
        depth = np.where(np.isfinite(depth) & (depth < deadband), 0.0, depth)

    cover_step = 1.0 / cover_levels
    cover_raw = quantise(cover, cover_step, 0.0, np.uint8)
    depth_raw = compand(depth)
    payload = len(encode_htj2k(cover_raw)) + len(encode_htj2k(depth_raw))
    label_dead = f" dead{deadband * 100:.0f}" if deadband else ""
    return Encoded(
        f"cover({cover_levels})+depth {block} m{label_dead}",
        payload,
        expand(depth_raw),
        block,
        cover=dequantise(cover_raw, cover_step, 0.0),
        cover_scale=block,
    )


# --- scoring ----------------------------------------------------------------

FOLIAGE_DEPTH_M = 0.25  # a block is called foliage above this mean penetration


@dataclass
class Score:
    name: str
    nbytes: int
    depth_rmse: float
    depth_worst: float
    mask_iou: float
    cover_rmse: float | None


def aggregate(field: np.ndarray, from_scale: int, to_scale: int) -> np.ndarray:
    """Bring a decoded field to the evaluation scale.

    Downwards this is a further block mean, which for a mean product is exact.
    Upwards it is nearest-neighbour replication, and the error that shows up is
    the real cost of having stored the layer coarsely — the sub-block structure
    is simply gone.
    """
    if from_scale == to_scale:
        return field
    if from_scale < to_scale:
        if to_scale % from_scale:
            raise ValueError(f"{to_scale} m is not a whole number of {from_scale} m cells")
        return block_mean(field, to_scale // from_scale)
    if from_scale % to_scale:
        raise ValueError(f"{from_scale} m is not a whole number of {to_scale} m cells")
    factor = from_scale // to_scale
    return np.repeat(np.repeat(field, factor, axis=0), factor, axis=1)


def score(encoded: Encoded, ref: Reference) -> Score:
    depth_hat = aggregate(encoded.field, encoded.field_scale, ref.scale)
    both = np.isfinite(depth_hat) & np.isfinite(ref.depth)
    error = depth_hat[both] - ref.depth[both]
    rmse = float(np.sqrt(np.mean(error**2))) if error.size else float("nan")
    worst = float(np.percentile(np.abs(error), 99.9)) if error.size else float("nan")

    ref_mask = both & (ref.depth >= FOLIAGE_DEPTH_M)
    hat_mask = both & (depth_hat >= FOLIAGE_DEPTH_M)
    union = (ref_mask | hat_mask).sum()
    iou = float((ref_mask & hat_mask).sum() / union) if union else 1.0

    cover_rmse = None
    if encoded.cover is not None:
        cover_hat = aggregate(encoded.cover, encoded.cover_scale, ref.scale)
        pair = np.isfinite(cover_hat) & np.isfinite(ref.cover)
        cover_rmse = float(np.sqrt(np.mean((cover_hat[pair] - ref.cover[pair]) ** 2)))

    return Score(encoded.name, encoded.nbytes, rmse, worst, iou, cover_rmse)


def build_candidates(dz: np.ndarray) -> list[Encoded]:
    return [
        # What is on disk today, and the cheapest honest variant of it.
        candidate_stored_dz(dz, 0.1),
        candidate_stored_dz(dz, 0.5),
        candidate_relu_dz(dz, 0.1),
        # Low-pass with no decimation, to separate the two effects.
        candidate_blur(dz, 3, 0.1),
        # Low-pass and decimation together, down the store's own 4x ladder.
        candidate_mean(dz, 2, step=0.1, dtype=np.uint16),
        candidate_mean(dz, 4, step=0.1, dtype=np.uint16),
        candidate_mean(dz, 4, step=0.25),
        candidate_mean(dz, 4, step=0.25, deadband=0.25),
        candidate_foliage(dz),
        candidate_foliage(dz, radius=2),
        candidate_foliage(dz, block=8),
        candidate_mean(dz, 4, step=0.5, deadband=0.25),
        candidate_mean(dz, 8, step=0.25, deadband=0.25),
        # Companding: fine codes near zero, coarse in the canopy.
        candidate_mean(dz, 4),
        candidate_reduction(dz, 4, "mean", levels=63),
        candidate_reduction(dz, 4, "mean", levels=15),
        # Rejected shapes, kept because the numbers are the argument.
        candidate_mean(dz, 4, deadband=0.25, prefilter="median"),
        candidate_mean(dz, 4, deadband=0.25, lossy=0.001),
        candidate_reduction(dz, 4, "90"),
        # Does the cover fraction earn a second plane?
        candidate_cover_and_depth(dz, 4, deadband=0.25, cover_levels=15),
        candidate_conditional(dz, 4, 0, 15),
    ]


# --- CLI --------------------------------------------------------------------

# Level-0 chunk count of the national LZ channel, which is the closest thing to
# the extent a dz-derived layer would cover.
NATIONAL_CHUNKS = 141_823


def run(cells: list[str], per_cell: int, eval_scale: int, zip_root: Path | None) -> None:
    totals: dict[str, list[Score]] = {}
    cover_fit: list[tuple[float, float]] = []

    for cell in cells:
        first = read_quad(cell, "FZ", zip_root)
        last = read_quad(cell, "LZ", zip_root)
        quad = difference(first, last)
        del first, last

        chunks = [(r, c, w) for r, c, w in windows(quad)]
        # Most-vegetated first: nodata and bare ground make every candidate look good.
        chunks.sort(key=lambda t: -np.nansum(t[2] > COVER_THRESHOLD_M))
        for r, c, window in chunks[:per_cell]:
            ref = reference(window, eval_scale)
            pair = np.isfinite(ref.depth) & np.isfinite(ref.cover) & np.isfinite(ref.top)
            if pair.sum() > 16:
                cover_fit.append(
                    (
                        float(np.corrcoef(ref.depth[pair], ref.cover[pair])[0, 1]),
                        float(np.corrcoef(ref.depth[pair], ref.top[pair])[0, 1]),
                    )
                )
            for encoded in build_candidates(window):
                totals.setdefault(encoded.name, []).append(score(encoded, ref))
            print(f"  {cell} r{r}c{c} done", flush=True)

    print()
    print(f"eval scale {eval_scale} m, {len(next(iter(totals.values())))} chunks")
    print()
    header = f"{'candidate':<28} {'KiB/chunk':>10} {'vs dz':>7} {'depth RMSE':>11} {'p99.9':>8} {'mask IoU':>9} {'cover RMSE':>11} {'national':>10}"
    print(header)
    print("-" * len(header))
    baseline = float(np.mean([s.nbytes for s in totals["dz 1 m @ 10 cm"]]))
    for name, scores in totals.items():
        kib = float(np.mean([s.nbytes for s in scores])) / 1024
        rmse = float(np.mean([s.depth_rmse for s in scores]))
        worst = float(np.mean([s.depth_worst for s in scores]))
        iou = float(np.mean([s.mask_iou for s in scores]))
        cover = [s.cover_rmse for s in scores if s.cover_rmse is not None]
        cover_text = f"{np.mean(cover):.4f}" if cover else "-"
        national = kib * 1024 * NATIONAL_CHUNKS / 1024**3
        share = float(np.mean([s.nbytes for s in scores])) / baseline * 100
        print(
            f"{name:<28} {kib:>10.1f} {share:>6.1f}% {rmse:>10.3f}m {worst:>7.3f}m"
            f" {iou:>9.4f} {cover_text:>11} {national:>8.2f} GiB"
        )

    if cover_fit:
        print()
        print(
            f"over {len(cover_fit)} chunks, against mean depth at {eval_scale} m: "
            f"cover r = {np.mean([f[0] for f in cover_fit]):.4f}, "
            f"p90 canopy top r = {np.mean([f[1] for f in cover_fit]):.4f}"
        )


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cells", nargs="+", default=["SU42ne"])
    parser.add_argument("--per-cell", type=int, default=3)
    parser.add_argument("--eval-scale", type=int, default=8)
    parser.add_argument("--zip-root", type=Path, default=None)
    args = parser.parse_args()
    run(args.cells, args.per_cell, args.eval_scale, args.zip_root)


if __name__ == "__main__":
    main()
