# Icequake Visualization — Prototype v2

3D browser visualization of spatiotemporal event evolution.  
Supports three datasets: Rhône Glacier icequakes · UK road traffic incidents · Lorenz attractor.


## Project structure

```
icequake-viz/
│
├── data/
│   ├── raw/                          <- put your original CSV files here
│   │   ├── detections_jittered.csv     seismic events (required)
│   │   ├── meteo.csv                   meteorological data
│   │   ├── runoff.csv                  water runoff
│   │   └── stations.csv                sensor positions
│   │
│   └── processed/                    <- (reserved for future intermediate files)
│
├── scripts/
│   └── convert_data.py               <- run this to regenerate all data files
│
└── public/                           <- open index.html in your browser
    ├── index.html
    ├── style.css
    ├── app.js
    ├── data.js                       <- auto-generated (icequakes)
    ├── data_traffic.js               <- auto-generated (synthetic traffic)
    └── data_lorenz.js                <- auto-generated (Lorenz attractor)
```


## Quick start

### 1. Install Python dependencies

```bash
pip install pandas scipy numpy
```

### 2. Run the conversion script

```bash
# Convert all datasets
python scripts/convert_data.py

# Or limit the icequake events for faster development
python scripts/convert_data.py --sample 5000
```

This reads the raw CSVs from `data/raw/`, generates the three JS data files
in `public/`, and prints a progress line for each step.

### 3. Open in browser

```
public/index.html   ← just double-click it, no server needed
```


## How the conversion works

```
data/raw/*.csv
      │
      │  scripts/convert_data.py
      │  - reads each CSV with pandas
      │  - renames columns to unified names (t, x, y, z, q)
      │  - parses timestamps → Unix seconds
      │  - resamples meteo/runoff to hourly (reduces file size)
      │  - computes metadata (t_min, t_max, x/y/z ranges, axes labels, …)
      │  - serialises everything as compact JSON
      │
      │  also generates two datasets algorithmically:
      │  - Lorenz attractor (scipy ODE integration, 22 000 steps)
      │  - Synthetic UK traffic (numpy random, 9 000 events)
      ▼
public/data.js          <- icequakes:  EV, METEO, RUNOFF, STATIONS, META
public/data_lorenz.js   <- Lorenz:     DATASET_LORENZ
public/data_traffic.js  <- Traffic:    DATASET_TRAFFIC
      │
      │  loaded by index.html as plain <script> tags
      ▼
app.js  reads the active dataset and renders with Three.js
```


## Adding a new dataset

1. Put your CSV in `data/raw/`
2. Make sure it has columns that map to the unified schema:

   | Unified | Accepted column names |
   |---|---|
   | `time` | time, timestamp, datetime, date |
   | `x` | east_shift, easting, x, lon, longitude |
   | `y` | north_shift, northing, y, lat, latitude |
   | `z` | depth_ellipsoid, depth, elevation, z |
   | `q` | semblance, quality, magnitude, snr, q |

3. Add a converter function in `scripts/convert_data.py`  
   (copy the pattern of `convert_events()` for CSV data,  
   or `generate_lorenz()` for algorithmically generated data)
4. Call `write_js_const(OUT_DIR / "data_myname.js", "DATASET_MYNAME", result)` in `main()`
5. Add an entry to `ALL_DATASETS` in `app.js` and a button to the dataset switcher in `index.html`
6. Re-run the script


## Unified event format

Each event across all datasets shares the same schema:

```json
{ "t": 1593683515.4, "x": -8.0, "y": 259.2, "z": -2537.2, "q": 0.137 }
```

| Field | Meaning | Unit |
|---|---|---|
| `t` | Unix timestamp (or simulation step for Lorenz) | seconds |
| `x` | Primary horizontal axis | metres / attractor units |
| `y` | Secondary horizontal axis | metres / attractor units |
| `z` | Vertical axis (depth, elevation, or Z state variable) | metres / attractor units |
| `q` | Quality / salience score (semblance, inverse severity, trajectory stability) | 0 – 1 |

Each dataset file also exposes a `meta` object:

```json
{
  "name":       "Rhône Glacier Icequakes 2020",
  "domain":     "seismic",
  "axes":       { "x": "East (m)", "y": "North (m)", "z": "Depth (m)" },
  "q_label":    "Semblance",
  "date_range": "Jul – Aug 2020",
  "has_meteo":  true,
  "count":      37356,
  "t_min":      1593683515.4,
  "t_max":      …,
  "x_range":    […, …],
  "y_range":    […, …],
  "z_range":    […, …]
}
```

The visualization reads all axis labels and display strings from `meta` at
runtime, so switching datasets requires no changes to rendering code.


## What's implemented (Prototype v2)

| Feature | Status |
|---|---|
| 3D point cloud — Overview 1 (Three.js) | ✅ |
| Color by time / Z axis / quality | ✅ |
| Time slider + playback animation | ✅ |
| Quality filter | ✅ |
| Orbit controls (rotate, zoom, touch) | ✅ |
| Temporal density heatmap — Overview 2 | ✅ |
| Rubber-band region selection | ✅ |
| Event trail (temporal sequence polyline) | ✅ |
| Local: event count over time | ✅ |
| Local: Z-axis distribution | ✅ |
| Local: quality distribution | ✅ |
| Meteo correlation strip | ✅ |
| Dataset switcher (icequakes / traffic / Lorenz) | ✅ |
| Multi-dataset coordinate normalization | ✅ |
| Keyboard shortcuts (Space, R, Esc) | ✅ |
| Data conversion + generation script | ✅ |


## Datasets

| Dataset | Events | Source | Domain |
|---|---|---|---|
| Rhône Glacier Icequakes 2020 | 37 356 | Real CSV (data/raw/) | seismic |
| UK Road Traffic Incidents | 9 000 | Synthetically generated | traffic |
| Lorenz Attractor | 22 000 | ODE integration (σ=10, ρ=28, β=8/3) | orbital |


## Out of scope (future work)

- Virtual / augmented reality rendering
- Real-time data streaming
- Automated clustering or ML-based analysis
- Expert or user evaluation study
