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
let infoRefs; // populated in setup when HTML elements exist

let selectedIdx = 0; // Currently selected point index (based on mouse position)
let cursorFollowMouse = true; // toggle whether cursor follows mouse

// Centralized DOM cache
let dom = {};
function cacheDomRefs() {
    dom.dashboard      = document.getElementById('dashboard');
    dom.welcome        = document.getElementById('welcome');
    dom.dropZone       = document.getElementById('drop-zone');
    dom.csvInput       = document.getElementById('csv-input');

    // Main canvas container
    dom.canvasContainer = document.getElementById('canvas-container');

    dom.cursorPlane    = document.getElementById('cursor-plane');
    dom.headingPlane   = document.getElementById('heading-plane');

    // Secondary canvas elements
    dom.flightPathHost = document.getElementById('flight-path-canvas');
    dom.flightSpeedHost= document.getElementById('flight-speed-canvas');

    // Info card fields
    dom.infoDate       = document.getElementById('info-date');
    dom.infoSince      = document.getElementById('info-since');
    dom.infoUntil      = document.getElementById('info-until');
    dom.infoFlightTime = document.getElementById('info-total-flight-time');
    dom.infoSpeed      = document.getElementById('info-speed');
    dom.infoHeading    = document.getElementById('info-heading');
    dom.infoLocation   = document.getElementById('info-location');
    dom.infoAltitude   = document.getElementById('info-altitude');
    dom.infoTilt       = document.getElementById('info-tilt');
    dom.infoCallsign   = document.getElementById('info-callsign');
    dom.infoTakeoff    = document.getElementById('info-actual-takeoff-time');
    dom.infoLanding    = document.getElementById('info-actual-landing-time');

    dom.avgSpeed       = document.getElementById('avg-speed');
    dom.maxSpeed       = document.getElementById('max-speed');

    dom.resetButton    = document.getElementById('reset-button');

    // Speed legend swatches
    dom.speedLegend = new Array(SPEED_BANDS.length);
    for (let i = 0; i < SPEED_BANDS.length; i++) {
        dom.speedLegend[i] = document.getElementById(`color-band-${i}`);
    }

    // Additional cursor status indicator DOM elements
    dom.cursorOnIcon         = document.getElementById('cursor-on-icon');
    dom.cursorOffIcon        = document.getElementById('cursor-off-icon');
    dom.cursorStatusTitle    = document.getElementById('cursor-status-title');
    dom.cursorStatusSubtitle = document.querySelector('.cursor-status-msg-subtitle');
}

function updateSpeedLegend() {
    for (let i = 0; i < SPEED_BANDS.length; i++) {
        const [r, g, b] = SPEED_BANDS[i].color;
        dom.speedLegend[i].style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
    }
}

// Flight start and end times (milliseconds since epoch)
let startTimestampMs = null, endTimestampMs = null;

// Detected takeoff/landing times (altitude transition-based)
let actualTakeOffMs = null, actualLandingMs = null; // computed from altitude transitions
let actualTakeOffTime = null, actualLandingTime = null; // formatted UTC strings


// Constant to convert speed from knots to feet per second
const KNOT_TO_FPS = 1.68781; // knots -> feet/second

// Fixed commercial-aviation speed bands (knots) → 6 colors
// 0–40  : Push/Taxi slow → Red
// 40–160: T/O roll & late approach → Orange
// 160–300: Climb/Descent (<FL100 ops) → Green
// 300–420: Transition / low cruise → Blue
// 420–520: Typical cruise → Purple
// 520+   : Fast cruise / jetstream → Pink
const GS_BREAKS = [0, 40, 160, 300, 420, 520];
const SPEED_BANDS = [
    { min: 0,   max: 40,       color: [255,  66,  69] },  // Red
    { min: 40,  max: 160,      color: [255, 146,  48] },  // Orange
    { min: 160, max: 300,      color: [ 48, 209,  88] },  // Green
    { min: 300, max: 420,      color: [  0, 145, 255] },  // Blue
    { min: 420, max: 520,      color: [ 219, 52, 242] },  // Purple
    { min: 520, max: Infinity, color: [ 255, 55,  95] }   // Pink (fastest)
];

// Stroke weight scale anchored to fixed aviation GS (knots)
const SW_MIN = 2.0, SW_MAX = 5.0, SW_MAX_AT = 520; // ≥520 kt uses max thickness

// GETTER that returns a simplified flight track as an array of {lat, lon}.
window.skyTrailState = {
    get track() {
        return (rows || []).map(r => ({ lat: r.lat, lon: r.lon }));
    },
    get cursorIndex() {
        return selectedIdx | 0;
    }
};

// Fine-tuning for visual centering of the SVG cursor on the rosette path
const CURSOR_INWARD_PX = 2;   // radial nudge toward center (px).
const CURSOR_ROT_DEG = 0;     // extra rotation

const HEADING_PLANE_SIZE_PX = 28; // size of the heading SVG in pixels

// UI configuration for ring step, transparency, etc.
const UI = {
    margin: 24, // margin from canvas edges
    ringStep: 1000, // Step between altitude rings (in feet)
    ringAlpha: 25, // Opacity for visible rings
    nonRelevantRingAlpha: 15, // Opacity for non-relevant rings
    labelAlpha: 70, // Opacity for labels
    arcLabel: '← Beginning of Data', // Optional text drawn along the outside of the outer ring (leave empty to disable)
    arcLabelAlign: 'end' // 'center' | 'start' | 'end' (anchor text relative to the reference angle)
};

// ============================== [1] SETUP & LIFECYCLE ===============================

function setup() {
    let c = createCanvas(windowWidth, windowHeight); // full window canvas
    c.parent("canvas-container");
    colorMode(HSB, 360, 100, 100, 100);
    pixelDensity(4); // High-DPI rendering for crispness on Retina screens

    cacheDomRefs();
    updateSpeedLegend();

    // Side info card. Cache references from centralized DOM cache
    window.infoRefs = {
        date:          dom.infoDate,
        since:         dom.infoSince,
        until:         dom.infoUntil,
        speed:         dom.infoSpeed,
        heading:       dom.infoHeading,
        loc:           dom.infoLocation,
        alt:           dom.infoAltitude,
        tilt:          dom.infoTilt,
        callsign:      dom.infoCallsign,
        takeoffActual: dom.infoTakeoff,
        landingActual: dom.infoLanding,
        flightTime:    dom.infoFlightTime,
    };

    // Wire up welcome/upload UI and swap screens after upload
    if (dom.dropZone && dom.csvInput) {
        const onFiles = (files) => {
            const f = files && files[0];
            if (!f) return;

            const reader = new FileReader();

            reader.onload = (e) => {
                parseFromCSVText(String(e.target.result));

                if (dom.welcome) dom.welcome.classList.add('hidden');
                if (dom.dashboard) dom.dashboard.classList.remove('hidden');

                if (!minimap) {
                    createMinimap();
                } else {
                    minimap.rebuild();
                }

                if (!speedChart) {
                    createSpeedChart();
                } else {
                    speedChart.rebuild();
                }
            };

            reader.readAsText(f);
        };

        dom.csvInput.addEventListener('change', (ev) => {
            onFiles(ev.target.files);
        });

        dom.csvInput.addEventListener('dragover', (ev) => {
            ev.preventDefault();
            dom.csvInput.classList.add('hover');
        });

        dom.csvInput.addEventListener('dragleave', () => dom.csvInput.classList.remove('hover'));

        dom.csvInput.addEventListener('drop', (ev) => {
            ev.preventDefault();
            dom.csvInput.classList.remove('hover');
            if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) {
                onFiles(ev.dataTransfer.files);
            }
        });
    }

    dom.headingPlane.style.transform = 'translate(-10000px,-10000px)';

    background(0, 0, 10);
    noFill();
    strokeJoin(ROUND);
    strokeCap(ROUND);

    // Reset button: return to welcome screen for a new upload
    dom.resetButton.addEventListener('click', (ev) => {
        ev.preventDefault();
        resetToWelcome();
    });

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

// ============================== [2] CSV PARSE HELPERS ===============================

function resetDataHolders() {
    rows = [];
    bounds = { latMin:  1e9, latMax: -1e9, lonMin:  1e9, lonMax: -1e9 };
    range  = { altMin:  1e9, altMax: -1e9, spdMin: 1e9, spdMax: -1e9 };
    startTimestampMs = null; endTimestampMs = null; trackDir = null;
    actualTakeOffMs = null; actualLandingMs = null;
    actualTakeOffTime = null; actualLandingTime = null;
}

function resetToWelcome() {
    // 1) Reset data/state
    resetDataHolders();
    selectedIdx = 0;

    // 2) Clear UI fields
    const refs = window.infoRefs || {};
    const set = (el, v) => { if (el) el.innerHTML = v; };
    set(refs.date, '—');
    set(refs.since, '—');
    set(refs.until, '—');
    set(refs.speed, '—');
    set(refs.heading, '—');
    set(refs.loc, '—');
    set(refs.alt, '—');
    set(refs.tilt, '—');
    if (dom.infoFlightTime) dom.infoFlightTime.textContent = '—';
    set(refs.takeoffActual, '—');
    set(refs.landingActual, '—');

    if (dom.avgSpeed) dom.avgSpeed.textContent = '—';
    if (dom.maxSpeed) dom.maxSpeed.textContent = '—';

    // 3) Clear canvases and overlays
    if (trail) { trail.clear(); }
    background(0, 0, 10);
    if (dom.cursorPlane)  dom.cursorPlane.style.transform  = 'translate(-10000px,-10000px)';
    if (dom.headingPlane) dom.headingPlane.style.transform = 'translate(-10000px,-10000px)';

    // 4) Refresh mini canvases (they’ll draw empty state)
    if (minimap) minimap.refresh();
    if (speedChart) speedChart.refresh();

    // 5) Swap screens and reset file input so the same file can be re-chosen
    if (dom.welcome)   dom.welcome.classList.remove('hidden');
    if (dom.dashboard) dom.dashboard.classList.add('hidden');
    if (dom.dropZone)  dom.dropZone.classList.remove('hover');
    if (dom.csvInput)  dom.csvInput.value = '';
}

function splitCSVLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];

        if (ch === '"') {
        if (inQuotes && line[i+1] === '"') {
            cur += '"';
            i++;
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
    // Reset all global data holders and ranges before parsing new data
    resetDataHolders();
    if (!text) return; // empty input guard

    // Split the input text into lines, removing any empty lines
    const lines = text.split(/\r?\n/).filter(l => l.trim().length); // /\r?\n/ matches \n (Unix-style line endings) or \r\n (Windows-style).
    if (!lines.length) return; // empty input guard

    // Parse the header row and normalize header names
    const headers = splitCSVLine(lines[0]).map(h => h.trim());
    const findIdx = (name) => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());
    const iPos = findIdx('Position');    // "lat,lon"
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
    for (let line = 1; line < lines.length; line++) {
        const cols = splitCSVLine(lines[line]);
        if (!cols.length) continue;

        // --- Position parsing (latitude, longitude) ---
        const posRaw = (iPos >= 0) ? cols[iPos] : '';
        const pos = unquote(posRaw);
        if (!pos) continue; //If this row pos is empty/falsy, skip the rest of this loop and move on to the next row
        const [latStr, lonStr] = pos.split(',');
        const lat = Number(latStr);
        const lon = Number(lonStr);

        // --- Altitude, speed, and heading parsing ---
        const alt = (iAlt >= 0) ? Number(cols[iAlt]) : NaN;
        const spd = (iSpd >= 0) ? Number(cols[iSpd]) : NaN;
        const hdg = (iHdg >= 0) ? Number(cols[iHdg]) : NaN;

        // --- Time parsing: use Unix Timestamp only (seconds → milliseconds) ---
        let timestampMs = NaN;
        if (iTs >= 0) {
            const ts = Number(cols[iTs]); // Unix epoch seconds
            if (Number.isFinite(ts)) timestampMs = ts * 1000; // convert to ms
        }
        // Keep the raw UTC string (unparsed) only for potential display/debug; not used for timing
        const utc = (iUtc >= 0 && cols[iUtc]) ? unquote(cols[iUtc]) : '';

        // --- Data structure creation ---
        rows.push({ lat, lon, alt, spd, hdg, utc, timestampMs });

        // --- Bounds and ranges update ---
        if (Number.isFinite(lat)) {
            bounds.latMin = min(bounds.latMin, lat);
            bounds.latMax = max(bounds.latMax, lat);
        }
        if (Number.isFinite(lon)) {
            bounds.lonMin = min(bounds.lonMin, lon);
            bounds.lonMax = max(bounds.lonMax, lon);
        }
        if (Number.isFinite(alt)) {
            range.altMin = min(range.altMin, alt);
            range.altMax = max(range.altMax, alt);
        }
        if (Number.isFinite(spd)) {
            range.spdMin = min(range.spdMin, spd);
            range.spdMax = max(range.spdMax, spd);
        }
    }

    // --- Finalization of parsing ---
    finalizeAfterRowsParsed();

    // --- Callsign display in DOM ---
    const csEl = dom.infoCallsign;
    if (csEl) csEl.textContent = callsignVal || '—';
}

// ====================== [3] POST-PARSE FINALIZATION (DERIVED DATA) ==================

function finalizeAfterRowsParsed() {
    const validTimes = rows.filter(r => Number.isFinite(r.timestampMs));
    if (validTimes.length) {
        startTimestampMs = validTimes[0].timestampMs;
        endTimestampMs   = validTimes[validTimes.length - 1].timestampMs;
    }

    // Takeoff detection: find the first row that has a valid timestamp (timestampMs)
    // and an altitude strictly greater than zero (we treat this as "airborne").
    let takeoffIdx = -1, landingIdx = -1; // sentinel: -1 means "not found yet"
    for (let i = 0; i < rows.length; i++) { // scan from the start of the dataset
        const r = rows[i]; // current row
        // Only accept rows that have both a finite timestamp and altitude,
        // and when altitude becomes > 0.
        if (Number.isFinite(r.timestampMs) && Number.isFinite(r.alt) && r.alt > 0) {
            takeoffIdx = i; // remember the index where flight becomes airborne
            break;          // stop at the first occurrence
        }
    }

    // If a valid takeoff index is found, compute derived takeoff/landing times.
    if (takeoffIdx >= 0) {
        // Store takeoff time as milliseconds since epoch and also as a formatted UTC string.
        actualTakeOffMs = rows[takeoffIdx].timestampMs;
        actualTakeOffTime = formatUTC(actualTakeOffMs);

        // Landing detection: starting *after* takeoff, look for the first transition
        // where altitude goes from a non-zero value back to exactly 0. This marks
        // touchdown. Also require a valid timestamp on the landing row.
        for (let i = takeoffIdx + 1; i < rows.length; i++) { // scan forward from takeoff
            const prev = rows[i - 1]; // previous row (altitude before)
            const cur  = rows[i];     // current row  (altitude after)

            // Guard against missing values with Number.isFinite.
            // We detect the edge: prev.alt != 0  →  cur.alt === 0 (touchdown),
            // and ensure cur.timestampMs exists so we can timestamp the landing.
            if (
                Number.isFinite(prev?.alt) && Number.isFinite(cur?.alt) &&
                prev.alt !== 0 && cur.alt === 0 && Number.isFinite(cur.timestampMs)
            ) {
                actualLandingMs = cur.timestampMs;               // landing time in ms since epoch
                actualLandingTime = formatUTC(actualLandingMs); // formatted UTC string
                landingIdx = i;
                break; // stop at the first detected landing
            }
        }
    }

    // --- Total flight time (airborne duration) ---
    if (
        Number.isFinite(actualTakeOffMs) &&
        Number.isFinite(actualLandingMs) &&
        actualLandingMs > actualTakeOffMs
    ) {
        if (dom.infoFlightTime) {
            // Use HH:MM:SS via formatter
            dom.infoFlightTime.textContent = formatHMS(actualLandingMs - actualTakeOffMs);
        }
    } else {
        if (dom.infoFlightTime) dom.infoFlightTime.textContent = '—';
    }

    // --- Average speed during flight (altitude > 0) ---
    (function updateAvgSpeedDuringFlight(){ // IIFE: keep vars local
        let iStart = takeoffIdx; // first airborne row
        let iEnd   = landingIdx; // first row where we touched down (alt returns to 0)

        if (iStart < 0) {
            // As a fallback, use the first row with a finite timestamp
            for (let i = 0; i < rows.length; i++) {
                if (Number.isFinite(rows[i]?.timestampMs)) {
                    iStart = i;
                    break;
                }
            }
        }
        if (iEnd <= iStart) {
            // Fallback: last row with a finite timestamp
            for (let i = rows.length - 1; i >= 0; i--) {
                if (Number.isFinite(rows[i]?.timestampMs)) {
                    iEnd = i;
                    break;
                }
            }
        }

        // We need at least two rows to form one segment
        if (!(iStart >= 0) || !(iEnd > iStart)) {
            dom.avgSpeed.textContent = '—';
            return;
        }

        let weightedSum = 0; // Σ( segmentAvgSpeed * dt )
        let totalDt = 0;     // Σ( dt ) in seconds

        // Iterate only the segment range: [takeoff, landing]
        for (let i = iStart; i < iEnd; i++) {
            const a = rows[i];
            const b = rows[i + 1];
            if (!a || !b) continue;
            if (!Number.isFinite(a.timestampMs) || !Number.isFinite(b.timestampMs)) continue;
            const dt = (b.timestampMs - a.timestampMs) / 1000; // seconds
            if (!(dt > 0)) continue;

            // Only count segments that are fully in-flight (airborne at both ends)
            if (!Number.isFinite(a.alt) || !Number.isFinite(b.alt) || a.alt <= 0 || b.alt <= 0) continue;

            // Require valid speeds at both segment endpoints (in knots)
            const sA = Number.isFinite(a.spd) ? a.spd : NaN;
            const sB = Number.isFinite(b.spd) ? b.spd : NaN;
            if (!Number.isFinite(sA) || !Number.isFinite(sB)) continue;

            const sAvg = 0.5 * (sA + sB); // midpoint average for the segment
            weightedSum += sAvg * dt;     // time-weighted contribution
            totalDt += dt;
        }

        if (totalDt > 0) {
            const avgKt = weightedSum / totalDt; // knots
            dom.avgSpeed.textContent = Math.round(avgKt) + ' kt';
        } else {
            dom.avgSpeed.textContent = '—';
        }
    })();

    if (rows.length >= 2) {
        const start = rows[0];
        const end   = rows[rows.length - 1];
        updateTrackDir(start.lat, start.lon, end.lat, end.lon);
    }
    if (range.altMin === range.altMax) range.altMax = range.altMin + 1;
    if (range.spdMin === range.spdMax) range.spdMax = range.spdMin + 1;

    // Reset trail buffer to fit current canvas and clear previous drawing
    trail = createGraphics(width, height);
    trail.colorMode(HSB, 360, 100, 100, 100);
    trail.clear();
    // Ensure speed legend matches current band colors
    updateSpeedLegend();
    {
        const refs = window.infoRefs || {};
        if (refs.takeoffActual) refs.takeoffActual.innerHTML = actualTakeOffTime || '—';
        if (refs.landingActual) refs.landingActual.innerHTML = actualLandingTime || '—';
    }
}

// =============== [4] ROSETTE GEOMETRY, DRAW LOOP & DRAWING HELPERS ==================

function draw() {
    if (!rows.length) {
        background(0, 0, 8);
        return;
    }
    drawRosette();
}

// This function computes the coordinates and attributes needed to draw the flight visualization,
// mapping each row of flight data to a point around a circular path (radius encodes alt).
function buildRosettePoints() {
    const altMin = range.altMin, altMax = range.altMax;
    const center = { x: width * 0.5, y: height * 0.5 };
    const maxRadius = (min(width, height) / 2) - UI.margin * 2;
    const varR = maxRadius * 0.6;
    const baseR = maxRadius - varR;

    let pts = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const t = timeFracForRow(row);
        const angle = HALF_PI + t * TWO_PI;
        const radius = baseR + map(row.alt, altMin, altMax, 0, varR, true); // map(value, inputMin, inputMax, outputMin, outputMax, [clamp])
        const x = center.x + cos(angle) * radius;
        const y = center.y + sin(angle) * radius;
        const idx = i;
        pts.push({
            x,
            y,
            alt: row.alt,
            spd: row.spd,
            hdg: row.hdg,
            lat: row.lat,
            lon: row.lon,
            utc: row.utc,
            timestampMs: row.timestampMs,
            idx,
            angle,
            radius
        });
    }
    pts.push(pts[0], pts[1]);
    return { pts, center, baseR, varR };
}

// Linear interpolation between two RGB colors
function lerpRGB(c0, c1, t) { // c0: start color [R, G, B], c1: end color [R, G, B], t: interpolation factor
    // Math.round(...) to ensure integer RGB values
    const r = Math.round(c0[0] + (c1[0] - c0[0]) * t); // (c1[0] - c0[0]) * t = how far to move towards c1[0]
    const g = Math.round(c0[1] + (c1[1] - c0[1]) * t);
    const b = Math.round(c0[2] + (c1[2] - c0[2]) * t);
    return [r, g, b]; // return the interpolated color as an array [R, G, B]
}

// Get color for a specific speed value and add smooth blending between bands
function speedColor(spd) {
    const SMOOTH_KT = 15; // Width of the smoothing zone (in knots) around band boundaries

    // Iterate through each defined speed band to find where the current speed falls
    for (let i = 0; i < SPEED_BANDS.length; i++) {
        const band = SPEED_BANDS[i];
        if (spd >= band.min && spd < band.max) {
            // Default to this band's base color
            let gradientColor = band.color;

            // If near the lower edge of this band, blend with the previous band
            if (i > 0) {
                const distFromMin = spd - band.min; // How far into this band the speed is
                if (distFromMin < SMOOTH_KT) {
                    const prevColor = SPEED_BANDS[i - 1].color;           // Color of the previous band
                    const avgColor = lerpRGB(prevColor, band.color, 0.5); // Midpoint between prev and current
                    const t = constrain(distFromMin / SMOOTH_KT, 0, 1);   // Normalized blend factor
                    gradientColor = lerpRGB(avgColor, band.color, t);     // Blend toward current band from midpoint
                }
            }

            // If near the upper edge of this band, blend with the next band
            if (i < SPEED_BANDS.length - 1 && Number.isFinite(band.max)) {
                const distToMax = band.max - spd; // Distance to upper bound
                if (distToMax < SMOOTH_KT) {
                    const nextColor = SPEED_BANDS[i + 1].color;             // Color of the next band
                    const avgColor = lerpRGB(band.color, nextColor, 0.5);   // Midpoint between current and next
                    const t = constrain(1 - (distToMax / SMOOTH_KT), 0, 1); // Normalized blend factor
                    gradientColor = lerpRGB(gradientColor, avgColor, t);    // Blend current toward midpoint
                }
            }

            // Return the final blended color with fixed alpha
            return { r: gradientColor[0], g: gradientColor[1], b: gradientColor[2], a: 100 };
        }
    }

    // If no band matched (extremely high speed), fall back to the last band color
    const last = SPEED_BANDS[SPEED_BANDS.length - 1].color;
    return { r: last[0], g: last[1], b: last[2], a: 92 };
}

// Helper for fixed stroke thickness based on fixed speed bands
function speedStrokeWeight(spd) {
    const v = Math.max(GS_BREAKS[0], Math.min(Number.isFinite(spd) ? spd : 0, SW_MAX_AT));
    const t = (v - GS_BREAKS[0]) / (SW_MAX_AT - GS_BREAKS[0]);
    return SW_MIN + (SW_MAX - SW_MIN) * t;
}

function drawRosette() {
    if (!rows.length) return;

    const { pts, center, baseR, varR } = buildRosettePoints();

    background(0, 0, 8);

    // Rings + labels
    drawAltitudeRings(center, baseR, varR);

    // Draw rosette on the offscreen buffer for crisp strokes
    trail.clear();
    trail.colorMode(RGB, 255, 255, 255, 100);

    for (let i = 0; i < pts.length - 2; i++) {
        const a = pts[i], b = pts[i + 1];
        if (i === rows.length - 1) continue;
        // Interpolate color and stroke weight per sub-segment
        const segs = 30;
        let px = a.x, py = a.y;
        for (let s = 1; s < segs; s++) {
            const t = s / segs;

            // Interpolate geometry
            const angleInterp = lerp(a.angle, b.angle, t);
            const radiusInterp = lerp(a.radius, b.radius, t);
            const x1 = cos(angleInterp) * radiusInterp + center.x;
            const y1 = sin(angleInterp) * radiusInterp + center.y;

            // Interpolate speed
            const spdInterp = lerp(a.spd, b.spd, t);
            const col = speedColor(spdInterp);
            const sw  = speedStrokeWeight(spdInterp);
            trail.stroke(col.r, col.g, col.b, col.a);
            trail.strokeWeight(sw);

            // Draw mini-segment
            trail.line(px, py, x1, y1);
            px = x1; py = y1;
        }
    }
    image(trail, 0, 0);

    drawStartEndMarker(center, baseR, varR);

    if (UI.arcLabel && UI.arcLabel.length) {
        const rLabel = baseR + varR + 14;
        drawTextAlongCircle(center, rLabel, UI.arcLabel, HALF_PI, false, 1, UI.arcLabelAlign);
    }

    // --- Interaction ---
    if (cursorFollowMouse) {
        selectedIdx = getIndexFromMouse(center, pts.length - 2);
    }
    const hdgNow = (rows[selectedIdx] && Number.isFinite(rows[selectedIdx].hdg)) ? rows[selectedIdx].hdg : null;
    drawHeadingViz(center, baseR, hdgNow);
    drawIndicator(pts, selectedIdx);
    updateInfoCard(pts[selectedIdx]);
    minimap.refresh();
    speedChart.refresh();
}

function drawAltitudeRings(center, baseR, varR) {
    const altMax = range.altMax;
    const step = UI.ringStep;
    const maxAlt = niceCeilToStep(altMax, step);
    const minAlt = 0;

    push();
    textSize(8);
    for (let alt = minAlt; alt <= maxAlt; alt += step) {
        const rr = baseR + map(alt, 0, altMax, 0, varR, true);
        const fl = Math.round(alt / 100);
        const kft = Math.round(alt / 1000);
        const relevant = trackDir
        ? (trackDir === 'E' ? (kft % 2 === 1) : (kft % 2 === 0))
        : true;

        noFill();
        stroke(0, 0, 100, relevant ? UI.ringAlpha : UI.nonRelevantRingAlpha);
        strokeWeight(relevant ? 2 : 1);
        circle(center.x, center.y, rr * 2);

        if (relevant) {
            noStroke();
            fill(0, 0, 100, UI.labelAlpha);
            textAlign(CENTER, BOTTOM);
            const flStr = `FL${nf(fl, 3)}`;
            text(flStr, center.x, center.y - rr - 2);
            stroke(0, 0, 100, UI.ringAlpha);
        }
    }
    pop();
}

function drawStartEndMarker(center, baseR, varR) {
    const x = center.x;
    const y0 = center.y + baseR;
    const y1 = center.y + baseR + varR;
    push();
    stroke(0, 80, 90, 40);
    strokeWeight(2);
    line(x, y0, x, y1);
    pop();
}

function drawTextAlongCircle(center, radius, label, angleCenter, outward = true, letterSpacing = 1, align = 'center') {
    if (!label || !label.length) return;
    push();
    noStroke();
    fill(0, 0, 100, 85);
    textAlign(CENTER, CENTER);
    textSize(12);

    let total = 0;
    let widths = [];
    for (let i = 0; i < label.length; i++) {
        const w = textWidth(label[i]);
        widths.push(w);
        total += w + (i ? letterSpacing : 0);
    }
    const theta = total / radius;

    if (outward) {
        let a;
        if (align === 'center') a = angleCenter - theta / 2;
        else if (align === 'end') a = angleCenter - theta;
        else a = angleCenter;
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
        let a;
        if (align === 'center') a = angleCenter + theta / 2;
        else if (align === 'end') a = angleCenter + theta;
        else a = angleCenter;
        for (let i = 0; i < label.length; i++) {
            const ch = label[i];
            const w = widths[i];
            a -= (w / 2) / radius;
            const x = center.x + Math.cos(a) * radius;
            const y = center.y + Math.sin(a) * radius;
            push();
            translate(x, y);
            rotate(a - HALF_PI);
            text(ch, 0, 0);
            pop();
            a -= (w / 2 + letterSpacing) / radius;
        }
    }
    pop();
}

// ======= Interaction + math helpers (kept in section [4]) =======
function getIndexFromMouse(center, count) {
    const dx = mouseX - center.x; // h offset between mouse and center of rosette
    const dy = mouseY - center.y; // v offset between mouse and center of rosette
    let ang = Math.atan2(dy, dx); // angle in radians
    let t = (ang - HALF_PI) % TWO_PI; // rotate so 0 = top (12 o'clock), instead of 3 o'clock
    if (t < 0) t += TWO_PI; // ensure t is in [0, 2π]
    t /= TWO_PI; // normalize angle (progress) to [0, 1]. Fraction of the rosette

    const targetimestampMs = startTimestampMs + t * (endTimestampMs - startTimestampMs);
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < rows.length; i++) {
        const d = Math.abs(rows[i].timestampMs - targetimestampMs);
        if (d < bestDiff) { bestDiff = d; bestIdx = i; }
    }
    if (bestDiff !== Infinity) return constrain(bestIdx, 0, count - 1);

    const idx = Math.round(t * (count - 1));
    return constrain(idx, 0, count - 1);
}

function drawIndicator(pts, i) {
    const a = pts[i];
    const b = pts[(i + 1) % (pts.length - 2)];
    const m = pts[(i - 1 + (pts.length - 2)) % (pts.length - 2)];

    const tx = b.x - m.x;
    const ty = b.y - m.y;
    const ang = Math.atan2(ty, tx);

    const degAdj = ang * 180 / Math.PI + CURSOR_ROT_DEG;
    const cx = width * 0.5, cy = height * 0.5;
    const rx = a.x - cx, ry = a.y - cy;
    const rlen = Math.hypot(rx, ry) || 1;
    const ox = -(rx / rlen) * CURSOR_INWARD_PX;
    const oy = -(ry / rlen) * CURSOR_INWARD_PX;

    dom.cursorPlane.style.transform = `translate(${a.x + ox}px, ${a.y + oy}px) translate(-50%, -50%) rotate(${degAdj}deg)`;
}

function drawHeadingViz(center, baseR, headingDeg) {
    const ringR = baseR * 0.40;

    push();
    translate(center.x, center.y);

    noFill();
    stroke(0, 0, 100, 12);
    strokeWeight(1);
    circle(0, 0, ringR * 2);

    for (let a = 0; a < 360; a += 30) {
        const isCardinal = (a % 90) === 0;
        const outer = ringR;
        const inner = ringR - (isCardinal ? 14 : 8);
        const ang = radians(a - 90);
        const x0 = cos(ang) * inner;
        const y0 = sin(ang) * inner;
        const x1 = cos(ang) * outer;
        const y1 = sin(ang) * outer;
        stroke(0, 0, 100, isCardinal ? 70 : 40); 
        strokeWeight(isCardinal ? 2 : 1);
        line(x0, y0, x1, y1);

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

    if (Number.isFinite(headingDeg)) {
        const deg = headingDeg - 90;
        dom.headingPlane.style.transform =
        `translate(${center.x}px, ${center.y}px) translate(-50%, -50%) rotate(${deg}deg)`;
    } else {
        dom.headingPlane.style.transform = 'translate(-10000px,-10000px)';
    }

    pop();
}

function updateInfoCard(p) {
    const tStr = (Number.isFinite(p.timestampMs)) ? formatUTC(p.timestampMs) : '—';
    
    const takeMs = Number.isFinite(actualTakeOffMs) ? actualTakeOffMs : startTimestampMs;
    const landMs = Number.isFinite(actualLandingMs) ? actualLandingMs : endTimestampMs;

    const since = (Number.isFinite(p.timestampMs) && Number.isFinite(takeMs) && p.timestampMs >= takeMs)
        ? formatHMS(p.timestampMs - takeMs)
        : '00:00:00';

    const until = (Number.isFinite(p.timestampMs) && Number.isFinite(landMs) && landMs >= p.timestampMs)
        ? formatHMS(landMs - p.timestampMs)
        : '00:00:00';

    const fpa = estimateFlightPathAngleDeg(p.idx);
    const fpaStr = (fpa === null) 
        ? '—' 
        : fpa === 0 
        ? '0° Leveled' 
        : `${nf(fpa, 1, 1)}° ${fpa > 0 ? '↑ Climb' : '↓ Descent'}`;
    const hdgStr = Number.isFinite(p.hdg) ? `${Math.round(p.hdg)}°` : '—';
    const spdStr = Number.isFinite(p.spd) ? `${Math.round(p.spd)} kt` : '—';
    const altStr = Number.isFinite(p.alt) ? `${Math.round(p.alt).toLocaleString('fr-FR')} ft` : '—';
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
    const prev = rows[Math.max(0, i - 1)];
    const next = rows[Math.min(rows.length - 1, i + 1)];
    if (!prev || !next) return null;
    if (!Number.isFinite(prev.timestampMs) || !Number.isFinite(next.timestampMs)) return null;
    const dt = (next.timestampMs - prev.timestampMs) / 1000;
    if (dt <= 0) return null;
    const dAlt = next.alt - prev.alt;
    const vsp = dAlt / dt;

    const gsFps = Number.isFinite(rows[i].spd) ? rows[i].spd * KNOT_TO_FPS : null;
    if (!Number.isFinite(gsFps) || gsFps <= 0) return null;

    const angRad = Math.atan(vsp / gsFps);
    return degrees(angRad);
}

// ============================== [5] UI COMPONENTS ===================================
//                             (Minimap & Speed Chart)

// MINIMAP
let minimap = null;

function createMinimap() {
    const sketch = (p) => {
        let pad = 12;
        let projected = []; // [{x,y}]
        let bounds = null; // {minLat, maxLat, minLon, maxLon}
        let s = 1, offX = 0, offY = 0;

        p.setup = () => {
            const host = dom.flightPathHost;
            const w = host.clientWidth;
            const h = host.clientHeight;
            p.createCanvas(w, h);
            p.pixelDensity(2);
            p.noLoop(); // redraw manually on demand
            p.clear();
            rebuild();
            observeResize(host);
        };

        function observeResize(host) {
            const ro = new ResizeObserver(() => {
                p.resizeCanvas(host.clientWidth, host.clientHeight);
                rebuild();
                p.redraw();
            });
            ro.observe(host);
        }

        function computeFit() {
            const track = window.skyTrailState.track;
            if (!track.length) {
                bounds = null;
                return;
            }
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
            // Convert geographic coordinates to canvas coordinates
            // X is derived from longitude, scaled by zoom factor `s` and shifted by offset `offX`
            const x = (pt.lon - bounds.minLon) * s + offX;

            // Y is derived from latitude, also scaled and offset
            // Invert the vertical axis (p5.js origin is top-left, but we want north-up)
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
            if (projected.length < 2) return; // Only draw if we have at least two points
            p.noFill(); // Disable fill color 
            p.stroke(255); // Set stroke color to solid white (RGB 255)
            p.strokeWeight(2); 
            p.beginShape(); // Begin drawing a continuous shape made of lines between vertices

            // Loop through all projected points and define vertices
            for (const pt of projected) { 
                p.vertex(pt.x, pt.y); // Add each point as a vertex of the shape
            }

            // Finalize the shape
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
            p.circle(last.x, last.y, 6);
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
        let padding = 16;                // internal padding
        let projectedPoints = [];        // projected points [{x,y,timestampMs,spd}]
        let scaleX = 1, offsetX = 0;     // mapping X (time)
        let scaleY = 1, offsetY = 0;     // mapping Y (speed)

        p.setup = () => {
            const host = dom.flightSpeedHost;
            const w = host?.clientWidth || 300;
            const h = host?.clientHeight || 120;
            p.createCanvas(w, h);
            p.pixelDensity(2);
            p.noLoop(); // manual redraw
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
            if (!rows.length || !Number.isFinite(startTimestampMs) || !Number.isFinite(endTimestampMs) || endTimestampMs <= startTimestampMs) {
                projectedPoints.length = 0; return;
            }
            const innerW = Math.max(1, p.width  - padding*2);
            const innerH = Math.max(1, p.height - padding*2);

            const timeSpanMs = endTimestampMs - startTimestampMs; // total ms
            scaleX = innerW / timeSpanMs;           // px per ms
            offsetX = padding;                 // left padding

            // vertical scale from global speed range
            const spanY = Math.max(1e-6, range.spdMax - range.spdMin);
            scaleY = innerH / spanY;
            offsetY = padding; // vertical flip is in project()
        }

        function project(row) {
            const x = (row.timestampMs - startTimestampMs) * scaleX + offsetX;
            // y grows downward: spdMin → bottom, spdMax → top
            const yVal = (row.spd - range.spdMin) * scaleY; // 0..innerH
            const y = p.height - (yVal + offsetY);
            return { x, y };
        }

        function rebuild() {
            projectedPoints.length = 0;
            computeFit();
            if (!rows.length || !Number.isFinite(startTimestampMs) || !Number.isFinite(endTimestampMs) || endTimestampMs <= startTimestampMs) return;

            for (const r of rows) {
                if (Number.isFinite(r.timestampMs) && Number.isFinite(r.spd)) {
                    const pr = project(r);
                    projectedPoints.push({ x: pr.x, y: pr.y, timestampMs: r.timestampMs, spd: r.spd });
                }
            }
            projectedPoints.sort((a,b) => a.timestampMs - b.timestampMs);
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
            if (projectedPoints.length < 2) return;

            const yForSpeed = (v) => p.height - (((v - range.spdMin) * scaleY) + offsetY);
            const baselineY = yForSpeed(range.spdMin);

            p.noStroke();
            p.fill(255, 255, 255, 51);

            p.beginShape();
            p.vertex(projectedPoints[0].x, baselineY);
            for (const pt of projectedPoints) {
                p.vertex(pt.x, pt.y);
            }
            p.vertex(projectedPoints[projectedPoints.length - 1].x, baselineY);
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
            if (dom.maxSpeed && Number.isFinite(range.spdMax)) {
                dom.maxSpeed.textContent = Math.round(range.spdMax) + ' kt';
            }

            // 2) Grid lines: baseline at 0 kt and every 100 kt up to floor(spdMax/100)*100
            const yForSpeed = (v) => {
                const yVal = (v - range.spdMin) * scaleY;
                return p.height - (yVal + offsetY);
            };

            if (Number.isFinite(range.spdMin) && Number.isFinite(range.spdMax)) {
                const y0raw = yForSpeed(0);
                const y0 = Math.max(1, Math.min(p.height - 1, Math.round(y0raw) + 0.5));
                p.stroke(255, 120);
                p.strokeWeight(1);
                p.line(1, y0, p.width - 1, y0);
            }

            if (Number.isFinite(range.spdMax)) {
                const maxHundred = Math.floor(range.spdMax / 100) * 100; // e.g., 340 → 300
                for (let v = 100; v <= maxHundred; v += 100) {
                    const y = yForSpeed(v);
                    if (y >= 0 && y <= p.height) {
                        p.stroke(255, 60);
                        p.strokeWeight(1);
                        p.line(1, Math.round(y) + 0.5, p.width - 1, Math.round(y) + 0.5);
                    }
                }
            }
        }

        function drawLine() {
            if (projectedPoints.length < 2) return;
            p.noFill();
            p.stroke(255, 200);
            p.strokeWeight(2);
            p.beginShape();
            for (const pt of projectedPoints) p.vertex(pt.x, pt.y);
            p.endShape();
        }

        function drawCursor() {
            const i = window.skyTrailState.cursorIndex;
            if (!Number.isFinite(i) || !rows[i]) return; // Guard against undefined access
            const pr = project(rows[i]);

            p.stroke(255, 120);
            p.strokeWeight(1);
            p.line(pr.x, 0, pr.x, p.height);

            if (Number.isFinite(rows[i].spd)) {
                p.noStroke();
                p.fill(255, 255, 0, 230);
                p.circle(pr.x, pr.y, 5);

                p.fill(255);
                p.textSize(10);
                p.textAlign(p.LEFT, p.BOTTOM);
                const lbl = Math.round(rows[i].spd) + ' kt';
                const tx = Math.min(pr.x + 6, p.width - 30);
                const ty = Math.max(12, pr.y - 6);
                p.text(lbl, tx, ty);
            }
        }

        p.rebuild = () => { rebuild(); p.redraw(); };
        p.refresh = () => { p.redraw(); };
    };

    speedChart = new p5(sketch, 'flight-speed-canvas');
}

// =============================== [6] MISC UTILITIES =================================

function keyPressed() {
    if (key === 'a' || key === 'A') {
        saveCanvas('altitude_rosette', 'png');
    }
    if (key === ' ') {
        cursorFollowMouse = !cursorFollowMouse;
        // Replace toggling .show with updating icon visibility and text
        if (cursorFollowMouse) {
            // Cursor just got enabled
            dom.cursorOnIcon.style.display = 'block';
            dom.cursorOffIcon.style.display = 'none';
            dom.cursorStatusTitle.textContent = 'Cursor Enabled';
            dom.cursorStatusSubtitle.innerHTML = 'Press <kbd>Space</kbd> to pause';
            dom.canvasContainer.classList.remove('cursor-off');
        } else {
            // Cursor just got paused
            dom.cursorOnIcon.style.display = 'none';
            dom.cursorOffIcon.style.display = 'block';
            dom.cursorStatusTitle.textContent = 'Cursor Paused';
            dom.cursorStatusSubtitle.innerHTML = 'Press <kbd>Space</kbd> to enable';
            dom.canvasContainer.classList.add('cursor-off');
        }
        return false; // prevent page scroll
    }

    // Arrow keys: step selection index by ±1 (left/right) or ±10 (up/down) (only if follow-mouse is off)
    if (keyCode === LEFT_ARROW || keyCode === RIGHT_ARROW || keyCode === UP_ARROW || keyCode === DOWN_ARROW) {
        if (!cursorFollowMouse) {
            let delta = 0;
            if (keyCode === RIGHT_ARROW) delta = 1;
            else if (keyCode === LEFT_ARROW) delta = -1;
            else if (keyCode === UP_ARROW) delta = 10;
            else if (keyCode === DOWN_ARROW) delta = -10;

            // wrap around
            let next = (selectedIdx + delta) % rows.length;
            if (next < 0) next += rows.length; // ensure positive modulo for negatives
            selectedIdx = next;
        }
        return false; // prevent page scroll
    }

    // Key I/O: I goes to data start, O goes to data end
    if (key === 'i' || key === 'I') {
        selectedIdx = 0;
    }
    if (key === 'o' || key === 'O') {
        selectedIdx = rows.length - 1;
    }
}

function parseUTCtoMs(s) {
    if (!s) return NaN;
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
    if (!Number.isFinite(lat1) || !Number.isFinite(lon1) || 
        !Number.isFinite(lat2) || !Number.isFinite(lon2)) {
        trackDir = null;
        return trackDir;
    }

    let dlon = ((lon2 - lon1 + 540) % 360) - 180;

    if (Math.abs(dlon) < 1e-6) {
        if (Math.abs(lat2 - lat1) < 1e-6) {
            trackDir = null;
            return trackDir;
        }
        trackDir = (lat2 > lat1) ? 'E' : 'W';
        return trackDir;
    }

    trackDir = dlon > 0 ? 'E' : 'W';
    return trackDir;
}

// Rounds a value up to the nearest multiple of the given step.
function niceCeilToStep(v, step) {
      return Math.ceil(v / step) * step;
}

function timeFracForRow(row) {
    const ms = row.timestampMs;
    return (ms - startTimestampMs) / (endTimestampMs - startTimestampMs);
}