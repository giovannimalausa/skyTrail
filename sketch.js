// ============ Flight Visualization — Rosette Only ============
// Controls:
//   S -> save PNG of the current rosette
// =============================================================

let table;
let rows = [];

let bounds = { latMin:  1e9, latMax: -1e9, lonMin:  1e9, lonMax: -1e9 };
let range  = { altMin:  1e9, altMax: -1e9, spdMin: 1e9, spdMax: -1e9 };
let proj   = { margin: 60 };          // pixels
let trail;                             // offscreen buffer for persistent drawing

// UI / Artwork params
const UI = {
  margin: 40,
  ringStep: 5000,   // altitude step for concentric rings (feet)
  ringAlpha: 10,    // opacity for rings
  labelAlpha: 70
};

function preload() {
  table = loadTable("NH110_3bb51c3e.csv", "csv", "header");
}

function setup() {
  let c = createCanvas(windowWidth, windowHeight);
  c.parent("canvas-container");
  colorMode(HSB, 360, 100, 100, 100);
  pixelDensity(1);

  // Parse rows
  for (let r = 0; r < table.getRowCount(); r++) {
    const pos = table.getString(r, "Position");
    if (!pos) continue;
    const [latStr, lonStr] = pos.split(",");
    const lat = Number(latStr);
    const lon = Number(lonStr);
    const alt = Number(table.getString(r, "Altitude"));
    const spd = Number(table.getString(r, "Speed"));
    const hdg = Number(table.getString(r, "Direction"));
    const utc = table.getString(r, "UTC");

    rows.push({ lat, lon, alt, spd, hdg, utc });

    // bounds & ranges
    bounds.latMin = min(bounds.latMin, lat);
    bounds.latMax = max(bounds.latMax, lat);
    bounds.lonMin = min(bounds.lonMin, lon);
    bounds.lonMax = max(bounds.lonMax, lon);

    range.altMin = min(range.altMin, alt);
    range.altMax = max(range.altMax, alt);
    range.spdMin = min(range.spdMin, spd);
    range.spdMax = max(range.spdMax, spd);
  }

  // Fallbacks if constants
  if (range.altMin === range.altMax) range.altMax = range.altMin + 1;
  if (range.spdMin === range.spdMax) range.spdMax = range.spdMin + 1;

  trail = createGraphics(width, height);
  trail.colorMode(HSB, 360, 100, 100, 100);
  trail.clear();

  background(0, 0, 10);
  noFill();
  strokeJoin(ROUND);
  strokeCap(ROUND);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  // Recreate trail to fit new size; you can keep the old buffer if you prefer
  trail = createGraphics(width, height);
  trail.colorMode(HSB, 360, 100, 100, 100);
  trail.clear();
  background(0, 0, 10);
}

function draw() {
  drawRosette();
}

function drawVignette() {
  push();
  noStroke();
  for (let r = 0; r < 120; r++) {
    fill(0, 0, 0, 1.2);
    rect(UI.margin + r, UI.margin + r, width - UI.margin*2 - 2*r, height - UI.margin*2 - 2*r, 18);
  }
  pop();
}

function drawAltitudeRings(center, baseR, varR) {
  const altMin = range.altMin, altMax = range.altMax;
  const step = UI.ringStep;
  const maxAlt = niceCeilToStep(altMax, step);
  const minAlt = max(0, niceFloorToStep(altMin, step));

  push();
  textSize(11);
  for (let alt = minAlt; alt <= maxAlt; alt += step) {
    const rr = baseR + map(alt, altMin, altMax, 0, varR, true);
    noFill();
    stroke(0, 0, 100, UI.ringAlpha);
    strokeWeight(1);
    ellipse(center.x, center.y, rr * 2, rr * 2);
    // tick label at 12 o'clock above each ring
    noStroke();
    fill(0, 0, 100, UI.labelAlpha);
    textAlign(CENTER, BOTTOM);
    const fl = Math.round(alt / 100);
    const flStr = `FL${nf(fl, 3)}`; // pad to 3 digits
    text(flStr, center.x, center.y - rr - 6);
    stroke(0, 0, 100, UI.ringAlpha);
  }
  pop();
}

function buildRosettePoints() {
  const n = rows.length;
  const altMin = range.altMin, altMax = range.altMax;
  const center = { x: width * 0.5, y: height * 0.5 };
  const maxRadius = (min(width, height) / 2) - UI.margin * 2;
  const varR = maxRadius * 0.44; // fraction for altitude variation
  const baseR = maxRadius - varR;

  let pts = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const ang = -HALF_PI + t * TWO_PI; // start at 12 o'clock, progress clockwise
    const row = rows[i];
    const rr = baseR + map(row.alt, altMin, altMax, 0, varR, true);
    const wobble = map(row.spd, range.spdMin, range.spdMax, 0, 6);
    const x = center.x + cos(ang) * (rr + cos(radians(row.hdg)) * wobble);
    const y = center.y + sin(ang) * (rr + sin(radians(row.hdg)) * wobble);
    pts.push({ x, y, alt: row.alt, spd: row.spd });
  }
  pts.push(pts[0], pts[1]); // close loop for continuity
  return { pts, center, baseR, varR };
}

function drawRosette() {
  const { pts, center, baseR, varR } = buildRosettePoints();

  background(0, 0, 8);
  drawVignette();

  // Rings underlay
  drawAltitudeRings(center, baseR, varR);

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

  // Minimal caption
  push();
  fill(0, 0, 100, 85);
  noStroke();
  textSize(14);
  textAlign(LEFT, TOP);
  text("Altitude Rosette — Press S to Save · Rings for FL", 20, 20);
  pop();
}

function keyPressed() {
  if (key === 's' || key === 'S') {
    saveCanvas('altitude_rosette', 'png');
  }
}

function niceCeilToStep(v, step) { return Math.ceil(v / step) * step; }
function niceFloorToStep(v, step) { return Math.floor(v / step) * step; }