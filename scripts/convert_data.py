#!/usr/bin/env python3
"""
convert_data.py
===============
Converts raw CSV datasets into the unified JSON format
used by the browser visualisation (public/data.js).

Usage
-----
    python scripts/convert_data.py                  # convert all datasets
    python scripts/convert_data.py --sample 5000    # limit to N events (for dev)
    python scripts/convert_data.py --help

Expected raw files (data/raw/)
------------------------------
    detections_jittered.csv   — seismic events  (required)
    meteo.csv                 — meteorological  (optional)
    runoff.csv                — water runoff    (optional)
    stations.csv              — sensor locations (optional)

Output
------
    public/data.js  — JS file exposing: EV, METEO, RUNOFF, STATIONS, META

Adding a new dataset
--------------------
    1. Put your CSV in data/raw/
    2. Make sure it has columns for time, x/east, y/north, z/depth, q/quality
    3. Add a converter function following the pattern of convert_events()
    4. Call it in main() and pass the result to write_data_js()
    5. Run this script again
"""

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

# Paths
ROOT     = Path(__file__).parent.parent   # project root (icequake-viz/)
RAW_DIR  = ROOT / "data" / "raw"
OUT_DIR  = ROOT / "public"
OUT_FILE = OUT_DIR / "data.js"


# 1. Events

def convert_events(sample = None):
    """
    Reads detections_jittered.csv and returns a list of compact event dicts:
        { t: unix_seconds, x: metres, y: metres, z: metres, q: 0-1 }

    t = Unix timestamp (float seconds since 1970-01-01)
    x = east_shift  — horizontal position in metres east of reference point
    y = north_shift — horizontal position in metres north of reference point
    z = depth_ellipsoid — depth in metres (negative values = below surface)
    q = semblance   — detection quality score between 0 and 1
    """
    csv_path = RAW_DIR / "detections_jittered.csv"
    if not csv_path.exists():
        print(f"  [SKIP] {csv_path.name} not found")
        return []

    print(f"  Reading {csv_path.name} ...", end=" ", flush=True)
    df = pd.read_csv(csv_path)

    # Normalise column names: lowercase, strip spaces
    df.columns = [c.strip().lower() for c in df.columns]

    # Verify required columns exist
    required = {"time", "east_shift", "north_shift", "depth_ellipsoid", "semblance"}
    missing  = required - set(df.columns)
    if missing:
        print(f"\n  [ERROR] Missing columns: {missing}")
        print(f"  Available columns: {list(df.columns)}")
        sys.exit(1)

    # Parse time string → proper datetime object
    df["time"] = pd.to_datetime(df["time"], utc=True)

    # Sort oldest → newest
    df = df.sort_values("time").reset_index(drop=True)

    # Optional random sample (useful during development)
    total = len(df)
    if sample and sample < total:
        df = (df.sample(sample, random_state=42)
                .sort_values("time")
                .reset_index(drop=True))
        print(f"sampled {sample} of {total} rows")
    else:
        print(f"{total} rows")

    # Build output - one compact dict per event
    events = [
        {
            "t": round(row.time.timestamp(), 1),   # datetime → float seconds
            "x": round(float(row.east_shift),  1), # metres east
            "y": round(float(row.north_shift), 1), # metres north
            "z": round(float(row.depth_ellipsoid), 1), # metres depth
            "q": round(float(row.semblance), 4),   # quality 0-1
        }
        for row in df.itertuples()
        if (pd.notna(row.east_shift) and pd.notna(row.north_shift)
            and pd.notna(row.depth_ellipsoid) and pd.notna(row.semblance))
    ]

    print(f"  → {len(events)} events | "
          f"time: {df.time.min().date()} – {df.time.max().date()} | "
          f"depth: {df.depth_ellipsoid.min():.0f} - {df.depth_ellipsoid.max():.0f} m | "
          f"east: {df.east_shift.min():.0f} - {df.east_shift.max():.0f} m")

    return events


# 2. Meteo

def convert_meteo():
    """
    Reads meteo.csv → list of { t, temp, precip } dicts.
    Resampled to hourly (raw is every 10 min — reduces size 6x).
    """
    csv_path = RAW_DIR / "meteo.csv"
    if not csv_path.exists():
        print(f"  [SKIP] {csv_path.name} not found")
        return []

    print(f"  Reading {csv_path.name} ...", end=" ", flush=True)
    df = pd.read_csv(csv_path)
    df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]
    df["time"] = pd.to_datetime(df["time"])

    # Resample: group by hour, take mean value in each hour
    df = (df.set_index("time")
            .resample("1h")
            .mean(numeric_only=True)
            .reset_index())

    result = [
        {
            "t":      int(row.time.timestamp()),
            "temp":   round(float(row.temperature), 1)  if pd.notna(row.temperature)  else None,
            "precip": round(float(row.precipitation), 2) if pd.notna(row.precipitation) else 0.0,
        }
        for row in df.itertuples()
        if pd.notna(row.temperature)
    ]

    print(f"{len(result)} hourly entries")
    return result


# 3. Runoff

def convert_runoff():
    """
    Reads runoff.csv → list of { t, v } dicts.
    Resampled to hourly.
    """
    csv_path = RAW_DIR / "runoff.csv"
    if not csv_path.exists():
        print(f"  [SKIP] {csv_path.name} not found")
        return []

    print(f"  Reading {csv_path.name} ...", end=" ", flush=True)
    df = pd.read_csv(csv_path)
    df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]
    df["time"] = pd.to_datetime(df["time"])

    df = (df.set_index("time")
            .resample("1h")
            .mean(numeric_only=True)
            .reset_index())

    # Pick the first non-time column as the value
    val_col = [c for c in df.columns if c != "time"][0]

    result = [
        {"t": int(row.time.timestamp()), "v": round(float(getattr(row, val_col)), 3)}
        for row in df.itertuples()
        if pd.notna(getattr(row, val_col))
    ]

    print(f"{len(result)} hourly entries  (column: '{val_col}')")
    return result


# 4. Stations

def convert_stations():
    """
    Reads stations.csv → list of { id, lat, lon, elev, depth } dicts.
    """
    csv_path = RAW_DIR / "stations.csv"
    if not csv_path.exists():
        print(f"  [SKIP] {csv_path.name} not found")
        return []

    print(f"  Reading {csv_path.name} ...", end=" ", flush=True)
    df = pd.read_csv(csv_path).fillna("")
    df.columns = [c.strip().lower() for c in df.columns]

    result = [
        {
            "id":    f"{row.network}.{row.station}",
            "lat":   round(float(row.latitude),  6),
            "lon":   round(float(row.longitude), 6),
            "elev":  round(float(row.elevation), 1),
            "depth": round(float(row.depth),     1),
        }
        for row in df.itertuples()
    ]

    print(f"{len(result)} stations")
    return result


# 5. Metadata

def build_meta(events):
    """
    Computes bounding box and time range from the events list.
    Stored in META constant in data.js — app.js reads this instead
    of using hardcoded values, so adding a new dataset just means
    re-running the script.
    """
    if not events:
        return {}
    return {
        "name":    "Rhône Glacier Icequakes 2020",
        "domain":  "seismic",
        "count":   len(events),
        "t_min":   events[0]["t"],
        "t_max":   events[-1]["t"],
        "x_range": [min(e["x"] for e in events), max(e["x"] for e in events)],
        "y_range": [min(e["y"] for e in events), max(e["y"] for e in events)],
        "z_range": [min(e["z"] for e in events), max(e["z"] for e in events)],
    }


# 6. Write public/data.js

def write_data_js(events, meteo, runoff, stations):
    """
    Serialises all arrays as JavaScript constants into public/data.js.

    The browser loads this with <script src="data.js">.
    After loading, app.js can use EV, METEO, RUNOFF, STATIONS, META directly —
    no server, no build step, no fetch() call needed.
    """
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Compact JSON — no extra spaces to keep file size down
    def dump(obj):
        return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)

    meta = build_meta(events)

    content = "\n".join([
        "// ─────────────────────────────────────────────────────────────────",
        "// data.js — auto-generated by scripts/convert_data.py",
        "// DO NOT EDIT BY HAND — re-run the script to regenerate.",
        "// ─────────────────────────────────────────────────────────────────",
        "",
        "// Metadata: name, count, time range, spatial bounding box",
        f"const META     = {dump(meta)};",
        "",
        "// Events sorted by time: [ { t, x, y, z, q }, ... ]",
        f"const EV       = {dump(events)};",
        "",
        "// Meteo hourly: [ { t, temp, precip }, ... ]",
        f"const METEO    = {dump(meteo)};",
        "",
        "// Runoff hourly: [ { t, v }, ... ]",
        f"const RUNOFF   = {dump(runoff)};",
        "",
        "// Seismic stations: [ { id, lat, lon, elev, depth }, ... ]",
        f"const STATIONS = {dump(stations)};",
        "",
    ])

    OUT_FILE.write_text(content, encoding="utf-8")

    size_kb = OUT_FILE.stat().st_size / 1024
    print(f"\n  ✓  Written: {OUT_FILE}")
    print(f"     Size:    {size_kb:.1f} KB")


# Main

def main():
    parser = argparse.ArgumentParser(
        description="Convert raw CSV datasets → public/data.js"
    )
    parser.add_argument(
        "--sample", type=int, default=None,
        help="Limit events to N rows  (e.g. --sample 5000 for faster development)"
    )
    args = parser.parse_args()

    print("\n=== convert_data.py ===")
    print(f"Input:  {RAW_DIR}")
    print(f"Output: {OUT_FILE}\n")

    print("[1/4] Events")
    events = convert_events(sample=args.sample)

    print("[2/4] Meteo")
    meteo = convert_meteo()

    print("[3/4] Runoff")
    runoff = convert_runoff()

    print("[4/4] Stations")
    stations = convert_stations()

    print("\n[5/5] Writing data.js ...")
    write_data_js(events, meteo, runoff, stations)

    print("\nDone. Open public/index.html in your browser.\n")


if __name__ == "__main__":
    main()