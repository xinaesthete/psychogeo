"""Regenerate the foliage-layer figures in docs/planning/images.

The size tables in
[zarr-transcode.md](../../../../docs/planning/zarr-transcode.md) cannot show the
finding that decided the pipeline — that a building's perimeter reads as several
metres of canopy — so it is carried by pictures instead, and pictures in a
planning doc need a generator that lives next to the numbers rather than in a
scratch directory.

    uv run codec-foliage-figures

Deterministic: fixed cells, fixed crops, no sampling.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import imagecodecs
import numpy as np

from .foliage import (
    COVER_THRESHOLD_M,
    block_mean,
    canopy_mask,
    dequantise,
    difference,
    opening,
    quantise,
    read_quad,
    relu,
)

CROP = 512
GAP = 8

# Fixed crops, chosen once: a Hampshire housing estate with mature garden trees,
# and farmland a few kilometres west with hedgerows and a wood.
SUBURBAN = ("SU42ne", 1200, 1150)
FARMLAND = ("SU42nw", 2600, 2000)

# The proposal's own settings, so the figures show the thing being proposed.
BLOCK = 4
STEP = 0.25
DEADBAND = 0.25


def height_panel(heights: np.ndarray) -> np.ndarray:
    """FZ as plain greys, for reading the ground truth off by eye."""
    lo, hi = np.nanpercentile(heights, [2, 98])
    grey = (np.clip((heights - lo) / (hi - lo), 0, 1) * 255).astype(np.uint8)
    return np.repeat(grey[..., None], 3, axis=2)


def depth_panel(depth: np.ndarray, ceiling: float = 20.0) -> np.ndarray:
    """Penetration depth as green over bare parchment; nodata mid-grey."""
    t = np.clip(np.nan_to_num(depth, nan=0.0) / ceiling, 0, 1) ** 0.6
    rgb = np.empty(depth.shape + (3,), np.uint8)
    rgb[..., 0] = 238 * (1 - t) + 20 * t
    rgb[..., 1] = 236 * (1 - t) + 92 * t
    rgb[..., 2] = 228 * (1 - t) + 32 * t
    rgb[~np.isfinite(depth)] = 120
    return rgb


def mask_panel(heights: np.ndarray, red: np.ndarray, blue: np.ndarray) -> np.ndarray:
    lo, hi = np.nanpercentile(heights, [2, 98])
    grey = (np.clip((heights - lo) / (hi - lo), 0, 1) * 200 + 30).astype(np.uint8)
    rgb = np.repeat(grey[..., None], 3, axis=2)
    rgb[red] = [220, 60, 50]
    rgb[blue] = [40, 110, 220]
    return rgb


def foliage_field(dz: np.ndarray, radius: int | None) -> np.ndarray:
    """The proposed layer, decoded and replicated back to 1 m for display."""
    depth = relu(dz)
    if radius:
        keep = canopy_mask(dz, radius)
        depth = np.where(keep, depth, np.where(np.isfinite(dz), 0.0, np.nan))
    coarse = block_mean(depth, BLOCK)
    coarse = np.where(np.isfinite(coarse) & (coarse < DEADBAND), 0.0, coarse)
    field = dequantise(quantise(coarse, STEP, 0.0, np.uint8), STEP, 0.0)
    return np.repeat(np.repeat(field, BLOCK, axis=0), BLOCK, axis=1)


def separable_rank(values: np.ndarray, radius: int, how: str) -> np.ndarray:
    """Grey-scale min/max over a square window, which factorises by axis."""
    reduce = np.minimum if how == "min" else np.maximum
    out = values
    for axis in (0, 1):
        pad = [(0, 0), (0, 0)]
        pad[axis] = (radius, radius)
        padded = np.pad(out, pad, mode="edge")
        acc = None
        for k in range(2 * radius + 1):
            index: list[slice] = [slice(None), slice(None)]
            index[axis] = slice(k, k + values.shape[axis])
            window = padded[tuple(index)]
            acc = window if acc is None else reduce(acc, window)
        out = acc
    return out


def strip(panels: list[np.ndarray]) -> np.ndarray:
    gap = np.full((panels[0].shape[0], GAP, 3), 255, np.uint8)
    joined: list[np.ndarray] = []
    for index, panel in enumerate(panels):
        if index:
            joined.append(gap)
        joined.append(panel)
    return np.concatenate(joined, axis=1)


def load(cell: str, row: int, col: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    first = read_quad(cell, "FZ")
    last = read_quad(cell, "LZ")
    window = (slice(row, row + CROP), slice(col, col + CROP))
    return difference(first, last)[window], first[window], last[window]


def write(path: Path, image: np.ndarray) -> None:
    # Lossless: these are false-colour renders with hard block edges, and lossy
    # coding puts ringing exactly on the 4 m cells the figure is about.
    path.write_bytes(imagecodecs.webp_encode(image, level=-1))
    print(f"  {path}  {path.stat().st_size / 1024:.0f} KiB")


def build(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    for name, (cell, row, col) in (("opening", SUBURBAN), ("rural", FARMLAND)):
        dz, heights, _ = load(cell, row, col)
        write(
            out_dir / f"foliage-{name}.webp",
            strip(
                [
                    height_panel(heights),
                    depth_panel(relu(dz)),
                    depth_panel(foliage_field(dz, None)),
                    depth_panel(foliage_field(dz, 1)),
                    depth_panel(foliage_field(dz, 2)),
                ]
            ),
        )

    dz, heights, last = load(*SUBURBAN)
    ridge = (np.isfinite(dz) & (dz > COVER_THRESHOLD_M)) & ~canopy_mask(dz, 1)

    # A bare-earth estimate from LZ alone: the beam reaches the ground in the
    # gaps, so a wide grey-scale opening rides the ground and ignores what
    # stands on it. 25 m has to exceed the widest building in the window.
    ground = separable_rank(separable_rank(last, 25, "min"), 25, "max")
    built = opening(np.isfinite(dz) & (dz < 0.5) & (last - ground > 2.5), 1)

    empty = np.zeros_like(ridge)
    write(
        out_dir / "foliage-building-signal.webp",
        strip(
            [
                mask_panel(heights, empty, empty),
                mask_panel(heights, ridge, empty),
                mask_panel(heights, empty, built),
            ]
        ),
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parents[4] / "docs" / "planning" / "images",
    )
    args = parser.parse_args()
    build(args.out)


if __name__ == "__main__":
    main()
