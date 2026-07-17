// benchmark.js — performance measurement harness for Chapter 6
// ------------------------------------------------------------------
// Add this AFTER app.js in index.html (or paste into the browser
// console once the app has loaded):
//
//     <script src="app.js"></script>
//     <script src="benchmark.js"></script>
//
// Then run in the console:   await runBenchmark()
//
// It measures, at each sample size, the three quantities reported in
// Table 6.2: steady-state FPS, point-cloud rebuild latency, and
// heatmap construction time. Results are printed as a console table
// and returned as an array you can copy into the thesis.
//
// IMPORTANT: run on the machine you intend to cite, and record its
// CPU, GPU, OS, and browser + version in the thesis alongside the
// numbers. Close other tabs/apps first for stable readings.
// ------------------------------------------------------------------

const BENCH_SAMPLES = [1000, 5000, 10000, 37356];   // event counts to test
const BENCH_FRAMES  = 180;                            // ~3 s at 60 fps
const BENCH_REPEATS = 20;                             // rebuild timing repeats

// Sub-sample the ACTIVE dataset down to n events (evenly across time).
// Returns a function that restores the original dataset.
function _benchSubsample(n) {
  const full = DS.events;
  if (n >= full.length) return () => {};
  const step = full.length / n;
  const sub = [];
  for (let i = 0; i < n; i++) sub.push(full[Math.floor(i * step)]);
  const originalEvents = DS.events;
  const originalN = N;
  DS.events = sub;
  N = sub.length;
  // rebuild the normalized helper arrays for the reduced set
  tNorm = new Float32Array(N);
  qArr  = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    tNorm[i] = TSPAN > 0 ? (DS.events[i].t - T0) / TSPAN : 0;
    qArr[i]  = DS.events[i].q;
  }
  return () => {   // restore
    DS.events = originalEvents;
    N = originalN;
    tNorm = new Float32Array(N);
    qArr  = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      tNorm[i] = TSPAN > 0 ? (DS.events[i].t - T0) / TSPAN : 0;
      qArr[i]  = DS.events[i].q;
    }
  };
}

// Measure steady-state FPS over BENCH_FRAMES animation frames.
function _benchFPS() {
  return new Promise(resolve => {
    let frames = 0;
    const t0 = performance.now();
    function tick() {
      frames++;
      if (frames >= BENCH_FRAMES) {
        const dt = performance.now() - t0;
        resolve(Math.round((frames / dt) * 1000));
      } else {
        requestAnimationFrame(tick);
      }
    }
    requestAnimationFrame(tick);
  });
}

// Median of an array of numbers.
function _median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Time a single point-cloud rebuild, median over BENCH_REPEATS.
function _benchRebuild() {
  const samples = [];
  for (let i = 0; i < BENCH_REPEATS; i++) {
    const t0 = performance.now();
    rebuildPointCloud();
    samples.push(performance.now() - t0);
  }
  return +_median(samples).toFixed(2);
}

// Time a single full heatmap construction, median over a few repeats.
function _benchHeatmap() {
  const samples = [];
  const repeats = Math.max(5, Math.floor(BENCH_REPEATS / 4));
  for (let i = 0; i < repeats; i++) {
    destroyHeatmap();
    const t0 = performance.now();
    buildDensityHeatmap();
    samples.push(performance.now() - t0);
  }
  destroyHeatmap();
  return +_median(samples).toFixed(1);
}

// Run the full benchmark across all sample sizes on the ACTIVE dataset.
async function runBenchmark() {
  console.log(`Benchmarking dataset "${DS.meta.name}" (${DS.meta.domain})`);
  console.log(`UA: ${navigator.userAgent}`);
  const results = [];

  // ensure we are in point-cloud mode and unfiltered
  setViewMode('pointcloud');
  S.qualMin = 0; S.tEnd = 1; S.winFrac = 1;

  for (const n of BENCH_SAMPLES) {
    const restore = _benchSubsample(n);
    rebuildPointCloud();

    const fps      = await _benchFPS();
    const rebuild  = _benchRebuild();
    const heatmap  = _benchHeatmap();

    results.push({ events: n, fps, rebuild_ms: rebuild, heatmap_ms: heatmap });
    restore();
    rebuildPointCloud();
  }

  console.table(results);
  console.log('LaTeX rows:');
  results.forEach(r =>
    console.log(`    \\num{${r.events}} & ${r.fps} & ${r.rebuild_ms} & ${r.heatmap_ms} \\\\`)
  );
  return results;
}

console.log('benchmark.js loaded — run:  await runBenchmark()');
