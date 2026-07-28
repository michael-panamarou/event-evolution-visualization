// app.js — Icequake Visualization
//
// Modules:
//   1. Constants & state
//   2. Three.js scene setup
//   3. Point cloud rendering
//   4. Orbit controls (mouse / touch)
//   5. Rubber-band selection
//   6. Local exploration panel + mini-charts
//   7. Meteo chart
//   8. UI controls (color, size, quality, time, play)
//   9. Resize
//  10. Init


// 1. Dataset definitions & active-dataset state

const ALL_DATASETS = {
  icequakes: { events: EV, meta: META, meteo: METEO },
  traffic:   DATASET_TRAFFIC,
  lorenz:    DATASET_LORENZ,
};

// Active-dataset values - recomputed by loadDataset()
let DS = null;
let T0, T1, TSPAN, N;
let X_MIN, X_MAX, X_SPAN;
let Y_MIN, Y_MAX, Y_SPAN;
let Z_MIN, Z_MAX, Z_SPAN;
let tNorm, qArr;   // Float32Array, length N

const SCENE_W = 600;   // scene units for X & Z
const SCENE_H = 484;   // scene units for Y (depth or time)

// Normalize any event's coordinates into scene space
// Axis convention (GIS / Z-up style, as in the reference DEM images):
//   data X = east       -> horizontal   [BLUE  axis]
//   data Y = north      -> horizontal   [RED   axis]
//   data Z = elevation  -> VERTICAL     [GREEN axis]
// Three.js itself is Y-up, so data Z is mapped to the engine's Y axis and
// data Y (north) to the engine's Z axis. The seismic catalogue stores z as a
// NEGATED elevation (z = -2537 means 2537 m altitude), so for that domain the
// vertical mapping is flipped: physically higher events must appear higher.
let Z_FLIP = false;

// Scene units per horizontal metre, plus an explicit vertical exaggeration.
// Stretching z to fill the cube is harmless for a dataset 1.2 km wide and 400 m
// deep (the glacier: ~2.4x), but for one 80 km wide with 500 m of relief it
// means 128x - real hills become alps. The vertical scale is therefore tied to
// the horizontal one, with an adjustable exaggeration factor on top.
let NAT_SCALE = 1;      // scene units per metre, horizontally
let MAX_EXAG  = 1;      // exaggeration at which the data exactly fills the cube

function sceneYFromZ(z) {
  if (Z_SPAN <= 0.001) return 0;
  const zMid = (Z_MIN + Z_MAX) / 2;
  let y = (z - zMid) * NAT_SCALE * S.vertExag;
  if (Z_FLIP) y = -y;
  return y;
}
function sceneXFromEast(east)   { return X_SPAN > 0.001 ? (east  - X_MIN) / X_SPAN * SCENE_W - SCENE_W/2 : 0; }
function sceneZFromNorth(north) { return Y_SPAN > 0.001 ? (north - Y_MIN) / Y_SPAN * SCENE_W - SCENE_W/2 : 0; }

// True elevation in metres (positive up) for labels and colour scales
function displayElev(z) { return Z_FLIP ? -z : z; }

function sceneX(e) { return sceneXFromEast(e.x); }
function sceneY(e) { return sceneYFromZ(e.z); }
function sceneZ(e) { return sceneZFromNorth(e.y); }

// Application state
const S = {
  colorBy: 'time',
  pointSz: 2.0,
  qualMin: 0.05,
  tEnd: 1.0,
  winFrac: 1.0,
  playing: false,
  autoRot: false,
  mode: 'orbit',
  viewMode: 'pointcloud',   // ← new
  showSurface: false,       // ← new (glacier DEM mesh)
  selIdx: [],
};


// 2. Three.js scene setup

const wrap = document.getElementById('view3d');
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setClearColor(0x0d0f14, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 1, 5000);

// Lights - only shaded meshes (the DEM terrain) respond to these; the point
// cloud, grid, box and trail use unlit materials and are unaffected.
scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x151a22, 0.85));
const sunLight = new THREE.DirectionalLight(0xffffff, 0.75);
sunLight.position.set(-0.55, 1.0, 0.35);
scene.add(sunLight);

// Scene decorations - bounding box + grid + labelled, colour-coded axes
function buildSceneDecorations() {
  const grid = new THREE.GridHelper(SCENE_W, 8, 0x1e2535, 0x181c26);
  grid.position.y = -SCENE_H / 2;
  scene.add(grid);

  const boxEdges = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(SCENE_W, SCENE_H, SCENE_W)
  );
  const boxMat = new THREE.LineBasicMaterial({ color: 0x1e2535, transparent: true, opacity: 0.7 });
  scene.add(new THREE.LineSegments(boxEdges, boxMat));

  // Axes with the requested colours. X (east) and Y (north) sit at the lower
  // corner; the Z axis is anchored at the TOP of the cube and runs DOWNWARD,
  // so that it reads as depth into the glacier.
  const L = 230;
  const lowCorner = new THREE.Vector3(-SCENE_W/2, -SCENE_H/2, -SCENE_W/2);
  const topCorner = new THREE.Vector3(-SCENE_W/2,  SCENE_H/2, -SCENE_W/2);
  const axesGroup = new THREE.Group();
  const addAxis = (from, dir, color) => {
    const to = from.clone().add(dir.clone().multiplyScalar(L));
    const g  = new THREE.BufferGeometry().setFromPoints([from.clone(), to]);
    axesGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color })));
    // small arrow head at the far end
    const head = new THREE.Mesh(new THREE.ConeGeometry(3.2, 13, 10),
        new THREE.MeshBasicMaterial({ color }));
    head.position.copy(to);
    head.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dir.clone().normalize());
    axesGroup.add(head);
  };
  addAxis(lowCorner, new THREE.Vector3(1,0,0), 0x3b82f6);   // X east   - blue
  addAxis(lowCorner, new THREE.Vector3(0,0,1), 0xef4444);   // Y north  - red
  scene.add(axesGroup);

  // The vertical axis is the only one whose direction is dataset-dependent, so
  // it is built separately and re-oriented whenever the dataset changes.
  zAxis = new THREE.Group();
  scene.add(zAxis);
  buildZAxis(true);

  // Z axis: downward from the top corner when the vertical coordinate is a
  // DEPTH (the seismic catalogue stores a negated elevation), upward from the
  // bottom corner when it is a true ELEVATION - otherwise the arrow contradicts
  // the data for the traffic and Lorenz datasets, where higher really is up.
  function buildZAxis(down) {
    while (zAxis.children.length) zAxis.remove(zAxis.children[0]);
    const from = down ? topCorner.clone() : lowCorner.clone();
    const dir  = new THREE.Vector3(0, down ? -1 : 1, 0);
    const to   = from.clone().add(dir.clone().multiplyScalar(L));
    zAxis.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([from, to]),
        new THREE.LineBasicMaterial({ color: 0x22c55e })));
    const head = new THREE.Mesh(new THREE.ConeGeometry(3.2, 13, 10),
        new THREE.MeshBasicMaterial({ color: 0x22c55e }));
    head.position.copy(to);
    head.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dir);
    zAxis.add(head);
  }
  setZAxisDown = buildZAxis;
}

let zAxis = null;
let setZAxisDown = () => {};

buildSceneDecorations();


// 3. Point cloud rendering

let pointCloud = null;

// Maps a 0-1 value to an RGB triplet using a 5-stop gradient:
// blue -> cyan -> green -> yellow -> red
function gradientColor(t) {
  const stops = [
    [0.00, 0.22, 0.51, 1.00],
    [0.25, 0.02, 0.71, 0.84],
    [0.50, 0.06, 0.72, 0.51],
    [0.75, 0.92, 0.70, 0.04],
    [1.00, 0.94, 0.27, 0.27],
  ];
  t = Math.max(0, Math.min(1, t));
  for (let i = 0; i < stops.length - 1; i++) {
    if (t <= stops[i + 1][0]) {
      const s = (t - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
      return [
        stops[i][1] * (1 - s) + stops[i + 1][1] * s,
        stops[i][2] * (1 - s) + stops[i + 1][2] * s,
        stops[i][3] * (1 - s) + stops[i + 1][3] * s,
      ];
    }
  }
  return [0.94, 0.27, 0.27];
}

// Rebuilds the point cloud geometry from current state filters.
// Called whenever color mode, quality filter, or time window changes.
function rebuildPointCloud() {
  if (pointCloud) scene.remove(pointCloud);

  const tEndAbs = T0 + S.tEnd * TSPAN;
  const tStartAbs = T0 + (S.tEnd - S.winFrac) * TSPAN;

  const positions = [];
  const colors = [];
  const visIndices = [];  // maps geometry index → EV index (used by selection)

  for (let i = 0; i < N; i++) {
    const e = DS.events[i];
    if (e.t < tStartAbs || e.t > tEndAbs) continue;
    if (e.q < S.qualMin) continue;

    // Colour value
    let t;
    if      (S.colorBy === 'time')  t = tNorm[i];
    else if (S.colorBy === 'depth') t = Z_SPAN > 0.001 ? (e.z - Z_MIN) / Z_SPAN : 0.5;
    else                            t = qArr[i];

    const [r, g, b] = gradientColor(t);

    // Scene position: X=east, Y=depth, Z=north
    positions.push(sceneX(e), sceneY(e), sceneZ(e));
    colors.push(r, g, b);
    visIndices.push(i);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(colors),    3));

  const mat = new THREE.PointsMaterial({
    size: S.pointSz,
    vertexColors: true,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });

  pointCloud = new THREE.Points(geo, mat);
  pointCloud.userData.visIndices = visIndices;
  scene.add(pointCloud);

  // Update header stat
  document.getElementById('s-shown').textContent = visIndices.length.toLocaleString();

  // Update time label
  const fmt = ts => DS.meta.domain !== 'orbital'
      ? new Date(ts * 1000).toISOString().slice(5, 16).replace('T', ' ')
      : 't=' + ts.toFixed(1);
  document.getElementById('time-label').textContent =
      S.winFrac >= 1
          ? 'Full dataset'
          : fmt(tStartAbs) + ' → ' + fmt(tEndAbs);

  drawMeteo();
}


// 4. Density heatmap  (Overview 2)

const HMAP_GRID = 64;          // grid for datasets that have no DEM
let heatmapGroup = null;

// Overview 2 - event density as a heat field draped over the 3D DEM surface.
// For datasets with no DEM (traffic, Lorenz) it falls back to a single density
// plane rather than a stack of separate layers.
// ---------------------------------------------------------------------------
// Overview 2: SPACE-TIME CUBE standing on the DEM
//
//   bottom slab : the real glacier-surface DEM (relief, elevation colours,
//                 true east/north coordinates)  -> WHERE
//   above it    : the vertical axis becomes TIME, so a column above a place
//                 is the history of that place -> WHEN events happened, how
//                 they propagated, and (through the heat colours) where the
//                 activity was most intense.
// ---------------------------------------------------------------------------
const STC_BASE_FRAC = 0.24;    // fraction of cube height used by the terrain
const STC_DGRID     = 26;      // density grid (east x north x time)

// vertical position of the DEM inside the bottom slab
function stcBaseY(z) {
  const SU = activeSurface(), BD = activeBedrock();
  const lo = Math.min(SU.z_min, BD ? BD.z_min : SU.z_min);
  const hi = Math.max(SU.z_max, BD ? BD.z_max : SU.z_max);
  let u = hi > lo ? (z - lo) / (hi - lo) : 0.5;
  if (Z_FLIP) u = 1 - u;                       // z is a negated elevation
  return -SCENE_H/2 + u * SCENE_H * STC_BASE_FRAC;
}
// Normalised vertical position of an event on the time axis.
//   absolute : 0 = first event in the dataset, 1 = last
//   cyclic   : 0 = 00:00, 1 = 24:00 -- folds every day onto one axis, which is
//              how a diurnal rhythm (rush hours) becomes visible at all
function eventT01(e) {
  if (S.timeMode === 'cyclic') return ((e.t / 3600) % 24) / 24;
  return TSPAN > 0 ? (e.t - T0) / TSPAN : 0;
}

// vertical position of a normalised time value (0 = start, 1 = end)
function stcTimeY(t01) {
  return -SCENE_H/2 + SCENE_H * STC_BASE_FRAC + t01 * SCENE_H * (1 - STC_BASE_FRAC);
}

// DEM terrain compressed into the bottom slab, coloured by true elevation
// Base slab for datasets that have no DEM (the Lorenz attractor). The
// Space-Time Cube needs *something* to stand on, so the terrain is replaced by
// a flat plane coloured by the 2-D event density in x/y - the vertical
// (time) half of the technique is identical either way.
//
// buildDensityHeatmap() called this function before it existed, so switching
// to Overview 2 on a DEM-less dataset threw a ReferenceError and left the view
// blank.
function buildFlatDensityPlane() {
  const n = HMAP_GRID;
  const g = new Float32Array(n * n);
  const tEndAbs   = T0 + S.tEnd * TSPAN;
  const tStartAbs = T0 + (S.tEnd - S.winFrac) * TSPAN;
  for (const e of DS.events) {
    if (e.t < tStartAbs || e.t > tEndAbs || e.q < S.qualMin) continue;
    const c = Math.min(n-1, Math.max(0, Math.floor((e.x - X_MIN) / (X_SPAN||1) * n)));
    const r = Math.min(n-1, Math.max(0, Math.floor((e.y - Y_MIN) / (Y_SPAN||1) * n)));
    g[r * n + c]++;
  }
  // 1-2-1 separable blur, twice - same smoothing as the draped DEM heat field
  let a = g;
  for (let pass = 0; pass < 2; pass++) {
    const b = new Float32Array(n * n);
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) {
        const C = a[r*n+c];
        const l = c > 0 ? a[r*n+c-1] : C, rr = c < n-1 ? a[r*n+c+1] : C;
        b[r*n+c] = (l + 2*C + rr) * 0.25;
      }
    const d = new Float32Array(n * n);
    for (let c = 0; c < n; c++)
      for (let r = 0; r < n; r++) {
        const C = b[r*n+c];
        const u = r > 0 ? b[(r-1)*n+c] : C, dn = r < n-1 ? b[(r+1)*n+c] : C;
        d[r*n+c] = (u + 2*C + dn) * 0.25;
      }
    a = d;
  }
  let mx = 0; for (let i = 0; i < a.length; i++) if (a[i] > mx) mx = a[i];

  const baseY = -SCENE_H/2 + SCENE_H * STC_BASE_FRAC;
  const geo = new THREE.PlaneGeometry(1, 1, n - 1, n - 1);
  const pos = geo.attributes.position;
  const colors = [];
  for (let row = 0; row < n; row++)
    for (let col = 0; col < n; col++) {
      const idx   = row * n + col;
      const east  = X_MIN + X_SPAN * (col / (n - 1));
      const north = Y_MIN + Y_SPAN * (row / (n - 1));
      pos.setXYZ(idx, sceneXFromEast(east), baseY, sceneZFromNorth(north));
      const t = mx > 0 ? Math.sqrt(a[idx] / mx) : 0;
      const [r, g2, b] = gradientColor(t);
      colors.push(r, g2, b);
    }
  pos.needsUpdate = true;
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const grp = new THREE.Group();
  grp.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.9, metalness: 0.0,
    side: THREE.DoubleSide, flatShading: false })));
  grp.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: 0x0d1117, wireframe: true, transparent: true, opacity: 0.10,
    depthWrite: false })));
  return grp;
}

function buildStcBase() {
  const SU = activeSurface();
  const n = SU.n;
  const { x_min, x_max, y_min, y_max } = SU;
  const eLo = Math.min(displayElev(SU.z_min), displayElev(SU.z_max));
  const eHi = Math.max(displayElev(SU.z_min), displayElev(SU.z_max));

  const geo = new THREE.PlaneGeometry(1, 1, n - 1, n - 1);
  const pos = geo.attributes.position;
  const colors = [];
  for (let row = 0; row < n; row++)
    for (let col = 0; col < n; col++) {
      const idx = row * n + col;
      const east  = x_min + (x_max - x_min) * (col / (n - 1));
      const north = y_min + (y_max - y_min) * (row / (n - 1));
      const z     = SU.z[idx];
      pos.setXYZ(idx, sceneXFromEast(east), stcBaseY(z), sceneZFromNorth(north));
      const t = eHi > eLo ? (displayElev(z) - eLo) / (eHi - eLo) : 0.5;
      const [r, g, b] = gradientColor(t);
      colors.push(r, g, b);
    }
  pos.needsUpdate = true;
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const grp = new THREE.Group();
  grp.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.9, metalness: 0.0,
    side: THREE.DoubleSide, flatShading: false })));
  grp.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: 0x0d1117, wireframe: true, transparent: true, opacity: 0.10,
    depthWrite: false })));
  return grp;
}

// Space-time density: events binned in (east, north, time), lightly smoothed,
// so each event can be coloured by how intense activity is around it.
function stcDensity() {
  const n = STC_DGRID;
  const cnt = new Float32Array(n * n * n);
  const idx = (i, j, k) => i + n * (j + n * k);
  const tEndAbs   = T0 + S.tEnd * TSPAN;
  const tStartAbs = T0 + (S.tEnd - S.winFrac) * TSPAN;
  for (const e of DS.events) {
    if (e.t < tStartAbs || e.t > tEndAbs || e.q < S.qualMin) continue;
    const i = Math.min(n-1, Math.max(0, Math.floor((e.x - X_MIN) / (X_SPAN||1) * n)));
    const j = Math.min(n-1, Math.max(0, Math.floor((e.y - Y_MIN) / (Y_SPAN||1) * n)));
    const k = Math.min(n-1, Math.max(0, Math.floor(eventT01(e) * n)));
    cnt[idx(i,j,k)]++;
  }
  // 1-2-1 smoothing along each axis
  let a = cnt;
  for (let pass = 0; pass < 2; pass++) {
    const b = new Float32Array(a.length);
    for (let k = 0; k < n; k++)
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const c = a[idx(i,j,k)];
          const gx = (i>0?a[idx(i-1,j,k)]:c) + 2*c + (i<n-1?a[idx(i+1,j,k)]:c);
          const gy = (j>0?a[idx(i,j-1,k)]:c) + 2*c + (j<n-1?a[idx(i,j+1,k)]:c);
          const gz = (k>0?a[idx(i,j,k-1)]:c) + 2*c + (k<n-1?a[idx(i,j,k+1)]:c);
          b[idx(i,j,k)] = (gx + gy + gz) / 12;
        }
    a = b;
  }
  let mx = 0; for (let p = 0; p < a.length; p++) if (a[p] > mx) mx = a[p];
  return { n, dens: a, max: mx, idx };
}

// The events themselves, lifted onto the time axis and coloured by intensity
function buildStcPoints() {
  const D = stcDensity();
  const positions = [], colors = [];
  const tEndAbs   = T0 + S.tEnd * TSPAN;
  const tStartAbs = T0 + (S.tEnd - S.winFrac) * TSPAN;
  const n = D.n;
  for (const e of DS.events) {
    if (e.t < tStartAbs || e.t > tEndAbs || e.q < S.qualMin) continue;
    const t01 = eventT01(e);
    positions.push(sceneX(e), stcTimeY(t01), sceneZ(e));
    const i = Math.min(n-1, Math.max(0, Math.floor((e.x - X_MIN) / (X_SPAN||1) * n)));
    const j = Math.min(n-1, Math.max(0, Math.floor((e.y - Y_MIN) / (Y_SPAN||1) * n)));
    const k = Math.min(n-1, Math.max(0, Math.floor(t01 * n)));
    const d = D.max > 0 ? Math.sqrt(D.dens[D.idx(i,j,k)] / D.max) : 0;
    const [r, g, b] = gradientColor(d);
    colors.push(r, g, b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(colors), 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({
    size: Math.max(1.6, S.pointSz), vertexColors: true,
    transparent: true, opacity: 0.9, sizeAttenuation: true }));
}

function buildDensityHeatmap() {
  destroyHeatmap();
  heatmapGroup = new THREE.Group();

  if (datasetHasSurface()) {
    heatmapGroup.add(buildStcBase());     // DEM terrain at the bottom
    heatmapGroup.add(buildStcPoints());   // space-time cube above it
    const marks = buildStationMarkers();  // stations, dropped onto the base
    if (marks) {
      marks.children.forEach(c => { c.position.y = stcBaseY(activeSurface().z_max); });
      heatmapGroup.add(marks);
    }
  } else {
    heatmapGroup.add(buildFlatDensityPlane());  // no DEM: flat density base
    heatmapGroup.add(buildStcPoints());         // same cube above it
  }
  scene.add(heatmapGroup);
  updateHeatmapLegend();
}

function updateHeatmapLegend() {
  const lo = document.getElementById('leg-min'), hi = document.getElementById('leg-max');
  if (lo && hi && S.viewMode === 'heatmap') {
    lo.textContent = 'Low density';
    hi.textContent = 'High density';
  }
}

function destroyHeatmap() {
  if (heatmapGroup) { scene.remove(heatmapGroup); heatmapGroup = null; }
}

// The drape depends on the time window, so a window change rebuilds it.
function updateHeatmapWindow() {
  if (S.viewMode === 'heatmap') buildDensityHeatmap();
}


// On-screen axis legend: each axis named in its own colour
function axisLegendHTML(extra) {
  const x = DS && DS.meta ? DS.meta.axes.x : 'East';
  const y = DS && DS.meta ? DS.meta.axes.y : 'North';
  // seismic z is a negated elevation and reads as depth; every other domain
  // stores a true elevation, so the axis must not be labelled "Depth" there.
  const zLabel = (DS && DS.meta && DS.meta.domain === 'seismic')
      ? 'Depth [m a.s.l.]'
      : ((DS && DS.meta && DS.meta.axes.z) || 'Elevation (m)');
  const zDir = (DS && DS.meta && DS.meta.domain === 'seismic')
      ? 'from top downward' : 'upward';
  let html = '<span class="ax-line"><b class="ax-x">X &mdash; ' + x + ' (blue)</b></span>' +
      '<span class="ax-line"><b class="ax-y">Y &mdash; ' + y + ' (red)</b></span>' +
      '<span class="ax-line"><b class="ax-z">Z &mdash; ' + zLabel +
      ' (green, ' + zDir + ')</b></span>';
  if (extra) html += '<span class="ax-line">' + extra + '</span>';
  return html;
}

function updateExagUI() {
  const sl = document.getElementById('exag-slider'), rd = document.getElementById('exag-val');
  if (sl) { sl.min = 1; sl.max = Math.max(2, Math.round(MAX_EXAG)); sl.step = 0.5; sl.value = S.vertExag; }
  if (rd) rd.textContent = '\u00d7' + S.vertExag.toFixed(1) +
      (S.vertExag >= MAX_EXAG - 0.01 ? ' (fills cube)' : '');
}

function setVertExag(v) {
  S.vertExag = parseFloat(v);
  updateExagUI();
  rebuildPointCloud();
  if (surfaceMesh) { const vis = surfaceMesh.visible; buildGlacierSurface(); surfaceMesh.visible = vis; }
  if (S.viewMode === 'heatmap') buildDensityHeatmap();
}

function setTimeMode(mode) {
  S.timeMode = mode;
  const a = document.getElementById('tm-abs'), c = document.getElementById('tm-cyc');
  if (a) a.className = mode === 'absolute' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline-secondary';
  if (c) c.className = mode === 'cyclic'   ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline-secondary';
  if (S.viewMode === 'heatmap') buildDensityHeatmap();
  const lbl = document.getElementById('axis-hint-label');
  if (lbl && S.viewMode === 'heatmap')
    lbl.innerHTML = axisLegendHTML(mode === 'cyclic'
        ? 'vertical axis = <b>hour of day</b> (00:00 at the base, 24:00 at the top)'
        : 'vertical axis = <b>time</b>; colour = intensity of activity');
}

function setViewMode(mode) {
  S.viewMode = mode;
  document.getElementById('vm-pc').className = mode === 'pointcloud'
      ? 'btn btn-sm btn-primary text-start'
      : 'btn btn-sm btn-outline-secondary text-start';
  document.getElementById('vm-hm').className = mode === 'heatmap'
      ? 'btn btn-sm btn-primary text-start'
      : 'btn btn-sm btn-outline-secondary text-start';

  if (mode === 'pointcloud') {
    if (pointCloud)   pointCloud.visible   = true;
    destroyHeatmap();
    if (surfaceMesh)  surfaceMesh.visible  = S.showSurface;
    document.getElementById('axis-hint-label').innerHTML = axisLegendHTML();
    document.getElementById('heatmap-note').style.display = 'none';
    setColor(S.colorBy);
  } else {
    if (pointCloud)   pointCloud.visible = false;
    if (surfaceMesh)  surfaceMesh.visible = false;   // the drape replaces it
    clearTrail();
    buildDensityHeatmap();
    document.getElementById('axis-hint-label').innerHTML =
        axisLegendHTML('colour on the ' +
            ((DS && DS.meta && DS.meta.domain === 'seismic') ? 'glacier surface'
             : datasetHasSurface() ? 'terrain surface' : 'base plane') +
            ' = event density');
    document.getElementById('heatmap-note').style.display = 'block';
  }
}

// 4b. Event trail  (Local exploration)

let trailGroup = null;

function drawEventTrail(selEvs) {
  clearTrail();
  if (selEvs.length < 2) return;
  trailGroup = new THREE.Group();

  const sorted = [...selEvs].sort((a, b) => a.t - b.t);
  const pts    = sorted.map(e => new THREE.Vector3(sceneX(e), sceneY(e), sceneZ(e)));

  trailGroup.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.75, transparent: true })
  ));

  const mkSphere = (color, pos) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(5, 10, 10),
        new THREE.MeshBasicMaterial({ color }));
    m.position.copy(pos); return m;
  };
  trailGroup.add(mkSphere(0x22c55e, pts[0]));               // green = first
  trailGroup.add(mkSphere(0xef4444, pts[pts.length - 1]));  // red   = last
  scene.add(trailGroup);
}

function clearTrail() {
  if (trailGroup) { scene.remove(trailGroup); trailGroup = null; }
}


// 4c. Glacier surface mesh  (DEM interpolated from station elevations)

let surfaceMesh = null;

// Builds a semi-transparent surface from the SURFACE grid in data.js.
// The grid stores z-values (event depth convention) over the east/north
// extent; each vertex is mapped through the same scene transform as the
// events, so the surface is spatially registered with the point cloud.
// Density grid over the DEM footprint (east x north), for the draped heatmap
function demDensityGrid(n) {
  const g = new Float32Array(n * n);
  const tEndAbs   = T0 + S.tEnd * TSPAN;
  const tStartAbs = T0 + (S.tEnd - S.winFrac) * TSPAN;
  const { x_min, x_max, y_min, y_max } = activeSurface();
  for (const e of DS.events) {
    if (e.t < tStartAbs || e.t > tEndAbs || e.q < S.qualMin) continue;
    const c = Math.floor((e.x - x_min) / ((x_max - x_min) || 1) * (n - 1));
    const r = Math.floor((e.y - y_min) / ((y_max - y_min) || 1) * (n - 1));
    if (c < 0 || c >= n || r < 0 || r >= n) continue;
    g[r * n + c]++;
  }
  // 1-2-1 separable blur, twice, so the drape reads as a smooth heat field
  let a = g;
  for (let p = 0; p < 2; p++) {
    const b = new Float32Array(n * n);
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) {
        const C = a[r*n+c];
        const l = c > 0     ? a[r*n+c-1] : C, rr = c < n-1 ? a[r*n+c+1] : C;
        b[r*n+c] = (l + 2*C + rr) * 0.25;
      }
    const d = new Float32Array(n * n);
    for (let c = 0; c < n; c++)
      for (let r = 0; r < n; r++) {
        const C = b[r*n+c];
        const u = r > 0     ? b[(r-1)*n+c] : C, dn = r < n-1 ? b[(r+1)*n+c] : C;
        d[r*n+c] = (u + 2*C + dn) * 0.25;
      }
    a = d;
  }
  let mx = 0;
  for (let i = 0; i < a.length; i++) if (a[i] > mx) mx = a[i];
  return { grid: a, max: mx };
}

// Builds the glacier DEM as a solid relief block.
//   opts.colorBy : 'elevation' (default) or 'density'
//   opts.opaque  : solid terrain + side walls (heatmap view) vs translucent
//                  sheet that the point cloud shows through (context view)
function buildDemMesh(opts) {
  const colorBy = (opts && opts.colorBy) || 'elevation';
  const opaque  = !!(opts && opts.opaque);
  const SRC     = (opts && opts.src) || activeSurface();

  const n = SRC.n;
  const { x_min, x_max, y_min, y_max } = SRC;

  const eLo = Math.min(displayElev(SRC.z_min), displayElev(SRC.z_max));
  const eHi = Math.max(displayElev(SRC.z_min), displayElev(SRC.z_max));

  let dens = null;
  if (colorBy === 'density') dens = demDensityGrid(n);

  const geo = new THREE.PlaneGeometry(1, 1, n - 1, n - 1);
  const pos = geo.attributes.position;
  const colors = [];
  const xyz = [];                       // keep scene coords for the side walls

  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const idx   = row * n + col;
      const east  = x_min + (x_max - x_min) * (col / (n - 1));
      const north = y_min + (y_max - y_min) * (row / (n - 1));
      const z     = SRC.z[idx];

      const sx = sceneXFromEast(east), sy = sceneYFromZ(z), sz = sceneZFromNorth(north);
      pos.setXYZ(idx, sx, sy, sz);
      xyz.push([sx, sy, sz]);

      let t;
      if (colorBy === 'flat') {
        const fc = (opts && opts.flatColor) || [0.7, 0.8, 0.9];
        // shade slightly by height so the relief is still readable
        const hs = eHi > eLo ? (displayElev(z) - eLo) / (eHi - eLo) : 0.5;
        colors.push(fc[0] * (0.72 + 0.42 * hs), fc[1] * (0.72 + 0.42 * hs), fc[2] * (0.72 + 0.42 * hs));
        continue;
      }
      if (colorBy === 'density') {
        t = dens.max > 0 ? Math.sqrt(dens.grid[row * n + col] / dens.max) : 0;
      } else {
        t = eHi > eLo ? (displayElev(z) - eLo) / (eHi - eLo) : 0.5;
      }
      const [r, g, b] = gradientColor(t);
      colors.push(r, g, b);
    }
  }
  pos.needsUpdate = true;
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const group = new THREE.Group();

  const topMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.9, metalness: 0.0,
    side: THREE.DoubleSide, flatShading: true,
    transparent: !opaque, opacity: opaque ? 1.0 : 0.55,
    depthWrite: opaque,
  });
  group.add(new THREE.Mesh(geo, topMat));

  // faint triangulation, as in the reference DEM figure
  group.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: 0x0d1117, wireframe: true, transparent: true,
    opacity: opaque ? 0.18 : 0.07, depthWrite: false })));

  // Solid side walls + base, so the DEM reads as a block of terrain rather
  // than a floating sheet. Only in the opaque (heatmap) view, otherwise the
  // walls would hide the events underneath.
  if (opaque) {
    const baseY = -SCENE_H / 2;
    const v = [];
    const at = (r, c) => xyz[r * n + c];
    const wall = (p, q) => {
      v.push(p[0], p[1], p[2],  q[0], q[1], q[2],  q[0], baseY, q[2]);
      v.push(p[0], p[1], p[2],  q[0], baseY, q[2], p[0], baseY, p[2]);
    };
    for (let c = 0; c < n - 1; c++) { wall(at(0, c),   at(0, c + 1)); }
    for (let c = 0; c < n - 1; c++) { wall(at(n-1, c+1), at(n-1, c)); }
    for (let r = 0; r < n - 1; r++) { wall(at(r + 1, 0), at(r, 0)); }
    for (let r = 0; r < n - 1; r++) { wall(at(r, n-1), at(r + 1, n-1)); }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    wg.computeVertexNormals();
    group.add(new THREE.Mesh(wg, new THREE.MeshStandardMaterial({
      color: 0x8fa3bd, roughness: 0.95, metalness: 0.0,
      side: THREE.DoubleSide, flatShading: true })));
  }
  return group;
}

// Seismic stations as white triangular markers
function buildStationMarkers() {
  if (typeof STATIONS === 'undefined' || !STATIONS || !Z_FLIP) return null;
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6,
    metalness: 0.0, flatShading: true });
  for (const st of STATIONS) {
    if (st.east === undefined) continue;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(7, 14, 4), mat);
    cone.position.set(sceneXFromEast(st.east), sceneYFromZ(st.z), sceneZFromNorth(st.north));
    cone.rotation.x = Math.PI;                 // point downward, like the figures
    g.add(cone);
  }
  return g;
}

// Context view: the real glacier surface DEM plus the bedrock DEM beneath it,
// with the icequakes in the ice column between them.
function buildGlacierSurface() {
  destroySurface();
  const SURF = activeSurface();
  if (!SURF) return;
  surfaceMesh = new THREE.Group();

  // bedrock: solid, muted rock tone (glacier only)
  const BED = activeBedrock();
  if (BED) {
    const bed = buildDemMesh({ src: BED, colorBy: 'flat',
      flatColor: [0.42, 0.40, 0.38], opaque: false });
    bed.children.forEach(m => {
      if (m.material.opacity !== undefined) m.material.opacity = 0.92;
      m.material.depthWrite = true;
    });
    surfaceMesh.add(bed);
  }
  // glacier surface: translucent ice
  const isGlacier = DS && DS.meta && DS.meta.domain === 'seismic';
  const ice = buildDemMesh({ src: SURF,
    colorBy: isGlacier ? 'flat' : 'elevation',
    flatColor: [0.72, 0.85, 0.95], opaque: false });
  // The events of a surface-bound dataset (road collisions) lie ON the terrain,
  // not inside a volume like the icequakes, so the sheet must stay translucent
  // enough for the point cloud underneath it to remain readable. At 0.75 the
  // 4 349 collisions were completely invisible whenever the surface was shown.
  ice.children.forEach(m => {
    if (m.material.opacity !== undefined) m.material.opacity = isGlacier ? 0.34 : 0.35; });
  surfaceMesh.add(ice);

  const marks = buildStationMarkers();
  if (marks) surfaceMesh.add(marks);

  surfaceMesh.visible = S.showSurface;
  scene.add(surfaceMesh);
  syncPointDepth();
}

// Events that sit on the terrain (collisions) are within a few metres of the
// DEM, so half of them fall behind the sheet and are lost to depth testing.
// While the surface is shown they are drawn last and without depth testing, so
// the point cloud reads as markers ON the map rather than inside it. Volume
// datasets (icequakes in the ice column) keep normal depth testing - there the
// occlusion carries real information about what is above and below the ice.
function syncPointDepth() {
  if (!pointCloud) return;
  const onTop = S.showSurface && !(DS && DS.meta && DS.meta.domain === 'seismic');
  pointCloud.material.depthTest = !onTop;
  pointCloud.renderOrder = onTop ? 10 : 0;
  pointCloud.material.needsUpdate = true;
}

function destroySurface() {
  if (surfaceMesh) { scene.remove(surfaceMesh); surfaceMesh = null; }
}

// Returns true if the active dataset has a surface grid
// The terrain for the active dataset: the glacier DEM for the seismic data,
// or a dataset-supplied DEM (traffic ships one inside DATASET_TRAFFIC.dem).
function activeSurface() {
  if (DS && DS.dem) return DS.dem;
  if (typeof SURFACE !== 'undefined' && SURFACE &&
      DS && DS.meta && DS.meta.domain === 'seismic') return SURFACE;
  return null;
}
function activeBedrock() {
  if (DS && DS.meta && DS.meta.domain === 'seismic' &&
      typeof BEDROCK !== 'undefined' && BEDROCK) return BEDROCK;
  return null;                       // only the glacier has a bedrock layer
}
function datasetHasSurface() { return activeSurface() !== null; }

function toggleSurface() {
  S.showSurface = !S.showSurface;
  if (S.showSurface && !surfaceMesh) buildGlacierSurface();
  if (surfaceMesh) surfaceMesh.visible = S.showSurface;
  syncPointDepth();

  const btn = document.getElementById('surf-btn');
  if (btn) {
    btn.className = S.showSurface
        ? 'btn btn-sm btn-info text-start'
        : 'btn btn-sm btn-outline-secondary text-start';
    btn.innerHTML = S.showSurface
        ? '<i class="bi bi-layers-half me-1"></i>Hide surface'
        : '<i class="bi bi-layers-half me-1"></i>Show surface';
  }
}


// 5. Orbit controls

// Spherical coordinates for the camera position
let sph = { theta: 0.8, phi: 1.1, radius: 900 };

function applyCamera() {
  camera.position.set(
      sph.radius * Math.sin(sph.phi) * Math.sin(sph.theta),
      sph.radius * Math.cos(sph.phi),
      sph.radius * Math.sin(sph.phi) * Math.cos(sph.theta)
  );
  camera.lookAt(0, 0, 0);
}
applyCamera();

// Mouse drag
let isDragging = false;
let prevMouse = { x: 0, y: 0 };

canvas.addEventListener('mousedown', e => {
  if (S.mode !== 'orbit') return;
  isDragging = true;
  prevMouse = { x: e.clientX, y: e.clientY };
});
window.addEventListener('mouseup', () => { isDragging = false; });
window.addEventListener('mousemove', e => {
  if (!isDragging || S.mode !== 'orbit') return;
  sph.theta -= (e.clientX - prevMouse.x) * 0.005;
  sph.phi = Math.max(0.15, Math.min(Math.PI - 0.15,
      sph.phi + (e.clientY - prevMouse.y) * 0.005));
  prevMouse = { x: e.clientX, y: e.clientY };
  applyCamera();
});

// Scroll zoom
canvas.addEventListener('wheel', e => {
  sph.radius = Math.max(200, Math.min(2200, sph.radius + e.deltaY));
  applyCamera();
  e.preventDefault();
}, { passive: false });

// Touch
let lastTouch = null;
canvas.addEventListener('touchstart', e => { lastTouch = e.touches[0]; });
canvas.addEventListener('touchmove', e => {
  if (!lastTouch || S.mode !== 'orbit') return;
  sph.theta -= (e.touches[0].clientX - lastTouch.clientX) * 0.006;
  sph.phi = Math.max(0.15, Math.min(Math.PI - 0.15,
      sph.phi + (e.touches[0].clientY - lastTouch.clientY) * 0.006));
  lastTouch = e.touches[0];
  applyCamera();
  e.preventDefault();
}, { passive: false });


// 6. Rubber-band selection

const selBox = document.getElementById('selbox');
let selStart = null;

canvas.addEventListener('mousedown', e => {
  if (S.mode !== 'select') return;
  const r = canvas.getBoundingClientRect();
  selStart = { x: e.clientX - r.left, y: e.clientY - r.top };
  selBox.style.display = 'block';
  selBox.style.left = selStart.x + 'px';
  selBox.style.top = selStart.y + 'px';
  selBox.style.width = '0px';
  selBox.style.height = '0px';
});

window.addEventListener('mousemove', e => {
  if (S.mode !== 'select' || !selStart) return;
  const r = canvas.getBoundingClientRect();
  const cx = e.clientX - r.left;
  const cy = e.clientY - r.top;
  selBox.style.left = Math.min(selStart.x, cx) + 'px';
  selBox.style.top = Math.min(selStart.y, cy) + 'px';
  selBox.style.width = Math.abs(cx - selStart.x) + 'px';
  selBox.style.height = Math.abs(cy - selStart.y) + 'px';
});

window.addEventListener('mouseup', e => {
  if (S.mode !== 'select' || !selStart) return;
  const r = canvas.getBoundingClientRect();
  const cx = e.clientX - r.left;
  const cy = e.clientY - r.top;
  const w = Math.abs(cx - selStart.x);
  const h = Math.abs(cy - selStart.y);
  if (w > 8 && h > 8) {
    const x0 = Math.min(selStart.x, cx);
    const y0 = Math.min(selStart.y, cy);
    findEventsInBox(x0, y0, x0 + w, y0 + h);
  }
  selStart = null;
});

// Projects a world-space point to canvas pixel coordinates
function projectToScreen(wx, wy, wz) {
  const v = new THREE.Vector3(wx, wy, wz).project(camera);
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  return { x: (v.x + 1) / 2 * W, y: (-v.y + 1) / 2 * H };
}

// Tests each visible point against the screen-space bounding box
function findEventsInBox(sx0, sy0, sx1, sy1) {
  if (!pointCloud) return;
  const posAttr = pointCloud.geometry.getAttribute('position');
  const visIndices = pointCloud.userData.visIndices;
  const found = [];

  for (let i = 0; i < posAttr.count; i++) {
    const sc = projectToScreen(
        posAttr.getX(i),
        posAttr.getY(i),
        posAttr.getZ(i)
    );
    if (sc.x >= sx0 && sc.x <= sx1 && sc.y >= sy0 && sc.y <= sy1) {
      found.push(visIndices[i]);
    }
  }

  S.selIdx = found;
  updateLocalPanel();
}

function clearSelection() {
  S.selIdx = [];
  selBox.style.display = 'none';
  clearTrail();
  updateLocalPanel();
}


// 6b. Export selected region as CSV

// Builds a CSV of the current selection and triggers a browser download.
// Column headers adapt to the active dataset's axis labels, and a
// human-readable ISO time column is added for time-based datasets.
function exportSelectionCSV() {
  if (!S.selIdx.length) return;

  const sel = S.selIdx.map(i => DS.events[i]).sort((a, b) => a.t - b.t);
  const ax  = DS.meta.axes || { x: 'x', y: 'y', z: 'z' };
  const isTime = DS.meta.domain !== 'orbital';

  // CSV-safe header cell (quote if it contains a comma)
  const cell = v => {
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  const header = ['t_raw'];
  if (isTime) header.push('time_iso');
  header.push(ax.x, ax.y, ax.z, DS.meta.q_label || 'q');

  const lines = [header.map(cell).join(',')];
  for (const e of sel) {
    const row = [e.t];
    if (isTime) row.push(new Date(e.t * 1000).toISOString());
    row.push(e.x, e.y, e.z, e.q);
    lines.push(row.map(cell).join(','));
  }
  const csv = lines.join('\n');

  // Trigger download via an object URL
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = url;
  a.download = `${DS.meta.domain}_selection_${sel.length}events_${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}


// 7. Local exploration panel

function updateLocalPanel() {
  const isEmpty = S.selIdx.length === 0;
  document.getElementById('local-empty').style.display = isEmpty ? 'flex' : 'none';
  document.getElementById('local-content').style.display = isEmpty ? 'none' : 'flex';
  if (isEmpty) return;

  const sel = S.selIdx.map(i => DS.events[i]);

  // Compute stats
  const times = sel.map(e => e.t).sort((a, b) => a - b);
  const depths = sel.map(e => e.z);
  const quals = sel.map(e => e.q);
  const avgQ = quals.reduce((a, b) => a + b, 0) / quals.length;
  const durH = (times[times.length - 1] - times[0]) / 3600;

  document.getElementById('l-count').textContent = sel.length.toLocaleString();
  document.getElementById('l-tspan').textContent =
      durH < 24 ? durH.toFixed(1) + ' hrs' : (durH / 24).toFixed(1) + ' days';
  document.getElementById('l-qual').textContent = avgQ.toFixed(3);
  document.getElementById('l-depth').textContent =
      Math.round(Math.min(...depths)) + ' – ' + Math.round(Math.max(...depths)) + ' m';

  drawLocalTimeChart(sel);
  drawDepthHistogram(sel);
  drawQualityDistribution(sel);
  drawEventTrail(sel);
}

// Bar chart: events binned by time
function drawLocalTimeChart(sel) {
  const cv = document.getElementById('local-time-chart');
  const W = cv.offsetWidth || 228;
  cv.width = W;
  const ctx = cv.getContext('2d');
  const H = cv.height;
  ctx.clearRect(0, 0, W, H);

  if (sel.length < 2) return;
  const BINS = 20;
  const tMin = Math.min(...sel.map(e => e.t));
  const tMax = Math.max(...sel.map(e => e.t));
  const binW = (tMax - tMin) / BINS || 1;
  const bins = new Array(BINS).fill(0);
  sel.forEach(e => {
    bins[Math.min(BINS - 1, Math.floor((e.t - tMin) / binW))]++;
  });
  const maxB = Math.max(...bins, 1);
  const bw = W / BINS;

  bins.forEach((b, i) => {
    const barH = Math.round((b / maxB) * (H - 14));
    ctx.fillStyle = 'rgba(79,195,247,0.18)';
    ctx.fillRect(i * bw + 1, H - barH - 10, bw - 2, barH);
    ctx.strokeStyle = 'rgba(79,195,247,0.7)';
    ctx.lineWidth = 1;
    ctx.strokeRect(i * bw + 1, H - barH - 10, bw - 2, barH);
  });

  // Axis labels
  ctx.fillStyle = '#2e3850';
  ctx.font = '8px IBM Plex Mono, monospace';
  const fmtShort = ts => new Date(ts * 1000).toISOString().slice(5, 10);
  ctx.fillText(fmtShort(tMin), 2, H - 2);
  ctx.textAlign = 'right';
  ctx.fillText(fmtShort(tMax), W - 2, H - 2);
  ctx.textAlign = 'left';
}

// Horizontal bar chart: depth distribution
function drawDepthHistogram(sel) {
  const cv = document.getElementById('depth-chart');
  const W = cv.offsetWidth || 228;
  cv.width = W;
  const ctx = cv.getContext('2d');
  const H = cv.height;
  ctx.clearRect(0, 0, W, H);

  const BINS = 16;
  const bins = new Array(BINS).fill(0);
  const zRange = Z_MAX - Z_MIN || 1;   // guard against zero span
  sel.forEach(e => {
    bins[Math.min(BINS - 1, Math.floor((e.z - Z_MIN) / zRange * BINS))]++;
  });
  const maxB = Math.max(...bins, 1);
  const bw = W / BINS;

  bins.forEach((b, i) => {
    const barH = Math.round((b / maxB) * (H - 14));
    // Colour: shallow=blue, deep=orange
    const t = i / BINS;
    const r = Math.round(50 + t * 200);
    const g = Math.round(180 - t * 100);
    const bl = Math.round(250 - t * 200);
    ctx.fillStyle = `rgba(${r},${g},${bl},0.35)`;
    ctx.fillRect(i * bw + 1, H - barH - 10, bw - 2, barH);
    ctx.strokeStyle = `rgba(${r},${g},${bl},0.8)`;
    ctx.lineWidth = 1;
    ctx.strokeRect(i * bw + 1, H - barH - 10, bw - 2, barH);
  });

  ctx.fillStyle = '#2e3850';
  ctx.font = '8px IBM Plex Mono, monospace';
  ctx.fillText('shallow', 2, H - 2);
  ctx.textAlign = 'right';
  ctx.fillText('deep', W - 2, H - 2);
  ctx.textAlign = 'left';
}

// Bar chart: semblance quality distribution
function drawQualityDistribution(sel) {
  const cv = document.getElementById('qual-chart');
  const W = cv.offsetWidth || 228;
  cv.width = W;
  const ctx = cv.getContext('2d');
  const H = cv.height;
  ctx.clearRect(0, 0, W, H);

  const BINS = 16;
  const bins = new Array(BINS).fill(0);
  sel.forEach(e => {
    bins[Math.min(BINS - 1, Math.floor(e.q / 0.8 * BINS))]++;
  });
  const maxB = Math.max(...bins, 1);
  const bw = W / BINS;

  bins.forEach((b, i) => {
    const barH = Math.round((b / maxB) * (H - 12));
    ctx.fillStyle = 'rgba(74,222,128,0.18)';
    ctx.fillRect(i * bw + 1, H - barH - 8, bw - 2, barH);
    ctx.strokeStyle = 'rgba(74,222,128,0.7)';
    ctx.lineWidth = 1;
    ctx.strokeRect(i * bw + 1, H - barH - 8, bw - 2, barH);
  });

  ctx.fillStyle = '#2e3850';
  ctx.font = '8px IBM Plex Mono, monospace';
  ctx.fillText('0.0', 2, H - 2);
  ctx.textAlign = 'right';
  ctx.fillText('0.8', W - 2, H - 2);
  ctx.textAlign = 'left';
}


// 8. Meteo chart

function drawMeteo() {
  if (!DS) return;

  const cv = document.getElementById('meteo-cv');
  const W = cv.offsetWidth || 600;
  cv.width = W;
  const H = cv.height;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const meteo = DS.meteo || [];
  if (!meteo.length) {
    ctx.fillStyle = '#9ca3af'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('No meteorological data for this dataset', W/2, H/2);
    ctx.textAlign = 'left'; return;
  }
  const mt0 = meteo[0].t;
  const mt1 = meteo[meteo.length - 1].t;
  const mSpan = mt1 - mt0 || 1;

  const temps = meteo.map(m => m.temp);
  const tMin = Math.min(...temps);
  const tMax = Math.max(...temps);
  const pMax = Math.max(...meteo.map(m => m.precip), 1);

  // Precipitation bars (background)
  meteo.forEach(m => {
    const x = ((m.t - mt0) / mSpan) * W;
    const h = (m.precip / pMax) * (H - 4);
    ctx.fillStyle = 'rgba(74,222,128,0.18)';
    ctx.fillRect(x, H - h - 2, 2, h);
  });

  // Temperature line
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(96,165,250,0.8)';
  ctx.lineWidth = 1.5;
  meteo.forEach((m, i) => {
    const x = ((m.t - mt0) / mSpan) * W;
    const y = H - 2 - ((m.temp - tMin) / (tMax - tMin)) * (H - 6);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Current time cursor
  const cx = S.tEnd * W;
  ctx.strokeStyle = 'rgba(251,146,60,0.9)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, H);
  ctx.stroke();
  ctx.setLineDash([]);
}


function loadDataset(name) {
  DS = ALL_DATASETS[name];
  const m = DS.meta;

  T0 = m.t_min;  T1 = m.t_max;  TSPAN = T1 - T0;
  N  = DS.events.length;
  X_MIN = m.x_range[0]; X_MAX = m.x_range[1]; X_SPAN = X_MAX - X_MIN;
  Y_MIN = m.y_range[0]; Y_MAX = m.y_range[1]; Y_SPAN = Y_MAX - Y_MIN;
  Z_MIN = m.z_range[0]; Z_MAX = m.z_range[1]; Z_SPAN = Z_MAX - Z_MIN;

  // seismic z is a negated elevation -> flip so higher ground is higher
  Z_FLIP = (m.domain === 'seismic');
  setZAxisDown(Z_FLIP);          // arrow points down only for depth data

  // The vertical axis must cover the events AND both DEM layers, otherwise the
  // glacier surface (which reaches higher than the shallowest event) is cut off
  // by the top of the cube and the terrain looks distorted.
  if (Z_FLIP && typeof SURFACE !== 'undefined' && SURFACE) {
    Z_MIN = Math.min(Z_MIN, SURFACE.z_min);
    Z_MAX = Math.max(Z_MAX, SURFACE.z_max);
    if (typeof BEDROCK !== 'undefined' && BEDROCK) {
      Z_MIN = Math.min(Z_MIN, BEDROCK.z_min);
      Z_MAX = Math.max(Z_MAX, BEDROCK.z_max);
    }
    Z_SPAN = Z_MAX - Z_MIN;
  }

  // horizontal scale + the exaggeration that would exactly fill the cube
  NAT_SCALE = SCENE_W / Math.max(X_SPAN || 1, Y_SPAN || 1);
  MAX_EXAG  = Z_SPAN > 0.001 ? SCENE_H / (Z_SPAN * NAT_SCALE) : 1;
  // fill the cube, but never exaggerate more than 10x
  S.vertExag = Math.min(10, MAX_EXAG);
  updateExagUI();

  tNorm = new Float32Array(N);
  qArr  = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    tNorm[i] = TSPAN > 0 ? (DS.events[i].t - T0) / TSPAN : 0;
    qArr[i]  = DS.events[i].q;
  }

  // Reset state
  Object.assign(S, { tEnd:1, winFrac:1, qualMin:0.05, colorBy:'time',
    playing:false, autoRot:false, mode:'orbit', selIdx:[],
    viewMode:'pointcloud', showSurface:false });

  // A few thousand events spread over 80 km need larger marks than 37 000
  // events packed into a 1.2 km glacier tongue.
  S.pointSz = (m.domain === 'seismic') ? 2.0 : 3.5;
  const szSlider = document.getElementById('sz-slider') ||
                   document.querySelector('input[oninput^="setSize"]');
  if (szSlider) szSlider.value = S.pointSz;
  const szVal = document.getElementById('sz-val');
  if (szVal) szVal.textContent = S.pointSz.toFixed(1);

  // Update UI
  document.getElementById('tslider').value = 100;
  if (document.getElementById('ds-name'))
    document.getElementById('ds-name').textContent = m.name || '—';
  if (document.getElementById('ds-count'))
    document.getElementById('ds-count').textContent = N.toLocaleString();
  if (document.getElementById('ds-range'))
    document.getElementById('ds-range').textContent = m.date_range || '—';
  if (document.getElementById('ds-domain'))
    document.getElementById('ds-domain').textContent = m.domain || '—';
  if (document.getElementById('axis-hint-label'))
    document.getElementById('axis-hint-label').innerHTML = axisLegendHTML();

  // Dataset switcher highlight
  document.querySelectorAll('.ds-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.ds === name));

  // Reset view mode buttons
  setViewMode('pointcloud');
  setColor('time');
  setMode('orbit');

  // Meteo strip
  const hasMeteo = !!(DS.meteo && DS.meteo.length);
  const meteoSection = document.getElementById('meteo-section');
  if (meteoSection) meteoSection.style.display = hasMeteo ? '' : 'none';

  // Glacier surface: only the seismic dataset has one
  destroySurface();
  const surfRow = document.getElementById('surface-row');
  if (surfRow) surfRow.style.display = datasetHasSurface() ? '' : 'none';
  const stcNote = document.getElementById('stc-note-text');
  if (stcNote) stcNote.innerHTML =
      (DS.meta.domain === 'seismic')
      ? 'Space-Time Cube on the glacier DEM: the terrain below is the real ice surface (elevation, true coordinates); above it the vertical axis is <b>time</b>, so a column shows when events occurred at that place. Colour = intensity of activity.'
      : datasetHasSurface()
      ? 'Space-Time Cube on the terrain DEM: the surface below is the real relief (SRTM&nbsp;30&nbsp;m, true coordinates); above it the vertical axis is <b>time</b>, so a column shows when events occurred at that place. Colour = intensity of activity.'
      : 'Space-Time Cube on a flat base: this dataset has no terrain, so the plane below is coloured by event density in the horizontal plane; above it the vertical axis is <b>time</b>, so a column shows when events occurred at that place.';
  const cap = document.getElementById('surf-caption');
  if (cap) cap.innerHTML = (DS.meta.domain === 'seismic')
      ? 'Real Rh&ocirc;ne Glacier DEM: ice surface and bedrock, with the icequakes in the ice column between them.'
      : 'Real terrain (SRTM&nbsp;30&nbsp;m) for the region, sampled as an elevation grid.';
  const surfBtn = document.getElementById('surf-btn');
  if (surfBtn) {
    surfBtn.className = 'btn btn-sm btn-outline-secondary text-start';
    surfBtn.innerHTML = '<i class="bi bi-layers-half me-1"></i>Show surface';
  }

  // Rebuild
  destroyHeatmap();
  clearTrail();
  clearSelection();
  rebuildPointCloud();
}


// 9. UI controls

function setColor(mode) {
  S.colorBy = mode;
  ['time', 'depth', 'qual'].forEach(m =>
      document.getElementById('cb-' + m).classList.toggle('active', m === mode)
  );

  const bar = 'linear-gradient(to right,#3b82f6,#06b6d4,#10b981,#eab308,#ef4444)';
  const legends = {
    time:  { min: 'Early',   max: 'Late', bar },
    depth: { min: 'Shallow', max: 'Deep', bar },
    qual:  { min: 'Low',     max: 'High', bar },
  };

  document.getElementById('legend-bar').style.background = legends[mode].bar;
  document.getElementById('leg-min').textContent = legends[mode].min;
  document.getElementById('leg-max').textContent = legends[mode].max;

  rebuildPointCloud();
}

function setSize(v) {
  S.pointSz = parseFloat(v);
  document.getElementById('sz-val').textContent = parseFloat(v).toFixed(1);
  if (pointCloud) pointCloud.material.size = S.pointSz;
}

function setQual(v) {
  S.qualMin = parseFloat(v);
  document.getElementById('q-val').textContent = parseFloat(v).toFixed(2);
  rebuildPointCloud();
  if (S.viewMode === 'heatmap') buildDensityHeatmap();
}

function onTSlider(v) {
  S.tEnd = v / 100;
  rebuildPointCloud();
  updateHeatmapWindow();
  drawMeteo();
}

let activeWinBtn = document.getElementById('win-all');
function setWin(frac, btn) {
  S.winFrac = frac;
  if (activeWinBtn) activeWinBtn.classList.remove('active');
  if (btn) { btn.classList.add('active'); activeWinBtn = btn; }
  rebuildPointCloud();
  updateHeatmapWindow();
}

function resetCam() {
  sph = { theta: 0.8, phi: 1.1, radius: 900 };
  applyCamera();
}

function toggleRot() {
  S.autoRot = !S.autoRot;
  const rotBtn = document.getElementById('rot-btn');
  rotBtn.classList.toggle('btn-primary', S.autoRot);
  rotBtn.classList.toggle('btn-outline-secondary', !S.autoRot);
  rotBtn.innerHTML = S.autoRot
      ? '<i class="bi bi-stop-fill me-1"></i>Stop rotate'
      : '<i class="bi bi-arrow-repeat me-1"></i>Auto-rotate';
}

function setMode(mode) {
  S.mode = mode;
  document.getElementById('m-orbit').className =
      mode === 'orbit' ? 'btn btn-sm btn-primary text-start' : 'btn btn-sm btn-outline-secondary text-start';
  document.getElementById('m-sel').className =
      mode === 'select' ? 'btn btn-sm btn-warning text-start' : 'btn btn-sm btn-outline-warning text-start';

  const badge = document.getElementById('mode-badge');
  badge.textContent = mode === 'select' ? 'SELECT REGION' : 'OVERVIEW';
  badge.classList.toggle('selecting', mode === 'select');

  document.getElementById('hud-orbit').style.display = mode === 'orbit'  ? 'block' : 'none';
  document.getElementById('hud-sel').style.display   = mode === 'select' ? 'block' : 'none';

  canvas.style.cursor = mode === 'select' ? 'crosshair' : 'grab';
  if (mode === 'orbit') selBox.style.display = 'none';
}

// Playback
let playInterval = null;
function togglePlay() {
  S.playing = !S.playing;
  const btn = document.getElementById('play-btn');
  const icon = document.getElementById('play-icon');
  icon.className = S.playing ? 'bi bi-pause-fill' : 'bi bi-play-fill';
  btn.classList.toggle('btn-warning', S.playing);
  btn.classList.toggle('btn-primary', !S.playing);

  if (S.playing) {
    if (S.tEnd >= 1.0) S.tEnd = 0.05;
    playInterval = setInterval(() => {
      S.tEnd = Math.min(1.0, S.tEnd + 0.004);
      document.getElementById('tslider').value = S.tEnd * 100;
      rebuildPointCloud();
      updateHeatmapWindow();
      drawMeteo();
      if (S.tEnd >= 1.0) togglePlay();
    }, 60);
  } else {
    clearInterval(playInterval);
  }
}

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { clearSelection(); if (S.mode === 'select') setMode('orbit'); }
  if (e.key === ' ')      { e.preventDefault(); togglePlay(); }
  if (e.key === 'r' || e.key === 'R') resetCam();
});


// 10. Resize

function onResize() {
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  renderer.setSize(W, H);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  drawMeteo();
}
window.addEventListener('resize', onResize);


// 11. Render loop + init

function renderLoop() {
  requestAnimationFrame(renderLoop);
  if (S.autoRot) { sph.theta += 0.004; applyCamera(); }
  renderer.render(scene, camera);
}

function init() {
  /*  const days = Math.round((META.t_max - META.t_min) / 86400);
    document.getElementById('s-loaded').textContent = META.count.toLocaleString();
    document.getElementById('s-days').textContent   = days + ' days';*/

  loadDataset('icequakes'); // DS is set first -  if not -> crash
  onResize();
  renderLoop();
}

init();