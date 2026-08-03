"""Compare zfp against the shipped HTJ2K encoding for DEFRA DSM tiles.

The shipped `height.dsm.fz` chunks are uint16-normalised per chunk and then
HTJ2K encoded **losslessly** (`lossyQuality: 0.` in `manifest.ts` becomes
`setQuality(true, 0)`), so everything we currently lose happens at the
normalisation step and is computable exactly rather than measured through a
decoder. That makes the baseline here honest without needing an HTJ2K decode
on the Python side.

zfp is the interesting alternative because it compresses floats directly: no
per-chunk scale/offset, which is the one piece of bespoke metadata the Zarr
store has to carry alongside the arrays.
"""

from __future__ import annotations

import argparse
import io
import zipfile
from dataclasses import dataclass
from pathlib import Path

import imagecodecs
import numpy as np
import tifffile

# DEFRA composite DSM rasters are inconsistent about the sentinel: the
# GDAL_NODATA tag on these files reads -3.4028235e+38 (which tifffile warns is
# not castable to float32), while others use -9999. Anything a long way below
# sea level is nodata; the lowest real ground in Britain is about -4 m.
NODATA_BELOW = -1000.0
UINT16_LEVELS = 65534  # raw 0 is reserved for nodata, so 1..65535 carry signal


@dataclass(frozen=True)
class Quantised:
    raw: np.ndarray
    scale: float
    offset: float
    reconstructed: np.ndarray


def quantise_globally(values: np.ndarray, valid: np.ndarray, lo: float, hi: float) -> Quantised:
    """One scale/offset for the whole country, so no per-chunk metadata at all.

    This is the variant that would let the Zarr store drop `encoding/scale` and
    `encoding/offset` and declare a plain array-level transform instead — the
    interoperable option. It costs precision: a 1410 m national range over
    65534 levels is a ~21 mm step, against ~1.4 mm when each chunk gets the
    range to itself.
    """
    scale = (hi - lo) / UINT16_LEVELS
    offset = lo - scale
    raw = np.zeros(values.shape, dtype=np.uint16)
    raw[valid] = np.rint((values[valid] - offset) / scale).clip(1, 65535).astype(np.uint16)
    recon = np.where(valid, raw.astype(np.float64) * scale + offset, np.nan)
    return Quantised(raw=raw, scale=scale, offset=offset, reconstructed=recon)


def quantise_like_pipeline(values: np.ndarray, valid: np.ndarray) -> Quantised:
    """Reproduce `encodeUint16Normalized`: 1..65535 across the chunk's own range.

    Mirrors the scalars the manifests record — `min = offset + scale`,
    `max = offset + 65535 * scale` — which is what makes per-chunk metadata
    necessary in the first place.
    """
    signal = values[valid]
    lo = float(signal.min())
    hi = float(signal.max())
    scale = (hi - lo) / UINT16_LEVELS if hi > lo else 1.0
    offset = lo - scale
    raw = np.zeros(values.shape, dtype=np.uint16)
    raw[valid] = np.rint((signal - offset) / scale).clip(1, 65535).astype(np.uint16)
    recon = np.where(valid, raw.astype(np.float64) * scale + offset, np.nan)
    return Quantised(raw=raw, scale=scale, offset=offset, reconstructed=recon)


def error_stats(reference: np.ndarray, recovered: np.ndarray, valid: np.ndarray) -> dict[str, float]:
    delta = np.abs(reference[valid].astype(np.float64) - recovered[valid].astype(np.float64))
    return {
        "max": float(delta.max()),
        "rms": float(np.sqrt(np.mean(delta**2))),
        "mean": float(delta.mean()),
    }


def zfp_accuracy(values: np.ndarray, tolerance: float) -> bytes:
    return imagecodecs.zfp_encode(values, level=tolerance, mode="a")


def zfp_reversible(values: np.ndarray) -> bytes:
    return imagecodecs.zfp_encode(values, mode="R")


def read_source_tile(zip_path: Path) -> np.ndarray:
    with zipfile.ZipFile(zip_path) as archive:
        name = next(n for n in archive.namelist() if n.endswith(".tif") and "/" not in n)
        with archive.open(name) as member:
            data = member.read()
    return tifffile.imread(io.BytesIO(data))


def iter_windows(raster: np.ndarray, size: int, limit: int):
    """Walk the 1 km windows the pipeline cuts, most-populated first."""
    rows = raster.shape[0] // size
    cols = raster.shape[1] // size
    windows = []
    for row in range(rows):
        for col in range(cols):
            window = raster[row * size : (row + 1) * size, col * size : (col + 1) * size]
            valid = np.isfinite(window) & (window > NODATA_BELOW)
            windows.append((valid.mean(), row, col, window, valid))
    windows.sort(key=lambda entry: -entry[0])
    return [entry[1:] for entry in windows[:limit]]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zip", required=True, type=Path, help="DEFRA composite zip (one 5 km tile)")
    parser.add_argument("--tiles", type=int, default=4, help="how many 1 km windows to test")
    parser.add_argument("--window", type=int, default=1000, help="window size in pixels")
    parser.add_argument(
        "--tolerances",
        type=float,
        nargs="+",
        default=[1.0, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01],
        help="zfp fixed-accuracy tolerances, metres",
    )
    parser.add_argument(
        "--global-range",
        type=float,
        nargs=2,
        default=[-10.0, 1400.0],
        metavar=("MIN", "MAX"),
        help="height range for the single-scale variant, metres (default covers Britain)",
    )
    args = parser.parse_args()

    raster = read_source_tile(args.zip)
    print(f"source {args.zip.name}: {raster.shape} {raster.dtype}")

    for row, col, window, valid in iter_windows(raster, args.window, args.tiles):
        values = window.astype(np.float32)
        if not valid.any():
            continue
        signal = values[valid]
        raw_bytes = values.nbytes
        print(
            f"\nwindow r{row} c{col}: {valid.mean() * 100:.1f}% valid, "
            f"{signal.min():.2f}..{signal.max():.2f} m, float32 {raw_bytes / 1e6:.2f} MB"
        )

        def report(label: str, encoded: bytes, stats: dict[str, float] | None) -> None:
            detail = (
                f"max {stats['max'] * 1000:7.2f} mm  rms {stats['rms'] * 1000:6.2f} mm"
                if stats
                else "exact"
            )
            print(f"  {label:38s} {len(encoded) / 1e6:6.3f} MB  {raw_bytes / len(encoded):5.1f}x  {detail}")

        quantised = quantise_like_pipeline(values, valid)
        shipped = imagecodecs.jpeg2k_encode(quantised.raw, level=0, reversible=True, codecformat="J2K")
        report(
            "uint16 per-chunk + J2K (as shipped)",
            shipped,
            error_stats(values, quantised.reconstructed, valid),
        )

        national = quantise_globally(values, valid, args.global_range[0], args.global_range[1])
        national_encoded = imagecodecs.jpeg2k_encode(national.raw, level=0, reversible=True, codecformat="J2K")
        report(
            f"uint16 global {args.global_range[0]:g}..{args.global_range[1]:g} + J2K",
            national_encoded,
            error_stats(values, national.reconstructed, valid),
        )

        report("zfp reversible", zfp_reversible(values), None)

        for tolerance in args.tolerances:
            encoded = zfp_accuracy(values, tolerance)
            recovered = imagecodecs.zfp_decode(encoded)
            report(f"zfp accuracy {tolerance:g} m", encoded, error_stats(values, recovered, valid))


if __name__ == "__main__":
    main()
