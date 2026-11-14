/**
 * PixFire Bolivia — Interfaz en lenguaje simple para NASA Space Apps 2026.
 *
 * En pantalla, "días con fuego" es el nombre simple de las celdas-día
 * (cada celda de 0,25° suma 1 por cada día con al menos una detección).
 *
 * Mantiene intacta la lógica científica de armonización:
 *   - data/processed/metadata.json
 *   - data/processed/monthly_cells.csv
 *   - data/processed/validation.csv
 *   - data/processed/data_bundle.js (fallback autónomo compatible con file:// y http://)
 */

const MONTH_NAMES = [
  "Ene", "Feb", "Mar", "Abr", "May", "Jun",
  "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"
];

const MONTH_FULL_NAMES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"
];

// Rampa única del calendario: de claro (poco fuego) a oscuro (mucho fuego)
const CAL_RAMP = ["#fff7ed", "#fed7aa", "#fb923c", "#ea580c", "#b91c1c", "#7c2d12"];

const ZONE_NAMES = {
  all: "Toda Bolivia",
  chiquitania: "Chiquitanía y Llanos",
  amazonia: "Amazonía y Beni",
  andina: "Andina y Valles",
  custom: "Zona elegida en el mapa"
};

const state = {
  meta: null,
  cellsMeta: new Map(), // cell_id -> { cellId, row, col, lat, lon, subregion, totalHarm, records: [] }
  allRecords: [],
  validationRows: [],
  selectedCells: new Set(),
  customPolygon: null,
  preset: "all",
  yearStart: 2003,
  yearEnd: 2026,
  focusYear: 2026,
  focusMonth: 10,
  compareSensors: false, // muestra las líneas de cada satélite en "Evolución"
  activeView: "calendar", // calendar | series | seasonal | ranking | ml
  mapMode: "period", // period (promedio del rango) | month (mes evaluado) | ml (riesgo 2026)
  animTimer: null,
  currentSeriesByYm: new Map(),
  subregionTotals: {
    chiquitania_llanos: 0,
    amazonia_beni_norte: 0,
    andina_valles: 0
  }
};

let map = null;
let gridLayerGroup = null;
let drawnItems = null;
const cellLayers = new Map(); // cell_id -> L.rectangle (se crean una sola vez)
let isDrawing = false; // evita abrir popups de celda mientras se dibuja un polígono
let chartCalendar = null;
let chartSeries = null;
let chartSeasonal = null;
let chartMlEffects = null;
let chartMlAoi = null;

/** Factor k_m del mes (con respaldo al factor anual si faltara). */
function getFactor(month) {
  if (!state.meta) return 1;
  const f = state.meta.factors_by_month ? state.meta.factors_by_month[String(month)] : null;
  return Number(f != null ? f : state.meta.factor_annual_fallback || 1);
}

function ymKey(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function fmtNum(v, digits = 1) {
  return Number(v).toLocaleString("es-BO", { maximumFractionDigits: digits });
}

/** "Días con fuego" (celdas-día): sin decimales cuando el número es grande. */
function fmtDays(v) {
  return fmtNum(v, Math.abs(v) >= 100 ? 0 : 1);
}

/** Compara un valor con lo habitual de ese mes (rango P25–P75 de 2003–2025). */
function classifyVsNormal(value, stat) {
  if (value > stat.p75) return { key: "high", label: "Más alto de lo normal", color: "#fdba74" };
  if (value < stat.p25) return { key: "low", label: "Más bajo de lo normal", color: "#5eead4" };
  return { key: "normal", label: "Dentro de lo normal", color: "#cbd5e1" };
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/* =========================================================================
 * 1. Carga y parseo de datos estáticos (Universal: HTTP o local file://)
 * ========================================================================= */
async function loadAllData() {
  if (window.PIXFIRE_DATA && window.PIXFIRE_DATA.meta && window.PIXFIRE_DATA.cellsCsv) {
    state.meta = window.PIXFIRE_DATA.meta;
    parseCellsCsv(window.PIXFIRE_DATA.cellsCsv, state.meta.cell_size_deg);
    parseValidationCsv(window.PIXFIRE_DATA.valCsv);
    return;
  }

  const [metaResp, cellsResp, valResp] = await Promise.all([
    fetch("data/processed/metadata.json"),
    fetch("data/processed/monthly_cells.csv"),
    fetch("data/processed/validation.csv")
  ]);

  state.meta = await metaResp.json();
  const cellsText = await cellsResp.text();
  const valText = await valResp.text();

  parseCellsCsv(cellsText, state.meta.cell_size_deg);
  parseValidationCsv(valText);
}

function classifySubregion(lat, lon) {
  if (lon <= -64.0 && lat < -14.0) return "andina_valles";
  if (lat >= -14.0) return "amazonia_beni_norte";
  return "chiquitania_llanos";
}

function parseCellsCsv(csvText, cellSize) {
  const lines = csvText.trim().split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const [cellId, yStr, mStr, hStr, aStr, sStr, source] = line.split(",");
    const year = parseInt(yStr, 10);
    const month = parseInt(mStr, 10);
    const harm = parseFloat(hStr);
    const aqua = aStr === "" ? null : parseInt(aStr, 10);
    const snpp = sStr === "" ? null : parseInt(sStr, 10);

    let cellObj = state.cellsMeta.get(cellId);
    if (!cellObj) {
      const [rStr, cStr] = cellId.split("_");
      const row = parseInt(rStr, 10);
      const col = parseInt(cStr, 10);
      const lat = (row + 0.5) * cellSize - 90.0;
      const lon = (col + 0.5) * cellSize - 180.0;
      const subregion = classifySubregion(lat, lon);
      cellObj = { cellId, row, col, lat, lon, subregion, totalHarm: 0, records: [], byYm: new Map() };
      state.cellsMeta.set(cellId, cellObj);
    }

    const rec = { cellId, year, month, harm, aqua, snpp, source };
    cellObj.totalHarm += harm;
    cellObj.records.push(rec);
    cellObj.byYm.set(ymKey(year, month), harm);
    state.allRecords.push(rec);
    state.subregionTotals[cellObj.subregion] = (state.subregionTotals[cellObj.subregion] || 0) + harm;
  }
}

function parseValidationCsv(csvText) {
  state.validationRows = [];
  const lines = csvText.trim().split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const [yStr, mStr, harmStr, aStr, sRawStr, sConvStr, split] = line.split(",");
    state.validationRows.push({
      year: parseInt(yStr, 10),
      month: parseInt(mStr, 10),
      harmonized: parseFloat(harmStr),
      aqua: aStr === "" ? null : parseFloat(aStr),
      snpp_raw: sRawStr === "" ? null : parseFloat(sRawStr),
      snpp_harmonized: sConvStr === "" ? null : parseFloat(sConvStr),
      split: split ? split.trim() : ""
    });
  }
}

/* =========================================================================
 * 2. Inicialización de Mapa Leaflet
 * ========================================================================= */
function initMap() {
  map = L.map("map", {
    center: [-16.4, -64.2],
    zoom: 5,
    minZoom: 4,
    maxZoom: 10,
    zoomControl: true,
    preferCanvas: true
  });

  // Clave pública de los mapas base de CARTO (sin ella las teselas salen con marca de agua)
  const CARTO_KEY = "cb1_58lv_1_5016ded4d19a88b491106fc0";

  const lightLayer = L.tileLayer(`https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=${CARTO_KEY}`, {
    attribution: "&copy; OpenStreetMap &copy; CARTO | NASA FIRMS",
    subdomains: "abcd",
    maxZoom: 19
  });

  const satLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    attribution: "Tiles &copy; Esri | NASA FIRMS",
    maxZoom: 18
  });

  lightLayer.addTo(map);
  L.control.layers({ "Mapa claro": lightLayer, "Satélite": satLayer }, null, { position: "topleft" }).addTo(map);

  gridLayerGroup = L.layerGroup().addTo(map);

  const legend = L.control({ position: "bottomleft" });
  legend.onAdd = () => {
    const div = L.DomUtil.create("div", "map-legend");
    div.id = "mapLegend";
    return div;
  };
  legend.addTo(map);
  drawnItems = new L.FeatureGroup().addTo(map);

  if (typeof L.Control !== "undefined" && typeof L.Control.Draw !== "undefined") {
    // Textos de las herramientas de dibujo en español
    if (L.drawLocal) {
      const d = L.drawLocal;
      d.draw.toolbar.buttons.polygon = "Dibujar una zona";
      d.draw.toolbar.buttons.rectangle = "Dibujar un rectángulo";
      d.draw.toolbar.actions.text = "Cancelar";
      d.draw.toolbar.finish.text = "Terminar";
      d.draw.toolbar.undo.text = "Borrar el último punto";
      d.draw.handlers.polygon.tooltip.start = "Haz clic para empezar a dibujar";
      d.draw.handlers.polygon.tooltip.cont = "Haz clic para seguir dibujando";
      d.draw.handlers.polygon.tooltip.end = "Haz clic en el primer punto para cerrar la zona";
      d.draw.handlers.rectangle.tooltip.start = "Haz clic y arrastra para marcar la zona";
      d.draw.handlers.simpleshape.tooltip.end = "Suelta para terminar";
      d.edit.toolbar.buttons.edit = "Modificar la zona";
      d.edit.toolbar.buttons.editDisabled = "No hay zona para modificar";
      d.edit.toolbar.buttons.remove = "Borrar la zona";
      d.edit.toolbar.buttons.removeDisabled = "No hay zona para borrar";
      d.edit.toolbar.actions.save.text = "Guardar";
      d.edit.toolbar.actions.cancel.text = "Cancelar";
      d.edit.toolbar.actions.clearAll.text = "Borrar todo";
    }

    const drawControl = new L.Control.Draw({
      position: "topright",
      draw: {
        polygon: {
          allowIntersection: false,
          shapeOptions: { color: "#7ff0e8", weight: 2, fillOpacity: 0.16 }
        },
        rectangle: {
          shapeOptions: { color: "#7ff0e8", weight: 2, fillOpacity: 0.16 }
        },
        polyline: false,
        circle: false,
        marker: false,
        circlemarker: false
      },
      edit: {
        featureGroup: drawnItems,
        remove: true
      }
    });
    map.addControl(drawControl);

    if (typeof L.Draw !== "undefined" && L.Draw.Event) {
      map.on(L.Draw.Event.CREATED, (e) => {
        drawnItems.clearLayers();
        drawnItems.addLayer(e.layer);
        state.customPolygon = e.layer.toGeoJSON();
        state.preset = "custom";
        const sel = document.getElementById("presetRegion");
        if (sel) sel.value = "custom";
        recomputeAoiSelection();
      });

      map.on(L.Draw.Event.DRAWSTART, () => {
        isDrawing = true;
      });
      map.on(L.Draw.Event.DRAWSTOP, () => {
        isDrawing = false;
      });

      map.on(L.Draw.Event.DELETED, () => {
        resetToPreset("all");
      });
    }
  }
}

/* Escalas de color del mapa, descritas con palabras.
 * "Días con fuego" = celdas-día (ver docs/METODO.md). */
const MAP_SCALES = {
  period: {
    title: "Días con fuego al año (promedio)",
    classes: [
      { min: 25, color: "#b91c1c", label: "Muy frecuente · más de 25" },
      { min: 10, color: "#ea580c", label: "Frecuente · 10 a 25" },
      { min: 2, color: "#fb923c", label: "Ocasional · 2 a 10" },
      { min: -Infinity, color: "#fed7aa", label: "Raro · menos de 2" }
    ]
  },
  month: {
    title: "Días con fuego en ese mes",
    classes: [
      { min: 15, color: "#7c2d12", label: "Más de 15 días" },
      { min: 7, color: "#b91c1c", label: "7 a 15 días" },
      { min: 3, color: "#ea580c", label: "3 a 7 días" },
      { min: 0, color: "#fdba74", label: "1 a 3 días" },
      { min: -Infinity, color: "#cbd5e1", label: "Sin fuego" }
    ]
  },
  ml: {
    title: "Días con fuego esperados en 2026",
    classes: [
      { min: 25, color: "#b91c1c", label: "Muy frecuente · más de 25" },
      { min: 10, color: "#ea580c", label: "Frecuente · 10 a 25" },
      { min: 2, color: "#fb923c", label: "Ocasional · 2 a 10" },
      { min: -Infinity, color: "#fed7aa", label: "Raro · menos de 2" }
    ]
  }
};

function getScaleColor(mode, value) {
  const classes = MAP_SCALES[mode].classes;
  const found = classes.find((c) => value > c.min);
  return found ? found.color : classes[classes.length - 1].color;
}

/** Valor de una celda según el modo del mapa (promedio del periodo, mes elegido o pronóstico). */
function getCellMapValue(cell) {
  if (state.mapMode === "ml") return getMlCellAnnual(cell.cellId);
  if (state.mapMode === "month") {
    return cell.byYm.get(ymKey(state.focusYear, state.focusMonth)) || 0;
  }
  let activeMonths = 0;
  for (let y = state.yearStart; y <= state.yearEnd; y++) {
    activeMonths += y === 2026 ? 10 : 12;
  }
  const numYears = Math.max(0.833, activeMonths / 12.0);
  let periodHarm = 0;
  for (const r of cell.records) {
    if (r.year >= state.yearStart && r.year <= state.yearEnd) periodHarm += r.harm;
  }
  return periodHarm / numYears;
}

function cellTooltipHtml(cell) {
  const v = getCellMapValue(cell);
  const body = state.mapMode === "ml"
    ? `Esperado en 2026: <b>${fmtDays(v)}</b> días con fuego`
    : state.mapMode === "month"
    ? `${MONTH_FULL_NAMES[state.focusMonth - 1]} ${state.focusYear}: <b>${fmtDays(v)}</b> días con fuego`
    : `Promedio ${state.yearStart}–${state.yearEnd}: <b>${fmtDays(v)}</b> días con fuego al año`;
  return body + "<br><span style='color:#64748b'>Clic para ver la historia de este lugar</span>";
}

/**
 * Pinta la grilla. Los rectángulos se crean una sola vez y luego solo se
 * actualiza su estilo (necesario para que la animación mes a mes sea fluida).
 */
function renderMapGrid() {
  if (!gridLayerGroup || !state.meta) return;
  const half = state.meta.cell_size_deg / 2.0;
  const mode = state.mapMode;

  state.cellsMeta.forEach((cell) => {
    let rect = cellLayers.get(cell.cellId);
    if (!rect) {
      rect = L.rectangle(
        [[cell.lat - half, cell.lon - half], [cell.lat + half, cell.lon + half]],
        { weight: 0.25 }
      );
      rect.bindTooltip(() => cellTooltipHtml(cell), { sticky: true });
      rect.on("click", (e) => openCellPopup(cell, e.latlng));
      cellLayers.set(cell.cellId, rect);
      gridLayerGroup.addLayer(rect);
    }

    const isSelected = state.selectedCells.has(cell.cellId);
    const value = getCellMapValue(cell);
    const fillColor = getScaleColor(mode, value);
    const noFire = mode === "month" && value <= 0;

    rect.setStyle({
      color: isSelected ? fillColor : "#cbd5e1",
      weight: isSelected ? 0.75 : 0.25,
      fillColor,
      fillOpacity: noFire ? (isSelected ? 0.12 : 0.05) : isSelected ? 0.65 : 0.12
    });
  });

  updateMapLegend();
}

function updateMapLegend() {
  const el = document.getElementById("mapLegend");
  if (!el) return;
  const scale = MAP_SCALES[state.mapMode];
  const when = state.mapMode === "ml"
    ? "Pronóstico 2026"
    : state.mapMode === "month"
    ? `${MONTH_FULL_NAMES[state.focusMonth - 1]} ${state.focusYear}`
    : `Lo habitual, ${state.yearStart}–${state.yearEnd}`;
  el.innerHTML =
    `<div class="legend-when">${when}</div>` +
    `<div class="legend-title">${scale.title}</div>` +
    scale.classes
      .map((c) => `<div class="legend-row"><i style="background:${c.color}"></i>${c.label}</div>`)
      .join("");
}

/* -------------------------------------------------------------------------
 * Modo del mapa y animación mes a mes
 * ------------------------------------------------------------------------- */
function setMapMode(mode) {
  state.mapMode = mode;
  document.querySelectorAll(".map-mode-btn").forEach((b) => {
    const active = b.dataset.mode === mode;
    b.classList.toggle("active", active);
    b.setAttribute("aria-pressed", active ? "true" : "false");
  });
  if (mode === "period") stopAnimation();
  renderMapGrid();
}

function nextMonth(year, month) {
  let y = year;
  let m = month + 1;
  if (m > 12) {
    m = 1;
    y += 1;
  }
  // Si nos salimos del rango (o pasamos oct 2026), volvemos al inicio
  if (y > state.yearEnd || (y === 2026 && m > 10)) {
    y = state.yearStart;
    m = 1;
  }
  return [y, m];
}

function startAnimation() {
  if (state.animTimer) return;
  if (state.mapMode !== "month") setMapMode("month");
  const btn = document.getElementById("btnPlay");
  if (btn) {
    btn.classList.add("playing");
    btn.textContent = "❚❚ Pausa";
    btn.setAttribute("aria-label", "Pausar animación");
  }
  state.animTimer = setInterval(() => {
    const [y, m] = nextMonth(state.focusYear, state.focusMonth);
    setFocus(y, m);
  }, 700);
}

function stopAnimation() {
  if (state.animTimer) {
    clearInterval(state.animTimer);
    state.animTimer = null;
  }
  const btn = document.getElementById("btnPlay");
  if (btn) {
    btn.classList.remove("playing");
    btn.textContent = "▶ Animar";
    btn.setAttribute("aria-label", "Animar mes a mes");
  }
}

/* -------------------------------------------------------------------------
 * Popup de celda: mini-gráfico de su historia anual y selección como AOI
 * ------------------------------------------------------------------------- */
const SUBREGION_NAMES = {
  chiquitania_llanos: "Chiquitanía y Llanos",
  amazonia_beni_norte: "Amazonía y Beni Norte",
  andina_valles: "Andina y Valles"
};

/** Barras SVG simples con el total anual armonizado de la celda (2003–2026). */
function buildSparklineSvg(totals, years) {
  const w = 230;
  const h = 56;
  const max = Math.max(1, ...totals);
  const bw = w / totals.length;
  const bars = totals
    .map((v, i) => {
      const bh = (v / max) * (h - 4);
      const isFocus = years[i] === state.focusYear;
      const isPartial = years[i] === 2026;
      const fill = isFocus ? "#0f172a" : isPartial ? "#fdba74" : "#ea580c";
      return `<rect x="${(i * bw + 0.5).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${bh.toFixed(1)}" fill="${fill}"><title>${years[i]}: ${fmtNum(v)}</title></rect>`;
    })
    .join("");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Días con fuego por año en este lugar">${bars}</svg>`;
}

function openCellPopup(cell, latlng) {
  if (isDrawing || !map) return;

  const years = [];
  for (let y = 2003; y <= 2026; y++) years.push(y);
  const totals = years.map(() => 0);
  for (const r of cell.records) totals[r.year - 2003] += r.harm;

  const full = totals.slice(0, totals.length - 1); // 2003–2025 (años completos)
  const peakIdx = full.indexOf(Math.max(...full));
  const avg = full.reduce((a, b) => a + b, 0) / full.length;

  const div = document.createElement("div");
  div.className = "cell-popup";
  div.innerHTML = `
    <div class="cp-title">Historia de este lugar</div>
    <div class="cp-sub">${SUBREGION_NAMES[cell.subregion] || ""} · cuadro de ~27 km</div>
    ${buildSparklineSvg(totals, years)}
    <div class="cp-axis"><span>2003</span><span>2026*</span></div>
    <div class="cp-stats">
      <div><span>Promedio al año</span><b>${fmtDays(avg)} días</b></div>
      <div><span>Peor año</span><b>${years[peakIdx]} (${fmtDays(full[peakIdx])} días)</b></div>
    </div>
    <div class="cp-note">Días con fuego por año · *2026 solo hasta octubre</div>
    <button type="button" class="btn-action primary cp-btn">Ver solo este lugar</button>`;

  div.querySelector(".cp-btn").addEventListener("click", () => {
    map.closePopup();
    selectSingleCell(cell);
  });

  L.popup({ maxWidth: 260 }).setLatLng(latlng).setContent(div).openOn(map);
}

function selectSingleCell(cell) {
  const half = state.meta.cell_size_deg / 2.0;
  // Margen pequeño para que solo el centro de esta celda quede dentro
  applyCustomBbox(cell.lon - half + 0.01, cell.lat - half + 0.01, cell.lon + half - 0.01, cell.lat + half - 0.01);
}

/** Usa un rectángulo (lon/lat mínimos y máximos) como área de interés personalizada. */
function applyCustomBbox(minLon, minLat, maxLon, maxLat) {
  const layer = L.rectangle([[minLat, minLon], [maxLat, maxLon]], {
    color: "#0891b2",
    weight: 2,
    fillOpacity: 0.08
  });
  if (drawnItems) {
    drawnItems.clearLayers();
    drawnItems.addLayer(layer);
  }
  state.customPolygon = layer.toGeoJSON();
  state.preset = "custom";
  const sel = document.getElementById("presetRegion");
  if (sel) sel.value = "custom";
  if (map) map.fitBounds(layer.getBounds(), { maxZoom: 8, padding: [30, 30] });
  recomputeAoiSelection();
}

/* =========================================================================
 * 3. Selección espacial (AOI) y agregación dinámica
 * ========================================================================= */
function cellMatchesPreset(cell, preset) {
  if (preset === "all") return true;
  if (preset === "chiquitania") return cell.subregion === "chiquitania_llanos";
  if (preset === "amazonia") return cell.subregion === "amazonia_beni_norte";
  if (preset === "andina") return cell.subregion === "andina_valles";
  return true;
}

function recomputeAoiSelection() {
  state.selectedCells.clear();

  state.cellsMeta.forEach((cell) => {
    if (state.preset === "custom" && state.customPolygon) {
      const pt = turf.point([cell.lon, cell.lat]);
      if (turf.booleanPointInPolygon(pt, state.customPolygon)) {
        state.selectedCells.add(cell.cellId);
      }
    } else if (cellMatchesPreset(cell, state.preset)) {
      state.selectedCells.add(cell.cellId);
    }
  });

  const count = state.selectedCells.size;

  const warnBar = document.getElementById("aoiWarning");
  const warnTxt = document.getElementById("aoiWarningText");
  const warnings = [];

  if (state.preset === "custom" && state.customPolygon && state.meta && Array.isArray(state.meta.bbox)) {
    const [bMinLon, bMinLat, bMaxLon, bMaxLat] = state.meta.bbox;
    const polyBbox = turf.bbox(state.customPolygon);
    const tol = 0.25;
    if (
      polyBbox[0] < bMinLon - tol ||
      polyBbox[1] < bMinLat - tol ||
      polyBbox[2] > bMaxLon + tol ||
      polyBbox[3] > bMaxLat + tol
    ) {
      warnings.push("Parte de la zona queda fuera de Bolivia: solo se cuenta lo que está dentro del país.");
    }
  }

  if (count === 0) {
    warnings.push("En la zona elegida no hay fuego registrado. Prueba con una zona más grande.");
  } else if (count < 4) {
    warnings.push("La zona es muy pequeña: los números cambian mucho de un mes a otro y conviene leerlos con cuidado.");
  }

  if (warnBar && warnTxt) {
    if (warnings.length > 0) {
      warnTxt.textContent = warnings.join(" ");
      warnBar.classList.remove("hidden");
    } else {
      warnBar.classList.add("hidden");
    }
  }

  renderMapGrid();
  aggregateSelectedCells();
  updateAllViews();
}

function aggregateSelectedCells() {
  state.currentSeriesByYm.clear();

  for (let y = 2003; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) {
      if (y === 2026 && m > 10) continue;
      const ym = `${y}-${String(m).padStart(2, "0")}`;
      state.currentSeriesByYm.set(ym, {
        year: y,
        month: m,
        harm: 0.0,
        aqua: 0,
        snpp: y >= 2012 && !(y === 2012 && m === 1) ? 0 : null,
        hasNrt: false
      });
    }
  }

  state.selectedCells.forEach((cellId) => {
    const cell = state.cellsMeta.get(cellId);
    if (!cell) return;
    for (const r of cell.records) {
      const ym = `${r.year}-${String(r.month).padStart(2, "0")}`;
      const bucket = state.currentSeriesByYm.get(ym);
      if (!bucket) continue;
      bucket.harm += r.harm;
      if (r.aqua !== null) bucket.aqua = (bucket.aqua || 0) + r.aqua;
      if (r.snpp !== null) bucket.snpp = (bucket.snpp || 0) + r.snpp;
      if (r.source === "snpp_converted_nrt" || r.source === "snpp_nrt") bucket.hasNrt = true;
    }
  });
}

/* =========================================================================
 * 4. Métricas climatológicas (Mediana histórica y Percentiles)
 * ========================================================================= */
function quantile(arr, q) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const pos = (a.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (a[base + 1] !== undefined) {
    return a[base] + rest * (a[base + 1] - a[base]);
  }
  return a[base];
}

function computeHistoricalStatsByMonth() {
  const byM = {};
  for (let m = 1; m <= 12; m++) byM[m] = [];

  state.currentSeriesByYm.forEach((val) => {
    if (val.year >= 2003 && val.year <= 2025) {
      byM[val.month].push(val.harm);
    }
  });

  const out = {};
  for (let m = 1; m <= 12; m++) {
    const vals = byM[m];
    const n = vals.length || 1;
    const sum = vals.reduce((acc, v) => acc + v, 0);
    out[m] = {
      count: vals.length,
      mean: sum / n,
      median: quantile(vals, 0.5),
      p25: quantile(vals, 0.25),
      p75: quantile(vals, 0.75)
    };
  }
  return out;
}

/* =========================================================================
 * 5. Actualización de Tarjetas y Gráfico ECharts
 * ========================================================================= */
function updateAllViews() {
  const histStats = computeHistoricalStatsByMonth();
  updateSummary(histStats);
  updateTrustNote();
  renderActiveView();
}

/** Cambia el mes evaluado desde cualquier vista (calendario, serie, ciclo, ranking). */
function setFocus(year, month) {
  if (year === 2026 && month > 10) return; // sin datos después de oct 2026
  state.focusYear = year;
  state.focusMonth = month;
  const mSel = document.getElementById("focusMonth");
  const ySel = document.getElementById("focusYear");
  if (mSel) mSel.value = String(month);
  if (ySel) ySel.value = String(year);
  syncFocusMonthOptions();
  updateAllViews();
  if (state.mapMode === "month") renderMapGrid();
}

/* =========================================================================
 * 5b. Pestañas de vistas temporales
 * ========================================================================= */
const VIEW_TEXTS = {
  calendar: {
    title: () => "Calendario de fuego",
    help: "Cada fila es un año y cada columna un mes. Más oscuro = más fuego. Haz clic en un mes para verlo arriba y en el mapa."
  },
  series: {
    title: () => "Evolución mes a mes",
    help: "La línea sube cuando hay más fuego. Usa la rueda del ratón o la barra de abajo para acercarte."
  },
  seasonal: {
    title: () => `¿Fue normal ${state.focusYear}?`,
    help: "Barras = ese año. Franja gris = lo normal. Barra naranja: más fuego de lo normal; verde: menos; gris: normal."
  },
  ranking: {
    title: () => "Años y meses con más fuego",
    help: "Haz clic en una fila para ver ese momento arriba y en el mapa."
  },
  ml: {
    title: () => "Pronóstico 2026 con un modelo estadístico",
    help: "Sección técnica para especialistas: qué tanto se puede anticipar el fuego con la historia de cada lugar."
  }
};

function switchView(view) {
  state.activeView = view;
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    const isActive = btn.dataset.view === view;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  document.querySelectorAll(".view-panel").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.view !== view);
  });
  // "Imagen del gráfico" solo aplica a las vistas que son un gráfico
  const pngBtn = document.getElementById("btnPng");
  if (pngBtn) pngBtn.disabled = view === "ranking" || view === "ml";
  renderActiveView();
}

/** Dibuja solo la vista visible (ECharts no puede medir un div oculto). */
function renderActiveView() {
  const texts = VIEW_TEXTS[state.activeView];
  if (texts) {
    setText("stageTitle", texts.title());
    setText("stageHelp", texts.help);
  }
  // La opción de comparar satélites solo existe en "Evolución"
  const compareBar = document.getElementById("compareBar");
  if (compareBar) compareBar.classList.toggle("hidden", state.activeView !== "series");
  const trustNote = document.getElementById("trustNote");
  if (trustNote) trustNote.classList.toggle("hidden", !state.compareSensors);
  const seriesLegend = document.getElementById("seriesLegend");
  if (seriesLegend) seriesLegend.classList.toggle("hidden", !state.compareSensors);

  if (state.activeView === "series") {
    renderSeriesChart();
    if (chartSeries) chartSeries.resize();
  } else if (state.activeView === "seasonal") {
    renderSeasonalChart();
    if (chartSeasonal) chartSeasonal.resize();
  } else if (state.activeView === "ranking") {
    renderRanking();
  } else if (state.activeView === "ml") {
    renderMlPanel();
  } else {
    renderCalendarChart();
    if (chartCalendar) chartCalendar.resize();
  }
}

/** Enciende o apaga la comparación entre satélites en "Evolución". */
function setCompareSensors(on) {
  state.compareSensors = on;
  const chk = document.getElementById("chkCompare");
  if (chk) chk.checked = on;
  renderActiveView();
}

/* =========================================================================
 * 5c. Serie temporal: Aqua crudo vs. S-NPP crudo vs. S-NPP × k_m vs. armonizada
 * ========================================================================= */
const TOOLTIP_STYLE = {
  backgroundColor: "rgba(15, 23, 42, 0.96)",
  borderColor: "#e2e8f0",
  borderWidth: 1,
  textStyle: { color: "#ffffff", fontFamily: "Sora, sans-serif", fontSize: 11 }
};

function getSeriesRowsInRange() {
  const rows = [];
  // El Map se llena en orden cronológico, así que rows queda ordenado.
  state.currentSeriesByYm.forEach((v, ym) => {
    if (v.year >= state.yearStart && v.year <= state.yearEnd) rows.push({ ym, ...v });
  });
  return rows;
}

function renderSeriesChart() {
  const dom = document.getElementById("chartSeries");
  if (!dom) return;

  if (!chartSeries) {
    chartSeries = echarts.init(dom);
    // Clic en cualquier punto del gráfico → elegir ese mes
    chartSeries.getZr().on("click", (e) => {
      const px = [e.offsetX, e.offsetY];
      if (!chartSeries.containPixel("grid", px)) return;
      const idx = chartSeries.convertFromPixel({ seriesIndex: 0 }, px)[0];
      const label = chartSeries._labels && chartSeries._labels[idx];
      if (!label) return;
      const [y, m] = label.split("-").map((v) => parseInt(v, 10));
      setFocus(y, m);
    });
  }

  const rows = getSeriesRowsInRange();
  const labels = rows.map((r) => r.ym);
  chartSeries._labels = labels;
  if (!labels.length) {
    chartSeries.clear();
    return;
  }

  const compare = state.compareSensors;
  const prettyYm = (ym) => {
    const [y, m] = ym.split("-").map((v) => parseInt(v, 10));
    return `${MONTH_NAMES[m - 1]} ${y}`;
  };

  // Franjas de contexto (solo al comparar satélites), recortadas al rango visible
  const first = labels[0];
  const last = labels[labels.length - 1];
  const areas = [];
  const addArea = (name, from, to, color) => {
    const a = from < first ? first : from;
    const b = to > last ? last : to;
    if (a <= b) areas.push([{ name, xAxis: a, itemStyle: { color } }, { xAxis: b }]);
  };
  if (compare) {
    addArea("Los dos satélites a la vez", "2012-02", "2021-12", "rgba(15, 118, 110, 0.07)");
    addArea("Solo el satélite nuevo", "2022-01", "2026-10", "rgba(245, 158, 11, 0.10)");
  }

  const focusYm = ymKey(state.focusYear, state.focusMonth);
  const focusLine = labels.includes(focusYm)
    ? {
        symbol: "none",
        silent: true,
        lineStyle: { color: "#0f172a", type: "dashed", width: 1 },
        label: { show: false },
        data: [{ xAxis: focusYm }]
      }
    : undefined;

  const series = [
    {
      name: compare ? "Dato final (corregido)" : "Días con fuego",
      type: "line",
      data: rows.map((r) => round1(r.harm)),
      showSymbol: false,
      z: 5,
      lineStyle: { width: 2.2, color: "#0f172a" },
      itemStyle: { color: "#0f172a" },
      areaStyle: compare ? undefined : { color: "rgba(234, 88, 12, 0.12)" },
      markArea: {
        silent: true,
        label: { fontSize: 10, color: "#475569", position: "insideTop" },
        data: areas
      },
      markLine: focusLine
    }
  ];

  if (compare) {
    series.push(
      {
        name: "Satélite antiguo (MODIS)",
        type: "line",
        data: rows.map((r) => (r.aqua === null ? null : r.aqua)),
        showSymbol: false,
        lineStyle: { width: 1.2, color: "#0284c7" },
        itemStyle: { color: "#0284c7" }
      },
      {
        name: "Satélite nuevo sin corregir (VIIRS)",
        type: "line",
        data: rows.map((r) => (r.snpp === null ? null : r.snpp)),
        showSymbol: false,
        lineStyle: { width: 1.2, color: "#dc2626", opacity: 0.8 },
        itemStyle: { color: "#dc2626" }
      },
      {
        name: "Satélite nuevo corregido",
        type: "line",
        data: rows.map((r) => (r.snpp === null ? null : round1(r.snpp * getFactor(r.month)))),
        showSymbol: false,
        lineStyle: { width: 1.2, color: "#0f766e", type: "dashed" },
        itemStyle: { color: "#0f766e" }
      }
    );
  }

  const option = {
    backgroundColor: "#ffffff",
    animation: false,
    tooltip: {
      ...TOOLTIP_STYLE,
      trigger: "axis",
      formatter: (items) => {
        let html = `<div style="font-weight:700;margin-bottom:3px">${prettyYm(items[0].axisValue)}</div>`;
        items.forEach((it) => {
          if (it.value === null || it.value === undefined) return;
          html += `<div>${it.marker}${it.seriesName}: <b>${fmtDays(it.value)}</b></div>`;
        });
        return html;
      }
    },
    // La leyenda va en HTML (#seriesLegend): así no se encima con el gráfico
    legend: { show: false },
    grid: { top: 14, bottom: 52, left: 52, right: 16 },
    xAxis: {
      type: "category",
      data: labels,
      boundaryGap: false,
      axisLine: { lineStyle: { color: "#cbd5e1" } },
      axisLabel: { color: "#475569", fontSize: 11, fontFamily: "Sora", formatter: (v) => v.slice(0, 4) },
      axisTick: { show: false }
    },
    yAxis: {
      type: "value",
      splitLine: { lineStyle: { color: "#f1f5f9" } },
      axisLabel: { color: "#475569", fontSize: 11, fontFamily: "Sora", formatter: (v) => fmtNum(v, 0) }
    },
    dataZoom: [
      { type: "inside" },
      { type: "slider", height: 14, bottom: 8, borderColor: "#e2e8f0", showDetail: false }
    ],
    series
  };

  // replaceMerge conserva el zoom del usuario entre actualizaciones
  chartSeries.setOption(option, { replaceMerge: ["series"] });
}

/* =========================================================================
 * 5d. Ciclo estacional: año evaluado vs. mediana y banda normal (P25–P75)
 * ========================================================================= */
function renderSeasonalChart() {
  const dom = document.getElementById("chartSeasonal");
  if (!dom) return;

  if (!chartSeasonal) {
    chartSeasonal = echarts.init(dom);
    chartSeasonal.on("click", (params) => {
      if (params.seriesType === "bar") setFocus(state.focusYear, params.dataIndex + 1);
    });
  }

  const hist = computeHistoricalStatsByMonth();
  const BAR_COLORS = { high: "#ea580c", low: "#0f766e", normal: "#94a3b8" };
  const p25 = [];
  const band = [];
  const median = [];
  const current = [];

  for (let m = 1; m <= 12; m++) {
    const st = hist[m];
    p25.push(round1(st.p25));
    band.push(round1(st.p75 - st.p25));
    median.push(round1(st.median));

    const bucket = state.currentSeriesByYm.get(ymKey(state.focusYear, m));
    if (!bucket) {
      current.push({ value: null });
      continue;
    }
    const color = BAR_COLORS[classifyVsNormal(bucket.harm, st).key];
    const isFocus = m === state.focusMonth;
    current.push({
      value: round1(bucket.harm),
      itemStyle: { color, borderColor: isFocus ? "#0f172a" : color, borderWidth: isFocus ? 2 : 0 }
    });
  }

  const yearName = String(state.focusYear);
  const option = {
    backgroundColor: "#ffffff",
    animation: false,
    tooltip: {
      ...TOOLTIP_STYLE,
      trigger: "axis",
      formatter: (items) => {
        const m = items[0].dataIndex + 1;
        const st = hist[m];
        const b = state.currentSeriesByYm.get(ymKey(state.focusYear, m));
        const status = b ? classifyVsNormal(b.harm, st) : null;
        return `
          <div style="font-weight:700;margin-bottom:3px">${MONTH_FULL_NAMES[m - 1]} ${state.focusYear}</div>
          <div>${b ? `<b>${fmtDays(b.harm)}</b> días con fuego` : "Todavía sin datos"}</div>
          <div>Lo normal: entre ${fmtDays(st.p25)} y ${fmtDays(st.p75)}</div>
          ${status ? `<div style="margin-top:3px;color:${status.color}">${status.label}</div>` : ""}`;
      }
    },
    legend: {
      top: 0,
      data: [yearName, "Mes típico", "Rango normal"],
      itemWidth: 14,
      itemHeight: 8,
      textStyle: { fontSize: 11, color: "#475569", fontFamily: "Sora" }
    },
    grid: { top: 32, bottom: 26, left: 52, right: 16 },
    xAxis: {
      type: "category",
      data: MONTH_NAMES,
      axisLine: { lineStyle: { color: "#cbd5e1" } },
      axisLabel: { color: "#475569", fontSize: 11, fontFamily: "Sora" },
      axisTick: { show: false }
    },
    yAxis: {
      type: "value",
      splitLine: { lineStyle: { color: "#f1f5f9" } },
      axisLabel: { color: "#475569", fontSize: 11, fontFamily: "Sora", formatter: (v) => fmtNum(v, 0) }
    },
    series: [
      // Rango normal como área apilada (base invisible + ancho del rango)
      {
        name: "base",
        type: "line",
        stack: "normal",
        data: p25,
        symbol: "none",
        lineStyle: { opacity: 0 },
        silent: true
      },
      {
        name: "Rango normal",
        type: "line",
        stack: "normal",
        data: band,
        symbol: "none",
        lineStyle: { opacity: 0 },
        areaStyle: { color: "rgba(148, 163, 184, 0.28)" },
        itemStyle: { color: "rgba(148, 163, 184, 0.6)" },
        silent: true
      },
      {
        name: yearName,
        type: "bar",
        data: current,
        barWidth: "45%",
        itemStyle: { color: "#94a3b8" }
      },
      {
        name: "Mes típico",
        type: "line",
        data: median,
        symbol: "circle",
        symbolSize: 4,
        lineStyle: { color: "#0f172a", width: 1.5, type: "dashed" },
        itemStyle: { color: "#0f172a" },
        z: 5
      }
    ]
  };

  chartSeasonal.setOption(option, true);
}

/* =========================================================================
 * 5d-bis. Resumen en una frase: ¿el mes elegido es normal?
 * ========================================================================= */
function updateSummary(histStats) {
  const current = state.currentSeriesByYm.get(ymKey(state.focusYear, state.focusMonth));
  const stat = histStats[state.focusMonth] || { median: 0, mean: 0, p25: 0, p75: 0 };
  const value = current ? current.harm : 0;
  const monthName = MONTH_FULL_NAMES[state.focusMonth - 1];
  const typical = `un ${monthName.toLowerCase()} típico`;
  const status = classifyVsNormal(value, stat);

  setText("sumTitle", `${monthName} ${state.focusYear} · ${ZONE_NAMES[state.preset] || ""}`);
  setText("sumValue", fmtDays(value));
  setText("sumRange", `${fmtDays(stat.p25)} – ${fmtDays(stat.p75)}`);

  const pill = document.getElementById("sumStatus");
  if (pill) {
    pill.textContent = status.label;
    pill.className = `status-pill ${status.key}`;
  }

  // Frase comparando con el mes típico (mediana 2003–2025)
  let sentence;
  if (stat.median > 0) {
    const pct = ((value - stat.median) / stat.median) * 100.0;
    if (Math.abs(pct) < 1) sentence = `Prácticamente igual que ${typical}.`;
    else if (pct >= 100) sentence = `${fmtNum(value / stat.median, 1)} veces el fuego de ${typical}.`;
    else sentence = `Un ${fmtNum(Math.abs(pct), 0)} % ${pct > 0 ? "más" : "menos"} que ${typical}.`;
  } else if (value > 0) {
    sentence = `En ${typical} casi no hay fuego en esta zona.`;
  } else {
    sentence = `Sin fuego detectado, igual que en ${typical}.`;
  }
  sentence += ` Lo normal para este mes es entre ${fmtDays(stat.p25)} y ${fmtDays(stat.p75)}.`;
  if (current && current.hasNrt) sentence += " Dato provisional.";
  setText("sumSentence", sentence);

  // Marcador de la barra: interpolación por tramos (P25 = 25 %, mediana = 50 %, P75 = 75 %)
  const markerEl = document.querySelector(".track-current-marker");
  if (markerEl) {
    const { p25, median: med, p75 } = stat;
    let pos = 50;
    if (p75 <= 0 && value <= 0) {
      pos = 25;
    } else if (value <= p25) {
      pos = p25 > 0 ? 3 + (value / p25) * 22 : 25;
    } else if (value <= med) {
      pos = med > p25 ? 25 + ((value - p25) / (med - p25)) * 25 : 50;
    } else if (value <= p75) {
      pos = p75 > med ? 50 + ((value - med) / (p75 - med)) * 25 : 75;
    } else {
      const upperCap = Math.max(p75 * 2.0, p75 + (p75 - p25) * 1.5, 10);
      const ratio = Math.min(1, (value - p75) / Math.max(1, upperCap - p75));
      pos = 75 + ratio * 22;
    }
    markerEl.style.left = `${Math.min(97, Math.max(3, pos)).toFixed(1)}%`;
  }

  setText(
    "calendarSummarySR",
    `${monthName} ${state.focusYear}, ${ZONE_NAMES[state.preset] || ""}: ${fmtDays(value)} días con fuego. ${status.label}. ${sentence}`
  );
}

/**
 * Métricas de la corrección entre satélites para la zona actual.
 * Toda Bolivia: prueba fuera de muestra 2017–2021. Subregión o zona propia: traslape 2012–2021.
 */
function getValidationMetrics() {
  if (!state.meta) return null;
  const vm = state.meta.validation_metrics || {};
  const subMap = {
    chiquitania: "chiquitania_llanos",
    amazonia: "amazonia_beni_norte",
    andina: "andina_valles"
  };

  if (state.preset === "all") {
    const m = vm.train_2012_2016_test_2017_2021;
    return m ? { ...m, scope: "2017–2021 (años que no se usaron para calcular la corrección)" } : null;
  }
  if (subMap[state.preset]) {
    const m = vm.subregions_2012_2021 ? vm.subregions_2012_2021[subMap[state.preset]] : null;
    return m ? { ...m, scope: "2012–2021 en esta región" } : null;
  }

  // Zona propia: se calcula con las celdas elegidas
  let sumAqua = 0;
  let sumSnppRaw = 0;
  let sumSnppHarm = 0;
  state.selectedCells.forEach((cellId) => {
    const cell = state.cellsMeta.get(cellId);
    if (!cell) return;
    for (const r of cell.records) {
      if (r.year < 2012 || r.year > 2021) continue;
      if (r.year === 2012 && r.month === 1) continue;
      if (r.year === 2020 && (r.month === 8 || r.month === 9)) continue;
      const snpp = r.snpp || 0;
      sumAqua += r.aqua || 0;
      sumSnppRaw += snpp;
      sumSnppHarm += snpp * getFactor(r.month);
    }
  });
  if (sumAqua <= 0) return null;
  return {
    raw_bias_pct: ((sumSnppRaw - sumAqua) / sumAqua) * 100,
    harmonized_bias_pct: ((sumSnppHarm - sumAqua) / sumAqua) * 100,
    scope: "2012–2021 en esta zona"
  };
}

/** Explica en palabras simples por qué y cuánto se corrige (pestaña "Evolución"). */
function updateTrustNote() {
  const el = document.getElementById("trustNote");
  if (!el) return;
  const why =
    "<b>¿Por qué se corrige?</b> El satélite nuevo (VIIRS) ve fuegos más pequeños que el antiguo (MODIS), " +
    "así que cuenta más aunque haya el mismo fuego. Para poder comparar todos los años, sus datos se ajustan a la escala del antiguo. ";
  const m = getValidationMetrics();
  if (!m) {
    el.innerHTML = why + "En esta zona no hay datos suficientes de los años con ambos satélites para comprobar el ajuste.";
    return;
  }
  const signed = (v, d) => `${v > 0 ? "+" : ""}${fmtNum(v, d)}\u00a0%`;
  el.innerHTML =
    why +
    `<b>Comprobación</b> (${m.scope}): sin corregir, el satélite nuevo contaba <b>${signed(m.raw_bias_pct, 0)}</b> ` +
    `respecto al antiguo; después de corregir, la diferencia es de <b>${signed(m.harmonized_bias_pct, 1)}</b>.`;
}

/* =========================================================================
 * 5e. Ranking: años y meses con más fuego en el área seleccionada
 * ========================================================================= */
function rankRowHtml(rank, label, value, maxVal, extra, dataAttrs) {
  const pct = maxVal > 0 ? (value / maxVal) * 100 : 0;
  return `
    <button type="button" class="rank-row" ${dataAttrs}>
      <span class="rank-n">${rank}</span>
      <span class="rank-label">${label}</span>
      <span class="rank-bar"><i style="width:${pct.toFixed(1)}%"></i></span>
      <span class="rank-val">${fmtDays(value)}</span>
      <span class="rank-extra">${extra}</span>
    </button>`;
}

function renderRanking() {
  const el = document.getElementById("rankingView");
  if (!el) return;

  const hist = computeHistoricalStatsByMonth();
  const rows = getSeriesRowsInRange();

  // Totales por año (2026 es parcial: solo ene–oct)
  const byYear = new Map();
  rows.forEach((r) => {
    const cur = byYear.get(r.year) || { total: 0, peakMonth: 1, peakVal: -1 };
    cur.total += r.harm;
    if (r.harm > cur.peakVal) {
      cur.peakVal = r.harm;
      cur.peakMonth = r.month;
    }
    byYear.set(r.year, cur);
  });
  const allYears = [...byYear.entries()].map(([year, v]) => ({ year, ...v }));
  const topYears = [...allYears].sort((a, b) => b.total - a.total).slice(0, 5);
  const fullYears = allYears.filter((y) => y.year <= 2025);
  const avgYear = fullYears.length ? fullYears.reduce((a, y) => a + y.total, 0) / fullYears.length : 0;

  const topMonths = [...rows].sort((a, b) => b.harm - a.harm).slice(0, 5);

  const yearsHtml = topYears
    .map((y, i) =>
      rankRowHtml(
        i + 1,
        y.year === 2026 ? "2026*" : String(y.year),
        y.total,
        topYears[0].total,
        avgYear > 0 ? `${fmtNum(y.total / avgYear, 1)} veces un año promedio` : "",
        `data-year="${y.year}" data-month="${y.peakMonth}"`
      )
    )
    .join("");

  const monthsHtml = topMonths
    .map((r, i) => {
      const med = hist[r.month].median;
      return rankRowHtml(
        i + 1,
        `${MONTH_NAMES[r.month - 1]} ${r.year}`,
        r.harm,
        topMonths[0].harm,
        med > 0 ? `${fmtNum(r.harm / med, 1)} veces lo típico de ese mes` : "",
        `data-year="${r.year}" data-month="${r.month}"`
      );
    })
    .join("");

  el.innerHTML = `
    <div class="rank-grid">
      <section>
        <h4>Los 5 años con más fuego</h4>
        ${yearsHtml || "<p class='rank-help'>Sin datos</p>"}
      </section>
      <section>
        <h4>Los 5 meses con más fuego</h4>
        ${monthsHtml || "<p class='rank-help'>Sin datos</p>"}
      </section>
    </div>
    <p class="rank-help">Números en días con fuego, entre ${state.yearStart} y ${state.yearEnd}. *2026 solo incluye enero–octubre (provisional).</p>`;

  el.querySelectorAll(".rank-row").forEach((btn) => {
    btn.addEventListener("click", () => {
      setFocus(parseInt(btn.dataset.year, 10), parseInt(btn.dataset.month, 10));
    });
  });
}

/* =========================================================================
 * 5e. Modelo de Machine Learning (resultados de scripts/ml_model.py)
 *
 * La web NO entrena nada: solo lee data/processed/ml_bundle.js
 * (window.PIXFIRE_ML) y suma los pronósticos de las celdas del AOI.
 * ========================================================================= */
const ML_YS_TERMS = ["ys_2", "ys_3", "ys_4", "ys_6"];
const ML_YS_LABELS = ["1 año\n(referencia)", "2 años", "3 años", "4–5 años", "6+ años o\nsin registro"];
const ML_COLORS = { occurrence: "#0f766e", intensity: "#ea580c", obs: "#94a3b8", clim: "#64748b" };

function getMl() {
  return window.PIXFIRE_ML && window.PIXFIRE_ML.cells_forecast ? window.PIXFIRE_ML : null;
}

/** Celdas-día esperadas para todo 2026 en una celda (suma de los 12 meses). */
function getMlCellAnnual(cellId) {
  const ml = getMl();
  const c = ml && ml.cells_forecast[cellId];
  return c ? c.pred.reduce((a, v) => a + v, 0) : 0;
}

/** Si no existe ml_bundle.js, oculta la pestaña y el modo de mapa (la app sigue funcionando). */
function initMlControls() {
  if (getMl()) return;
  document.querySelectorAll('[data-view="ml"], [data-mode="ml"]').forEach((el) => el.classList.add("hidden"));
}

function mlTerm(part, term) {
  return getMl().effects[part].terms.find((t) => t.term === term);
}

/** Frases de hallazgos calculadas a partir de los resultados (no hay cifras escritas a mano). */
function buildMlFindings(ml) {
  const d = ml.distribution_check;
  const occ6 = mlTerm("occurrence", "ys_6");
  const int6 = mlTerm("intensity", "ys_6");
  const [base, nb, hgb] = ml.metrics_test;
  const best = nb.poisson_deviance <= hgb.poisson_deviance ? nb : hgb;
  const devGain = ((base.poisson_deviance - best.poisson_deviance) / base.poisson_deviance) * 100;
  const sig = (t) => t.ci_low > 1 || t.ci_high < 1;

  const items = [];
  items.push(
    `<b>No es una distribución normal.</b> El ${fmtNum(d.share_zeros_train * 100, 0)} % de las celdas-mes vale 0 ` +
    `y la varianza es ${fmtNum(d.variance_train / d.mean_train, 1)} veces la media (sobredispersión). ` +
    `Por eso se usan modelos de conteo (binomial negativa, Poisson), no regresión lineal.`
  );
  items.push(sig(occ6)
    ? `<b>Persistencia:</b> si la celda ardió el año pasado, las probabilidades (odds) de fuego son ` +
      `<b>${fmtNum(1 / occ6.ratio, 1)}×</b> mayores que en una celda con 6+ años sin fuego, aun descontando su normal histórico.`
    : `<b>Persistencia:</b> el efecto de haber ardido el año pasado no es concluyente (IC 95 % cruza 1).`);
  items.push(sig(int6) && int6.ratio > 1
    ? `<b>Acumulación:</b> cuando el fuego vuelve tras 6+ años sin fuego, dura/se extiende ` +
      `<b>${fmtNum((int6.ratio - 1) * 100, 0)} %</b> más celdas-día que en una celda que ardió el año pasado.`
    : `<b>Acumulación:</b> no se encontró un aumento claro de intensidad tras años sin fuego.`);
  items.push(
    `<b>Capacidad predictiva:</b> el mejor modelo (${best.model}) reduce la deviance un ${fmtNum(devGain, 0)} % frente a la climatología ` +
    `en ${ml.test_years[0]}–${ml.test_years[1]}. ` +
    (best.mae_bolivia_monthly_total >= base.mae_bolivia_monthly_total
      ? "Pero para el <b>total mensual de Bolivia</b> no mejora a la climatología: su valor está en ubicar <i>dónde</i>, no en cuánto en total."
      : "También mejora el error del total mensual de Bolivia.")
  );
  return items.map((t) => `<li>${t}</li>`).join("");
}

function buildMlMetricsTable(ml) {
  const row = (m, rows) => {
    const best = (k, lowIsBetter) => {
      const vals = rows.map((r) => r[k]);
      const target = lowIsBetter ? Math.min(...vals) : Math.max(...vals);
      return m[k] === target ? " class='ml-best'" : "";
    };
    return `<tr><td>${m.model}</td>` +
      `<td${best("poisson_deviance", true)}>${fmtNum(m.poisson_deviance, 3)}</td>` +
      `<td${best("auc_fire_occurrence", false)}>${fmtNum(m.auc_fire_occurrence, 3)}</td>` +
      `<td${best("mae_bolivia_monthly_total", true)}>${fmtNum(m.mae_bolivia_monthly_total, 0)}</td>` +
      `<td>${m.total_bias_pct > 0 ? "+" : ""}${fmtNum(m.total_bias_pct, 1)} %</td></tr>`;
  };
  const block = (title, rows) =>
    `<tr class="ml-sep"><td colspan="5">${title}</td></tr>` + rows.map((m) => row(m, rows)).join("");
  return `
    <table class="ml-table">
      <thead><tr>
        <th>Modelo</th>
        <th title="Error para conteos; menor es mejor">Deviance ↓</th>
        <th title="Capacidad de distinguir celda-mes con y sin fuego; mayor es mejor">AUC ↑</th>
        <th title="Error absoluto medio del total mensual de Bolivia (celdas-día)">Error total mes ↓</th>
        <th>Sesgo total</th>
      </tr></thead>
      <tbody>
        ${block(`Prueba fuera de muestra ${ml.test_years[0]}–${ml.test_years[1]} (MODIS Aqua)`, ml.metrics_test)}
        ${block(`Pronóstico ${ml.forecast_year} ene–oct (provisional, VIIRS armonizado)`, ml.metrics_forecast_2026_provisional)}
      </tbody>
    </table>`;
}

function renderMlEffectsChart(ml) {
  const dom = document.getElementById("chartMlEffects");
  if (!dom) return;
  if (!chartMlEffects) chartMlEffects = echarts.init(dom);

  const series = [];
  [["occurrence", "¿Hay fuego? (odds ratio)", -5], ["intensity", "Si hay fuego, ¿cuánto? (razón de tasas)", 5]]
    .forEach(([part, name, dx]) => {
      const terms = ML_YS_TERMS.map((t) => mlTerm(part, t));
      const color = ML_COLORS[part];
      series.push({
        name, type: "line", color, symbolSize: 8, lineStyle: { width: 2 },
        data: [1, ...terms.map((t) => t.ratio)],
        z: 3
      });
      // Barras de error: intervalo de confianza del 95 %
      series.push({
        name, type: "custom", color, z: 2, tooltip: { show: false },
        data: terms.map((t, i) => [i + 1, t.ci_low, t.ci_high]),
        renderItem: (params, api) => {
          const lo = api.coord([api.value(0), api.value(1)]);
          const hi = api.coord([api.value(0), api.value(2)]);
          const x = lo[0] + dx;
          const st = { stroke: color, lineWidth: 1.5 };
          return {
            type: "group",
            children: [
              { type: "line", shape: { x1: x, y1: lo[1], x2: x, y2: hi[1] }, style: st },
              { type: "line", shape: { x1: x - 3, y1: lo[1], x2: x + 3, y2: lo[1] }, style: st },
              { type: "line", shape: { x1: x - 3, y1: hi[1], x2: x + 3, y2: hi[1] }, style: st }
            ]
          };
        }
      });
    });

  chartMlEffects.setOption({
    animation: false,
    textStyle: { fontFamily: "Sora, sans-serif" },
    title: { text: "Años desde el último fuego en la celda", left: 0, top: 0, textStyle: { fontSize: 11, fontWeight: 600 } },
    legend: { top: 18, left: 0, itemWidth: 14, textStyle: { fontSize: 9.5 }, data: series.filter((s) => s.type === "line").map((s) => s.name) },
    grid: { left: 40, right: 12, top: 52, bottom: 38 },
    tooltip: {
      ...TOOLTIP_STYLE,
      trigger: "axis",
      formatter: (ps) => {
        const i = ps[0].dataIndex;
        let html = `<b>${ML_YS_LABELS[i].replace("\n", " ")}</b>`;
        ps.filter((p) => p.seriesType === "line").forEach((p) => {
          const part = p.color === ML_COLORS.occurrence ? "occurrence" : "intensity";
          const t = i === 0 ? null : mlTerm(part, ML_YS_TERMS[i - 1]);
          html += `<br>${p.marker}${p.seriesName}: <b>${fmtNum(p.value, 2)}</b>` +
            (t ? ` (IC 95 %: ${fmtNum(t.ci_low, 2)}–${fmtNum(t.ci_high, 2)})` : " (referencia)");
        });
        return html + "<br><span style='color:#94a3b8'>1 = igual que una celda que ardió el año pasado</span>";
      }
    },
    xAxis: { type: "category", data: ML_YS_LABELS, axisLabel: { fontSize: 9, interval: 0 } },
    yAxis: {
      type: "log", min: 0.1, max: 2, logBase: 10,
      axisLabel: { fontSize: 9, formatter: (v) => `${v}×` },
      splitLine: { lineStyle: { color: "#f1f5f9" } }
    },
    series: [
      ...series,
      {
        type: "line", data: [], silent: true,
        markLine: { symbol: "none", silent: true, label: { show: false }, lineStyle: { color: "#94a3b8", type: "dashed" }, data: [{ yAxis: 1 }] }
      }
    ]
  }, true);
  chartMlEffects.resize();
}

function renderMlAoiChart(ml) {
  const dom = document.getElementById("chartMlAoi");
  if (!dom) return;
  if (!chartMlAoi) chartMlAoi = echarts.init(dom);

  const pred = new Array(12).fill(0);
  const clim = new Array(12).fill(0);
  const obs = new Array(12).fill(0);
  state.selectedCells.forEach((cellId) => {
    const c = ml.cells_forecast[cellId];
    if (!c) return;
    for (let m = 0; m < 12; m++) {
      pred[m] += c.pred[m];
      clim[m] += c.clim[m];
      if (c.obs[m] !== null) obs[m] += c.obs[m];
    }
  });
  const lastObs = ml.forecast_observed_through_month;
  const obsData = obs.map((v, m) => (m < lastObs ? Number(v.toFixed(1)) : null));

  chartMlAoi.setOption({
    animation: false,
    textStyle: { fontFamily: "Sora, sans-serif" },
    title: { text: `Área seleccionada · ${ml.forecast_year} (celdas-día por mes)`, left: 0, top: 0, textStyle: { fontSize: 11, fontWeight: 600 } },
    legend: { top: 18, left: 0, itemWidth: 14, textStyle: { fontSize: 9.5 } },
    grid: { left: 44, right: 12, top: 52, bottom: 26 },
    tooltip: { ...TOOLTIP_STYLE, trigger: "axis", valueFormatter: (v) => (v === null || v === undefined ? "sin dato" : fmtNum(v)) },
    xAxis: { type: "category", data: MONTH_NAMES, axisLabel: { fontSize: 9 } },
    yAxis: { type: "value", axisLabel: { fontSize: 9 }, splitLine: { lineStyle: { color: "#f1f5f9" } } },
    series: [
      { name: "Observado (VIIRS armonizado)", type: "bar", color: ML_COLORS.obs, barWidth: "55%", data: obsData },
      { name: "Modelo ML", type: "line", color: ML_COLORS.intensity, symbolSize: 6, lineStyle: { width: 2 }, data: pred.map((v) => Number(v.toFixed(1))) },
      { name: "Climatología", type: "line", color: ML_COLORS.clim, symbol: "none", lineStyle: { width: 1.5, type: "dashed" }, data: clim.map((v) => Number(v.toFixed(1))) }
    ]
  }, true);
  chartMlAoi.resize();
}

function renderMlPanel() {
  const el = document.getElementById("mlView");
  const ml = getMl();
  if (!el) return;
  if (!ml) {
    el.innerHTML = "<p class='rank-help'>No se encontró data/processed/ml_bundle.js. Ejecuta: python scripts/ml_model.py</p>";
    return;
  }

  // El esqueleto se crea una sola vez; luego solo se actualizan los gráficos (el AOI cambia).
  if (!el.dataset.built) {
    el.innerHTML = `
      <ul class="ml-findings">${buildMlFindings(ml)}</ul>
      <div class="ml-charts">
        <div id="chartMlEffects" class="ml-chart" role="img" aria-label="Efecto de los años desde el último fuego sobre la ocurrencia y la intensidad"></div>
        <div id="chartMlAoi" class="ml-chart" role="img" aria-label="Pronóstico 2026 del modelo frente a lo observado en el área seleccionada"></div>
      </div>
      ${buildMlMetricsTable(ml)}
      <p class="rank-help ml-note">
        Unidad: celda de 0,25° × mes. Variables: normal histórico de la celda, fuego el mismo mes del año anterior,
        años desde el último fuego y fuego en celdas vecinas, todas con datos <b>solo hasta el año anterior</b>.
        Entrenado en ${ml.train_years[0]}–${ml.train_years[1]}, probado en ${ml.test_years[0]}–${ml.test_years[1]}.
        Las celdas-día miden duración/extensión del fuego, no área quemada. El pronóstico ${ml.forecast_year} usa historia derivada de VIIRS
        (más sensible) y es provisional. Detalles en docs/METODO.md. Activa <b>“Riesgo ML 2026”</b> en el mapa para ver el pronóstico por celda.
      </p>`;
    el.dataset.built = "1";
    chartMlEffects = null;
    chartMlAoi = null;
  }
  renderMlEffectsChart(ml);
  renderMlAoiChart(ml);
}

/* =========================================================================
 * 6. Calendario Térmico Interactivo con ECharts
 * ========================================================================= */
function renderCalendarChart() {
  const dom = document.getElementById("chartCalendar");
  if (!dom) return;

  if (!chartCalendar) {
    chartCalendar = echarts.init(dom);
    chartCalendar.on("click", (params) => {
      if (params.value && params.value.length === 3) {
        const yLabel = chartCalendar._yearsList[params.value[1]];
        setFocus(parseInt(yLabel, 10), params.value[0] + 1);
      }
    });
  }

  const years = [];
  for (let y = state.yearStart; y <= state.yearEnd; y++) years.push(String(y));
  chartCalendar._yearsList = years;

  const hist = computeHistoricalStatsByMonth();
  const data = [];
  let maxVal = 0;

  years.forEach((yStr, yIdx) => {
    const y = parseInt(yStr, 10);
    for (let m = 1; m <= 12; m++) {
      if (y === 2026 && m > 10) continue;
      const bucket = state.currentSeriesByYm.get(ymKey(y, m));
      const val = bucket ? bucket.harm : 0;
      if (val > maxVal) maxVal = val;
      data.push([m - 1, yIdx, round1(val)]);
    }
  });

  const option = {
    backgroundColor: "#ffffff",
    tooltip: {
      ...TOOLTIP_STYLE,
      position: "top",
      formatter: (p) => {
        const mNum = p.value[0] + 1;
        const year = parseInt(years[p.value[1]], 10);
        const val = p.value[2];
        const status = classifyVsNormal(val, hist[mNum]);
        const b = state.currentSeriesByYm.get(ymKey(year, mNum));
        return `
          <div style="font-weight:700;margin-bottom:3px">${MONTH_FULL_NAMES[mNum - 1]} ${year}</div>
          <div><b>${fmtDays(val)}</b> días con fuego</div>
          <div style="color:${status.color}">${status.label}</div>
          ${b && b.hasNrt ? "<div style='color:#94a3b8;font-size:10px'>Dato provisional</div>" : ""}`;
      }
    },
    grid: { top: 8, bottom: 58, left: 46, right: 12 },
    xAxis: {
      type: "category",
      data: MONTH_NAMES,
      splitArea: { show: false },
      axisLine: { show: false },
      axisLabel: { color: "#475569", fontSize: 11, fontFamily: "Sora" },
      axisTick: { show: false }
    },
    yAxis: {
      type: "category",
      data: years,
      splitArea: { show: false },
      axisLine: { show: false },
      axisLabel: { color: "#0f172a", fontSize: 11, fontFamily: "Sora", fontWeight: 600 },
      axisTick: { show: false }
    },
    visualMap: {
      min: 0,
      max: maxVal > 0 ? maxVal : 100,
      calculable: false,
      orient: "horizontal",
      left: "center",
      bottom: 4,
      itemWidth: 12,
      itemHeight: 160,
      text: ["Más fuego", "Menos fuego"],
      inRange: { color: CAL_RAMP },
      textStyle: { color: "#64748b", fontSize: 11, fontFamily: "Sora" }
    },
    series: [
      {
        name: "Días con fuego",
        type: "heatmap",
        data,
        label: { show: false },
        itemStyle: { borderWidth: 1, borderColor: "#ffffff" },
        emphasis: {
          itemStyle: { borderColor: "#0f172a", borderWidth: 1.5 }
        }
      }
    ]
  };

  chartCalendar.setOption(option, true);
}

/* =========================================================================
 * 7. Descarga CSV y Controles de Interfaz
 * ========================================================================= */
function syncFocusMonthOptions() {
  const focusMSel = document.getElementById("focusMonth");
  if (!focusMSel) return;
  const is2026 = state.focusYear === 2026;
  Array.from(focusMSel.options).forEach((opt) => {
    const mVal = parseInt(opt.value, 10);
    if (mVal > 10) {
      opt.disabled = is2026;
    }
  });
}

function triggerCsvDownload(filename, csvContent) {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadAoiSeriesCsv() {
  const histStats = computeHistoricalStatsByMonth();
  const rows = [[
    "year",
    "month",
    "count_harmonized_aqua_eq",
    "count_raw_aqua",
    "count_raw_snpp",
    "historical_median_2003_2025",
    "historical_p25",
    "historical_p75",
    "anomaly_pct_vs_median",
    "source",
    "aoi_preset",
    "selected_cells"
  ]];
  const count = state.selectedCells.size;

  state.currentSeriesByYm.forEach((val, ym) => {
    const [yStr, mStr] = ym.split("-");
    const y = parseInt(yStr, 10);
    const m = parseInt(mStr, 10);
    if (y < state.yearStart || y > state.yearEnd) return;

    const mStat = histStats[m] || { median: 0, p25: 0, p75: 0 };
    const anomPct = mStat.median > 0
      ? (((val.harm - mStat.median) / mStat.median) * 100.0).toFixed(2)
      : "";

    let src = "modis_aqua";
    if (y === 2020 && (m === 8 || m === 9)) src = "snpp_harmonized_outage";
    else if (y >= 2022) src = val.hasNrt ? "snpp_harmonized_nrt" : "snpp_harmonized";

    rows.push([
      y,
      m,
      val.harm.toFixed(2),
      val.aqua !== null ? val.aqua : "",
      val.snpp !== null ? val.snpp : "",
      mStat.median.toFixed(2),
      mStat.p25.toFixed(2),
      mStat.p75.toFixed(2),
      anomPct,
      src,
      state.preset,
      count
    ]);
  });

  const csv = rows.map((r) => r.join(",")).join("\n");
  triggerCsvDownload(`pixfire_bolivia_aoi_${state.preset}_${state.yearStart}_${state.yearEnd}.csv`, csv);
}

/** CSV con el detalle por celda y mes (solo celdas del área y años del rango). */
function downloadCellsCsv() {
  const header = [
    "cell_id", "lat_center", "lon_center", "subregion", "year", "month",
    "count_harmonized", "count_raw_aqua", "count_raw_snpp", "source"
  ];
  const rows = [];
  state.selectedCells.forEach((cellId) => {
    const cell = state.cellsMeta.get(cellId);
    if (!cell) return;
    for (const r of cell.records) {
      if (r.year < state.yearStart || r.year > state.yearEnd) continue;
      rows.push([
        cell.cellId,
        cell.lat.toFixed(3),
        cell.lon.toFixed(3),
        cell.subregion,
        r.year,
        r.month,
        r.harm,
        r.aqua !== null ? r.aqua : "",
        r.snpp !== null ? r.snpp : "",
        r.source
      ]);
    }
  });
  // Orden cronológico y luego por celda
  rows.sort((a, b) => a[4] - b[4] || a[5] - b[5] || String(a[0]).localeCompare(String(b[0])));
  const csv = [header, ...rows].map((r) => r.join(",")).join("\n");
  triggerCsvDownload(`pixfire_bolivia_celdas_${state.preset}_${state.yearStart}_${state.yearEnd}.csv`, csv);
}

/** Descarga el gráfico visible (calendario, serie o ciclo) como PNG. */
function downloadActiveChartPng() {
  const charts = { calendar: chartCalendar, series: chartSeries, seasonal: chartSeasonal };
  const chart = charts[state.activeView];
  if (!chart) return;
  const url = chart.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: "#ffffff" });
  const a = document.createElement("a");
  a.href = url;
  a.download = `pixfire_bolivia_${state.activeView}_${state.preset}_${state.yearStart}_${state.yearEnd}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function resetToPreset(preset) {
  state.preset = preset;
  if (drawnItems) drawnItems.clearLayers();
  state.customPolygon = null;

  const sel = document.getElementById("presetRegion");
  if (sel) sel.value = preset;

  if (map) {
    if (preset === "all") map.setView([-16.4, -64.2], 5);
    else if (preset === "chiquitania") map.setView([-17.5, -60.8], 6);
    else if (preset === "amazonia") map.setView([-12.5, -66.5], 6);
    else if (preset === "andina") map.setView([-18.5, -66.5], 6);
  }

  recomputeAoiSelection();
}

function populateYearSelectors() {
  const yStartSel = document.getElementById("yearStart");
  const yEndSel = document.getElementById("yearEnd");
  const focusYearSel = document.getElementById("focusYear");

  if (!yStartSel || !yEndSel || !focusYearSel) return;

  for (let y = 2003; y <= 2026; y++) {
    yStartSel.add(new Option(String(y), String(y), y === 2003, y === 2003));
    yEndSel.add(new Option(String(y), String(y), y === 2026, y === 2026));
    focusYearSel.add(new Option(String(y), String(y), y === 2026, y === 2026));
  }
}

/** Lee el formulario de coordenadas, valida y aplica el rectángulo como AOI. */
function applyCoordForm(e) {
  e.preventDefault();
  const read = (id) => parseFloat(document.getElementById(id).value);
  const latMin = read("latMin");
  const latMax = read("latMax");
  const lonMin = read("lonMin");
  const lonMax = read("lonMax");

  const warnBar = document.getElementById("aoiWarning");
  const warnTxt = document.getElementById("aoiWarningText");
  const showError = (msg) => {
    if (warnBar && warnTxt) {
      warnTxt.textContent = msg;
      warnBar.classList.remove("hidden");
    }
  };

  if ([latMin, latMax, lonMin, lonMax].some((v) => Number.isNaN(v))) {
    showError("Completa las cuatro coordenadas (latitud y longitud mínimas y máximas).");
    return;
  }
  if (latMin >= latMax || lonMin >= lonMax) {
    showError("El mínimo debe ser menor que el máximo en latitud y en longitud.");
    return;
  }
  if (latMin < -90 || latMax > 90 || lonMin < -180 || lonMax > 180) {
    showError("Coordenadas fuera de rango: latitud entre -90 y 90, longitud entre -180 y 180.");
    return;
  }
  applyCustomBbox(lonMin, latMin, lonMax, latMax);
}

function bindEvents() {
  const presetSel = document.getElementById("presetRegion");
  if (presetSel) {
    presetSel.addEventListener("change", (e) => {
      resetToPreset(e.target.value);
    });
  }

  const resetBtn = document.getElementById("btnResetAoi");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      resetToPreset("all");
    });
  }

  const yStartSel = document.getElementById("yearStart");
  if (yStartSel) {
    yStartSel.addEventListener("change", (e) => {
      state.yearStart = parseInt(e.target.value, 10);
      if (state.yearStart > state.yearEnd) {
        state.yearEnd = state.yearStart;
        document.getElementById("yearEnd").value = String(state.yearEnd);
      }
      renderMapGrid();
      updateAllViews();
    });
  }

  const yEndSel = document.getElementById("yearEnd");
  if (yEndSel) {
    yEndSel.addEventListener("change", (e) => {
      state.yearEnd = parseInt(e.target.value, 10);
      if (state.yearEnd < state.yearStart) {
        state.yearStart = state.yearEnd;
        document.getElementById("yearStart").value = String(state.yearStart);
      }
      renderMapGrid();
      updateAllViews();
    });
  }

  const focusYSel = document.getElementById("focusYear");
  if (focusYSel) {
    focusYSel.addEventListener("change", (e) => {
      state.focusYear = parseInt(e.target.value, 10);
      if (state.focusYear === 2026 && state.focusMonth > 10) {
        state.focusMonth = 10;
        document.getElementById("focusMonth").value = "10";
      }
      setFocus(state.focusYear, state.focusMonth);
    });
  }

  const focusMSel = document.getElementById("focusMonth");
  if (focusMSel) {
    focusMSel.addEventListener("change", (e) => {
      state.focusMonth = parseInt(e.target.value, 10);
      if (state.focusYear === 2026 && state.focusMonth > 10) {
        state.focusYear = 2025;
        document.getElementById("focusYear").value = "2025";
      }
      setFocus(state.focusYear, state.focusMonth);
    });
  }

  syncFocusMonthOptions();

  // Menú "Descargar": cada opción descarga y cierra el menú
  const menu = document.getElementById("downloadMenu");
  const bindDownload = (id, fn) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener("click", () => {
      fn();
      if (menu) menu.open = false;
    });
  };
  bindDownload("btnDownloadSeries", downloadAoiSeriesCsv);
  bindDownload("btnDownloadCells", downloadCellsCsv);
  bindDownload("btnPng", downloadActiveChartPng);
  document.addEventListener("click", (e) => {
    if (menu && menu.open && !menu.contains(e.target)) menu.open = false;
  });

  // Botón "?": explica qué es un "día con fuego"
  const infoBtn = document.getElementById("btnInfoUnit");
  const infoPop = document.getElementById("infoUnit");
  if (infoBtn && infoPop) {
    infoBtn.addEventListener("click", () => {
      const nowHidden = infoPop.classList.toggle("hidden");
      infoBtn.setAttribute("aria-expanded", nowHidden ? "false" : "true");
      refreshSizes();
    });
  }

  // "Ver cómo": abre Evolución mostrando la corrección entre satélites
  const trustBtn = document.getElementById("btnTrust");
  if (trustBtn) {
    trustBtn.addEventListener("click", () => {
      state.compareSensors = true;
      const chk = document.getElementById("chkCompare");
      if (chk) chk.checked = true;
      switchView("series");
    });
  }

  const chkCompare = document.getElementById("chkCompare");
  if (chkCompare) chkCompare.addEventListener("change", (e) => setCompareSensors(e.target.checked));

  const coordDetails = document.getElementById("coordDetails");
  if (coordDetails) coordDetails.addEventListener("toggle", refreshSizes);

  document.querySelectorAll(".map-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => setMapMode(btn.dataset.mode));
  });

  const coordForm = document.getElementById("coordForm");
  if (coordForm) coordForm.addEventListener("submit", applyCoordForm);

  const playBtn = document.getElementById("btnPlay");
  if (playBtn) {
    playBtn.addEventListener("click", () => {
      if (state.animTimer) stopAnimation();
      else startAnimation();
    });
  }

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  window.addEventListener("resize", refreshSizes);
}

/** Reajusta gráficos y mapa cuando cambia el espacio disponible. */
function refreshSizes() {
  [chartCalendar, chartSeries, chartSeasonal, chartMlEffects, chartMlAoi].forEach((c) => {
    if (c) c.resize();
  });
  if (map) map.invalidateSize();
}

(async function initApp() {
  try {
    populateYearSelectors();
    initMap();
    bindEvents();
    initMlControls();
    await loadAllData();
    recomputeAoiSelection();
  } catch (err) {
    console.error("Error inicializando la aplicación:", err);
    const warnBar = document.getElementById("aoiWarning");
    const warnTxt = document.getElementById("aoiWarningText");
    if (warnBar && warnTxt) {
      warnTxt.textContent = "Error al inicializar datos: " + (err.message || err);
      warnBar.classList.remove("hidden");
    }
  }
})();
