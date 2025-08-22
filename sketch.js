// ============ Flight Visualization — Rosette Only ============
// Controls:
//   S -> save PNG of the current rosette
// =============================================================

let table;
let rows = [];

let bounds = { latMin:  1e9, latMax: -1e9, lonMin:  1e9, lonMax: -1e9 };
let range  = { altMin:  1e9, altMax: -1e9, spdMin: 1e9, spdMax: -1e9 };
let proj   = { margin: 60 }; // pixels
let trail; // Off-screen graphics buffer to draw persistent trail (rosette lines)
let trackDir = null; // Overall track direction: 'E' (eastbound) or 'W' (westbound)

// DOM info card panel and references to its fields
let infoCard; // DOM panel with live data
let __infoRefs; // populated in setup when HTML elements exist

let selectedIdx = 0; // Currently selected point index (based on mouse position)

// Flight start and end times (milliseconds since epoch)
let startMs = null, endMs = null;

// Detected takeoff/landing times (altitude transition-based)
let actualTakeOffMs = null, actualLandingMs = null; // computed from altitude transitions
let actualTakeOffTime = null, actualLandingTime = null; // formatted UTC strings

// Constant to convert speed from knots to feet per second
const KNOT_TO_FPS = 1.68781; // knots -> feet/second

// Global state shared with the minimap (used in `minimapP5`)
window.skyTrailState = {
  get track() {
    // Return simplified track with only lat/lon
    return (rows || []).map(r => ({ lat: r.lat, lon: r.lon }));
  },
  get cursorIndex() {
    return selectedIdx | 0;
  }
};

// DOM element for SVG plane icon (the cursor that follows the path)
let planeEl = null;

// Fine-tuning for visual centering of the SVG cursor on the rosette path
const CURSOR_INWARD_PX = 2;   // radial nudge toward center (px).
const CURSOR_ROT_DEG = 0;   // extra rotation

// DOM element for heading indicator SVG (in center of rosette)
let headingPlaneEl = null;
const HEADING_PLANE_SIZE_PX = 28; // size of the heading SVG in pixels

// UI configuration for ring step, transparency, etc.
const UI = {
  margin: 24, // margin from canvas edges
  ringStep: 1000, // Step between altitude rings (in feet)
  ringAlpha: 25, // Opacity for visible rings
  nonRelevantRingAlpha: 5, // Opacity for non-relevant rings
  labelAlpha: 70 // Opacity for labels
};



function preload() {
  // No default CSV load; user uploads from the welcome screen.
  table = null;
}

function setup() {
  let c = createCanvas(windowWidth, windowHeight); // full window canvas
  c.parent("canvas-container");
  colorMode(HSB, 360, 100, 100, 100);
  pixelDensity(1);

  // Side info card. Cache references to DOM elements (fields) inside the side panel
  infoCard = document.getElementById('info-card');
  const get = (id) => document.getElementById(id);
  window.__infoRefs = {
    date:    get('info-date'),
    since:   get('info-since'),
    until:   get('info-until'),
    speed:   get('info-speed'),
    heading: get('info-heading'),
    loc:     get('info-location'),
    alt:     get('info-altitude'),
    tilt:    get('info-tilt'),
    callsign: get('info-callsign'),
    takeoffActual: get('info-actual-takeoff-time'),
    landingActual: get('info-actual-landing-time')
  };
  if (!infoCard) {
    console.warn('info-card element not found in HTML. Add it to index.html.');
  }

  // Wire up welcome/upload UI and swap screens after upload
  const dash = document.getElementById('dashboard');
  const welcome = document.getElementById('welcome');
  const dz = document.getElementById('drop-zone');
  const fileEl = document.getElementById('csv-input');

  if (dz && fileEl) {
    const onFiles = (files) => {
      const f = files && files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        parseFromCSVText(String(e.target.result));

        // Swap screens
        if (welcome) welcome.classList.add('hidden');
        if (dash) dash.classList.remove('hidden');

        // Initialize or update minimap
        if (!minimapP5) {
          createMinimap();
        } else {
          minimapP5.rebuild();
        }

      };
      reader.readAsText(f);
    };

    fileEl.addEventListener('change', (ev) => onFiles(ev.target.files));

    dz.addEventListener('dragover', (ev) => { ev.preventDefault(); dz.classList.add('hover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('hover'));
    dz.addEventListener('drop', (ev) => {
      ev.preventDefault(); dz.classList.remove('hover');
      if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) {
        onFiles(ev.dataTransfer.files);
      }
    });
  }

  // Hook existing overlay element for the cursor icon (CSS handles positioning)
  planeEl = document.getElementById('cursor-plane');
  if (!planeEl) {
    console.warn('cursor-plane element not found in HTML.');
  }

  // Hook a separate overlay element for the heading indicator
  headingPlaneEl = document.getElementById('heading-plane');
  headingPlaneEl.style.transform = 'translate(-10000px,-10000px)';


  background(0, 0, 10);
  noFill();
  strokeJoin(ROUND);
  strokeCap(ROUND);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  // Recreate trail to fit new viewport size
  trail = createGraphics(width, height);
  trail.colorMode(HSB, 360, 100, 100, 100);
  trail.clear();
  background(0, 0, 10);
  // (No overlay element DOM re-append needed; CSS handles stacking)

}


function draw() {
  if (!rows.length) {
    background(0, 0, 8);
    return;
  }
  drawRosette();
}

function drawAltitudeRings(center, baseR, varR) {
  const altMin = range.altMin, altMax = range.altMax;
  const step = UI.ringStep;
  const maxAlt = niceCeilToStep(altMax, step);
  const minAlt = max(0, niceFloorToStep(altMin, step));

  push();
  textSize(8);
  for (let alt = minAlt; alt <= maxAlt; alt += step) {
    const rr = baseR + map(alt, altMin, altMax, 0, varR, true);
    const fl = Math.round(alt / 100); // FL label (hundreds of feet)
    const kft = Math.round(alt / 1000); // thousands of feet for parity
    const relevant = trackDir
      ? (trackDir === 'E' ? (kft % 2 === 1)       // odd thousands → eastbound
                          : (kft % 2 === 0))      // even thousands → westbound
      : true;                                     // if unknown, show all as relevant

    // ring stroke
    noFill();
    stroke(0, 0, 100, relevant ? UI.ringAlpha : UI.nonRelevantRingAlpha);
    strokeWeight(2);
    ellipse(center.x, center.y, rr * 2, rr * 2);

    // label only relevant FLs
    if (relevant) {
      noStroke();
      fill(0, 0, 100, UI.labelAlpha);
      textAlign(CENTER, BOTTOM);
      const flStr = `FL${nf(fl, 3)}`; // pad to 3 digits
      text(flStr, center.x, center.y - rr - 2);
      stroke(0, 0, 100, UI.ringAlpha);
    }
  }
  pop();
}

function buildRosettePoints() {
  const n = rows.length;
  const altMin = range.altMin, altMax = range.altMax;
  const center = { x: width * 0.5, y: height * 0.5 };
  const maxRadius = (min(width, height) / 2) - UI.margin * 2;
  const varR = maxRadius * 0.6; // fraction for altitude variation
  const baseR = maxRadius - varR;

  let pts = [];
  for (let i = 0; i < n; i++) {
    const row = rows[i];
    const t = timeFracForRow(row, i, n);
    const ang = HALF_PI + t * TWO_PI; // start at 6 o'clock, progress clockwise
    const rr = baseR + map(row.alt, altMin, altMax, 0, varR, true);
    const wobble = map(row.spd, range.spdMin, range.spdMax, 0, 6);
    const x = center.x + cos(ang) * (rr + cos(radians(row.hdg)) * wobble);
    const y = center.y + sin(ang) * (rr + sin(radians(row.hdg)) * wobble);
    const idx = i;
    pts.push({ x, y, alt: row.alt, spd: row.spd, hdg: row.hdg, lat: row.lat, lon: row.lon, utc: row.utc, tMs: row.tMs, idx });
  }
  pts.push(pts[0], pts[1]); // close loop for continuity
  return { pts, center, baseR, varR };
}

function drawRosette() {
  if (!rows.length) return;
  const { pts, center, baseR, varR } = buildRosettePoints();

  background(0, 0, 8);

  // Draw rosette on the offscreen buffer for crisp strokes
  trail.clear();
  trail.colorMode(HSB, 360, 100, 100, 100);

  for (let i = 0; i < pts.length - 2; i++) {
    const a = pts[i], b = pts[i + 1];
    const hue = 200; // fixed hue blue
    const sat = 85;
    const bri = map(a.spd, range.spdMin, range.spdMax, 40, 100, true); // brightness based on speed
    const sw  = map(a.spd, range.spdMin, range.spdMax, 0.9, 4.2, true);

    trail.stroke(hue, sat, bri, 92);
    trail.strokeWeight(sw);

    const segs = 24;
    let px = a.x, py = a.y;
    for (let s = 1; s < segs; s++) {
      const t = s / (segs - 1);
      const x1 = lerp(a.x, b.x, t);
      const y1 = lerp(a.y, b.y, t);
      trail.line(px, py, x1, y1);
      px = x1; py = y1;
    }
  }

  image(trail, 0, 0);

  // Rings + labels on top of rosette, below cursor
  drawAltitudeRings(center, baseR, varR);

  // --- Interactive probe from mouse position ---
  selectedIdx = getIndexFromMouse(center, pts.length - 2); // exclude the two closing duplicates
  const hdgNow = (rows[selectedIdx] && Number.isFinite(rows[selectedIdx].hdg)) ? rows[selectedIdx].hdg : null;
  drawHeadingViz(center, baseR, hdgNow);
  drawIndicator(pts, selectedIdx);
  updateInfoCard(pts[selectedIdx]);
  minimapP5.refresh(); // Refresh minimap
}

function keyPressed() {
  if (key === 's' || key === 'S') {
    saveCanvas('altitude_rosette', 'png');
  }
}

// ======= Interaction + math helpers =======
function getIndexFromMouse(center, count) {
  // Map mouse angle to the parametric t we used to build the rosette
  const dx = mouseX - center.x;
  const dy = mouseY - center.y;
  let ang = Math.atan2(dy, dx); // -PI..PI, 0 at +x
  // Our construction was: ang = HALF_PI + t * TWO_PI (start at 6 o'clock, CW)
  // Invert it to get t:
  let t = (ang - HALF_PI) % TWO_PI;
  if (t < 0) t += TWO_PI;
  t /= TWO_PI; // 0..1

  // If we have real timestamps, choose the row whose time is closest to the mouse time.
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
    const targetMs = startMs + t * (endMs - startMs);
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const tm = rows[i] && rows[i].tMs;
      if (!Number.isFinite(tm)) continue;
      const d = Math.abs(tm - targetMs);
      if (d < bestDiff) { bestDiff = d; bestIdx = i; }
    }
    if (bestDiff !== Infinity) return constrain(bestIdx, 0, count - 1);
  }

  // Fallback: old index-based mapping
  const idx = Math.round(t * (count - 1));
  return constrain(idx, 0, count - 1);
  }

function drawIndicator(pts, i) {
  const a = pts[i];
  const b = pts[(i + 1) % (pts.length - 2)]; // next real point
  const m = pts[(i - 1 + (pts.length - 2)) % (pts.length - 2)]; // prev real point

  // Tangent direction using central difference
  const tx = b.x - m.x;
  const ty = b.y - m.y;
  const ang = Math.atan2(ty, tx);

  // Convert to degrees and allow an optional micro-tweak
  const degAdj = ang * 180 / Math.PI + CURSOR_ROT_DEG;
  // Radial inward offset (toward canvas center) to counter visual drift to the outside
  const cx = width * 0.5, cy = height * 0.5;
  const rx = a.x - cx, ry = a.y - cy;
  const rlen = Math.hypot(rx, ry) || 1;
  const ox = -(rx / rlen) * CURSOR_INWARD_PX; // negative = inward toward center
  const oy = -(ry / rlen) * CURSOR_INWARD_PX;
  // Use translate(-50%,-50%) so the element is truly centered on the point,
  // then rotate around its own visual center
  if (planeEl) {
    planeEl.style.transform =
      `translate(${a.x + ox}px, ${a.y + oy}px) translate(-50%, -50%) rotate(${degAdj}deg)`;
  }

  // Faint crosshair
  push();
  stroke(0, 0, 100, 35);
  strokeWeight(1);
  line(a.x - 8, a.y, a.x + 8, a.y);
  line(a.x, a.y - 8, a.x, a.y + 8);
  pop();
}

function drawHeadingViz(center, baseR, headingDeg) {
  // Compass-style heading viz inside the inner circle
  const L = baseR * 0.55;     // arrow half-length baseline
  const ringR = baseR * 0.40; // inner ring radius

  push();
  translate(center.x, center.y);

  // faint inner circle
  noFill();
  stroke(0, 0, 100, 12);
  strokeWeight(1);
  ellipse(0, 0, ringR * 2, ringR * 2);

  // tick marks every 30°, with stronger cardinals
  for (let a = 0; a < 360; a += 30) {
    const isCardinal = (a % 90) === 0;
    const outer = ringR;
    const inner = ringR - (isCardinal ? 14 : 8);
    const ang = radians(a - 90); // 0° at North, clockwise
    const x0 = cos(ang) * inner;
    const y0 = sin(ang) * inner;
    const x1 = cos(ang) * outer;
    const y1 = sin(ang) * outer;
    stroke(0, 0, 100, isCardinal ? 70 : 40); 
    strokeWeight(isCardinal ? 2 : 1);
    line(x0, y0, x1, y1);

    // Cardinal labels
    if (isCardinal) {
      noStroke();
      fill(0, 0, 100, 85);
      textAlign(CENTER, CENTER);
      textSize(10);
      const lbl = (a === 0) ? 'N' : (a === 90) ? 'E' : (a === 180) ? 'S' : 'W';
      const lx = cos(ang) * (ringR + 12);
      const ly = sin(ang) * (ringR + 12);
      text(lbl, lx, ly);
    }
  }

  // Heading plane icon (if available)
  if (Number.isFinite(headingDeg)) {
    // SVG plane points to +x (east). Convert so that 0° = North (up), clockwise positive.
    const deg = headingDeg - 90;
    headingPlaneEl.style.transform =
      `translate(${center.x}px, ${center.y}px) translate(-50%, -50%) rotate(${deg}deg)`;
  } else {
    headingPlaneEl.style.transform = 'translate(-10000px,-10000px)';
  }

  pop();
}

function updateInfoCard(p) {
  if (!infoCard || !p) return;

  // Time strings
  const tStr = (Number.isFinite(p.tMs)) ? formatUTC(p.tMs) : '—';
  
  // Use effective takeoff/landing if available; otherwise fall back to dataset bounds
  const takeMs = Number.isFinite(actualTakeOffMs) ? actualTakeOffMs : startMs;
  const landMs = Number.isFinite(actualLandingMs) ? actualLandingMs : endMs;

  const since = (Number.isFinite(p.tMs) && Number.isFinite(takeMs) && p.tMs >= takeMs)
    ? formatHMS(p.tMs - takeMs)
    : '00:00:00';

  const until = (Number.isFinite(p.tMs) && Number.isFinite(landMs) && landMs >= p.tMs)
    ? formatHMS(landMs - p.tMs)
    : '00:00:00';

  // Flight Path Angle (approx) from vertical speed and ground speed
  const fpa = estimateFlightPathAngleDeg(p.idx);
  const fpaStr = (fpa === null) 
    ? '—' 
    : fpa === 0 
      ? '0° Leveled' 
      : `${nf(fpa, 1, 1)}° ${fpa > 0 ? '↑ Climb' : '↓ Descent'}`;
  const hdgStr = Number.isFinite(p.hdg) ? `${Math.round(p.hdg)}°` : '—';
  const spdStr = Number.isFinite(p.spd) ? `${Math.round(p.spd)} kt` : '—';
  const altStr = Number.isFinite(p.alt) ? `${Math.round(p.alt)} ft` : '—';
  const locStr = formatLatLon(p.lat, p.lon);

  const refs = window.__infoRefs || {};
  const set = (el, v) => { if (el) el.innerHTML = v; };

  if (refs.date || refs.since || refs.until || refs.speed || refs.heading || refs.loc || refs.alt || refs.tilt) {
    set(refs.date,  tStr);
    set(refs.since, since);
    set(refs.until, until);
    set(refs.speed, spdStr);
    set(refs.heading, hdgStr);
    set(refs.loc, locStr);
    set(refs.alt, altStr);
    set(refs.tilt, fpaStr);
  }
}

function estimateFlightPathAngleDeg(i) {
  // Use neighbors to estimate vertical speed (ft/s). If timestamps missing, return null.
  const prev = rows[Math.max(0, i - 1)];
  const next = rows[Math.min(rows.length - 1, i + 1)];
  if (!prev || !next) return null;
  if (!Number.isFinite(prev.tMs) || !Number.isFinite(next.tMs)) return null;
  const dt = (next.tMs - prev.tMs) / 1000; // seconds
  if (dt <= 0) return null;
  const dAlt = next.alt - prev.alt; // feet
  const vsp = dAlt / dt; // ft/s (+ climb)

  // Ground speed: use instantaneous speed at i, assume "Speed" is in knots
  const gsFps = Number.isFinite(rows[i].spd) ? rows[i].spd * KNOT_TO_FPS : null;
  if (!Number.isFinite(gsFps) || gsFps <= 0) return null;

  const angRad = Math.atan(vsp / gsFps);
  return degrees(angRad);
}

function parseUTCtoMs(s) {
  if (!s) return NaN;
  // Try safe parses; many CSVs have plain HH:MM:SS or ISO-like strings
  // Prefer UTC by appending 'Z' if it looks like a time without TZ
  let d = Date.parse(s);
  if (Number.isNaN(d)) d = Date.parse(s + 'Z');
  return d;
}

function formatHMS(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const hh = h.toString().padStart(2, '0');
  const mm = m.toString().padStart(2, '0');
  const ss = s.toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatUTC(ms) {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const HH = String(d.getUTCHours()).padStart(2, '0');
  const MM = String(d.getUTCMinutes()).padStart(2, '0');
  const SS = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}<br>${HH}:${MM}:${SS} UTC`;
}

function formatLatLon(lat, lon) {
  const fmt = (val, posH, negH) => {
    if (!Number.isFinite(val)) return '—';
    const hemi = val >= 0 ? posH : negH;
    return `${Math.abs(val).toFixed(5)}° ${hemi}`;
  };
  return `${fmt(lat, 'N', 'S')}, ${fmt(lon, 'E', 'W')}`;
}

function toRad(d) { return d * Math.PI / 180; }
function toDeg(r) { return r * 180 / Math.PI; }
// Initial great-circle bearing from point 1 to point 2 (degrees 0..360)
function initialBearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  let θ = Math.atan2(y, x); // -π..+π
  θ = (toDeg(θ) + 360) % 360; // 0..360
  return θ;
}

function niceCeilToStep(v, step) {
  return Math.ceil(v / step) * step;
}
function niceFloorToStep(v, step) {
  return Math.floor(v / step) * step;
}

function fracFromTimeMs(ms) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || !Number.isFinite(ms)) return null;
  return constrain((ms - startMs) / (endMs - startMs), 0, 1);
}

function timeFracForRow(row, i, n) {
  const ft = fracFromTimeMs(row && row.tMs);
  if (ft !== null) return ft;
  // Fallback to index spacing if this row has no timestamp
  return (n > 1) ? (i / (n - 1)) : 0;
}

// --- CSV parsing and data helpers for upload flow ---
function resetDataHolders() {
  rows = [];
  bounds = { latMin:  1e9, latMax: -1e9, lonMin:  1e9, lonMax: -1e9 };
  range  = { altMin:  1e9, altMax: -1e9, spdMin: 1e9, spdMax: -1e9 };
  startMs = null; endMs = null; trackDir = null;
  actualTakeOffMs = null; actualLandingMs = null;
  actualTakeOffTime = null; actualLandingTime = null;
}

function finalizeAfterRowsParsed() {
  const validTimes = rows.filter(r => Number.isFinite(r.tMs));
  if (validTimes.length) {
    startMs = validTimes[0].tMs;
    endMs   = validTimes[validTimes.length - 1].tMs;
  }

  // Compute effective takeoff and landing times from altitude transitions
  actualTakeOffMs = null; actualLandingMs = null;
  actualTakeOffTime = null; actualLandingTime = null;

  // Takeoff: first row with Altitude > 0 and a valid timestamp
  let takeIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (Number.isFinite(r.tMs) && Number.isFinite(r.alt) && r.alt > 0) { takeIdx = i; break; }
  }
  if (takeIdx >= 0) {
    actualTakeOffMs = rows[takeIdx].tMs;
    actualTakeOffTime = formatUTC(actualTakeOffMs);

    // Landing: first row where altitude becomes exactly 0 after being non-zero
    for (let i = takeIdx + 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur  = rows[i];
      if (
        Number.isFinite(prev?.alt) && Number.isFinite(cur?.alt) &&
        prev.alt !== 0 && cur.alt === 0 && Number.isFinite(cur.tMs)
      ) {
        actualLandingMs = cur.tMs;
        actualLandingTime = formatUTC(actualLandingMs);
        break;
      }
    }
  }

  if (rows.length >= 2) {
    const start = rows[0];
    const end   = rows[rows.length - 1];
    const brg = initialBearingDeg(start.lat, start.lon, end.lat, end.lon);
    trackDir = (brg >= 0 && brg < 180) ? 'E' : 'W';
  }
  if (range.altMin === range.altMax) range.altMax = range.altMin + 1;
  if (range.spdMin === range.spdMax) range.spdMax = range.spdMin + 1;

  // Reset trail buffer to fit current canvas and clear previous drawing
  trail = createGraphics(width, height);
  trail.colorMode(HSB, 360, 100, 100, 100);
  trail.clear();
  {
    // Set actual takeoff/landing UTC time fields in the info card (static, does not update)
    const refs = window.__infoRefs || {};
    if (refs.takeoffActual) refs.takeoffActual.innerHTML = actualTakeOffTime || '—';
    if (refs.landingActual) refs.landingActual.innerHTML = actualLandingTime || '—';
  }
}

// --- Robust CSV line splitter and unquote helper ---
function splitCSVLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // Toggle quotes OR handle escaped quotes "" -> "
      if (inQuotes && line[i+1] === '"') {
        cur += '"';
        i++; // skip next quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function unquote(s) {
  if (typeof s !== 'string') return s;
  s = s.trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length-1] === '"') {
    s = s.slice(1, -1).replace(/""/g, '"');
  }
  return s;
}

function parseFromCSVText(text) {
  resetDataHolders();
  if (!text) return;
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return;

  const headers = splitCSVLine(lines[0]).map(h => h.trim());
  const findIdx = (name) => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());
  const iPos = findIdx('Position');
  const iAlt = findIdx('Altitude');
  const iSpd = findIdx('Speed');
  const iHdg = findIdx('Direction');
  const iUtc = findIdx('UTC');
  const iTs  = findIdx('Timestamp');
  const iCallsign = findIdx('Callsign');

  let callsignVal = '';

  for (let li = 1; li < lines.length; li++) {
    const cols = splitCSVLine(lines[li]);
    if (!cols.length) continue;

    // Capture callsign if available and not already captured
    if (iCallsign >= 0 && !callsignVal) {
      callsignVal = unquote(cols[iCallsign] || '');
    }

    const posRaw = (iPos >= 0) ? cols[iPos] : '';
    const pos = unquote(posRaw);
    if (!pos) continue;
    const [latStr, lonStr] = pos.split(',');
    const lat = Number(latStr);
    const lon = Number(lonStr);

    const alt = (iAlt >= 0) ? Number(cols[iAlt]) : NaN;
    const spd = (iSpd >= 0) ? Number(cols[iSpd]) : NaN;
    const hdg = (iHdg >= 0) ? Number(cols[iHdg]) : NaN;

    let utc = (iUtc >= 0) ? cols[iUtc] : '';
    utc = utc ? unquote(utc) : '';
    let tMs = NaN;
    if (utc) {
      tMs = parseUTCtoMs(utc);
    } else if (iTs >= 0) {
      const ts = Number(cols[iTs]);
      if (Number.isFinite(ts)) tMs = ts * 1000; // seconds -> ms
    }

    rows.push({ lat, lon, alt, spd, hdg, utc, tMs });

    if (Number.isFinite(lat)) { bounds.latMin = min(bounds.latMin, lat); bounds.latMax = max(bounds.latMax, lat); }
    if (Number.isFinite(lon)) { bounds.lonMin = min(bounds.lonMin, lon); bounds.lonMax = max(bounds.lonMax, lon); }
    if (Number.isFinite(alt)) { range.altMin = min(range.altMin, alt); range.altMax = max(range.altMax, alt); }
    if (Number.isFinite(spd)) { range.spdMin = min(range.spdMin, spd); range.spdMax = max(range.spdMax, spd); }
  }

  finalizeAfterRowsParsed();
  // Update the DOM element for callsign
  const csEl = document.getElementById('info-callsign');
  if (csEl) csEl.textContent = callsignVal || '—';
}

// MINIMAP
let minimapP5 = null;

function createMinimap() {
  const sketch = (p) => {
    let pad = 8;
    let projected = []; // [{x,y}]
    let bounds = null; // {minLat, maxLat, minLon, maxLon}
    let s = 1, offX = 0, offY = 0;

    p.setup = () => {
      const host = document.getElementById('flight-path-canvas');
      const w = host?.clientWidth || 300;
      const h = host?.clientHeight || 300;
      p.createCanvas(w, h);
      p.pixelDensity(1);
      p.noLoop(); // redraw manually on demand
      p.clear();
      p.canvas.style.pointerEvents = 'none'; // belt & suspenders with your CSS
      rebuild();
      observeResize(host);
    };

    function observeResize(host) {
      if (!host) return;
      const ro = new ResizeObserver(() => {
        p.resizeCanvas(host.clientWidth, host.clientHeight);
        rebuild();
        p.redraw();
      });
      ro.observe(host);
    }

    function computeFit() {
      const track = window.skyTrailState.track;
      if (!track.length) { bounds = null; return; }
      let minLat = +Infinity, maxLat = -Infinity, minLon = +Infinity, maxLon = -Infinity;
      for (const pt of track) {
        if (Number.isFinite(pt.lat)) { if (pt.lat < minLat) minLat = pt.lat; if (pt.lat > maxLat) maxLat = pt.lat; }
        if (Number.isFinite(pt.lon)) { if (pt.lon < minLon) minLon = pt.lon; if (pt.lon > maxLon) maxLon = pt.lon; }
      }
      bounds = { minLat, maxLat, minLon, maxLon };

      const innerW = Math.max(1, p.width  - pad*2);
      const innerH = Math.max(1, p.height - pad*2);
      const lonSpan = Math.max(1e-9, maxLon - minLon);
      const latSpan = Math.max(1e-9, maxLat - minLat);
      const sx = innerW / lonSpan;
      const sy = innerH / latSpan;
      s = Math.min(sx, sy);

      const wTrack = lonSpan * s;
      const hTrack = latSpan * s;
      offX = pad + (innerW - wTrack) / 2;
      offY = pad + (innerH - hTrack) / 2;
    }

    function project(pt) {
      // lon → x (L→R), lat → y (N up). p5 y grows down, so invert:
      const x = (pt.lon - bounds.minLon) * s + offX;
      const y = p.height - ((pt.lat - bounds.minLat) * s + offY);
      return { x, y };
    }

    function rebuild() {
      projected.length = 0;
      computeFit();
      if (!bounds) return;
      const track = window.skyTrailState.track;
      for (const pt of track) projected.push(project(pt));
    }

    p.draw = () => {
      p.clear();
      drawFrame();
      drawPath();
      drawEndpoints();
      drawCursor();
    };

    function drawFrame() {
      p.noFill();
      p.stroke(255, 40);
      p.strokeWeight(1);
      p.rect(0.5, 0.5, p.width-1, p.height-1, 6);
    }

    function drawPath() {
      if (projected.length < 2) return;
      p.noFill();
      p.stroke(255, 128);
      p.strokeWeight(1);
      p.beginShape();
      for (const pt of projected) p.vertex(pt.x, pt.y);
      p.endShape();
    }

    function drawEndpoints() {
      if (!projected.length) return;
      p.noStroke();
      // start = green
      p.fill(0, 255, 0, 220);
      p.circle(projected[0].x, projected[0].y, 5);
      // end = red
      const last = projected[projected.length - 1];
      p.fill(255, 0, 0, 220);
      p.circle(last.x, last.y, 5);
    }

    function drawCursor() {
      const i = window.skyTrailState.cursorIndex;
      if (!Number.isFinite(i) || !projected[i]) return;
      const pt = projected[i];
      // halo
      p.noStroke();
      p.fill(255, 255, 0, 70);
      p.circle(pt.x, pt.y, 14);
      // dot
      p.fill(255, 255, 0, 230);
      p.circle(pt.x, pt.y, 5);
    }

    // Public hooks for when data or selection changes:
    p.rebuild = () => { rebuild(); p.redraw(); };
    p.refresh = () => { p.redraw(); };
  };

  minimapP5 = new p5(sketch, 'flight-path-canvas');
}