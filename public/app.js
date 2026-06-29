// app.js — Icequake Visualization · Prototype v1
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
function sceneX(e) { return X_SPAN > 0.001 ? (e.x - X_MIN) / X_SPAN * SCENE_W - SCENE_W/2 : 0; }
function sceneY(e) { return Z_SPAN > 0.001 ? (e.z - Z_MIN) / Z_SPAN * SCENE_H - SCENE_H/2 : 0; }
function sceneZ(e) { return Y_SPAN > 0.001 ? (e.y - Y_MIN) / Y_SPAN * SCENE_W - SCENE_W/2 : 0; }

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

// Scene decorations — bounding box + grid + axis helper
function buildSceneDecorations() {
  const grid = new THREE.GridHelper(SCENE_W, 8, 0x1e2535, 0x181c26);
  grid.position.y = -SCENE_H / 2;
  scene.add(grid);

  const boxEdges = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(SCENE_W, SCENE_H, SCENE_W)
  );
  const boxMat = new THREE.LineBasicMaterial({ color: 0x1e2535, transparent: true, opacity: 0.7 });
  scene.add(new THREE.LineSegments(boxEdges, boxMat));

  const axes = new THREE.AxesHelper(220);
  axes.position.set(-SCENE_W / 2, -SCENE_H / 2, -SCENE_W / 2);
  scene.add(axes);
}

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

const HMAP_SLICES = 16;
const HMAP_GRID   = 32;
let heatmapGroup  = null;

function buildDensityHeatmap() {
  destroyHeatmap();
  heatmapGroup = new THREE.Group();

  const sliceDur = TSPAN / HMAP_SLICES;
  const grids = [];
  let globalMax = 0;

  for (let s = 0; s < HMAP_SLICES; s++) {
    const tS = T0 + s * sliceDur, tE = T0 + (s + 1) * sliceDur;
    const grid = new Float32Array(HMAP_GRID * HMAP_GRID);
    for (const e of DS.events) {
      if (e.t < tS || e.t >= tE || e.q < S.qualMin) continue;
      const gx = Math.min(HMAP_GRID-1, Math.max(0, Math.floor((e.x - X_MIN) / (X_SPAN||1) * HMAP_GRID)));
      const gy = Math.min(HMAP_GRID-1, Math.max(0, Math.floor((e.y - Y_MIN) / (Y_SPAN||1) * HMAP_GRID)));
      grid[gx + gy * HMAP_GRID]++;
    }
    grids.push(grid);
    globalMax = Math.max(globalMax, ...grid);
  }

  for (let s = 0; s < HMAP_SLICES; s++) {
    const cvs = document.createElement('canvas');
    cvs.width = HMAP_GRID; cvs.height = HMAP_GRID;
    const ctx2 = cvs.getContext('2d');
    const img  = ctx2.createImageData(HMAP_GRID, HMAP_GRID);
    for (let i = 0; i < HMAP_GRID * HMAP_GRID; i++) {
      const d = globalMax > 0 ? grids[s][i] / globalMax : 0;
      img.data[i*4]   = Math.round(255 * Math.min(1, d * 2));
      img.data[i*4+1] = Math.round(255 * Math.max(0, 1 - Math.abs(d - 0.5) * 2));
      img.data[i*4+2] = Math.round(255 * Math.max(0, 1 - d * 2));
      img.data[i*4+3] = Math.round(220 * d);
    }
    ctx2.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(cvs);
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(SCENE_W, SCENE_W),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.72,
          side: THREE.DoubleSide, depthWrite: false })
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.y  = SCENE_H * (s / (HMAP_SLICES - 1)) - SCENE_H / 2;
    plane.userData.sliceIdx = s;
    heatmapGroup.add(plane);
  }
  scene.add(heatmapGroup);
}

function destroyHeatmap() {
  if (heatmapGroup) { scene.remove(heatmapGroup); heatmapGroup = null; }
}

function updateHeatmapWindow() {
  if (!heatmapGroup) return;
  const tS = T0 + (S.tEnd - S.winFrac) * TSPAN;
  const tE = T0 + S.tEnd * TSPAN;
  heatmapGroup.children.forEach(c => {
    if (c.userData.sliceIdx === undefined) return;
    const mid = T0 + (c.userData.sliceIdx + 0.5) * (TSPAN / HMAP_SLICES);
    c.material.opacity = (mid >= tS && mid <= tE) ? 0.72 : 0.12;
  });
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
    if (heatmapGroup) heatmapGroup.visible = false;
    document.getElementById('axis-hint-label').textContent =
        `X ${DS.meta.axes.x}  ·  Y ${DS.meta.axes.z}  ·  Z ${DS.meta.axes.y}`;
    document.getElementById('heatmap-note').style.display = 'none';
  } else {
    if (pointCloud)   pointCloud.visible = false;
    clearTrail();
    if (!heatmapGroup) buildDensityHeatmap();
    else heatmapGroup.visible = true;
    document.getElementById('axis-hint-label').textContent =
        `X ${DS.meta.axes.x}  ·  Y Time  ·  Z ${DS.meta.axes.y}`;
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

  tNorm = new Float32Array(N);
  qArr  = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    tNorm[i] = TSPAN > 0 ? (DS.events[i].t - T0) / TSPAN : 0;
    qArr[i]  = DS.events[i].q;
  }

  // Reset state
  Object.assign(S, { tEnd:1, winFrac:1, qualMin:0.05, colorBy:'time',
    playing:false, autoRot:false, mode:'orbit', selIdx:[], viewMode:'pointcloud' });

  // Update UI
  document.getElementById('tslider').value = 100;
  if (document.getElementById('ds-count'))
    document.getElementById('ds-count').textContent = N.toLocaleString();
  if (document.getElementById('ds-range'))
    document.getElementById('ds-range').textContent = m.date_range || '—';
  if (document.getElementById('ds-domain'))
    document.getElementById('ds-domain').textContent = m.domain || '—';
  if (document.getElementById('axis-hint-label'))
    document.getElementById('axis-hint-label').textContent =
        m.axes ? `X ${m.axes.x}  ·  Y ${m.axes.z}  ·  Z ${m.axes.y}` : '';

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

  onResize();
  loadDataset('icequakes');
  renderLoop();
}

init();