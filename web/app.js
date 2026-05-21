/* Ogopogo Triathlon — course map SPA
 * Static, single-file front-end. Reads data/courses.json, renders a Leaflet
 * map + Chart.js elevation profile per course, syncs hover between them, and
 * supports drag-vertex editing with localStorage persistence + GPX export.
 */

const COLORS = {
  green: "#1F5C2E",
  red: "#C00000",
  redBright: "#FF1F1F",
  cream: "#F0E0C0",
  ink: "#0A0A0A",
};

// ---------- PDF quality presets ------------------------------------------
const QUALITY = {
  standard: { scale: 2, format: "jpeg", jpegQuality: 0.92 }, // ~5 MB / course
  high:     { scale: 3, format: "jpeg", jpegQuality: 0.96 }, // ~10 MB / course
  print:    { scale: 3, format: "png" },                     // lossless, ~25 MB
};

// ---------- Tile providers -----------------------------------------------
const STYLES = {
  voyager: {
    label: "Light",
    base: () => L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png",
      { maxZoom: 20, subdomains: "abcd",
        attribution: "© <a href='https://openstreetmap.org/copyright'>OSM</a> · © <a href='https://carto.com/attributions'>CARTO</a>" }
    ),
    overlay: null,
    routeHalo: false,
  },
  positron: {
    label: "Minimal",
    base: () => L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png",
      { maxZoom: 20, subdomains: "abcd",
        attribution: "© OSM · © CARTO" }
    ),
    overlay: null,
    routeHalo: false,
  },
  satellite: {
    label: "Satellite",
    base: () => L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics" }
    ),
    overlay: () => L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}@2x.png",
      { maxZoom: 20, subdomains: "abcd", attribution: "" }
    ),
    routeHalo: true,
  },
  topo: {
    label: "Topographic",
    base: () => L.tileLayer(
      "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
      { maxZoom: 17, subdomains: "abc",
        attribution: "Map data © OSM · SRTM · © <a href='https://opentopomap.org'>OpenTopoMap</a> (CC-BY-SA)" }
    ),
    overlay: null,
    routeHalo: true,
  },
  cyclosm: {
    label: "Cycling",
    base: () => L.tileLayer(
      "https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png",
      { maxZoom: 20, subdomains: "abc",
        attribution: "© <a href='https://www.cyclosm.org'>CyclOSM</a> · © OSM contributors" }
    ),
    overlay: null,
    routeHalo: false,
  },
  osm: {
    label: "OSM Standard",
    base: () => L.tileLayer(
      "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      { maxZoom: 19,
        attribution: "© <a href='https://openstreetmap.org/copyright'>OpenStreetMap</a> contributors" }
    ),
    overlay: null,
    routeHalo: false,
  },
  esritopo: {
    label: "Esri Topographic",
    base: () => L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Tiles © Esri · Source: Esri, HERE, Garmin, USGS, NGA, EPA" }
    ),
    overlay: null,
    routeHalo: false,
  },
  shaded: {
    label: "Shaded Relief",
    base: () => L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 13, attribution: "Tiles © Esri · Source: Esri" }
    ),
    overlay: () => L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}@2x.png",
      { maxZoom: 20, subdomains: "abcd", attribution: "" }
    ),
    routeHalo: false,
  },
  dark: {
    label: "Dark",
    base: () => L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
      { maxZoom: 20, subdomains: "abcd",
        attribution: "© OSM · © CARTO" }
    ),
    overlay: null,
    routeHalo: true,
  },
};

// ---------- App state -----------------------------------------------------
const state = {
  data: null,           // full courses payload
  courseKey: null,      // currently active course key
  course: null,         // active course object (with possible edits applied)
  map: null,
  baseLayer: null,
  overlayLayer: null,
  routeLayer: null,
  routeHalo: null,
  markerLayer: null,    // L.LayerGroup for km markers + endpoints
  hoverMarker: null,
  styleKey: localStorage.getItem("ogo:style") || "voyager",
  qualityKey: localStorage.getItem("ogo:quality") || "standard",
  editing: false,
  editedTracks: {},     // courseKey -> [{lat, lon}]
};

// ---------- Bootstrap -----------------------------------------------------
async function main() {
  state.data = await (await fetch("data/courses.json")).json();
  loadEditsFromStorage();
  buildSidebar();
  initMap();
  bindControls();
  // Initial course from hash or sensible default
  const key = (location.hash.replace("#", "")) ||
              firstNonSwimKey() ||
              state.data.order[0];
  selectCourse(key);
  document.getElementById("style-select").value = state.styleKey;
}

function firstNonSwimKey() {
  return state.data.order.find(k => !state.data.courses[k].swim);
}

// ---------- Sidebar -------------------------------------------------------
function buildSidebar() {
  const nav = document.getElementById("course-nav");
  const groups = {};
  for (const key of state.data.order) {
    const c = state.data.courses[key];
    (groups[c.race_name] ||= []).push(c);
  }
  let html = "";
  for (const [race, list] of Object.entries(groups)) {
    html += `<h2>${race}</h2>`;
    for (const c of list) {
      const meta = c.swim ? c.distance_label.split("/")[0].trim()
                          : `${c.distance_km.toFixed(1)} km`;
      html += `
        <a href="#${c.key}" data-key="${c.key}">
          <span class="badge ${c.discipline}">${c.discipline.toUpperCase()}</span>
          <span>${c.title.replace(" COURSE", "")}</span>
          <span class="meta">${meta}</span>
        </a>`;
    }
  }
  nav.innerHTML = html;
  nav.addEventListener("click", e => {
    const a = e.target.closest("a[data-key]");
    if (!a) return;
    e.preventDefault();
    location.hash = "#" + a.dataset.key;
  });
  window.addEventListener("hashchange", () => {
    const k = location.hash.replace("#", "");
    if (k && state.data.courses[k]) selectCourse(k);
  });
}

// ---------- Map initialisation -------------------------------------------
function initMap() {
  state.map = L.map("map", {
    zoomControl: true,
    preferCanvas: false,
    // Seed the SVG renderer so vector layers can be added before the map has
    // panned/zoomed (otherwise the first polyline crashes in _clipPoints).
    renderer: L.svg({ padding: 0.5 }),
    // Fractional zoom: tiles still load at integer levels (Leaflet scales the
    // bitmap) but the camera can frame routes in 0.25-step increments. Lets
    // users tighten the view so the whole route fills the PDF page without
    // huge empty margins.
    zoomSnap: 0.25,
    zoomDelta: 0.25,
    wheelPxPerZoomLevel: 100,
  });
  // Set a default view so the renderer has valid bounds even before
  // selectCourse() fits to the route.
  state.map.setView([49.45, -119.58], 12);
  applyStyle();
  state.markerLayer = L.layerGroup().addTo(state.map);
  // Hover marker (created lazily — placed on demand from elevation hover)
  const hover = L.divIcon({ className: "hover-marker", iconSize: [14, 14] });
  state.hoverMarker = L.marker([0, 0], { icon: hover, interactive: false, opacity: 0 });
  state.hoverMarker.addTo(state.map);
}

function applyStyle() {
  const s = STYLES[state.styleKey] || STYLES.voyager;
  if (state.baseLayer) state.map.removeLayer(state.baseLayer);
  if (state.overlayLayer) { state.map.removeLayer(state.overlayLayer); state.overlayLayer = null; }
  state.baseLayer = s.base().addTo(state.map);
  if (s.overlay) state.overlayLayer = s.overlay().addTo(state.map);
  // Refresh route halo if needed
  if (state.routeLayer) drawRoute(true);
}

// ---------- Course selection ---------------------------------------------
function selectCourse(key) {
  state.courseKey = key;
  const base = state.data.courses[key];
  // Apply persisted edits if present
  const edited = state.editedTracks[key];
  state.course = edited ? { ...base, track: edited, edited: true } : base;
  // Recompute derived stats for edited courses
  if (edited) recomputeStats(state.course);
  // UI
  document.querySelectorAll("#course-nav a").forEach(a =>
    a.classList.toggle("active", a.dataset.key === key));
  document.getElementById("brand-title").textContent =
    `${base.race_name.toUpperCase()}  ·  ${base.title.replace(" COURSE", "").toUpperCase()}`;
  renderStats();
  drawRoute();
  drawElevation();
  updateActions();
}

function recomputeStats(c) {
  if (!c.track || c.track.length < 2) return;
  let d = 0;
  for (let i = 1; i < c.track.length; i++) {
    d += haversine(c.track[i-1], c.track[i]);
    c.track[i].d = d;
  }
  c.track[0].d = 0;
  c.distance_km = +(d.toFixed(2));
  let gain = 0;
  for (let i = 1; i < c.track.length; i++) {
    const diff = c.track[i].ele - c.track[i-1].ele;
    if (diff > 0) gain += diff;
  }
  c.elevation_gain_m = Math.round(gain);
  c.start_elev_m = Math.round(c.track[0].ele);
  c.finish_elev_m = Math.round(c.track[c.track.length-1].ele);
}

function haversine(a, b) {
  const R = 6371;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------- Stats bar -----------------------------------------------------
function renderStats() {
  const c = state.course;
  const el = document.getElementById("stats");
  if (c.swim) {
    el.innerHTML = `
      <div class="title">${c.race_name}<small>${c.title}</small></div>
      <div class="stat">Distance<strong>${c.distance_label}</strong></div>
      <div class="stat">Location<strong>Skaha Beach, Penticton</strong></div>
      <div class="pill">Hand-drawn course</div>`;
    return;
  }
  const editedFlag = c.edited ? `<div class="pill">EDITED</div>` : "";
  el.innerHTML = `
    <div class="title">${c.race_name}<small>${c.title}</small></div>
    <div class="stat">Distance<strong>${c.distance_km.toFixed(1)} km</strong></div>
    <div class="stat">Elevation gain<strong>${c.elevation_gain_m.toLocaleString()} m</strong></div>
    <div class="stat">Start elev<strong>${c.start_elev_m} m</strong></div>
    <div class="stat">Finish elev<strong>${c.finish_elev_m} m</strong></div>
    ${editedFlag}`;
}

// ---------- Route layer ---------------------------------------------------
function drawRoute(keepView = false) {
  const c = state.course;
  state.markerLayer.clearLayers();
  if (state.routeLayer) { state.map.removeLayer(state.routeLayer); state.routeLayer = null; }
  if (state.routeHalo) { state.map.removeLayer(state.routeHalo); state.routeHalo = null; }
  state.hoverMarker.setOpacity(0);

  if (c.swim) {
    if (c.swim_track && c.swim_track.length >= 2) {
      const latlngs = c.swim_track.map(p => [p.lat, p.lon]);
      const styleDef = STYLES[state.styleKey];
      if (styleDef.routeHalo) {
        state.routeHalo = L.polyline(latlngs, {
          color: "#ffffff", weight: 7, opacity: 0.9, lineCap: "round",
        }).addTo(state.map);
      }
      state.routeLayer = L.polyline(latlngs, {
        color: styleDef.routeHalo ? COLORS.redBright : COLORS.red,
        weight: 4, opacity: 1, lineCap: "round",
      }).addTo(state.map);
      // Yellow turn-buoy markers at each corner (exclude closing point)
      for (let i = 0; i < c.swim_track.length - 1; i++) {
        const p = c.swim_track[i];
        L.circleMarker([p.lat, p.lon], {
          radius: 7, color: COLORS.red, weight: 2,
          fillColor: "#FFD400", fillOpacity: 1,
        }).bindTooltip(i === 0 ? "Swim Start / Exit" : "Turn buoy",
                       { direction: "top" })
          .addTo(state.markerLayer);
      }
      // Start glyph on shore-side corner
      L.marker([c.swim_track[0].lat, c.swim_track[0].lon], {
        icon: L.divIcon({ className: "endpoint-marker start", html: "S",
                         iconSize: [30, 30], iconAnchor: [15, 15] }),
      }).bindTooltip("Swim Start / Exit", { direction: "top" })
        .addTo(state.markerLayer);
      if (!keepView) state.map.fitBounds(state.routeLayer.getBounds(),
                                         { padding: [60, 60] });
    } else {
      const v = c.default_view;
      if (!keepView) state.map.setView([v.lat, v.lon], v.zoom);
    }
    return;
  }
  if (!c.track || c.track.length < 2) return;

  const latlngs = c.track.map(p => [p.lat, p.lon]);
  const styleDef = STYLES[state.styleKey];

  if (styleDef.routeHalo) {
    state.routeHalo = L.polyline(latlngs, {
      color: "#ffffff", weight: 7, opacity: 0.9, lineCap: "round",
    }).addTo(state.map);
  }
  state.routeLayer = L.polyline(latlngs, {
    color: styleDef.routeHalo ? COLORS.redBright : COLORS.red,
    weight: 4, opacity: 1, lineCap: "round",
  }).addTo(state.map);

  // KM markers
  const everyKm = c.distance_km < 25 ? 2 : (c.distance_km < 100 ? 5 : 10);
  for (let t = everyKm; t < c.distance_km; t += everyKm) {
    const i = nearestIndexByDistance(c.track, t);
    if (i < 0) continue;
    const p = c.track[i];
    L.marker([p.lat, p.lon], {
      icon: L.divIcon({
        className: "km-marker", html: Math.round(t),
        iconSize: [26, 26], iconAnchor: [13, 13],
      }),
      interactive: true,
    }).bindTooltip(`${Math.round(t)} km`, { direction: "top" })
      .addTo(state.markerLayer);
  }

  // Start / finish (combined if loop)
  const a = c.track[0], b = c.track[c.track.length - 1];
  const loop = haversine(a, b) * 1000 < 300;
  if (loop) {
    L.marker([a.lat, a.lon], {
      icon: L.divIcon({
        className: "endpoint-marker startfinish", html: "S F",
        iconSize: [52, 30], iconAnchor: [26, 15],
      }),
    }).bindTooltip("Start / Finish", { direction: "top" })
      .addTo(state.markerLayer);
  } else {
    L.marker([a.lat, a.lon], {
      icon: L.divIcon({ className: "endpoint-marker start", html: "S",
                       iconSize: [30, 30], iconAnchor: [15, 15] }),
    }).bindTooltip("START", { direction: "top" }).addTo(state.markerLayer);
    L.marker([b.lat, b.lon], {
      icon: L.divIcon({ className: "endpoint-marker finish", html: "F",
                       iconSize: [30, 30], iconAnchor: [15, 15] }),
    }).bindTooltip("FINISH", { direction: "top" }).addTo(state.markerLayer);
  }

  // Hover the polyline → also move the hover marker (reverse sync)
  state.routeLayer.on("mousemove", e => {
    const i = nearestIndexToLatLng(c.track, e.latlng);
    if (i >= 0) syncHover(i, /*fromMap=*/true);
  });
  state.routeLayer.on("mouseout", clearHover);

  if (!keepView) state.map.fitBounds(state.routeLayer.getBounds(), { padding: [40, 40] });

  // Edit mode wiring
  refreshEditMode();
}

function nearestIndexByDistance(track, dist) {
  let lo = 0, hi = track.length - 1;
  if (dist <= 0) return 0;
  if (dist >= track[hi].d) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (track[mid].d < dist) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function nearestIndexToLatLng(track, latlng) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < track.length; i++) {
    const dy = track[i].lat - latlng.lat;
    const dx = track[i].lon - latlng.lng;
    const d = dy*dy + dx*dx;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// ---------- Elevation chart ----------------------------------------------
let elevChart = null;

function drawElevation() {
  const c = state.course;
  const canvas = document.getElementById("elev-chart");
  const empty  = document.getElementById("elev-empty");
  if (c.swim || !c.track) {
    if (elevChart) { elevChart.destroy(); elevChart = null; }
    canvas.classList.add("hidden");
    empty.classList.remove("hidden");
    empty.textContent = c.swim
      ? "Swim course — no elevation profile."
      : "No elevation profile available.";
    return;
  }
  canvas.classList.remove("hidden");
  empty.classList.add("hidden");

  const labels = c.track.map(p => p.d);
  const data   = c.track.map(p => p.ele);

  if (elevChart) elevChart.destroy();
  elevChart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [{
        data,
        borderColor: COLORS.red,
        backgroundColor: "rgba(192, 0, 0, 0.18)",
        fill: true,
        pointRadius: 0,
        borderWidth: 1.8,
        tension: 0.1,
      }],
    },
    options: {
      animation: false,
      maintainAspectRatio: false,
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          backgroundColor: "rgba(15, 63, 31, 0.95)",
          titleColor: "#fff", bodyColor: "#fff",
          padding: 8, displayColors: false,
          callbacks: {
            title: items => `${items[0].label !== undefined ? Number(items[0].label).toFixed(1) : ""} km`,
            label: ctx => `${Math.round(ctx.parsed.y)} m`,
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          title: { display: true, text: "Distance (km)",
                   color: "#444", font: { size: 11, weight: "bold" } },
          grid: { color: "#eee" },
          ticks: { color: "#666", font: { size: 10 },
                   callback: v => Number(v).toFixed(0) },
        },
        y: {
          title: { display: true, text: "Elevation (m)",
                   color: "#444", font: { size: 11, weight: "bold" } },
          grid: { color: "#eee" },
          ticks: { color: "#666", font: { size: 10 } },
        },
      },
      onHover: (evt, items) => {
        if (!items || !items.length) return clearHover();
        const i = items[0].index;
        syncHover(i, /*fromMap=*/false);
      },
    },
  });

  // Clear hover when leaving the chart
  canvas.onmouseleave = clearHover;
}

function syncHover(i, fromMap) {
  const t = state.course.track[i];
  if (!t) return;
  state.hoverMarker.setLatLng([t.lat, t.lon]).setOpacity(1);
  if (!fromMap || !elevChart) return;
  // From map → drive the chart tooltip
  elevChart.setActiveElements([{ datasetIndex: 0, index: i }]);
  elevChart.tooltip.setActiveElements([{ datasetIndex: 0, index: i }],
    { x: 0, y: 0 });
  elevChart.update("none");
}
function clearHover() {
  state.hoverMarker.setOpacity(0);
  if (elevChart) {
    elevChart.setActiveElements([]);
    elevChart.tooltip.setActiveElements([], { x: 0, y: 0 });
    elevChart.update("none");
  }
}

// ---------- Controls ------------------------------------------------------
function bindControls() {
  document.getElementById("style-select").addEventListener("change", e => {
    state.styleKey = e.target.value;
    localStorage.setItem("ogo:style", state.styleKey);
    applyStyle();
  });
  const qs = document.getElementById("quality-select");
  qs.value = state.qualityKey;
  qs.addEventListener("change", e => {
    state.qualityKey = e.target.value;
    localStorage.setItem("ogo:quality", state.qualityKey);
  });
  document.getElementById("edit-toggle").addEventListener("click", toggleEdit);
  document.getElementById("reset-btn").addEventListener("click", resetEdits);
  document.getElementById("download-gpx").addEventListener("click", downloadGpx);
  document.getElementById("generate-pdf").addEventListener("click", generatePdf);
  document.getElementById("generate-all-pdfs").addEventListener("click", generateAllPdfs);
}

function updateActions() {
  const c = state.course;
  const editBtn = document.getElementById("edit-toggle");
  const resetBtn = document.getElementById("reset-btn");
  const dlGpx = document.getElementById("download-gpx");
  // Disable edit / GPX for swim courses
  editBtn.disabled = c.swim;
  dlGpx.style.pointerEvents = c.swim ? "none" : "";
  dlGpx.style.opacity = c.swim ? 0.4 : 1;
  resetBtn.disabled = !state.editedTracks[state.courseKey];
  editBtn.classList.toggle("active", state.editing);
}

// ---------- Edit mode -----------------------------------------------------
function toggleEdit() {
  if (state.course.swim) return;
  state.editing = !state.editing;
  refreshEditMode();
  updateActions();
  if (state.editing) {
    toast("Drag any point to move it. Click finish to save.");
  }
}

function refreshEditMode() {
  if (!state.routeLayer || !state.routeLayer.pm) return;
  if (state.editing) {
    state.routeLayer.pm.enable({
      allowSelfIntersection: true,
      preventMarkerRemoval: false,
      snappable: false,
    });
    state.routeLayer.on("pm:markerdragend pm:edit pm:vertexremoved", commitEdits);
  } else {
    try { state.routeLayer.pm.disable(); } catch (e) {}
  }
}

function commitEdits() {
  const ll = state.routeLayer.getLatLngs();
  const newTrack = ll.map((p, i) => {
    // Preserve existing elevation if possible; fall back to nearest original
    const src = state.course.track[Math.min(i, state.course.track.length - 1)];
    return { lat: +p.lat.toFixed(6), lon: +p.lng.toFixed(6),
             ele: src ? src.ele : 0, d: 0 };
  });
  state.editedTracks[state.courseKey] = newTrack;
  saveEditsToStorage();
  // Re-load course with edits applied
  selectCourse(state.courseKey);
}

function resetEdits() {
  if (!confirm("Reset this course to the original GPX?")) return;
  delete state.editedTracks[state.courseKey];
  saveEditsToStorage();
  selectCourse(state.courseKey);
  toast("Course reset.");
}

function saveEditsToStorage() {
  localStorage.setItem("ogo:edits", JSON.stringify(state.editedTracks));
}
function loadEditsFromStorage() {
  try {
    state.editedTracks = JSON.parse(localStorage.getItem("ogo:edits") || "{}");
  } catch { state.editedTracks = {}; }
}

// ---------- GPX export ----------------------------------------------------
function downloadGpx(e) {
  e?.preventDefault();
  const c = state.course;
  if (c.swim || !c.track) return;
  const now = new Date().toISOString();
  const name = `${c.race_name} — ${c.title}`;
  const pts = c.track.map(p => (
    `      <trkpt lat="${p.lat}" lon="${p.lon}"><ele>${p.ele}</ele></trkpt>`
  )).join("\n");
  const gpx =
`<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Ogopogo Map App" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${escapeXml(name)}${c.edited ? " (edited)" : ""}</name>
    <time>${now}</time>
  </metadata>
  <trk>
    <name>${escapeXml(name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>`;
  const blob = new Blob([gpx], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${c.key}${c.edited ? "_edited" : ""}.gpx`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g,
    ch => ({"<":"&lt;",">":"&gt;","&":"&amp;","'":"&apos;",'"':"&quot;"}[ch]));
}

// ---------- Toast ---------------------------------------------------------
let toastTimer = null;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---------- PDF generation (client-side, jsPDF + html2canvas) -------------
let LOGO_DATA_URL = null;
async function preloadLogo() {
  try {
    const r = await fetch("logo.png");
    const blob = await r.blob();
    LOGO_DATA_URL = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  } catch (e) { /* logo optional */ }
}

function addRouteCanvasOverlay(c) {
  // Build a <canvas> sized to the map div, draw the route using Leaflet's
  // projection, and append it inside the map div so html2canvas picks it up
  // as raster pixels instead of fighting Leaflet's SVG transforms.
  const pts = c.swim ? (c.swim_track || []) : (c.track || []);
  if (pts.length < 2) return null;
  const mapEl = document.getElementById("map");
  const w = mapEl.clientWidth, h = mapEl.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  const overlay = document.createElement("canvas");
  overlay.width = w * dpr;
  overlay.height = h * dpr;
  overlay.style.position = "absolute";
  overlay.style.left = "0";
  overlay.style.top = "0";
  overlay.style.width = w + "px";
  overlay.style.height = h + "px";
  overlay.style.pointerEvents = "none";
  // Sit at z=400 (Leaflet's overlay-pane level) so the marker-pane (z=600)
  // draws above the route line. Must be appended into .leaflet-map-pane below,
  // not #map, so the z-index shares a stacking context with the other panes.
  overlay.style.zIndex = "400";
  const ctx = overlay.getContext("2d");
  ctx.scale(dpr, dpr);
  const useHalo = !!STYLES[state.styleKey].routeHalo;
  const stroke = useHalo ? COLORS.redBright : COLORS.red;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const trace = () => {
    ctx.beginPath();
    pts.forEach((p, i) => {
      const cp = state.map.latLngToContainerPoint([p.lat, p.lon]);
      if (i === 0) ctx.moveTo(cp.x, cp.y); else ctx.lineTo(cp.x, cp.y);
    });
    ctx.stroke();
  };
  if (useHalo) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 7;
    trace();
  }
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 4;
  trace();
  // Swim buoys live in Leaflet's SVG overlay-pane (which we hide during
  // capture), so redraw them onto the canvas overlay.
  if (c.swim && pts.length > 1) {
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i];
      const cp = state.map.latLngToContainerPoint([p.lat, p.lon]);
      ctx.beginPath();
      ctx.arc(cp.x, cp.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = "#FFD400";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = COLORS.red;
      ctx.stroke();
    }
  }
  // Append into the Leaflet map-pane so our z-index stacks against the other
  // panes (tile/overlay/marker). The pane has a translate3d for panning; we
  // negate it via left/top so latLngToContainerPoint coords still land where
  // they should visually.
  const mapPane = mapEl.querySelector(".leaflet-map-pane");
  if (mapPane) {
    const off = L.DomUtil.getPosition(mapPane) || { x: 0, y: 0 };
    overlay.style.left = (-off.x) + "px";
    overlay.style.top = (-off.y) + "px";
    mapPane.appendChild(overlay);
  } else {
    mapEl.appendChild(overlay);
  }
  return overlay;
}

async function generatePdf() {
  const btn = document.getElementById("generate-pdf");
  btn.disabled = true;
  const oldLabel = btn.textContent;
  btn.textContent = "Generating…";
  toast("Generating PDF — this takes a few seconds…");
  try {
    const { doc, filename } = await buildPdfForCurrentCourse();
    doc.save(filename);
    try {
      window.__lastPdfBlob = doc.output("blob");
      window.__lastPdfName = filename;
    } catch {}
    toast("PDF downloaded.");
  } catch (err) {
    console.error(err);
    toast("PDF generation failed, see console.");
  } finally {
    btn.disabled = false;
    btn.textContent = oldLabel;
  }
}

async function generateAllPdfs() {
  if (typeof JSZip === "undefined") {
    toast("ZIP library not loaded.");
    return;
  }
  const btn = document.getElementById("generate-all-pdfs");
  btn.disabled = true;
  const oldLabel = btn.textContent;
  const keys = state.data.order.slice();
  const originalKey = state.courseKey;
  const zip = new JSZip();
  try {
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      btn.textContent = `Generating ${i + 1}/${keys.length}…`;
      toast(`Generating ${state.data.courses[key].title} (${i + 1}/${keys.length})…`);
      selectCourse(key);
      // Give Leaflet + tiles + Chart.js time to settle before capture
      await waitForMapIdle();
      const { doc, filename } = await buildPdfForCurrentCourse();
      zip.file(filename, doc.output("blob"));
    }
    btn.textContent = "Zipping…";
    const blob = await zip.generateAsync({ type: "blob" });
    const styleLabel = STYLES[state.styleKey].label.toLowerCase().replace(/\s+/g, "_");
    const zipName = `ogopogo_course_maps_${styleLabel}.zip`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = zipName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`Downloaded ${zipName}`);
  } catch (err) {
    console.error(err);
    toast("Bulk PDF generation failed, see console.");
  } finally {
    if (originalKey && originalKey !== state.courseKey) selectCourse(originalKey);
    btn.disabled = false;
    btn.textContent = oldLabel;
  }
}

function waitForMapIdle() {
  return new Promise(resolve => {
    state.map.invalidateSize();
    let pending = 0;
    let settled = false;
    const tileLayers = [];
    state.map.eachLayer(l => { if (l instanceof L.TileLayer) tileLayers.push(l); });
    const done = () => {
      if (settled) return;
      settled = true;
      // Extra buffer so labels/markers paint before html2canvas snapshots
      setTimeout(resolve, 350);
    };
    tileLayers.forEach(l => {
      if (l.isLoading && l.isLoading()) {
        pending++;
        l.once("load", () => { pending--; if (pending === 0) done(); });
      }
    });
    if (pending === 0) done();
    // Hard ceiling so a slow tile never deadlocks the loop
    setTimeout(done, 4000);
  });
}

async function buildPdfForCurrentCourse() {
  const c = state.course;
  state.map.invalidateSize();
  await new Promise(r => setTimeout(r, 400));
  const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "letter", orientation: "portrait" });
    const W = doc.internal.pageSize.getWidth();   // 215.9
    const H = doc.internal.pageSize.getHeight();  // 279.4

    // ----- Header band (deep green, red accent line) -----
    doc.setFillColor(15, 63, 31);
    doc.rect(0, 0, W, 20, "F");
    doc.setFillColor(192, 0, 0);
    doc.rect(0, 20, W, 1.2, "F");

    // Logo
    if (LOGO_DATA_URL) {
      try { doc.addImage(LOGO_DATA_URL, "PNG", 5, 2.5, 15, 15); } catch {}
    }

    // Title text — left
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.text(c.race_name.toUpperCase(), 24, 10);
    doc.setFontSize(7.5);
    doc.setTextColor(240, 224, 192);
    // Derive a short, letter-spaced subtitle from the course's location:
    //   "PENTICTON, BRITISH COLUMBIA, CANADA" -> "P E N T I C T O N ,   B C"
    //   "APEX, BRITISH COLUMBIA, CANADA"      -> "A P E X ,   B C"
    const city = (c.location || "").split(",")[0].trim().toUpperCase();
    const subtitle = city.split("").join(" ") + " ,   B C";
    doc.text(subtitle, 24, 15.5);

    // Title text — right
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(c.title.toUpperCase(), W - 5, 9, { align: "right" });
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.text(c.distance_label, W - 5, 13.5, { align: "right" });
    doc.setFontSize(8);
    doc.setTextColor(240, 224, 192);
    doc.text(c.location, W - 5, 17.5, { align: "right" });

    // ----- Map image -----
    const mapEl = document.getElementById("map");
    // html2canvas mishandles Leaflet's SVG overlay (ignores translate3d), so:
    //   1. Hide the SVG overlay pane during capture.
    //   2. Render the route into a <canvas> overlay on the map instead.
    const overlayPane = mapEl.querySelector(".leaflet-overlay-pane");
    const prevVisibility = overlayPane ? overlayPane.style.visibility : "";
    if (overlayPane) overlayPane.style.visibility = "hidden";
    // Hide UI chrome that should not appear in the printed PDF (zoom buttons,
    // attribution credit). Visibility (not display:none) preserves layout.
    const hideSel = [
      ".leaflet-control-zoom",
      ".leaflet-control-attribution",
    ];
    const hidden = [];
    for (const sel of hideSel) {
      mapEl.querySelectorAll(sel).forEach(el => {
        hidden.push([el, el.style.visibility]);
        el.style.visibility = "hidden";
      });
    }
    const routeOverlay = addRouteCanvasOverlay(c);
    const q = QUALITY[state.qualityKey] || QUALITY.standard;
    let mapCanvas;
    try {
      mapCanvas = await html2canvas(mapEl, {
        useCORS: true,
        allowTaint: false,
        scale: q.scale,
        logging: false,
        backgroundColor: "#ffffff",
      });
    } finally {
      if (routeOverlay) routeOverlay.remove();
      if (overlayPane) overlayPane.style.visibility = prevVisibility;
      hidden.forEach(([el, v]) => { el.style.visibility = v; });
    }
    const mapImg = q.format === "png"
      ? mapCanvas.toDataURL("image/png")
      : mapCanvas.toDataURL("image/jpeg", q.jpegQuality);
    const margin = 5;
    const mapTop = 26;
    const hasElevation = !c.swim && elevChart;
    const mapBoxH = hasElevation ? 180 : (H - mapTop - 24);
    // Compute fit dimensions preserving aspect
    const aspect = mapCanvas.width / mapCanvas.height;
    let mw = W - margin * 2;
    let mh = mw / aspect;
    if (mh > mapBoxH) { mh = mapBoxH; mw = mh * aspect; }
    const mx = (W - mw) / 2;
    doc.setDrawColor(220, 215, 200);
    doc.setLineWidth(0.4);
    doc.rect(mx, mapTop, mw, mh);
    doc.addImage(mapImg, q.format === "png" ? "PNG" : "JPEG", mx, mapTop, mw, mh);

    let y = mapTop + mh + 4;

    // ----- Stats line + elevation chart (non-swim courses) -----
    if (hasElevation) {
      doc.setTextColor(15, 63, 31);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      const stats =
        `DISTANCE: ${c.distance_km.toFixed(1)} km    ` +
        `ELEVATION GAIN: ${c.elevation_gain_m.toLocaleString()} m    ` +
        `START ELEV: ${c.start_elev_m} m    ` +
        `FINISH ELEV: ${c.finish_elev_m} m` +
        (c.edited ? "    [EDITED]" : "");
      doc.text(stats, margin, y);
      y += 2;
      // Elevation chart from Chart.js (already rendered to canvas)
      const elevImg = elevChart.toBase64Image("image/png", 1.0);
      const elevH = 45;
      const elevW = W - margin * 2;
      doc.addImage(elevImg, "PNG", margin, y, elevW, elevH);
      y += elevH;
    } else if (c.swim) {
      doc.setTextColor(15, 63, 31);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.text(`DISTANCE: ${c.distance_label}    LOCATION: Skaha Beach, Penticton`,
               margin, y);
      // (Subtext intentionally omitted per client feedback.)
    }

    // ----- Footer -----
    doc.setFontSize(7);
    doc.setTextColor(140, 140, 140);
    doc.setFont("helvetica", "normal");
    const now = new Date();
    const stamp = now.toISOString().slice(0, 16).replace("T", " ");
    doc.text(
      `© Ogopogo Extreme & Relay  ·  Generated ${stamp}  ·  ` +
      `Map: ${STYLES[state.styleKey].label}`,
      margin, H - 4
    );

  const styleSlug = state.styleKey === "voyager" ? "" : `_${state.styleKey}`;
  const filename = `${c.key}${styleSlug}${c.edited ? "_edited" : ""}.pdf`;
  return { doc, filename };
}

document.addEventListener("DOMContentLoaded", () => {
  preloadLogo();
  main();
});
