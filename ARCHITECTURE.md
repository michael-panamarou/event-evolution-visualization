[stack-architecture.md](https://github.com/user-attachments/files/27905700/stack-architecture.md)
# Event Evolution Visualization — Stack & Architecture Reference

**Bachelor Thesis:** Event Evolution Visualization  
**Dataset:** Rhône Glacier Icequakes 2020 (~37k seismic events with 3D spatial + temporal data)

---

## Dataset Structure

| File | Description | Key Fields |
|---|---|---|
| `detections_jittered.csv` | 37,356 icequake events | `time`, `lat`, `lon`, `depth_ellipsoid`, `east_shift`, `north_shift`, `semblance` |
| `stations.csv` | 14 seismic stations | `latitude`, `longitude`, `elevation`, `depth` |
| `env_data/meteo.csv` | Meteorological data | `temperature`, `precipitation`, `global radiation` |
| `env_data/runoff.csv` | Water runoff measurements | `time`, `runoff` |
| `DEM/` | Digital Elevation Model of glacier surface | GeoTIFF heightmap |

---

## Technology Stack

### 3D Rendering
- **Three.js** — primary 3D engine (WebGL), full control over rendering, well-documented, widely used in academic visualization prototypes. Used for Space-Time Cube, point clouds, DEM (Digital elevation model) surface mesh.
- **deck.gl** *(optional)* — GPU-accelerated geospatial layer on top of Three.js; useful if switching to a map-based overview with `ScatterplotLayer` or `TripsLayer`.

### 2D Linked Views & Data
- **D3.js** — temporal timeline, meteo correlation charts, color scales, data binning
- **Papa Parse** — fast CSV parsing in the browser

### Frontend Framework
- **React + Vite** — component structure for 3D canvas + UI controls (time slider, filters, selection panel)

### Data Preprocessing (run once, before the dev server)
- **Python + Pandas** — CSV → unified JSON conversion, temporal resampling, spatial binning
- **rasterio / GDAL** — DEM processing (GeoTIFF → PNG heightmap for Three.js)
- **SciPy / scikit-learn** *(optional)* — spatial clustering (ST-DBSCAN) for local exploration

---

## Unified Data Format

All datasets are converted into a single JSON schema before loading into the browser:

```json
{
  "metadata": {
    "name": "Rhône Glacier Icequakes 2020",
    "domain": "seismic",
    "t_min": 1593683515.363,
    "t_max": 1598437168.738,
    "x_range": [-608.32, 608.33],
    "y_range": [-608.31, 608.33],
    "z_range": [-2608.33, -2191.67]
  },
  "events": [
    { "t": 1593683515.363, "x": -7.98, "y": 259.25, "z": -2537.16, "q": 0.137 }
  ]
}
```

- `t` — Unix timestamp (float seconds), fast to sort and bin in JS
- `x`, `y`, `z` — metric spatial coordinates in meters (`east_shift`, `north_shift`, `depth_ellipsoid`)
- `q` — quality scalar (semblance value, 0–1)

### Python Conversion Script

```python
import pandas as pd
import json
from pathlib import Path

OUTPUT = Path("public/data")
OUTPUT.mkdir(parents=True, exist_ok=True)

# Events
df = pd.read_csv("Stefan_Vis/detections_jittered.csv")
df["time"] = pd.to_datetime(df["time"], utc=True)

events = [
    {"t": round(r.time.timestamp(), 3),
     "x": round(r.east_shift, 2),
     "y": round(r.north_shift, 2),
     "z": round(r.depth_ellipsoid, 2),
     "q": round(r.semblance, 4)}
    for r in df.itertuples()
]

json.dump({
    "metadata": {
        "name": "Rhône Glacier Icequakes 2020",
        "domain": "seismic",
        "t_min": df["time"].min().timestamp(),
        "t_max": df["time"].max().timestamp(),
        "x_range": [float(df.east_shift.min()), float(df.east_shift.max())],
        "y_range": [float(df.north_shift.min()), float(df.north_shift.max())],
        "z_range": [float(df.depth_ellipsoid.min()), float(df.depth_ellipsoid.max())]
    },
    "events": events
}, open(OUTPUT / "icequakes.json", "w"))

# Meteo
m = pd.read_csv("Stefan_Vis/env_data/meteo.csv")
m["time"] = pd.to_datetime(m["time"])
json.dump([{"t": round(r.time.timestamp()), "temp": r.temperature,
            "precip": r.precipitation} for r in m.itertuples()],
          open(OUTPUT / "meteo.json", "w"))

# Stations
s = pd.read_csv("Stefan_Vis/stations.csv")
json.dump(s.fillna("").to_dict(orient="records"), open(OUTPUT / "stations.json", "w"))

print(f"Done: {len(events)} events written.")
```

---

## Visualization Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  GLOBAL VIEW  (Three.js)                    │
│                                                             │
│  Overview 1: Space-Time Cube                                │
│    X = east_shift   Y = north_shift   Z = depth             │
│    color = time     size = semblance                        │
│    + DEM glacier surface as 3D mesh                         │
│                                                             │
│  Overview 2: Temporal Density Heatmap                       │
│    Time split into intervals → density field per slice      │
│    Volumetric rendering to show activity "bursts"           │
└───────────────────┬─────────────────────────────────────────┘
                    │  spatial bbox selection (brush/click)
┌───────────────────▼─────────────────────────────────────────┐
│                  LOCAL VIEW  (D3.js)                        │
│                                                             │
│  Event Trail: events within selected region shown in        │
│  temporal sequence, connected by arrows                     │
│                                                             │
│  Linked timeline: meteo correlation panel below             │
│  (precipitation, temperature, runoff vs. event count)       │
└─────────────────────────────────────────────────────────────┘
                    ↕
        shared temporal slider (plays back time)
        shared spatial filter (bbox in 3D scene)
```

---

## Dataset → Visualization Mapping

| Dataset | Overview 1 (Space-Time Cube) | Overview 2 (Density Heatmap) | Local Exploration |
|---|---|---|---|
| **Icequakes (glacier)** | X/Y/Z = spatial, color = time, size = semblance | Density per depth slice over time | Event trail in region + meteo correlation |
| **Traffic incidents** | X/Y = road network, Z = time | Heatmap by hour/day | Incident sequence on a road segment |
| **Fractal orbits** | X/Y/Z = orbit position, color = iteration step | Density of visited regions | Trajectory of a single orbit |

---

## Project Structure

```
icequake-vis/
├── public/
│   └── data/               # preprocessed JSON files
│       ├── icequakes.json
│       ├── meteo.json
│       ├── runoff.json
│       └── stations.json
├── src/
│   ├── components/
│   │   ├── SpaceTimeCube.jsx     # Three.js overview 1
│   │   ├── DensityHeatmap.jsx    # Three.js overview 2
│   │   ├── EventTrail.jsx        # D3.js local view
│   │   └── MeteoPanel.jsx        # D3.js correlation chart
│   ├── stores/
│   │   └── viewState.js          # shared time + spatial filter state
│   └── App.jsx
├── scripts/
│   └── convert_data.py           # preprocessing pipeline
└── vite.config.js
```

---

## Scalability Notes

- 37k events is a small dataset — Three.js `Points` with `BufferGeometry` handles this trivially in a single draw call
- For future larger datasets: consider spatial indexing (k-d tree) client-side, or tile-based loading via FastAPI backend
- DEM heightmap: export as PNG (1 channel = elevation) and load as `PlaneGeometry` with displacement map in Three.js
