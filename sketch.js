// ============ Flight Visualization — Rosette Only ============
// Controls:
//   A -> save PNG of the current rosette
// =============================================================

let rows = [];

// Initialize lat/lon bounds with extreme values (±1e9) so that any real coordinate
// from the CSV (lat ∈ [-90,+90], lon ∈ [-180,+180]) will always replace them.
// This avoids special-case logic for the first data point and ensures min()/max()
// comparisons work correctly from the start.
let bounds = { latMin:  1e9, latMax: -1e9, lonMin:  1e9, lonMax: -1e9 }; // object that stores the geographical limits of the flight data

// Track overall min/max altitude (ft) and speed (knots) across the dataset.
// Used only for visualization scaling in the rosette:
// - altitude → controls radius of rings and plotted path
// - speed    → controls stroke brightness/thickness
// Initialized with ±1e9 so first real value always replaces the default.
let range  = { altMin:  1e9, altMax: -1e9, spdMin: 1e9, spdMax: -1e9 };

let trail; // Off-screen graphics buffer to draw persistent trail (rosette lines)
let trackDir = null; // Overall track direction: 'E' (eastbound) or 'W' (westbound)

// DOM info card panel and references to its fields
let infoCard; // DOM panel with live data
let infoRefs; // populated in setup when HTML elements exist

let selectedIdx = 0; // Currently selected point index (based on mouse position)

// Flight start and end times (milliseconds since epoch)
let startMs = null, endMs = null;

// Detected takeoff/landing times (altitude transition-based)
let actualTakeOffMs = null, actualLandingMs = null; // computed from altitude transitions
let actualTakeOffTime = null, actualLandingTime = null; // formatted UTC strings

// Constant to convert speed from knots to feet per second
const KNOT_TO_FPS = 1.68781; // knots -> feet/second

// GETTER that returns a simplified flight track as an array of {lat, lon}.
// Used by the minimap to draw the flight path without needing altitude, speed, etc.
window.skyTrailState = {
  get track() {
    // From rows[], extract only {lat, lon} for each entry.
    // (rows || []) ensures there's always an array (fallback = []).
    // .map() transforms each row into a simpler object containing only coordinates
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
  labelAlpha: 70, // Opacity for labels
  arcLabel: '← Beginning of Data', // Optional text drawn along the outside of the outer ring (leave empty to disable)
  arcLabelAlign: 'end' // 'center' | 'start' | 'end' (anchor text relative to the reference angle)
};

function setup() {
  let c = createCanvas(windowWidth, windowHeight); // full window canvas
  c.parent("canvas-container");
  colorMode(HSB, 360, 100, 100, 100);
  pixelDensity(1);

  // Side info card. Cache references to DOM elements (fields) inside the side panel
  infoCard = document.getElementById('left-info-card');
  const get = (id) => document.getElementById(id); // helper function that gets an element from the DOM by its ID
  window.infoRefs = {
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
    console.warn('left-info-card element not found in HTML. Add it to index.html.');
  }

  // Wire up welcome/upload UI and swap screens after upload
  const dashboard = document.getElementById('dashboard');
  const welcome = document.getElementById('welcome');
  const dz = document.getElementById('drop-zone');
  const fileEl = document.getElementById('csv-input');

  if (dz && fileEl) {
    const onFiles = (files) => { // arrow function that handles file uploads
      const f = files && files[0]; // only process the first file if there's more than one
      if (!f) return; // return early and do nothing if no file is selected

      // Create a new FileReader instance to read the file's contents.
      // (FileReader is a browser API that allows us to read files from the user's computer as text or data URLs.)
      const reader = new FileReader();

      // Set up the onload event handler, which will be called once the file has been successfully read.
      // This function receives an event object 'e' containing the file data.
      reader.onload = (e) => {
        // 'e.target.result' contains the contents of the file as a string.
        parseFromCSVText(String(e.target.result)); // Parse the uploaded CSV text and update the app's data structures.

        // Hide the welcome screen to transition away from the file upload UI.
        if (welcome) welcome.classList.add('hidden');
        // Show the dashboard, which displays the flight visualization and info.
        if (dashboard) dashboard.classList.remove('hidden');

        // If the minimap does not exist yet (first upload), create it now to display the flight path.
        if (!minimap) {
          createMinimap();
        } else {
          // If it already exists (user uploads a new file), rebuild it to reflect the new data.
          minimap.rebuild();
        }

        // If the speed chart does not exist yet (first upload), create it now.
        if (!speedChart) {
          createSpeedChart();
        } else {
          speedChart.rebuild();
        }
      };

      // Start reading the file as plain text.
      // This triggers the reader.onload handler above once reading is complete.
      reader.readAsText(f);
    };

    // Listen for the 'change' event on the file input element.
    // This event fires when the user selects a file using the file picker dialog.
    fileEl.addEventListener('change', (ev) => {
      // ev.target.files contains the list of files selected by the user.
      // Pass ev.target.files to onFiles so it can process the uploaded file(s).
      onFiles(ev.target.files);
    });

    // Listen for the 'dragover' event on the drop zone.
    dz.addEventListener('dragover', (ev) => {
      ev.preventDefault(); // Required to enable drop (without it, the browser may try to open the file instead of uploading).
      dz.classList.add('hover'); // Add a visual hover effect
    });

    // Listen for the 'dragleave' event on the drop zone.
    dz.addEventListener('dragleave', () => dz.classList.remove('hover')); // Remove the hover class to update the visual feedback.

    // Listen for the 'drop' event on the drop zone (fires when the user drops one or more files).
    // Extract the files from ev.dataTransfer.files and call onFiles again to process them.
    dz.addEventListener('drop', (ev) => {
      ev.preventDefault(); // Prevent default browser behavior
      dz.classList.remove('hover'); // Remove hover effect
      if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) {
        // Pass the dropped files to onFiles for processing
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
  // Get the minimum and maximum altitudes from the global range
  const altMin = range.altMin, altMax = range.altMax;
  // Step size for altitude rings (in feet)
  const step = UI.ringStep;
  // Compute the maximum altitude ring (rounded up to the nearest step)
  const maxAlt = niceCeilToStep(altMax, step);
  // Always start rings at ground level for consistent visuals across flights
  const minAlt = 0;

  push();
  textSize(8);
  // Loop through each altitude value at the specified step
  for (let alt = minAlt; alt <= maxAlt; alt += step) {
    // Compute the radius for this altitude ring using linear mapping
    const rr = baseR + map(alt, altMin, altMax, 0, varR, true); // map(value, inMin, inMax, outMin, outMax, clamp?)
    // Format altitude for display: FL = Flight Level (hundreds of feet)
    const fl = Math.round(alt / 100); // FL label (hundreds of feet)
    // Compute thousands of feet for odd/even FL rule
    const kft = Math.round(alt / 1000); // thousands of feet for parity
    // Determine if this ring is relevant based on track direction and FL parity
    // Eastbound (E): odd thousands, Westbound (W): even thousands; if unknown, all relevant
    const relevant = trackDir
      ? (trackDir === 'E' ? (kft % 2 === 1)       // odd thousands → eastbound
                          : (kft % 2 === 0))      // even thousands → westbound
      : true;                                     // if unknown, show all as relevant

    // Draw the altitude ring: color/opacity indicates relevance
    noFill();
    stroke(0, 0, 100, relevant ? UI.ringAlpha : UI.nonRelevantRingAlpha);
    strokeWeight(2);
    circle(center.x, center.y, rr * 2);

    // Draw the FL label only for relevant rings
    if (relevant) {
      noStroke();
      fill(0, 0, 100, UI.labelAlpha);
      textAlign(CENTER, BOTTOM);
      const flStr = `FL${nf(fl, 3)}`; // p5.js --> nf(number, leftDigits, rightDigits) // Pad FL to 3 digits (e.g., FL330) 
      text(flStr, center.x, center.y - rr - 2);
      stroke(0, 0, 100, UI.ringAlpha); // Restore stroke for next ring
    }
  }
  pop();
}

// Vertical marker at 6 o'clock (t=0/1) to indicate where data start/finish
function drawStartEndMarker(center, baseR, varR) {
  // 6 o'clock direction → angle = HALF_PI, x stays at center.x
  const x = center.x;
  const y0 = center.y + baseR; // start at inner altitude ring
  const y1 = center.y + baseR + varR; // extend to outer altitude ring
  push();
  stroke(0, 80, 90, 40);
  strokeWeight(2);
  line(x, y0, x, y1);
  pop();
}

// Draw a string along a circular arc, centered at a given angle.
// radius is measured from center; angleCenter in radians (0 at +x, counterclockwise).
// If outward=true the text is upright relative to the outside of the circle.
function drawTextAlongCircle(center, radius, label, angleCenter, outward = true, letterSpacing = 1, align = 'center') {
  if (!label || !label.length) return;
  push();
  noStroke();
  fill(0, 0, 100, 85);
  textAlign(CENTER, CENTER);
  textSize(12);

  // Measure arc length needed: sum of character widths + spacing
  let total = 0;
  let widths = [];
  for (let i = 0; i < label.length; i++) {
    const w = textWidth(label[i]);
    widths.push(w);
    total += w + (i ? letterSpacing : 0);
  }
  const theta = total / radius; // total angular span (radians)

  if (outward) {
    let a;
    if (align === 'center') a = angleCenter - theta / 2; // centered on angleCenter
    else if (align === 'end') a = angleCenter - theta; // right edge at angleCenter
    else a = angleCenter; // 'start' → left edge at angleCenter
    for (let i = 0; i < label.length; i++) {
      const ch = label[i];
      const w = widths[i];
      a += (w / 2) / radius;
      const x = center.x + Math.cos(a) * radius;
      const y = center.y + Math.sin(a) * radius;
      push();
      translate(x, y);
      rotate(a + HALF_PI);
      text(ch, 0, 0);
      pop();
      a += (w / 2 + letterSpacing) / radius;
    }
  } else {
    // Inward orientation but keep reading order left→right on screen.
    // Move along the arc from left end → right end (decreasing angle near 6 o'clock)
    let a;
    if (align === 'center') a = angleCenter + theta / 2; // centered on angleCenter
    else if (align === 'end') a = angleCenter + theta;   // right edge at angleCenter
    else a = angleCenter;                                // 'start' → left edge at angleCenter
    for (let i = 0; i < label.length; i++) {
      const ch = label[i];
      const w = widths[i];
      a -= (w / 2) / radius; // half advance toward the right (decreasing angle)
      const x = center.x + Math.cos(a) * radius;
      const y = center.y + Math.sin(a) * radius;
      push();
      translate(x, y);
      // Tangent baseline rotated so glyphs are upright when viewed from outside
      rotate(a - HALF_PI);
      text(ch, 0, 0);
      pop();
      a -= (w / 2 + letterSpacing) / radius; // complete advance
    }
  }
  pop();
}

// This function computes the coordinates and attributes needed to draw the flight visualization,
// mapping each row of flight data to a point around a circular path (radius encodes alt).
function buildRosettePoints() {
  const n = rows.length; // Number of data points (rows) to process
  const altMin = range.altMin, altMax = range.altMax; // Min and max alt across the dataset, used for scaling the radius
  const center = { x: width * 0.5, y: height * 0.5 }; // The center of the rosette (middle of the canvas)
  const maxRadius = (min(width, height) / 2) - UI.margin * 2; // The max radius the rosette can reach, leaving a margin from the edges
  const varR = maxRadius * 0.6; // The portion of the total radius that will vary based on alt.
  const baseR = maxRadius - varR; // Min radius from the center (the "innermost" ring, for lowest alt).

  let pts = []; // Array to hold all computed rosette points
  for (let i = 0; i < n; i++) {
    const row = rows[i];
    const t = timeFracForRow(row, i, n); // t = value from 0 to 1, representing the fraction of the way through the flight. Based on timestamp if available, or index-based if not.
    const angle = HALF_PI + t * TWO_PI; // The angle for this point around the circle. Start at HALF_PI (6 o'clock) and sweep clockwise through TWO_PI as t goes from 0 to 1.
    // The radius for this point is determined by linearly mapping the row's alt from [altMin, altMax]
    // to [0, varR], then offsetting by baseR. This means:
    // - The lowest altitude maps to the innermost ring (baseR)
    // - The highest altitude maps to the outermost ring (baseR + varR)
    const radius = baseR + map(row.alt, altMin, altMax, 0, varR, true);
    // Convert polar coordinates (angle, radius) to Cartesian (x, y) for plotting on the canvas.
    // This is necessary because drawing functions require x/y coordinates, not angle/radius.
    const x = center.x + cos(angle) * radius;
    const y = center.y + sin(angle) * radius;
    const idx = i;
    // Store all relevant data for this point, including its computed position,
    // original flight data, and polar coordinates (angle, radius) for interpolation.
    pts.push({
      x, y, alt: row.alt, spd: row.spd, hdg: row.hdg, lat: row.lat, lon: row.lon, utc: row.utc, tMs: row.tMs, idx,
      angle, radius
    });
  }
  // Add the first two points again to the end of the array.
  // This "closes the loop," ensuring the path is continuous when drawing curves that wrap around.
  pts.push(pts[0], pts[1]); // close loop for continuity
  // Return an object containing:
  // - pts: Array of all computed point objects, ready for drawing the rosette path.
  // - center: The center coordinate of the rosette (for drawing reference).
  // - baseR: The minimum radius (for drawing inner rings and scaling).
  // - varR: The amount of radius that varies with altitude (for scaling and drawing rings).
  // This structure is returned so the caller can use all the necessary geometry and scaling info
  // for rendering the rosette and related overlays.
  return { pts, center, baseR, varR };
}

function drawRosette() {
  if (!rows.length) return;

  // 1. Call the function buildRosettePoints().   2. Take the object it returns.
  // 3. Unpack the properties pts, center, baseR, and varR.   4. Store them in constants with the same names.
  const { pts, center, baseR, varR } = buildRosettePoints();

  background(0, 0, 8);

  // Rings + labels on top of rosette, below cursor
  drawAltitudeRings(center, baseR, varR);

  // Draw rosette on the offscreen buffer for crisp strokes
  trail.clear();
  trail.colorMode(HSB, 360, 100, 100, 100);

  for (let i = 0; i < pts.length - 2; i++) {
    const a = pts[i], b = pts[i + 1];    
    if (i === rows.length - 1) continue; // Prevent drawing between last and first point (skip last-to-first connection)
    const hue = 200; // fixed hue blue
    const sat = map(a.spd, range.spdMin, range.spdMax, 100, 50, true); // saturation based on speed
    const bri = map(a.spd, range.spdMin, range.spdMax, 25, 100, true); // brightness based on speed
    const sw  = map(a.spd, range.spdMin, range.spdMax, 2, 4.5, true); // stroke weight based on speed

    trail.stroke(hue, sat, bri, 92);
    trail.strokeWeight(sw);

    // Polar interpolation for smoother curves
    const segs = 24;
    let px = a.x, py = a.y;
    for (let s = 1; s < segs; s++) {
      const t = s / segs;

      // Interpolate angle and radius separately for smoother curves
      const angleInterp = lerp(a.angle, b.angle, t);
      const radiusInterp = lerp(a.radius, b.radius, t);

      // Convert interpolated polar coordinates back to Cartesian
      const x1 = cos(angleInterp) * radiusInterp + center.x;
      const y1 = sin(angleInterp) * radiusInterp + center.y;

      trail.line(px, py, x1, y1);

      // Update previous point for the next segment
      px = x1;
      py = y1;
    }
  }
  image(trail, 0, 0); // Draws the trail buffer onto the main canvas.

  drawStartEndMarker(center, baseR, varR);

  // Optional label along the outside of the outer circle (centered at 6 o'clock)
  if (UI.arcLabel && UI.arcLabel.length) {
    const rLabel = baseR + varR + 14; // a bit outside the outer ring
    drawTextAlongCircle(center, rLabel, UI.arcLabel, HALF_PI, false, 1, UI.arcLabelAlign);
  }

  // --- Interactive probe from mouse position ---
  selectedIdx = getIndexFromMouse(center, pts.length - 2); // exclude the two closing duplicates
  const hdgNow = (rows[selectedIdx] && Number.isFinite(rows[selectedIdx].hdg)) ? rows[selectedIdx].hdg : null;
  drawHeadingViz(center, baseR, hdgNow);
  drawIndicator(pts, selectedIdx);
  updateInfoCard(pts[selectedIdx]);
  minimap.refresh(); // Refresh minimap
  speedChart.refresh(); // Refresh speed chart
}

function keyPressed() {
  if (key === 'a' || key === 'A') {
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
  circle(0, 0, ringR * 2);

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

  const refs = window.infoRefs || {};
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

// Bearing helper: verify whether the flight is tracking Eastbound or Westbound.
// Updates global trackDir and returns 'E', 'W', or null.
function updateTrackDir(lat1, lon1, lat2, lon2) {
  // Validate inputs
  if (!Number.isFinite(lat1) || !Number.isFinite(lon1) ||
      !Number.isFinite(lat2) || !Number.isFinite(lon2)) {
    trackDir = null;
    return trackDir;
  }

  // Normalize shortest-path Δlon to [-180, +180]
  let dlon = ((lon2 - lon1 + 540) % 360) - 180;

  // Pure N/S (same meridian within epsilon): tie-break by latitude
  if (Math.abs(dlon) < 1e-6) {
    if (Math.abs(lat2 - lat1) < 1e-6) {
      trackDir = null; // same point → undefined
      return trackDir;
    }
    trackDir = (lat2 > lat1) ? 'E' : 'W';
    return trackDir;
  }

  // General case: sign of Δlon decides
  trackDir = dlon > 0 ? 'E' : 'W';
  return trackDir;
}

// Rounds a value up to the nearest multiple of the given step.
// For example, niceCeilToStep(1025, 1000) → 2000.
function niceCeilToStep(v, step) {
  return Math.ceil(v / step) * step; // example: Math.ceil(1025 / 1000) * 1000; // → 2 * 1000 → 2000
}

// Rounds a value down to the nearest multiple of the given step.
// For example, niceFloorToStep(1850, 1000) → 1000.
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

  // --- Average speed during flight (altitude > 0) ---
  (function updateAvgSpeedDuringFlight(){
    const el = document.getElementById('avg-speed');
    if (!el) return;

    // We rely on the same takeoff/landing detection as above
    // Recompute indices to bound the in-flight interval
    let takeIdx2 = -1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (Number.isFinite(r.tMs) && Number.isFinite(r.alt) && r.alt > 0) { takeIdx2 = i; break; }
    }

    if (takeIdx2 < 0) { el.textContent = '—'; return; }

    let landIdx2 = rows.length - 1;
    for (let i = takeIdx2 + 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur  = rows[i];
      if (Number.isFinite(prev?.alt) && Number.isFinite(cur?.alt) && prev.alt !== 0 && cur.alt === 0) {
        landIdx2 = i; // the first row at ground
        break;
      }
    }

    let weightedSum = 0; // sum( avg(speed_i, speed_{i+1}) * dt_i )
    let totalDt = 0;     // seconds while in flight

    for (let i = takeIdx2; i < landIdx2; i++) {
      const a = rows[i];
      const b = rows[i + 1];
      if (!a || !b) continue;
      if (!Number.isFinite(a.tMs) || !Number.isFinite(b.tMs)) continue;
      const dt = (b.tMs - a.tMs) / 1000; // seconds
      if (!(dt > 0)) continue;

      // consider interval only if both endpoints are in-flight (alt > 0)
      if (!Number.isFinite(a.alt) || !Number.isFinite(b.alt) || a.alt <= 0 || b.alt <= 0) continue;

      // use trapezoidal average of speed (knots)
      const sA = Number.isFinite(a.spd) ? a.spd : NaN;
      const sB = Number.isFinite(b.spd) ? b.spd : NaN;
      if (!Number.isFinite(sA) || !Number.isFinite(sB)) continue;

      const sAvg = (sA + sB) * 0.5;
      weightedSum += sAvg * dt;
      totalDt += dt;
    }

    if (totalDt > 0) {
      const avgKt = weightedSum / totalDt; // time-weighted average speed in knots
      el.textContent = Math.round(avgKt) + ' kt';
    } else {
      el.textContent = '—';
    }
  })();

  if (rows.length >= 2) {
    const start = rows[0];
    const end   = rows[rows.length - 1];
    // Verify whether the flight is tracking East/West and update global trackDir
    updateTrackDir(start.lat, start.lon, end.lat, end.lon);
  }
  if (range.altMin === range.altMax) range.altMax = range.altMin + 1;
  if (range.spdMin === range.spdMax) range.spdMax = range.spdMin + 1;

  // Reset trail buffer to fit current canvas and clear previous drawing
  trail = createGraphics(width, height);
  trail.colorMode(HSB, 360, 100, 100, 100);
  trail.clear();
  {
    // Set actual takeoff/landing UTC time fields in the info card (static, does not update)
    const refs = window.infoRefs || {};
    if (refs.takeoffActual) refs.takeoffActual.innerHTML = actualTakeOffTime || '—';
    if (refs.landingActual) refs.landingActual.innerHTML = actualLandingTime || '—';
  }
}

// --- CSV line splitter and unquote helper ---
function splitCSVLine(line) {
  const out = []; // final result
  let cur = ''; // building value
  let inQuotes = false; // Tracks whether we are currently inside a quoted field

  // Loop through every character in the given CSV line
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]; // current character

    if (ch === '"') {
      // If character is a double quote:

      if (inQuotes && line[i+1] === '"') {
        // Case: we're inside quotes and encounter two double-quotes in a row ("")
        // This means an escaped quote → append a single quote to current value
        cur += '"';
        i++; // skip the second quote to avoid duplication
      } else {
        // Otherwise, toggle the "inQuotes" flag.
        // If we were outside quotes → we're now entering quoted section.
        // If we were inside quotes → we're now exiting quoted section.
        inQuotes = !inQuotes;
      }

    } else if (ch === ',' && !inQuotes) {
      // If character is a comma **outside** of a quoted section:
      // → Treat it as a separator between CSV fields.

      out.push(cur);  // push the current value into the output array
      cur = '';       // reset accumulator for the next field

    } else {
      // For all other cases (normal characters or commas inside quotes):
      // → Add the character to the current field value.
      cur += ch;
    }
  }

  // Push the last collected value after the loop ends.
  out.push(cur);

  // Return the resulting array of fields for this CSV line.
  return out;
}

function unquote(s) {
  if (typeof s !== 'string') return s; // Defensive programming: ensures that the function only processes strings (→ if number, return as is)
  s = s.trim(); // Removes leading and trailing whitespace
  if (s.length >= 2 && s[0] === '"' && s[s.length-1] === '"') { // Check if the string is at least 2 chars long, and first and last chars are double quotes
    s = s.slice(1, -1).replace(/""/g, '"'); // Remove outer quotes and replace double double-quotes with single quotes
  }
  return s;
}

function parseFromCSVText(text) {
  // Reset all global data holders and ranges before parsing new data
  resetDataHolders();
  if (!text) return;

  // Split the input text into lines, removing any empty lines
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return;
  // console.log(lines); // ← uncomment to debug

  // Parse the header row and normalize header names
  const headers = splitCSVLine(lines[0]).map(h => h.trim());
  // Helper to find the column index by case-insensitive header name
  const findIdx = (name) => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());
  // Find indices for each relevant field
  const iPos = findIdx('Position');    // e.g. "lat,lon"
  const iAlt = findIdx('Altitude');    // altitude in feet
  const iSpd = findIdx('Speed');       // speed in knots
  const iHdg = findIdx('Direction');   // heading in degrees
  const iUtc = findIdx('UTC');         // UTC string timestamp
  const iTs  = findIdx('Timestamp');   // Unix timestamp (seconds)
  const iCallsign = findIdx('Callsign'); // flight callsign

  // Extract callsign once from the first available data row
  let callsignVal = (iCallsign >= 0 && lines.length > 1)
    ? unquote(splitCSVLine(lines[1])[iCallsign] || '')
    : '';

  // Iterate over each CSV data line (skip header row)
  for (let li = 1; li < lines.length; li++) {
    // Split the current line into columns, handling quoted fields
    const cols = splitCSVLine(lines[li]);
    if (!cols.length) continue;

    // --- Position parsing (latitude, longitude) ---
    const posRaw = (iPos >= 0) ? cols[iPos] : '';
    const pos = unquote(posRaw);
    if (!pos) continue; // skip row if position is missing
    const [latStr, lonStr] = pos.split(',');
    const lat = Number(latStr);
    const lon = Number(lonStr);

    // --- Altitude, speed, and heading parsing ---
    const alt = (iAlt >= 0) ? Number(cols[iAlt]) : NaN;
    const spd = (iSpd >= 0) ? Number(cols[iSpd]) : NaN;
    const hdg = (iHdg >= 0) ? Number(cols[iHdg]) : NaN;

    // --- Time parsing: prefer UTC, fallback to Unix timestamp ---
    let utc = (iUtc >= 0) ? cols[iUtc] : '';
    utc = utc ? unquote(utc) : '';
    let tMs = NaN;
    if (utc) {
      // If UTC string exists, parse it to ms since epoch
      tMs = parseUTCtoMs(utc);
    } else if (iTs >= 0) {
      // Fallback: use Unix timestamp (seconds), convert to ms
      const ts = Number(cols[iTs]);
      if (Number.isFinite(ts)) tMs = ts * 1000; // seconds -> ms
    }

    // --- Data structure creation ---
    // Store parsed values as an object in the rows array
    rows.push({ lat, lon, alt, spd, hdg, utc, tMs });

    // --- Bounds and ranges update ---
    // Update min/max bounds for latitude
    if (Number.isFinite(lat)) {
      bounds.latMin = min(bounds.latMin, lat);
      bounds.latMax = max(bounds.latMax, lat);
    }

    // Update min/max bounds for longitude
    if (Number.isFinite(lon)) {
      bounds.lonMin = min(bounds.lonMin, lon);
      bounds.lonMax = max(bounds.lonMax, lon);
    }

    // Update min/max ranges for altitude
    if (Number.isFinite(alt)) {
      range.altMin = min(range.altMin, alt);
      range.altMax = max(range.altMax, alt);
    }

    // Update min/max ranges for speed
    if (Number.isFinite(spd)) {
      range.spdMin = min(range.spdMin, spd);
      range.spdMax = max(range.spdMax, spd);
    }
  }

  // --- Finalization of parsing ---
  // Compute start/end times, takeoff/landing, track direction, and adjust ranges
  finalizeAfterRowsParsed();

  // --- Callsign display in DOM ---
  // Update the DOM element for callsign (if available)
  const csEl = document.getElementById('info-callsign');
  if (csEl) csEl.textContent = callsignVal || '—';
}

// MINIMAP
let minimap = null;

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
        if (Number.isFinite(pt.lat)) {
          if (pt.lat < minLat) minLat = pt.lat;
          if (pt.lat > maxLat) maxLat = pt.lat;
        }
        if (Number.isFinite(pt.lon)) {
          if (pt.lon < minLon) minLon = pt.lon;
          if (pt.lon > maxLon) maxLon = pt.lon;
        }
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

  minimap = new p5(sketch, 'flight-path-canvas');
}

// SPEED CHART
let speedChart = null;

function createSpeedChart() {
  const sketch = (p) => {
    let pad = 16;                 // internal padding
    let pts = [];                // projected points [{x,y,tMs,spd}]
    let sX = 1, offX = 0;        // mapping X (time)
    let sY = 1, offY = 0;        // mapping Y (speed)

    p.setup = () => {
      const host = document.getElementById('flight-speed-canvas');
      const w = host?.clientWidth || 300;
      const h = host?.clientHeight || 120;
      p.createCanvas(w, h);
      p.pixelDensity(1);
      p.noLoop();     // manual redraw
      p.clear();
      p.canvas.style.pointerEvents = 'none';
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
      // dati e tempi validi?
      if (!rows.length || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        pts.length = 0; return;
      }
      const innerW = Math.max(1, p.width  - pad*2);
      const innerH = Math.max(1, p.height - pad*2);

      const tSpan = endMs - startMs; // total ms
      sX = innerW / tSpan;           // px per ms
      offX = pad;                    // left padding

      // vertical scale from global speed range
      const spanY = Math.max(1e-6, range.spdMax - range.spdMin);
      sY = innerH / spanY;
      offY = pad; // vertical flip is in project()
    }

    function project(row) {
      const x = (row.tMs - startMs) * sX + offX;
      // y grows downward: spdMin → bottom, spdMax → top
      const yVal = (row.spd - range.spdMin) * sY; // 0..innerH
      const y = p.height - (yVal + offY);
      return { x, y };
    }

    function rebuild() {
      pts.length = 0;
      computeFit();
      if (!rows.length || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;

      for (const r of rows) {
        if (Number.isFinite(r.tMs) && Number.isFinite(r.spd)) {
          const pr = project(r);
          pts.push({ x: pr.x, y: pr.y, tMs: r.tMs, spd: r.spd });
        }
      }
      // for safety: sort by time
      pts.sort((a,b) => a.tMs - b.tMs);
    }

    p.draw = () => {
      p.clear();
      drawFrame();
      drawAxes();
      drawAreaUnderLine();
      drawLine();
      drawCursor();
    };
    function drawAreaUnderLine() {
      if (pts.length < 2) return;

      // Baseline at current visual minimum speed (range.spdMin)
      const yBase = p.height - ((0 - 0 + (range.spdMin - range.spdMin)) * sY + offY); // placeholder to show form
      // compute with same projector used in project():
      const yForSpeed = (v) => p.height - (((v - range.spdMin) * sY) + offY);
      const baselineY = yForSpeed(range.spdMin);

      p.noStroke();
      // ~20% opacity (0.20 * 255 ≈ 51)
      p.fill(255, 255, 255, 51);

      p.beginShape();
      // start at first x on baseline
      p.vertex(pts[0].x, baselineY);
      // trace the curve
      for (const pt of pts) {
        p.vertex(pt.x, pt.y);
      }
      // end at last x on baseline, then close
      p.vertex(pts[pts.length - 1].x, baselineY);
      p.endShape(p.CLOSE);
    }

    function drawFrame() {
      p.noFill();
      p.stroke(255, 40);
      p.strokeWeight(1);
      p.rect(0.5, 0.5, p.width-1, p.height-1, 6);
    }

    function drawAxes() {
      // 1) Update DOM with max speed
      const el = document.getElementById('max-speed');
      if (el && Number.isFinite(range.spdMax)) {
        el.textContent = Math.round(range.spdMax) + ' kt';
      }

      // 2) Grid lines: baseline at 0 kt and every 100 kt up to floor(spdMax/100)*100
      const yForSpeed = (v) => {
        const yVal = (v - range.spdMin) * sY;
        return p.height - (yVal + offY);
      };

      // Baseline at 0 kt — always draw it (clamped to canvas if outside range)
      if (Number.isFinite(range.spdMin) && Number.isFinite(range.spdMax)) {
        const y0raw = yForSpeed(0);
        const y0 = Math.max(1, Math.min(p.height - 1, Math.round(y0raw) + 0.5));
        p.stroke(255, 120); // a bit stronger
        p.strokeWeight(1);
        p.line(1, y0, p.width - 1, y0);
      }

      // Horizontal lines every 100 kt up to the last full hundred ≤ max speed
      if (Number.isFinite(range.spdMax)) {
        const maxHundred = Math.floor(range.spdMax / 100) * 100; // e.g., 340 → 300
        for (let v = 100; v <= maxHundred; v += 100) {
          const y = yForSpeed(v);
          if (y >= 0 && y <= p.height) {
            p.stroke(255, 60); // subtle
            p.strokeWeight(1);
            p.line(1, Math.round(y) + 0.5, p.width - 1, Math.round(y) + 0.5);
          }
        }
      }
    }

    function drawLine() {
      if (pts.length < 2) return;
      p.noFill();
      p.stroke(255, 200);
      p.strokeWeight(2);
      p.beginShape();
      for (const pt of pts) p.vertex(pt.x, pt.y);
      p.endShape();
    }

    function drawCursor() {
      const i = window.skyTrailState.cursorIndex;
      if (!Number.isFinite(i) || !rows[i]) return;
      const r = rows[i];
      if (!Number.isFinite(r.tMs)) return;
      const pr = project(r);

      // vertical cursor on time
      p.stroke(255, 120);
      p.strokeWeight(1);
      p.line(pr.x, 0, pr.x, p.height);

      // point on line at current speed
      if (Number.isFinite(r.spd)) {
        p.noStroke();
        p.fill(255, 255, 0, 230);
        p.circle(pr.x, pr.y, 5);

        // small label near the point
        p.fill(255);
        p.textSize(10);
        p.textAlign(p.LEFT, p.BOTTOM);
        const lbl = Math.round(r.spd) + ' kt';
        const tx = Math.min(pr.x + 6, p.width - 30);
        const ty = Math.max(12, pr.y - 6);
        p.text(lbl, tx, ty);
      }
    }

    // public hooks
    p.rebuild = () => { rebuild(); p.redraw(); };
    p.refresh = () => { p.redraw(); };
  };

  speedChart = new p5(sketch, 'flight-speed-canvas');
}