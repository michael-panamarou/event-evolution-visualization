#!/usr/bin/env python3
"""
convert_data.py
===============
Converts raw CSV datasets into the unified JSON format
used by the browser visualisation (public/data.js).

Usage
-----
    python scripts/convert_data.py                  # convert all datasets in data/raw/
    python scripts/convert_data.py --sample 5000    # limit to N events (for dev)
    python scripts/convert_data.py --help

Expected raw files (data/raw/)
------------------------------
    detections_jittered.csv   — seismic events  (required)
    meteo.csv                 — meteorological  (optional)
    runoff.csv                — water runoff     (optional)
    stations.csv              — sensor locations (optional)

Output
------
    public/data.js            — JS file with const EV, METEO, RUNOFF, STATIONS

Adding a new dataset
--------------------
    1. Put your CSV in data/raw/
    2. Make sure it has columns that map to: time, x, y, z, q
       (see COLUMN_MAP below — add your own mapping if needed)
    3. Run this script again
"""

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

# Paths
ROOT      = Path(__file__).parent.parent          # project root
RAW_DIR   = ROOT / "data" / "raw"
OUT_DIR   = ROOT / "public"
OUT_FILE  = OUT_DIR / "data.js"

# Column name mapping
# Maps alternative column names → unified name used internally.
# Add new mappings here when you add a new dataset.

COLUMN_MAP = {
    # time variants
    "time":        "time",
    "timestamp":   "time",
    "datetime":    "time",
    "date":        "time",

    # x  (east / longitude-ish)
    "east_shift":  "x",
    "easting":     "x",
    "x":           "x",
    "lon":         "x",
    "longitude":   "x",

    # y  (north / latitude-ish)
    "north_shift": "y",
    "northing":    "y",
    "y":           "y",
    "lat":         "y",
    "latitude":    "y",

    # z  (depth / elevation)
    "depth_ellipsoid": "z",
    "depth":           "z",
    "elevation":       "z",
    "z":               "z",

    # q  (quality / magnitude)
    "semblance":   "q",
    "quality":     "q",
    "magnitude":   "q",
    "q":           "q",
    "snr":         "q",
}


# 1.  EVENTS  (detections_jittered.csv)

def convert_events(sample: int | None = None) -> list[dict]:
    """
    Reads detections_jittered.csv and returns a list of compact event dicts:
        { t: unix_seconds, x: metres, y: metres, z: metres, q: 0-1 }

    Columns are renamed via COLUMN_MAP so the same function works for
    other event datasets — just drop a new CSV into data/raw/ with
    compatible column names.
    """
    csv_path = RAW_DIR / "detections_jittered.csv"
    if not csv_path.exists():
        print(f"  [SKIP] {csv_path.name} not found", file=sys.stderr)
        return []

    print(f"  Reading {csv_path.name} ...", end=" ")
    df = pd.read_csv(csv_path)

    # Rename columns to unified names
    df.columns = [COLUMN_MAP.get(c.strip().lower(), c.strip().lower())
                  for c in df.columns]

    # Parse time → Unix timestamp (float seconds)
    df["time"] = pd.to_datetime(df["time"], utc=True)
    df = df.sort_values("time").reset_index(drop=True)

    # Optional sample for faster development
    if sample and sample < len(df):
        df = df.sample(sample, random_state=42).sort_values("time").reset_index(drop=True)
        print(f"sampled {sample} of {len(df) + sample} rows")
    else:
        print(f"{len(df)} rows")

    # Build output list
    events = [
        {
            "t": round(row.time.timestamp(), 1),
            "x": round(row.x, 1),
            "y": round(row.y, 1),
            "z": round(row.z, 1),
            "q": round(row.q, 4),
        }
        for row in df.itertuples()
        # drop rows with missing required fields
        if pd.notna(row.x) and pd.notna(row.y) and pd.notna(row.z) and pd.notna(row.q)
    ]

    print(f"  → {len(events)} events, "
          f"t=[{events[0]['t']:.0f} … {events[-1]['t']:.0f}], "
          f"z=[{min(e['z'] for e in events):.0f} … {max(e['z'] for e in events):.0f} m]")

    return events


# 2.  Meteo  (meteo.csv)

def convert_meteo() -> list[dict]:
    """
    Reads meteo.csv, resamples to hourly resolution (reduces size ~6×),
    and returns a list of:
        { t: unix_seconds, temp: °C, precip: mm }
    """
    csv_path = RAW_DIR / "meteo.csv"
    if not csv_path.exists():
        print(f"  [SKIP] {csv_path.name} not found", file=sys.stderr)
        return []

    print(f"  Reading {csv_path.name} ...", end=" ")
    df = pd.read_csv(csv_path)
    df["time"] = pd.to_datetime(df["time"])

    # Normalise column names
    df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]

    # Resample to 1-hour intervals — raw is every 10 min, browser doesn't need that
    df = df.set_index("time").resample("1h").mean(numeric_only=True).reset_index()

    result = [
        {
            "t":      int(row.time.timestamp()),
            "temp":   round(row.temperature, 1) if pd.notna(row.temperature) else None,
            "precip": round(row.precipitation, 2) if pd.notna(row.precipitation) else 0.0,
        }
        for row in df.itertuples()
        if pd.notna(row.temperature)
    ]

    print(f"{len(result)} hourly entries")
    return result


# 3.  RUNOFF  (runoff.csv)
def convert_runoff() -> list[dict]:
    """
    Reads runoff.csv, resamples to hourly resolution, returns:
        { t: unix_seconds, v: m³/s }
    """
    csv_path = RAW_DIR / "runoff.csv"
    if not csv_path.exists():
        print(f"  [SKIP] {csv_path.name} not found", file=sys.stderr)
        return []

    print(f"  Reading {csv_path.name} ...", end=" ")
    df = pd.read_csv(csv_path)
    df["time"] = pd.to_datetime(df["time"])
    df = df.set_index("time").resample("1h").mean(numeric_only=True).reset_index()

    result = [
        {"t": int(row.time.timestamp()), "v": round(row.runoff, 3)}
        for row in df.itertuples()
        if pd.notna(row.runoff)
    ]

    print(f"{len(result)} hourly entries")
    return result


# 4.  STATIONS  (stations.csv)

def convert_stations() -> list[dict]:
    """
    Reads stations.csv, returns a list of sensor positions:
        { id: str, lat, lon, elev, depth }
    """
    csv_path = RAW_DIR / "stations.csv"
    if not csv_path.exists():
        print(f"  [SKIP] {csv_path.name} not found", file=sys.stderr)
        return []

    print(f"  Reading {csv_path.name} ...", end=" ")
    df = pd.read_csv(csv_path).fillna("")

    result = [
        {
            "id":    f"{row.network}.{row.station}",
            "lat":   round(row.latitude,  6),
            "lon":   round(row.longitude, 6),
            "elev":  round(row.elevation, 1),
            "depth": round(row.depth,     1),
        }
        for row in df.itertuples()
    ]

    print(f"{len(result)} stations")
    return result


# 5.  WRITE  public/data.js

def write_data_js(events, meteo, runoff, stations):
    """
    Serialises all arrays as JS constants into public/data.js.
    The browser just loads this file with <script src="data.js">.
    No build step, no server needed.
    """
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Compact JSON — no spaces, minimises file size
    def dump(obj):
        return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)

    # Compute metadata for the events
    meta = {}
    if events:
        meta = {
            "name":    "Rhône Glacier Icequakes 2020",
            "domain":  "seismic",
            "count":   len(events),
            "t_min":   events[0]["t"],
            "t_max":   events[-1]["t"],
            "x_range": [min(e["x"] for e in events), max(e["x"] for e in events)],
            "y_range": [min(e["y"] for e in events), max(e["y"] for e in events)],
            "z_range": [min(e["z"] for e in events), max(e["z"] for e in events)],
        }

    lines = [
        "// data.js  —  auto-generated by scripts/convert_data.py",
        "// Re-run the script to regenerate.",
        "",
        "// Dataset metadata",
        f"const META     = {dump(meta)};",
        "",
        "// Events: [ {{ t, x, y, z, q }}, ... ]",
        f"const EV       = {dump(events)};",
        "",
        "// Meteo (hourly): [ {{ t, temp, precip }}, ... ]",
        f"const METEO    = {dump(meteo)};",
        "",
        "// Runoff (hourly): [ {{ t, v }}, ... ]",
        f"const RUNOFF   = {dump(runoff)};",
        "",
        "// Stations: [ {{ id, lat, lon, elev, depth }}, ... ]",
        f"const STATIONS = {dump(stations)};",
        "",
    ]

    OUT_FILE.write_text("\n".join(lines), encoding="utf-8")

    size_kb = OUT_FILE.stat().st_size / 1024
    print(f"\n  ✓  Written: {OUT_FILE}  ({size_kb:.1f} KB)")


# Main

def main():
    parser = argparse.ArgumentParser(
        description="Convert raw CSV datasets → public/data.js"
    )
    parser.add_argument(
        "--sample", type=int, default=None,
        help="Limit events to N rows (useful during development, e.g. --sample 5000)"
    )
    args = parser.parse_args()

    print("\n=== convert_data.py ===\n")
    print("Input:  ", RAW_DIR)
    print("Output: ", OUT_FILE)
    print()

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
