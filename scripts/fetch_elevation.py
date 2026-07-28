#!/usr/bin/env python3
"""
fetch_elevation.py
──────────────────────────────────────────────────────────────────────────────
Gives the traffic dataset a real third spatial dimension.

STATS19 records where and when a collision happened, but not how high it was.
This script looks up a real elevation for every collision, and also samples a
terrain grid over the region so the Space-Time Cube can stand on a DEM in the
same way the icequake view stands on the glacier surface.

It writes two files:

    data/raw/traffic_elevation.csv    collision_index,elevation
    data/raw/traffic_dem.json         { n, x_min, x_max, y_min, y_max, z[] }

Elevation source
    OpenTopoData's public API (https://www.opentopodata.org), SRTM 30 m.
    Free, no API key. The public instance allows 100 locations per call and
    about 1000 calls per day, which is comfortably enough here. Results are
    cached, so re-running only fetches what is missing.

    If you would rather not use a web service, any DEM raster works: replace
    lookup_batch() with a raster sample (e.g. rasterio) over OS Terrain 50.

Usage
    python scripts/fetch_elevation.py            # events + terrain grid
    python scripts/fetch_elevation.py --grid 60  # coarser terrain grid
"""

from __future__ import annotations
import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

ROOT     = Path(__file__).resolve().parent.parent
RAW_DIR  = ROOT / "data" / "raw"        # inputs, immutable
PROC_DIR = ROOT / "data" / "processed"  # everything this script generates

CSV_NAME  = "dft-road-casualty-statistics-collision-provisional-2025.csv"
ELEV_CSV  = PROC_DIR / "traffic_elevation.csv"
DEM_JSON  = PROC_DIR / "traffic_dem.json"

BBOX = dict(lat_min=53.30, lat_max=53.95, lon_min=-2.45, lon_max=-1.25)

API       = "https://api.opentopodata.org/v1/srtm30m"
BATCH     = 100          # locations per request (public instance limit)
PAUSE_S   = 1.1          # be polite: public instance allows ~1 call/second


def lookup_batch(points: list[tuple[float, float]]) -> list[float]:
    """points = [(lat, lon), ...] -> [elevation_m, ...]"""
    loc = "|".join(f"{lat:.6f},{lon:.6f}" for lat, lon in points)
    for attempt in range(4):
        try:
            r = requests.post(API, data={"locations": loc}, timeout=60)
            if r.status_code == 429:            # rate limited - back off
                time.sleep(5 * (attempt + 1))
                continue
            r.raise_for_status()
            js = r.json()
            if js.get("status") != "OK":
                raise RuntimeError(js.get("error", "unknown API error"))
            return [(res.get("elevation") if res.get("elevation") is not None else np.nan)
                    for res in js["results"]]
        except Exception as exc:                 # noqa: BLE001
            wait = 3 * (attempt + 1)
            print(f"    retry {attempt+1}/4 after {wait}s ({exc})")
            time.sleep(wait)
    raise RuntimeError("elevation lookup failed after 4 attempts")


def fetch_many(points: list[tuple[float, float]], label: str) -> list[float]:
    out: list[float] = []
    total = (len(points) + BATCH - 1) // BATCH
    for i in range(0, len(points), BATCH):
        chunk = points[i:i + BATCH]
        out.extend(lookup_batch(chunk))
        done = i // BATCH + 1
        print(f"    {label}: batch {done}/{total} ({len(out)}/{len(points)} points)")
        if done < total:
            time.sleep(PAUSE_S)
    return out


def collision_elevations() -> None:
    csv_path = RAW_DIR / CSV_NAME
    if not csv_path.exists():
        print(f"ERROR: {csv_path} not found."); sys.exit(1)

    df = pd.read_csv(csv_path, low_memory=False, dtype={"collision_index": str})
    df = df[df.latitude.notna() & df.longitude.notna()]
    df = df[df.latitude.between(BBOX["lat_min"], BBOX["lat_max"]) &
            df.longitude.between(BBOX["lon_min"], BBOX["lon_max"])]
    print(f"  {len(df)} collisions in the region")

    have: dict[int, float] = {}
    if ELEV_CSV.exists():
        cached = pd.read_csv(ELEV_CSV, dtype={"collision_index": str})
        have = dict(zip(cached.collision_index, cached.elevation))
        print(f"  {len(have)} already cached")

    todo = df[~df.collision_index.isin(have.keys())]
    if len(todo) == 0:
        print("  nothing to fetch")
    else:
        print(f"  fetching {len(todo)} elevations "
              f"({(len(todo)+BATCH-1)//BATCH} requests, "
              f"~{(len(todo)/BATCH)*PAUSE_S/60:.1f} min)")
        pts = list(zip(todo.latitude.values, todo.longitude.values))
        elevs = fetch_many(pts, "events")
        have.update(dict(zip(todo.collision_index.values, elevs)))

    out = pd.DataFrame({"collision_index": list(have.keys()),
                        "elevation": list(have.values())}).dropna()
    PROC_DIR.mkdir(parents=True, exist_ok=True)
    out.to_csv(ELEV_CSV, index=False)
    print(f"  -> {ELEV_CSV}  ({len(out)} rows, "
          f"{out.elevation.min():.0f}..{out.elevation.max():.0f} m)")


def terrain_grid(n: int) -> None:
    """Samples an n x n elevation grid over the region for the STC base."""
    if DEM_JSON.exists():
        print(f"  {DEM_JSON.name} already exists - delete it to re-sample")
        return
    lats = np.linspace(BBOX["lat_min"], BBOX["lat_max"], n)
    lons = np.linspace(BBOX["lon_min"], BBOX["lon_max"], n)
    pts = [(la, lo) for la in lats for lo in lons]
    print(f"  sampling {n}x{n} = {len(pts)} terrain points "
          f"({(len(pts)+BATCH-1)//BATCH} requests, "
          f"~{(len(pts)/BATCH)*PAUSE_S/60:.1f} min)")
    z = np.array(fetch_many(pts, "terrain"), dtype=float).reshape(n, n)
    z = np.nan_to_num(z, nan=float(np.nanmedian(z)))

    DEM_JSON.write_text(json.dumps({
        "n": n,
        "lat_min": BBOX["lat_min"], "lat_max": BBOX["lat_max"],
        "lon_min": BBOX["lon_min"], "lon_max": BBOX["lon_max"],
        "z_min": float(z.min()), "z_max": float(z.max()),
        "z": [round(float(v), 1) for v in z.ravel()],
    }), encoding="utf-8")
    print(f"  -> {DEM_JSON}  (elevation {z.min():.0f}..{z.max():.0f} m)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--grid", type=int, default=80,
                    help="terrain grid resolution per axis (default 80)")
    ap.add_argument("--skip-events", action="store_true")
    ap.add_argument("--skip-grid", action="store_true")
    args = ap.parse_args()

    print("[1/2] Collision elevations")
    if not args.skip_events:
        collision_elevations()

    print("[2/2] Terrain grid for the STC base")
    if not args.skip_grid:
        terrain_grid(args.grid)

    print("\nNow run:  python scripts/convert_traffic_stats19.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
