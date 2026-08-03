"""Does a global quantisation step need dithering, or does the data dither itself?

Height error tells you nothing about banding. A uniform step turns a gentle
slope into terraces, and the shading normal differentiates the height field, so
a step that is invisible as a height error is not necessarily invisible on
screen.

Quantisation error decorrelates by itself wherever the surface's own noise is
larger than the step. So the question is not the average roughness of a tile —
it is how much of the tile is *smoother* than the step. Water, roads, playing
fields and interpolated nodata are where banding would show.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import imagecodecs
import numpy as np

from .compare import (
    NODATA_BELOW,
    UINT16_LEVELS,
    iter_windows,
    quantise_globally,
    quantise_like_pipeline,
    read_source_tile,
)


def local_roughness(values: np.ndarray) -> np.ndarray:
    """RMS-scale residual from the 4-neighbour mean — the surface's noise floor.

    Interior only; the border is dropped rather than padded so a synthetic edge
    cannot masquerade as roughness.
    """
    centre = values[1:-1, 1:-1]
    neighbours = (
        values[:-2, 1:-1].astype(np.float64)
        + values[2:, 1:-1]
        + values[1:-1, :-2]
        + values[1:-1, 2:]
    ) / 4.0
    return np.abs(centre - neighbours)


def flat_fraction(raw: np.ndarray) -> float:
    """Share of 3x3 neighbourhoods that quantise to a single level — a terrace."""
    centre = raw[1:-1, 1:-1]
    same = np.ones(centre.shape, dtype=bool)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy == 0 and dx == 0:
                continue
            shifted = raw[1 + dy : raw.shape[0] - 1 + dy, 1 + dx : raw.shape[1] - 1 + dx]
            same &= shifted == centre
    return float(same.mean())


def surface_normals(values: np.ndarray, spacing: float = 1.0) -> np.ndarray:
    """Normals by central difference, as the tile shader computes them.

    This is the metric that predicts what shows on screen: differentiating the
    height field amplifies a quantisation step far beyond what its height error
    suggests, and it is the shading — not the elevation — that banding is
    visible in.
    """
    dzdx = (values[1:-1, 2:].astype(np.float64) - values[1:-1, :-2]) / (2.0 * spacing)
    dzdy = (values[2:, 1:-1].astype(np.float64) - values[:-2, 1:-1]) / (2.0 * spacing)
    normals = np.stack([-dzdx, -dzdy, np.ones_like(dzdx)], axis=-1)
    return normals / np.linalg.norm(normals, axis=-1, keepdims=True)


def normal_error_degrees(reference: np.ndarray, other: np.ndarray) -> np.ndarray:
    dot = np.clip(np.sum(reference * other, axis=-1), -1.0, 1.0)
    return np.degrees(np.arccos(dot))


def quantise_dithered(
    values: np.ndarray,
    valid: np.ndarray,
    lo: float,
    hi: float,
    seed: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Global quantisation with triangular-PDF dither of +/-1 LSB.

    TPDF is the standard choice: it makes the error independent of the signal,
    which is what removes the banding, at the cost of a little more noise than
    rectangular dither.
    """
    scale = (hi - lo) / UINT16_LEVELS
    offset = lo - scale
    rng = np.random.default_rng(seed)
    noise = rng.random(values.shape) - rng.random(values.shape)  # triangular, +/-1
    raw = np.zeros(values.shape, dtype=np.uint16)
    level = (values[valid] - offset) / scale + noise[valid]
    raw[valid] = np.rint(level).clip(1, 65535).astype(np.uint16)
    recon = np.where(valid, raw.astype(np.float64) * scale + offset, np.nan)
    return raw, recon


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zip", required=True, type=Path)
    parser.add_argument("--tiles", type=int, default=3)
    parser.add_argument("--window", type=int, default=1000)
    parser.add_argument("--global-range", type=float, nargs=2, default=[-10.0, 1400.0])
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    lo, hi = args.global_range
    step = (hi - lo) / UINT16_LEVELS
    print(f"global step {step * 1000:.2f} mm over {lo:g}..{hi:g} m")

    raster = read_source_tile(args.zip)
    for row, col, window, valid in iter_windows(raster, args.window, args.tiles):
        values = window.astype(np.float32)
        if not valid.all():
            print(f"\nwindow r{row} c{col}: skipped, has nodata")
            continue
        rough = local_roughness(values)
        percentiles = np.percentile(rough, [1, 5, 25, 50])
        below = float((rough < step).mean())
        print(f"\nwindow r{row} c{col}: {values[valid].min():.2f}..{values[valid].max():.2f} m")
        print(
            "  own roughness |h - mean(4-neighbours)|: "
            f"p1 {percentiles[0] * 1000:.2f} mm, p5 {percentiles[1] * 1000:.2f} mm, "
            f"p25 {percentiles[2] * 1000:.2f} mm, median {percentiles[3] * 1000:.2f} mm"
        )
        print(f"  samples quieter than one step: {below * 100:.2f}%")

        plain = quantise_globally(values, valid, lo, hi)
        plain_bytes = imagecodecs.jpeg2k_encode(plain.raw, level=0, reversible=True, codecformat="J2K")
        dithered_raw, dithered_recon = quantise_dithered(values, valid, lo, hi, args.seed)
        dithered_bytes = imagecodecs.jpeg2k_encode(
            dithered_raw, level=0, reversible=True, codecformat="J2K"
        )

        per_chunk = quantise_like_pipeline(values, valid)
        per_chunk_bytes = imagecodecs.jpeg2k_encode(
            per_chunk.raw, level=0, reversible=True, codecformat="J2K"
        )
        reference = surface_normals(values.astype(np.float64))

        for label, raw, recon, encoded in (
            ("per-chunk", per_chunk.raw, per_chunk.reconstructed, per_chunk_bytes),
            ("global plain", plain.raw, plain.reconstructed, plain_bytes),
            ("global dither", dithered_raw, dithered_recon, dithered_bytes),
        ):
            delta = np.abs(values[valid].astype(np.float64) - recon[valid])
            angles = normal_error_degrees(reference, surface_normals(recon))
            print(
                f"  {label:13s} {len(encoded) / 1e6:6.3f} MB  "
                f"rms {np.sqrt(np.mean(delta**2)) * 1000:5.2f} mm  "
                f"normal err mean {np.mean(angles):5.2f} deg p95 {np.percentile(angles, 95):5.2f} deg  "
                f"flat3x3 {flat_fraction(raw) * 100:6.3f}%"
            )
        growth = len(dithered_bytes) / len(plain_bytes) - 1
        print(f"  dither costs {growth * 100:+.1f}% in size")


if __name__ == "__main__":
    main()
