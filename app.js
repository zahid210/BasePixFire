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

// Textos según el idioma (i18n.js). Se recalculan al cambiar ES/EN en refreshLangConstants().
let MONTH_NAMES = t("months.short");
let MONTH_FULL_NAMES = t("months.full");

// Rampa única del calendario: de claro (poco fuego) a oscuro (mucho fuego)
const CAL_RAMP = ["#fff7ed", "#fed7aa", "#fb923c", "#ea580c", "#b91c1c", "#7c2d12"];

/** Nombre de la zona (all, chiquitania, amazonia, andina, custom) en el idioma actual. */
function zoneName(preset) {
  return t(`zone.${preset}`);
}

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
  activeView: "calendar", // calendar | harm | series | seasonal | ranking | ml
  mapMode: "period", // period (promedio del rango) | month (mes evaluado) | ml (proyección ML)
  mlYear: 2030, // año de la proyección ML que se pinta en el mapa
  gridRes: "0.25", // tamaño de celda en grados: "0.25" | "0.10" | "0.05"
  baseMeta: null,
  baseCells025: null,
  gridCache: new Map(),
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
let chartMlPower = null;
let chartMlProjection = null;
let chartHarmFactors = null;
let chartHarmValidation = null;
let layersControl = null; // control de capas (se rehace al cambiar de idioma)
let drawControl = null; // herramientas de dibujo (se rehacen al cambiar de idioma)
let baseLayers = null;

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
  return Number(v).toLocaleString(t("locale"), { maximumFractionDigits: digits });
}

/** "Días con fuego" (celdas-día): sin decimales cuando el número es grande. */
function fmtDays(v) {
  return fmtNum(v, Math.abs(v) >= 100 ? 0 : 1);
}

/** Compara un valor con lo habitual de ese mes (rango P25–P75 de 2003–2025). */
function classifyVsNormal(value, stat) {
  if (value > stat.p75) return { key: "high", label: t("status.high"), color: "#fdba74" };
  if (value < stat.p25) return { key: "low", label: t("status.low"), color: "#5eead4" };
  return { key: "normal", label: t("status.normal"), color: "#cbd5e1" };
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/* =========================================================================
 * 1. Carga y parseo de datos estáticos (Universal: HTTP o local file://)
 * ========================================================================= */
async function loadAllData(resKey) {
  if (resKey) state.gridRes = resKey;
  const r = state.gridRes || "0.25";
  const cs = parseFloat(r);

  if (!state.baseCells025) {
    let rawMeta = null;
    let cellsText = null;
    let valText = null;

    if (window.PIXFIRE_DATA && window.PIXFIRE_DATA.meta && window.PIXFIRE_DATA.cellsCsv) {
      rawMeta = window.PIXFIRE_DATA.meta;
      cellsText = window.PIXFIRE_DATA.cellsCsv;
      valText = window.PIXFIRE_DATA.valCsv;
    } else {
      const [metaResp, cellsResp, valResp] = await Promise.all([
        fetch("data/processed/metadata.json"),
        fetch("data/processed/monthly_cells.csv"),
        fetch("data/processed/validation.csv")
      ]);
      rawMeta = await metaResp.json();
      cellsText = await cellsResp.text();
      valText = await valResp.text();
    }

    state.baseMeta = rawMeta;
    state.baseCells025 = parseBaseCells025(cellsText);
    parseValidationCsv(valText);
  }

  state.meta = {
    ...state.baseMeta,
    cell_size_deg: cs
  };

  if (!state.gridCache.has(r)) {
    state.gridCache.set(r, buildContinuousGrid(cs));
  }
  const cached = state.gridCache.get(r);
  state.cellsMeta = cached.cellsMeta;
  state.subregionTotals = cached.subregionTotals;
}

function classifySubregion(lat, lon) {
  if (lon <= -64.0 && lat < -14.0) return "andina_valles";
  if (lat >= -14.0) return "amazonia_beni_norte";
  return "chiquitania_llanos";
}

function parseBaseCells025(csvText) {
  const baseMap = new Map();
  const cellSize = 0.25;
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

    let cellObj = baseMap.get(cellId);
    if (!cellObj) {
      const [rStr, cStr] = cellId.split("_");
      const row = parseInt(rStr, 10);
      const col = parseInt(cStr, 10);
      const lat = (row + 0.5) * cellSize - 90.0;
      const lon = (col + 0.5) * cellSize - 180.0;
      const subregion = classifySubregion(lat, lon);
      cellObj = {
        cellId,
        parentCellId: cellId,
        row,
        col,
        lat,
        lon,
        subregion,
        totalHarm: 0,
        records: [],
        byYm: new Map(),
        densityFactor: 1.0,
        areaWeight: 1.0
      };
      baseMap.set(cellId, cellObj);
    }

    const rec = { cellId, year, month, harm, aqua, snpp, source };
    cellObj.totalHarm += harm;
    cellObj.records.push(rec);
    cellObj.byYm.set(ymKey(year, month), harm);
  }
  return baseMap;
}

/**
 * Construye una grilla 100% continua sin bloques separados ni filas/columnas vacías
 * para la resolución seleccionada (`0.25°`, `0.10°`, `0.05°`), aplicando interpolación
 * espacial IDW entre celdas vecinas de 0.25° para transiciones suaves.
 */
function buildContinuousGrid(cs) {
  const baseMap = state.baseCells025;
  const subregionTotals = {
    chiquitania_llanos: 0,
    amazonia_beni_norte: 0,
    andina_valles: 0
  };
  baseMap.forEach((b) => {
    subregionTotals[b.subregion] = (subregionTotals[b.subregion] || 0) + b.totalHarm;
  });

  if (Math.abs(cs - 0.25) < 1e-6) {
    return { cellsMeta: baseMap, subregionTotals };
  }

  // Índice espacial rápido por (row_025, col_025)
  const rcIndex = new Map();
  baseMap.forEach((b) => {
    rcIndex.set(`${b.row}_${b.col}`, b);
  });

  const subCells = new Map();
  const baseHalf = 0.125;

  // 1. Generar todas las subceldas que intersectan cada celda de 0.25° activa
  baseMap.forEach((b) => {
    const latMin = b.lat - baseHalf;
    const latMax = b.lat + baseHalf;
    const lonMin = b.lon - baseHalf;
    const lonMax = b.lon + baseHalf;

    const rMin = Math.floor((latMin + 90.0 + 1e-9) / cs);
    const rMax = Math.floor((latMax + 90.0 - 1e-9) / cs);
    const cMin = Math.floor((lonMin + 180.0 + 1e-9) / cs);
    const cMax = Math.floor((lonMax + 180.0 - 1e-9) / cs);

    const children = [];
    for (let r = rMin; r <= rMax; r++) {
      const sLat = +((r + 0.5) * cs - 90.0).toFixed(4);
      for (let c = cMin; c <= cMax; c++) {
        const sLon = +((c + 0.5) * cs - 180.0).toFixed(4);
        const sId = `${r}_${c}`;
        let sub = subCells.get(sId);
        if (!sub) {
          sub = {
            cellId: sId,
            parentCellId: b.cellId,
            baseCell: b,
            row: r,
            col: c,
            lat: sLat,
            lon: sLon,
            subregion: classifySubregion(sLat, sLon),
            totalHarm: b.totalHarm,
            records: b.records,
            byYm: b.byYm,
            densityFactor: 1.0,
            areaWeight: 1.0,
            _rawGrad: 1.0
          };
          subCells.set(sId, sub);
          children.push(sub);
        } else {
          // Si una subcelda de 0.10° cae en el borde entre dos celdas de 0.25°,
          // se asocia a la celda padre cuyo centro esté más cerca.
          const dCurr = Math.hypot(sLat - sub.baseCell.lat, sLon - sub.baseCell.lon);
          const dNew = Math.hypot(sLat - b.lat, sLon - b.lon);
          if (dNew < dCurr) {
            sub.parentCellId = b.cellId;
            sub.baseCell = b;
            sub.records = b.records;
            sub.byYm = b.byYm;
            sub.totalHarm = b.totalHarm;
          }
        }
      }
    }
    b._children = children;
  });

  // 2. Agrupar hijos finales por celda base y calcular interpolación espacial IDW 3x3
  baseMap.forEach((b) => {
    b._children = [];
  });
  subCells.forEach((sub) => {
    sub.baseCell._children.push(sub);
  });

  baseMap.forEach((b) => {
    const kids = b._children;
    if (!kids || !kids.length) return;

    // Recolectar vecindario 3x3 de celdas de 0.25°
    const neighbors = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const nb = rcIndex.get(`${b.row + dr}_${b.col + dc}`);
        if (nb) neighbors.push(nb);
      }
    }

    let sumGrad = 0;
    const baseVal = b.totalHarm + 5.0;
    for (const sub of kids) {
      let wSum = 0;
      let valSum = 0;
      for (const nb of neighbors) {
        const dist = Math.hypot(sub.lat - nb.lat, sub.lon - nb.lon);
        const w = 1.0 / Math.pow(Math.max(0.03, dist), 1.6);
        wSum += w;
        valSum += w * (nb.totalHarm + 5.0);
      }
      const interp = wSum > 0 ? valSum / wSum : baseVal;
      // Mezcla suave entre el valor de la celda padre y el gradiente vecino
      const rawFactor = Math.max(0.35, Math.min(1.85, 0.55 + 0.45 * (interp / baseVal)));
      sub._rawGrad = rawFactor;
      sumGrad += rawFactor;
    }

    const nKids = kids.length;
    const meanGrad = sumGrad / nKids;
    for (const sub of kids) {
      // densityFactor tiene promedio 1.0 dentro de la celda padre (mantiene la escala visual de colores)
      sub.densityFactor = meanGrad > 0 ? sub._rawGrad / meanGrad : 1.0;
      // areaWeight suma 1.0 dentro de la celda padre (conserva el conteo total de focos al agregar)
      sub.areaWeight = sumGrad > 0 ? sub._rawGrad / sumGrad : 1.0 / nKids;
      sub.totalHarm = b.totalHarm * sub.areaWeight;
    }
    delete b._children;
  });

  return { cellsMeta: subCells, subregionTotals };
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
  baseLayers = { light: lightLayer, sat: satLayer };
  buildLayersControl();

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
    buildDrawControl();

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

/** Control de capas (mapa claro / satélite) con los nombres en el idioma actual. */
function buildLayersControl() {
  if (!map || !baseLayers) return;
  if (layersControl) map.removeControl(layersControl);
  layersControl = L.control
    .layers({ [t("map.layer.light")]: baseLayers.light, [t("map.layer.sat")]: baseLayers.sat }, null, { position: "topleft" })
    .addTo(map);
}

/** Herramientas de dibujo con los textos en el idioma actual (Leaflet.draw lee L.drawLocal al crearlas). */
function buildDrawControl() {
  if (!map || typeof L.Control.Draw === "undefined") return;
  if (L.drawLocal) {
    const d = L.drawLocal;
    d.draw.toolbar.buttons.polygon = t("draw.polygon");
    d.draw.toolbar.buttons.rectangle = t("draw.rectangle");
    d.draw.toolbar.actions.text = t("draw.cancel");
    d.draw.toolbar.finish.text = t("draw.finish");
    d.draw.toolbar.undo.text = t("draw.undo");
    d.draw.handlers.polygon.tooltip.start = t("draw.poly.start");
    d.draw.handlers.polygon.tooltip.cont = t("draw.poly.cont");
    d.draw.handlers.polygon.tooltip.end = t("draw.poly.end");
    d.draw.handlers.rectangle.tooltip.start = t("draw.rect.start");
    d.draw.handlers.simpleshape.tooltip.end = t("draw.shape.end");
    d.edit.toolbar.buttons.edit = t("draw.edit");
    d.edit.toolbar.buttons.editDisabled = t("draw.editDisabled");
    d.edit.toolbar.buttons.remove = t("draw.remove");
    d.edit.toolbar.buttons.removeDisabled = t("draw.removeDisabled");
    d.edit.toolbar.actions.save.text = t("draw.save");
    d.edit.toolbar.actions.cancel.text = t("draw.cancel");
    d.edit.toolbar.actions.clearAll.text = t("draw.clearAll");
  }
  if (drawControl) map.removeControl(drawControl);
  drawControl = new L.Control.Draw({
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
}

/* Escalas de color del mapa, descritas con palabras (title/label son claves de i18n.js).
 * "Días con fuego" = celdas-día (ver docs/METODO.md). */
const MAP_SCALES = {
  period: {
    title: "scale.period.title",
    classes: [
      { min: 25, color: "#b91c1c", label: "scale.vhigh" },
      { min: 10, color: "#ea580c", label: "scale.high" },
      { min: 2, color: "#fb923c", label: "scale.mid" },
      { min: -Infinity, color: "#fed7aa", label: "scale.low" }
    ]
  },
  month: {
    title: "scale.month.title",
    classes: [
      { min: 15, color: "#7c2d12", label: "scale.m15" },
      { min: 7, color: "#b91c1c", label: "scale.m7" },
      { min: 3, color: "#ea580c", label: "scale.m3" },
      { min: 0, color: "#fdba74", label: "scale.m1" },
      { min: -Infinity, color: "#cbd5e1", label: "scale.none" }
    ]
  },
  ml: {
    title: "scale.ml.title",
    classes: [
      { min: 25, color: "#b91c1c", label: "scale.vhigh" },
      { min: 10, color: "#ea580c", label: "scale.high" },
      { min: 2, color: "#fb923c", label: "scale.mid" },
      { min: -Infinity, color: "#fed7aa", label: "scale.low" }
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
  const df = cell.densityFactor !== undefined ? cell.densityFactor : 1.0;
  if (state.mapMode === "ml") return getMlCellAnnual(cell.cellId);
  if (state.mapMode === "month") {
    return (cell.byYm.get(ymKey(state.focusYear, state.focusMonth)) || 0) * df;
  }
  const base = cell.baseCell || cell;
  if (base._periodRangeKey === state._periodRangeKey && base._periodAvg !== undefined) {
    return base._periodAvg * df;
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
  const avg = periodHarm / numYears;
  base._periodRangeKey = state._periodRangeKey;
  base._periodAvg = avg;
  return avg * df;
}

function cellTooltipHtml(cell) {
  const v = getCellMapValue(cell);
  const body = state.mapMode === "ml"
    ? t("tip.ml", { year: state.mlYear, v: fmtDays(v) })
    : state.mapMode === "month"
    ? t("tip.month", { month: MONTH_FULL_NAMES[state.focusMonth - 1], year: state.focusYear, v: fmtDays(v) })
    : t("tip.period", { from: state.yearStart, to: state.yearEnd, v: fmtDays(v) });
  return body + `<br><span style='color:#64748b'>${t("tip.click")}</span>`;
}

/**
 * Pinta la grilla. Los rectángulos se crean una sola vez y luego solo se
 * actualiza su estilo (necesario para que la animación mes a mes sea fluida).
 */
function renderMapGrid() {
  if (!gridLayerGroup || !state.meta) return;
  const cs = state.meta.cell_size_deg;
  const half = cs / 2.0;
  const mode = state.mapMode;

  state._periodRangeKey = `${state.yearStart}_${state.yearEnd}`;
  if (mode === "period" && state.baseCells025) {
    let activeMonths = 0;
    for (let y = state.yearStart; y <= state.yearEnd; y++) {
      activeMonths += y === 2026 ? 10 : 12;
    }
    const numYears = Math.max(0.833, activeMonths / 12.0);
    state.baseCells025.forEach((b) => {
      if (b._periodRangeKey !== state._periodRangeKey) {
        let periodHarm = 0;
        for (const r of b.records) {
          if (r.year >= state.yearStart && r.year <= state.yearEnd) periodHarm += r.harm;
        }
        b._periodAvg = periodHarm / numYears;
        b._periodRangeKey = state._periodRangeKey;
      }
    });
  }

  const selWeight = cs < 0.25 ? 0.35 : 0.75;
  const unselWeight = cs < 0.25 ? 0.1 : 0.25;

  state.cellsMeta.forEach((cell) => {
    let rect = cellLayers.get(cell.cellId);
    if (!rect) {
      rect = L.rectangle(
        [[cell.lat - half, cell.lon - half], [cell.lat + half, cell.lon + half]],
        { weight: unselWeight }
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
      color: isSelected ? fillColor : (cs < 0.25 ? fillColor : "#cbd5e1"),
      weight: isSelected ? selWeight : unselWeight,
      fillColor,
      fillOpacity: noFire ? (isSelected ? 0.12 : 0.05) : isSelected ? 0.68 : 0.12
    });
  });

  updateMapLegend();
}

function updateMapLegend() {
  const el = document.getElementById("mapLegend");
  if (!el) return;
  const scale = MAP_SCALES[state.mapMode];
  const when = state.mapMode === "ml"
    ? t("legend.ml", { year: state.mlYear })
    : state.mapMode === "month"
    ? `${MONTH_FULL_NAMES[state.focusMonth - 1]} ${state.focusYear}`
    : t("legend.period", { from: state.yearStart, to: state.yearEnd });
  el.innerHTML =
    `<div class="legend-when">${when}</div>` +
    `<div class="legend-title">${t(scale.title)}</div>` +
    scale.classes
      .map((c) => `<div class="legend-row"><i style="background:${c.color}"></i>${t(c.label)}</div>`)
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
  state.animTimer = setInterval(() => {
    const [y, m] = nextMonth(state.focusYear, state.focusMonth);
    setFocus(y, m);
  }, 700);
  updatePlayButton();
}

/** Texto del botón Animar/Pausa según el estado y el idioma. */
function updatePlayButton() {
  const btn = document.getElementById("btnPlay");
  if (!btn) return;
  const playing = Boolean(state.animTimer);
  btn.classList.toggle("playing", playing);
  btn.textContent = playing ? t("map.pause") : t("map.play");
  btn.setAttribute("aria-label", playing ? t("map.pause.aria") : t("map.play.aria"));
}

function stopAnimation() {
  if (state.animTimer) {
    clearInterval(state.animTimer);
    state.animTimer = null;
  }
  updatePlayButton();
}

/* -------------------------------------------------------------------------
 * Popup de celda: mini-gráfico de su historia anual y selección como AOI
 * ------------------------------------------------------------------------- */

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
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${t("cp.spark.aria")}">${bars}</svg>`;
}

function openCellPopup(cell, latlng) {
  if (isDrawing || !map) return;

  const df = cell.densityFactor !== undefined ? cell.densityFactor : 1.0;
  const years = [];
  for (let y = 2003; y <= 2026; y++) years.push(y);
  const totals = years.map(() => 0);
  for (const r of cell.records) totals[r.year - 2003] += r.harm * df;

  const full = totals.slice(0, totals.length - 1); // 2003–2025 (años completos)
  const peakIdx = full.indexOf(Math.max(...full));
  const avg = full.reduce((a, b) => a + b, 0) / full.length;
  const cs = state.meta ? state.meta.cell_size_deg : 0.25;
  const kmLabel = cs <= 0.05 ? fmtNum(5.5, 1) : cs <= 0.10 ? "11" : "27";

  const div = document.createElement("div");
  div.className = "cell-popup";
  div.innerHTML = `
    <div class="cp-title">${t("cp.title")}</div>
    <div class="cp-sub">${t(`sub.${cell.subregion}`)} · ${t("cp.square.km", { km: kmLabel })}</div>
    ${buildSparklineSvg(totals, years)}
    <div class="cp-axis"><span>2003</span><span>2026*</span></div>
    <div class="cp-stats">
      <div><span>${t("cp.avg")}</span><b>${t("cp.days", { v: fmtDays(avg) })}</b></div>
      <div><span>${t("cp.peak")}</span><b>${years[peakIdx]} (${t("cp.days", { v: fmtDays(full[peakIdx]) })})</b></div>
    </div>
    <div class="cp-note">${t("cp.note")}</div>
    <button type="button" class="btn-action primary cp-btn">${t("cp.btn")}</button>`;

  div.querySelector(".cp-btn").addEventListener("click", () => {
    map.closePopup();
    selectSingleCell(cell);
  });

  L.popup({ maxWidth: 260 }).setLatLng(latlng).setContent(div).openOn(map);
}

function selectSingleCell(cell) {
  const half = state.meta.cell_size_deg / 2.0;
  const margin = Math.min(0.01, half * 0.2);
  // Margen pequeño proporcional para que solo el centro de esta celda quede dentro
  applyCustomBbox(cell.lon - half + margin, cell.lat - half + margin, cell.lon + half - margin, cell.lat + half - margin);
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
      warnings.push(t("warn.outside"));
    }
  }

  if (count === 0) {
    warnings.push(t("warn.empty"));
  } else if (count < 4) {
    warnings.push(t("warn.small"));
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
    const w = cell.areaWeight !== undefined ? cell.areaWeight : 1.0;
    for (const r of cell.records) {
      const ym = `${r.year}-${String(r.month).padStart(2, "0")}`;
      const bucket = state.currentSeriesByYm.get(ym);
      if (!bucket) continue;
      bucket.harm += r.harm * w;
      if (r.aqua !== null) bucket.aqua = (bucket.aqua || 0) + r.aqua * w;
      if (r.snpp !== null) bucket.snpp = (bucket.snpp || 0) + r.snpp * w;
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
  calendar: { title: () => t("view.calendar.title"), help: () => t("view.calendar.help") },
  harm: { title: () => t("view.harm.title"), help: () => t("view.harm.help") },
  series: { title: () => t("view.series.title"), help: () => t("view.series.help") },
  seasonal: { title: () => t("view.seasonal.title", { year: state.focusYear }), help: () => t("view.seasonal.help") },
  ranking: { title: () => t("view.ranking.title"), help: () => t("view.ranking.help") },
  ml: { title: () => t("view.ml.title"), help: () => t("view.ml.help") }
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
  if (pngBtn) pngBtn.disabled = ["ranking", "ml", "harm"].includes(view);
  renderActiveView();
}

/** Dibuja solo la vista visible (ECharts no puede medir un div oculto). */
function renderActiveView() {
  const texts = VIEW_TEXTS[state.activeView];
  if (texts) {
    setText("stageTitle", texts.title());
    setText("stageHelp", texts.help());
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
  } else if (state.activeView === "harm") {
    renderHarmPanel();
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
    addArea(t("series.area.both"), "2012-02", "2021-12", "rgba(15, 118, 110, 0.07)");
    addArea(t("series.area.new"), "2022-01", "2026-10", "rgba(245, 158, 11, 0.10)");
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
      name: compare ? t("series.final") : t("series.days"),
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
        name: t("series.modis"),
        type: "line",
        data: rows.map((r) => (r.aqua === null ? null : r.aqua)),
        showSymbol: false,
        lineStyle: { width: 1.2, color: "#0284c7" },
        itemStyle: { color: "#0284c7" }
      },
      {
        name: t("series.viirsRaw"),
        type: "line",
        data: rows.map((r) => (r.snpp === null ? null : r.snpp)),
        showSymbol: false,
        lineStyle: { width: 1.2, color: "#dc2626", opacity: 0.8 },
        itemStyle: { color: "#dc2626" }
      },
      {
        name: t("series.viirsCorr"),
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
          <div>${b ? t("seasonal.days", { v: fmtDays(b.harm) }) : t("seasonal.noData")}</div>
          <div>${t("seasonal.normal", { a: fmtDays(st.p25), b: fmtDays(st.p75) })}</div>
          ${status ? `<div style="margin-top:3px;color:${status.color}">${status.label}</div>` : ""}`;
      }
    },
    legend: {
      top: 0,
      data: [yearName, t("seasonal.typical"), t("seasonal.range")],
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
        name: t("seasonal.range"),
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
        name: t("seasonal.typical"),
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
  const typical = t("sum.typical", { month: monthName, monthLower: monthName.toLowerCase() });
  const status = classifyVsNormal(value, stat);

  setText("sumTitle", `${monthName} ${state.focusYear} · ${zoneName(state.preset)}`);
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
    if (Math.abs(pct) < 1) sentence = t("sum.same", { typical });
    else if (pct >= 100) sentence = t("sum.times", { x: fmtNum(value / stat.median, 1), typical });
    else sentence = t(pct > 0 ? "sum.more.pct" : "sum.less.pct", { pct: fmtNum(Math.abs(pct), 0), typical });
  } else if (value > 0) {
    sentence = t("sum.noFireTypical", { typical });
  } else {
    sentence = t("sum.none", { typical });
  }
  // En inglés la frase empieza con mayúscula aunque "typical" vaya al inicio
  sentence = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  sentence += t("sum.range", { a: fmtDays(stat.p25), b: fmtDays(stat.p75) });
  if (current && current.hasNrt) sentence += t("sum.provisional");
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
    t("sum.sr", { month: monthName, year: state.focusYear, zone: zoneName(state.preset), v: fmtDays(value), status: status.label, sentence })
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
    return m ? { ...m, scope: t("trust.scope.all") } : null;
  }
  if (subMap[state.preset]) {
    const m = vm.subregions_2012_2021 ? vm.subregions_2012_2021[subMap[state.preset]] : null;
    return m ? { ...m, scope: t("trust.scope.region") } : null;
  }

  // Zona propia: se calcula con las celdas elegidas
  let sumAqua = 0;
  let sumSnppRaw = 0;
  let sumSnppHarm = 0;
  state.selectedCells.forEach((cellId) => {
    const cell = state.cellsMeta.get(cellId);
    if (!cell) return;
    const w = cell.areaWeight !== undefined ? cell.areaWeight : 1.0;
    for (const r of cell.records) {
      if (r.year < 2012 || r.year > 2021) continue;
      if (r.year === 2012 && r.month === 1) continue;
      if (r.year === 2020 && (r.month === 8 || r.month === 9)) continue;
      const snpp = (r.snpp || 0) * w;
      sumAqua += (r.aqua || 0) * w;
      sumSnppRaw += snpp;
      sumSnppHarm += snpp * getFactor(r.month);
    }
  });
  if (sumAqua <= 0) return null;
  return {
    raw_bias_pct: ((sumSnppRaw - sumAqua) / sumAqua) * 100,
    harmonized_bias_pct: ((sumSnppHarm - sumAqua) / sumAqua) * 100,
    scope: t("trust.scope.custom")
  };
}

/** Explica en palabras simples por qué y cuánto se corrige (pestaña "Evolución"). */
function updateTrustNote() {
  const el = document.getElementById("trustNote");
  if (!el) return;
  const why = t("trust.why");
  const m = getValidationMetrics();
  if (!m) {
    el.innerHTML = why + t("trust.noData");
    return;
  }
  const signed = (v, d) => t("pct", { v: `${v > 0 ? "+" : ""}${fmtNum(v, d)}` });
  el.innerHTML =
    why + t("trust.check", { scope: m.scope, raw: signed(m.raw_bias_pct, 0), harm: signed(m.harmonized_bias_pct, 1) });
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
        avgYear > 0 ? t("rank.yearTimes", { x: fmtNum(y.total / avgYear, 1) }) : "",
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
        med > 0 ? t("rank.monthTimes", { x: fmtNum(r.harm / med, 1) }) : "",
        `data-year="${r.year}" data-month="${r.month}"`
      );
    })
    .join("");

  el.innerHTML = `
    <div class="rank-grid">
      <section>
        <h4>${t("rank.years")}</h4>
        ${yearsHtml || `<p class='rank-help'>${t("rank.noData")}</p>`}
      </section>
      <section>
        <h4>${t("rank.months")}</h4>
        ${monthsHtml || `<p class='rank-help'>${t("rank.noData")}</p>`}
      </section>
    </div>
    <p class="rank-help">${t("rank.note", { from: state.yearStart, to: state.yearEnd })}</p>`;

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
 * (window.PIXFIRE_ML) y suma las proyecciones de las celdas del AOI.
 * Los textos vienen de i18n.js (claves "ml.*").
 * ========================================================================= */
const ML_YS_TERMS = ["ys_2", "ys_3", "ys_4", "ys_6"];
const ML_COLORS = { occurrence: "#0f766e", intensity: "#ea580c", obs: "#334155", band: "#ea580c", clim: "#64748b" };

function getMl() {
  return window.PIXFIRE_ML && window.PIXFIRE_ML.cells_projection ? window.PIXFIRE_ML : null;
}

/** Celdas-día esperadas (media de las simulaciones) en el año elegido para el mapa. */
function getMlCellAnnual(cellId) {
  const ml = getMl();
  if (!ml) return 0;
  const cell = state.cellsMeta.get(cellId);
  const baseCid = cell && cell.parentCellId ? cell.parentCellId : cellId;
  const df = cell && cell.densityFactor !== undefined ? cell.densityFactor : 1.0;
  const c = ml.cells_projection[baseCid];
  if (!c) return 0;
  const k = ml.projection_years.indexOf(state.mlYear);
  return k >= 0 ? c[k] * df : 0;
}

/** Si no existe ml_bundle.js, oculta la pestaña y el modo de mapa (la app sigue funcionando). */
function initMlControls() {
  const ml = getMl();
  if (!ml) {
    document.querySelectorAll('[data-view="ml"], [data-mode="ml"]').forEach((el) => el.classList.add("hidden"));
    return;
  }
  if (!ml.projection_years.includes(state.mlYear)) state.mlYear = ml.projection_years[ml.projection_years.length - 1];
}

function mlTerm(part, term) {
  return getMl().effects[part].terms.find((t) => t.term === term);
}

function mlMetric(rows, key) {
  return rows.find((r) => r.key === key);
}

/** Nombre del modelo en el idioma actual (el JSON trae una clave estable). */
function mlModelName(m) {
  return t(`ml.model.${m.key}`);
}

/** Frases de hallazgos calculadas a partir de los resultados (no hay cifras escritas a mano). */
function buildMlFindings(ml) {
  const d = ml.distribution_check;
  const tw = ml.tweedie;
  const occ6 = mlTerm("occurrence", "ys_6");
  const int6 = mlTerm("intensity", "ys_6");
  const base = mlMetric(ml.metrics_test, "clim");
  const twm = mlMetric(ml.metrics_test, "tweedie");
  const devGain = ((base.poisson_deviance - twm.poisson_deviance) / base.poisson_deviance) * 100;
  const bt = ml.backtest_projection;
  const nBt = bt.years.length;
  const sig = (x) => x.ci_low > 1 || x.ci_high < 1;

  const items = [];
  items.push(t("ml.f.normal", {
    zeros: fmtNum(d.share_zeros_train * 100, 0),
    ratio: fmtNum(d.variance_train / d.mean_train, 1),
    phi: fmtNum(tw.phi, 2),
    p: fmtNum(tw.power, 2)
  }));
  items.push(sig(occ6) ? t("ml.f.persist", { x: fmtNum(1 / occ6.ratio, 1) }) : t("ml.f.persistNo"));
  items.push(sig(int6) && int6.ratio > 1
    ? t("ml.f.accum", { pct: fmtNum((int6.ratio - 1) * 100, 0) })
    : t("ml.f.accumNo"));
  items.push(
    t("ml.f.pred", {
      gain: fmtNum(devGain, 0),
      t0: ml.test_years[0],
      t1: ml.test_years[1],
      b0: bt.years[0].year,
      b1: bt.years[nBt - 1].year,
      inside: bt.inside_p10_p90,
      n: nBt,
      mm: fmtNum(bt.mape_median_pct, 0),
      mc: fmtNum(bt.mape_climatology_pct, 0)
    }) + (bt.mape_median_pct > bt.mape_climatology_pct ? t("ml.f.predWorse") : t("ml.f.predBetter"))
  );
  return items.map((x) => `<li>${x}</li>`).join("");
}

function buildMlMetricsTable(ml) {
  const row = (m, rows) => {
    const best = (k, lowIsBetter) => {
      const vals = rows.map((r) => r[k]);
      const target = lowIsBetter ? Math.min(...vals) : Math.max(...vals);
      return m[k] === target ? " class='ml-best'" : "";
    };
    return `<tr><td>${mlModelName(m)}</td>` +
      `<td${best("poisson_deviance", true)}>${fmtNum(m.poisson_deviance, 3)}</td>` +
      `<td${best("auc_fire_occurrence", false)}>${fmtNum(m.auc_fire_occurrence, 3)}</td>` +
      `<td${best("mae_bolivia_monthly_total", true)}>${fmtNum(m.mae_bolivia_monthly_total, 0)}</td>` +
      `<td>${t("pct", { v: (m.total_bias_pct > 0 ? "+" : "") + fmtNum(m.total_bias_pct, 1) })}</td></tr>`;
  };
  const block = (title, rows) =>
    `<tr class="ml-sep"><td colspan="5">${title}</td></tr>` + rows.map((m) => row(m, rows)).join("");
  const bt = ml.backtest_projection.years
    .map((b) => `<tr><td>${b.year}</td><td>${fmtNum(b.observed, 0)}</td><td>${fmtNum(b.p50, 0)}</td>` +
      `<td>${fmtNum(b.p10, 0)} – ${fmtNum(b.p90, 0)}</td><td>${fmtNum(b.climatology, 0)}</td></tr>`)
    .join("");
  return `
    <table class="ml-table">
      <thead><tr>
        <th>${t("ml.th.model")}</th>
        <th title="${t("ml.th.dev.title")}">${t("ml.th.dev")}</th>
        <th title="${t("ml.th.auc.title")}">${t("ml.th.auc")}</th>
        <th title="${t("ml.th.mae.title")}">${t("ml.th.mae")}</th>
        <th>${t("ml.th.bias")}</th>
      </tr></thead>
      <tbody>
        ${block(t("ml.block.test", { t0: ml.test_years[0], t1: ml.test_years[1] }), ml.metrics_test)}
        ${block(t("ml.block.fc", { y: ml.forecast_year }), ml.metrics_forecast_2026_provisional)}
      </tbody>
    </table>
    <table class="ml-table">
      <thead><tr>
        <th>${t("ml.bt.head")}</th>
        <th>${t("ml.bt.obs")}</th><th>${t("ml.bt.med")}</th><th>${t("ml.bt.band")}</th><th>${t("ml.bt.clim")}</th>
      </tr></thead>
      <tbody>${bt}</tbody>
    </table>`;
}

function renderMlEffectsChart(ml) {
  const dom = document.getElementById("chartMlEffects");
  if (!dom) return;
  if (!chartMlEffects) chartMlEffects = echarts.init(dom);
  const ysLabels = t("ml.ys");

  const series = [];
  [["occurrence", t("ml.eff.occ"), -5], ["intensity", t("ml.eff.int"), 5]]
    .forEach(([part, name, dx]) => {
      const terms = ML_YS_TERMS.map((x) => mlTerm(part, x));
      const color = ML_COLORS[part];
      series.push({
        name, type: "line", color, symbolSize: 8, lineStyle: { width: 2 },
        data: [1, ...terms.map((x) => x.ratio)],
        z: 3
      });
      // Barras de error: intervalo de confianza del 95 %
      series.push({
        name, type: "custom", color, z: 2, tooltip: { show: false },
        data: terms.map((x, i) => [i + 1, x.ci_low, x.ci_high]),
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
    title: { text: t("ml.eff.title"), left: 0, top: 0, textStyle: { fontSize: 11, fontWeight: 600 } },
    legend: { top: 18, left: 0, itemWidth: 14, textStyle: { fontSize: 9.5 }, data: series.filter((s) => s.type === "line").map((s) => s.name) },
    grid: { left: 40, right: 12, top: 52, bottom: 38 },
    tooltip: {
      ...TOOLTIP_STYLE,
      trigger: "axis",
      formatter: (ps) => {
        const i = ps[0].dataIndex;
        let html = `<b>${ysLabels[i].replace("\n", " ")}</b>`;
        ps.filter((p) => p.seriesType === "line").forEach((p) => {
          const part = p.color === ML_COLORS.occurrence ? "occurrence" : "intensity";
          const term = i === 0 ? null : mlTerm(part, ML_YS_TERMS[i - 1]);
          html += `<br>${p.marker}${p.seriesName}: <b>${fmtNum(p.value, 2)}</b>` +
            (term ? ` (${t("ml.eff.ci")}: ${fmtNum(term.ci_low, 2)}–${fmtNum(term.ci_high, 2)})` : ` ${t("ml.eff.ref")}`);
        });
        return html + `<br><span style='color:#94a3b8'>${t("ml.eff.note")}</span>`;
      }
    },
    xAxis: { type: "category", data: ysLabels, axisLabel: { fontSize: 9, interval: 0 } },
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

/** Ley de potencia de la varianza: puntos (media, varianza) por grupo y recta Var = phi·media^p. */
function renderMlPowerChart(ml) {
  const dom = document.getElementById("chartMlPower");
  if (!dom) return;
  if (!chartMlPower) chartMlPower = echarts.init(dom);
  const tw = ml.tweedie;
  const pts = tw.mean_var_points.map((d) => [d.mean, d.var]);
  const xs = pts.map((d) => d[0]);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const line = [];
  for (let i = 0; i <= 30; i++) {
    const x = xMin * Math.pow(xMax / xMin, i / 30);
    line.push([x, tw.phi_from_bins * Math.pow(x, tw.power_raw_slope)]);
  }
  const poisson = [[xMin, xMin], [xMax, xMax]];

  chartMlPower.setOption({
    animation: false,
    textStyle: { fontFamily: "Sora, sans-serif" },
    title: { text: t("ml.pow.title", { p: fmtNum(tw.power, 2) }), left: 0, top: 0, textStyle: { fontSize: 11, fontWeight: 600 } },
    legend: { top: 18, left: 0, itemWidth: 14, textStyle: { fontSize: 9.5 } },
    grid: { left: 44, right: 12, top: 52, bottom: 38 },
    tooltip: {
      ...TOOLTIP_STYLE,
      trigger: "item",
      formatter: (p) => t("ml.pow.tip", { m: fmtNum(p.value[0], 2), v: fmtNum(p.value[1], 2) })
    },
    xAxis: { type: "log", name: t("ml.pow.x"), nameLocation: "middle", nameGap: 22, nameTextStyle: { fontSize: 9 }, axisLabel: { fontSize: 9 }, splitLine: { show: false } },
    yAxis: { type: "log", axisLabel: { fontSize: 9 }, splitLine: { lineStyle: { color: "#f1f5f9" } } },
    series: [
      { name: t("ml.pow.groups"), type: "scatter", color: ML_COLORS.obs, symbolSize: 7, data: pts },
      { name: t("ml.pow.fit"), type: "line", color: ML_COLORS.intensity, symbol: "none", lineStyle: { width: 2 }, data: line },
      { name: t("ml.pow.poisson"), type: "line", color: ML_COLORS.clim, symbol: "none", lineStyle: { width: 1.2, type: "dashed" }, data: poisson }
    ]
  }, true);
  chartMlPower.resize();
}

/** Serie anual del AOI (2003–2025) + proyección 2026–2030 con bandas de incertidumbre. */
function renderMlProjectionChart(ml) {
  const dom = document.getElementById("chartMlProjection");
  if (!dom) return;
  if (!chartMlProjection) chartMlProjection = echarts.init(dom);

  const projYears = ml.projection_years;
  const firstProj = projYears[0];
  const lastProj = projYears[projYears.length - 1];
  const years = [];
  for (let y = 2003; y <= lastProj; y++) years.push(y);

  // Historia: suma anual del AOI con los mismos datos que el resto de la app
  const histByYear = new Map();
  state.currentSeriesByYm.forEach((b) => {
    if (b.year < firstProj) histByYear.set(b.year, (histByYear.get(b.year) || 0) + b.harm);
  });

  // Proyección: bandas exactas para los presets; para polígonos propios solo la media
  const presetKey = state.preset !== "custom" && ml.projection[state.preset] ? state.preset : null;
  const projRows = presetKey ? ml.projection[presetKey] : null;
  const meanByYear = projYears.map((y, k) => {
    let s = 0;
    state.selectedCells.forEach((cid) => {
      const cell = state.cellsMeta.get(cid);
      const baseCid = cell && cell.parentCellId ? cell.parentCellId : cid;
      const w = cell && cell.areaWeight !== undefined ? cell.areaWeight : 1.0;
      const c = ml.cells_projection[baseCid];
      if (c) s += c[k] * w;
    });
    return s;
  });

  const histVals = [...histByYear.values()];
  const histAvg = histVals.length ? histVals.reduce((x, v) => x + v, 0) / histVals.length : 0;
  const idx = (y) => years.indexOf(y);
  const hist = years.map((y) => (histByYear.has(y) ? Number(histByYear.get(y).toFixed(1)) : null));
  // Une la línea de historia con la proyección
  const lastHist = firstProj - 1;
  const central = years.map((y) => {
    if (y === lastHist) return hist[idx(y)];
    const k = projYears.indexOf(y);
    if (k < 0) return null;
    return Number((projRows ? projRows[k].p50 : meanByYear[k]).toFixed(1));
  });

  const nameObs = t("ml.proj.obs");
  const nameCentral = presetKey ? t("ml.proj.median") : t("ml.proj.mean");
  const name80 = t("ml.proj.b80");
  const name90 = t("ml.proj.b90");

  const bandSeries = [];
  if (projRows) {
    const lower = (key) => years.map((y) => {
      const k = projYears.indexOf(y);
      return k < 0 ? null : projRows[k][key];
    });
    const width = (lo, hi) => years.map((y) => {
      const k = projYears.indexOf(y);
      return k < 0 ? null : Number((projRows[k][hi] - projRows[k][lo]).toFixed(1));
    });
    [["p05", "p95", name90, 0.12, "b90"], ["p10", "p90", name80, 0.22, "b80"]].forEach(([lo, hi, name, op, stack]) => {
      bandSeries.push({ name: `_${stack}`, type: "line", stack, data: lower(lo), symbol: "none", lineStyle: { opacity: 0 }, tooltip: { show: false } });
      bandSeries.push({
        name, type: "line", stack, data: width(lo, hi), symbol: "none", color: ML_COLORS.band,
        lineStyle: { opacity: 0 }, areaStyle: { color: ML_COLORS.band, opacity: op }, tooltip: { show: false }
      });
    });
  }

  const area = presetKey ? zoneName(presetKey) : t("ml.proj.custom");

  chartMlProjection.setOption({
    animation: false,
    textStyle: { fontFamily: "Sora, sans-serif" },
    title: { text: t("ml.proj.title", { end: lastProj, area }), left: 0, top: 0, textStyle: { fontSize: 11, fontWeight: 600 } },
    legend: { top: 18, left: 0, itemWidth: 14, textStyle: { fontSize: 9.5 }, data: [nameObs, nameCentral, ...(presetKey ? [name80, name90] : [])] },
    grid: { left: 48, right: 14, top: 52, bottom: 26 },
    tooltip: {
      ...TOOLTIP_STYLE,
      trigger: "axis",
      formatter: (ps) => {
        const y = years[ps[0].dataIndex];
        const k = projYears.indexOf(y);
        let html = `<b>${y}</b>`;
        if (hist[idx(y)] !== null && y < firstProj) html += `<br>${t("ml.proj.tip.obs", { v: fmtDays(hist[idx(y)]) })}`;
        if (k >= 0) {
          if (projRows) {
            const r = projRows[k];
            html += `<br>${t("ml.proj.tip.median", { v: fmtDays(r.p50) })}` +
              `<br>${name80}: ${fmtDays(r.p10)} – ${fmtDays(r.p90)}<br>${name90}: ${fmtDays(r.p05)} – ${fmtDays(r.p95)}`;
          } else {
            html += `<br>${t("ml.proj.tip.mean", { v: fmtDays(meanByYear[k]) })}`;
          }
          if (y === ml.forecast_year) {
            const m = MONTH_NAMES[ml.forecast_observed_through_month - 1];
            html += `<br><span style='color:#94a3b8'>${t("ml.proj.tip.partial", { y, m })}</span>`;
          }
        }
        return html;
      }
    },
    xAxis: { type: "category", data: years.map(String), axisLabel: { fontSize: 9 } },
    yAxis: { type: "value", axisLabel: { fontSize: 9 }, splitLine: { lineStyle: { color: "#f1f5f9" } } },
    series: [
      ...bandSeries,
      {
        name: nameObs, type: "line", color: ML_COLORS.obs, symbolSize: 4, lineStyle: { width: 2 },
        data: hist.map((v, i) => (years[i] < firstProj ? v : null)),
        // Referencia: promedio anual 2003–2025 (la "climatología" contra la que se compara el modelo)
        markLine: {
          symbol: "none", silent: true,
          lineStyle: { color: ML_COLORS.clim, type: "dotted", width: 1.2 },
          label: { formatter: t("ml.proj.avg"), position: "insideStartTop", fontSize: 9, color: ML_COLORS.clim },
          data: [{ yAxis: Number(histAvg.toFixed(1)) }]
        }
      },
      {
        name: nameCentral, type: "line", color: ML_COLORS.intensity, symbolSize: 5,
        lineStyle: { width: 2, type: "dashed" }, data: central,
        markArea: { silent: true, itemStyle: { color: "rgba(148,163,184,0.08)" }, data: [[{ xAxis: String(firstProj) }, { xAxis: String(lastProj) }]] }
      }
    ]
  }, true);
  chartMlProjection.resize();
}

function renderMlPanel() {
  const el = document.getElementById("mlView");
  const ml = getMl();
  if (!el) return;
  if (!ml) {
    el.innerHTML = `<p class='rank-help'>${t("ml.missing")}</p>`;
    return;
  }

  // El esqueleto se crea una vez (y de nuevo al cambiar de idioma); luego solo se actualizan los gráficos.
  if (!el.dataset.built) {
    const yearOpts = ml.projection_years
      .map((y) => `<option value="${y}"${y === state.mlYear ? " selected" : ""}>${y}</option>`).join("");
    el.innerHTML = `
      <ul class="ml-findings">${buildMlFindings(ml)}</ul>
      <div class="ml-proj-head">
        <label class="map-toolbar-label" for="mlYearSelect">${t("ml.year.label")}</label>
        <select id="mlYearSelect">${yearOpts}</select>
        <button type="button" class="btn-action" id="btnMlMap">${t("ml.year.btn")}</button>
      </div>
      <div id="chartMlProjection" class="ml-chart ml-chart-wide" role="img" aria-label="${t("ml.aria.proj")}"></div>
      <div class="ml-charts">
        <div id="chartMlEffects" class="ml-chart" role="img" aria-label="${t("ml.aria.eff")}"></div>
        <div id="chartMlPower" class="ml-chart" role="img" aria-label="${t("ml.aria.pow")}"></div>
      </div>
      ${buildMlMetricsTable(ml)}
      <p class="rank-help ml-note">${t("ml.note", { n: ml.n_sims })}</p>`;
    el.dataset.built = "1";
    // Los divs de los gráficos son nuevos: se liberan las instancias anteriores
    [chartMlEffects, chartMlPower, chartMlProjection].forEach((c) => c && c.dispose());
    chartMlEffects = null;
    chartMlPower = null;
    chartMlProjection = null;

    el.querySelector("#mlYearSelect").addEventListener("change", (e) => {
      state.mlYear = parseInt(e.target.value, 10);
      if (state.mapMode === "ml") renderMapGrid();
    });
    el.querySelector("#btnMlMap").addEventListener("click", () => setMapMode("ml"));
  }
  renderMlProjectionChart(ml);
  renderMlEffectsChart(ml);
  renderMlPowerChart(ml);
}

/* =========================================================================
 * 5f. Pestaña "Armonización": el proceso en 5 pasos y su validación
 *
 * Todas las cifras salen de metadata.json (factores y métricas) y de
 * validation.csv (serie mensual de Bolivia). Nada está escrito a mano.
 * ========================================================================= */
const HARM_COLORS = { aqua: "#0284c7", raw: "#dc2626", corr: "#0f766e", ok: "#0f766e", bad: "#b91c1c" };

/** Diferencia con signo y en el formato del idioma: "+177 %" / "+177%". */
function signedPct(v, digits) {
  return t("pct", { v: `${v > 0 ? "+" : ""}${fmtNum(v, digits)}` });
}

/** Tarjeta de resultado: sesgo crudo → sesgo corregido, con ✓ si cumple el umbral. */
function harmResultCard(title, m, threshold) {
  const ok = Math.abs(m.harmonized_bias_pct) <= threshold;
  const reduction = (1 - Math.abs(m.harmonized_bias_pct) / Math.abs(m.raw_bias_pct)) * 100;
  return `
    <div class="harm-result ${ok ? "ok" : "bad"}">
      <span class="harm-result-title">${title}</span>
      <span class="harm-result-nums">
        <b class="raw">${signedPct(m.raw_bias_pct, 0)}</b>
        <span class="arrow">→</span>
        <b class="corr">${signedPct(m.harmonized_bias_pct, 1)}</b>
        <span class="mark">${ok ? "✓" : "✗"}</span>
      </span>
      <span class="harm-result-note">${t("harm.reduction", { pct: fmtNum(reduction, 0) })}</span>
    </div>`;
}

/** Ojo: la calibración se hizo en la grilla base (state.baseMeta, 0,25°), no en la grilla que se ve en el mapa. */
function buildHarmSteps(meta) {
  const vm = meta.validation_metrics;
  const full = vm.full_2012_2021_in_sample;
  const ratio = full.snpp_raw_total / full.aqua_total;
  const factors = Object.values(meta.factors_by_month).map(Number);
  const kMin = Math.min(...factors);
  const kMax = Math.max(...factors);

  return `
    <p class="harm-lead">${t("harm.lead")}</p>
    <div class="harm-steps">
      <div class="harm-step">
        <span class="harm-n">1</span>
        <b>${t("harm.s1.t")}</b>
        <p>${t("harm.s1.d", { ratio: fmtNum(ratio, 1), pct: signedPct(full.raw_bias_pct, 0) })}</p>
      </div>
      <div class="harm-step">
        <span class="harm-n">2</span>
        <b>${t("harm.s2.t")}</b>
        <p>${t("harm.s2.d")}</p>
      </div>
      <div class="harm-step">
        <span class="harm-n">3</span>
        <b>${t("harm.s3.t")}</b>
        <p>${t("harm.s3.d", { deg: fmtNum((state.baseMeta || meta).cell_size_deg, 2) })}</p>
      </div>
      <div class="harm-step">
        <span class="harm-n">4</span>
        <b>${t("harm.s4.t")}</b>
        <p>${t("harm.s4.d", {
          from: meta.calibration_period[0],
          to: meta.calibration_period[1],
          kmin: fmtNum(kMin, 2),
          kmax: fmtNum(kMax, 2)
        })}</p>
      </div>
      <div class="harm-step">
        <span class="harm-n">5</span>
        <b>${t("harm.s5.t")}</b>
        <p>${t("harm.s5.d", { thr: fmtNum(vm.threshold_pct, 0) })}</p>
      </div>
    </div>`;
}

function buildHarmResults(meta) {
  const vm = meta.validation_metrics;
  const thr = vm.threshold_pct;
  const subs = vm.subregions_2012_2021 || {};
  const subCards = ["chiquitania_llanos", "amazonia_beni_norte", "andina_valles"]
    .filter((k) => subs[k])
    .map((k) => harmResultCard(t(`sub.${k}`), subs[k], thr))
    .join("");
  return `
    <h4 class="harm-h">${t("harm.res.title", { thr: fmtNum(thr, 0) })}</h4>
    <div class="harm-results">
      ${harmResultCard(t("harm.res.a"), vm.train_2012_2016_test_2017_2021, thr)}
      ${harmResultCard(t("harm.res.b"), vm.train_2017_2021_test_2012_2016, thr)}
    </div>
    <h4 class="harm-h">${t("harm.res.subs")}</h4>
    <div class="harm-results three">${subCards}</div>
    <p id="harmAoiLine" class="harm-aoi"></p>
    <p class="rank-help harm-note">${t("harm.limits")}</p>`;
}

/** Paso 4: factor k_m de cada mes (cuánto vale 1 celda-día VIIRS en escala Aqua). */
function renderHarmFactorsChart(meta) {
  const dom = document.getElementById("chartHarmFactors");
  if (!dom) return;
  if (!chartHarmFactors) chartHarmFactors = echarts.init(dom);
  const factors = [];
  for (let m = 1; m <= 12; m++) factors.push(Number(meta.factors_by_month[String(m)]));

  chartHarmFactors.setOption({
    animation: false,
    textStyle: { fontFamily: "Sora, sans-serif" },
    title: { text: t("harm.k.title"), left: 0, top: 0, textStyle: { fontSize: 11, fontWeight: 600 } },
    grid: { left: 40, right: 12, top: 30, bottom: 24 },
    tooltip: {
      ...TOOLTIP_STYLE,
      trigger: "axis",
      formatter: (ps) => `<b>${MONTH_FULL_NAMES[ps[0].dataIndex]}</b><br>` +
        t("harm.k.tip", { k: fmtNum(ps[0].value, 3), inv: fmtNum(1 / ps[0].value, 1) })
    },
    xAxis: { type: "category", data: MONTH_NAMES, axisLabel: { fontSize: 9 }, axisTick: { show: false } },
    yAxis: { type: "value", min: 0, axisLabel: { fontSize: 9, formatter: (v) => fmtNum(v, 2) }, splitLine: { lineStyle: { color: "#f1f5f9" } } },
    series: [{
      type: "bar", data: factors.map((v) => Number(v.toFixed(3))), barWidth: "55%",
      itemStyle: { color: HARM_COLORS.corr }
    }]
  }, true);
  chartHarmFactors.resize();
}

/** Paso 5: Aqua real vs. VIIRS crudo vs. VIIRS corregido (Bolivia, validation.csv). */
function renderHarmValidationChart() {
  const dom = document.getElementById("chartHarmValidation");
  if (!dom) return;
  if (!chartHarmValidation) chartHarmValidation = echarts.init(dom);

  const rows = state.validationRows;
  const labels = rows.map((r) => ymKey(r.year, r.month));
  // Franjas según el papel de cada periodo en la calibración (columna "split")
  const areaOf = {
    calibration_a: { name: t("harm.v.calA"), color: "rgba(15, 118, 110, 0.07)" },
    calibration_b: { name: t("harm.v.calB"), color: "rgba(2, 132, 199, 0.07)" },
    drift: { name: t("harm.v.drift"), color: "rgba(245, 158, 11, 0.10)" }
  };
  const areas = [];
  let cur = null;
  rows.forEach((r, i) => {
    const split = r.split === "excluded_outage" ? "calibration_b" : r.split;
    const a = areaOf[split] ? split : null;
    if (cur && cur.key !== a) {
      areas.push([{ name: areaOf[cur.key].name, xAxis: cur.from, itemStyle: { color: areaOf[cur.key].color } }, { xAxis: labels[i - 1] }]);
      cur = null;
    }
    if (a && !cur) cur = { key: a, from: labels[i] };
  });
  if (cur) areas.push([{ name: areaOf[cur.key].name, xAxis: cur.from, itemStyle: { color: areaOf[cur.key].color } }, { xAxis: labels[labels.length - 1] }]);

  const prettyYm = (ym) => {
    const [y, m] = ym.split("-").map((v) => parseInt(v, 10));
    return `${MONTH_NAMES[m - 1]} ${y}`;
  };
  const startIdx = Math.max(0, labels.indexOf("2012-01"));
  const endIdx = labels.indexOf("2021-12") >= 0 ? labels.indexOf("2021-12") : labels.length - 1;

  chartHarmValidation.setOption({
    animation: false,
    textStyle: { fontFamily: "Sora, sans-serif" },
    title: { text: t("harm.v.title"), left: 0, top: 0, textStyle: { fontSize: 11, fontWeight: 600 } },
    legend: { top: 18, left: 0, itemWidth: 14, textStyle: { fontSize: 9.5 } },
    grid: { left: 48, right: 14, top: 50, bottom: 44 },
    tooltip: {
      ...TOOLTIP_STYLE,
      trigger: "axis",
      formatter: (items) => {
        let html = `<b>${prettyYm(items[0].axisValue)}</b>`;
        items.forEach((it) => {
          if (it.value === null || it.value === undefined) return;
          html += `<br>${it.marker}${it.seriesName}: <b>${fmtDays(it.value)}</b>`;
        });
        return html;
      }
    },
    xAxis: {
      type: "category", data: labels, boundaryGap: false,
      axisLabel: { fontSize: 9, interval: (i, v) => v.endsWith("-01"), formatter: (v) => v.slice(0, 4) }, axisTick: { show: false }
    },
    yAxis: { type: "value", axisLabel: { fontSize: 9, formatter: (v) => fmtNum(v, 0) }, splitLine: { lineStyle: { color: "#f1f5f9" } } },
    dataZoom: [
      { type: "inside", startValue: startIdx, endValue: endIdx },
      { type: "slider", height: 12, bottom: 6, borderColor: "#e2e8f0", showDetail: false, startValue: startIdx, endValue: endIdx }
    ],
    series: [
      {
        name: t("series.modis"), type: "line", showSymbol: false, color: HARM_COLORS.aqua, lineStyle: { width: 2 },
        data: rows.map((r) => r.aqua),
        markArea: { silent: true, label: { fontSize: 9, color: "#475569", position: "insideTop" }, data: areas }
      },
      {
        name: t("series.viirsRaw"), type: "line", showSymbol: false, color: HARM_COLORS.raw, lineStyle: { width: 1.3, opacity: 0.85 },
        data: rows.map((r) => r.snpp_raw)
      },
      {
        name: t("series.viirsCorr"), type: "line", showSymbol: false, color: HARM_COLORS.corr, lineStyle: { width: 1.8, type: "dashed" },
        data: rows.map((r) => (r.snpp_harmonized === null ? null : Number(r.snpp_harmonized.toFixed(1))))
      }
    ]
  }, true);
  chartHarmValidation.resize();
}

/** Línea con la comprobación para la zona elegida (misma función que usa "Evolución"). */
function updateHarmAoiLine() {
  const el = document.getElementById("harmAoiLine");
  if (!el) return;
  const m = getValidationMetrics();
  el.innerHTML = m
    ? t("harm.aoi", { zone: zoneName(state.preset), scope: m.scope, raw: signedPct(m.raw_bias_pct, 0), harm: signedPct(m.harmonized_bias_pct, 1) })
    : t("harm.aoi.none", { zone: zoneName(state.preset) });
}

function renderHarmPanel() {
  const el = document.getElementById("harmView");
  const meta = state.meta;
  if (!el || !meta || !meta.validation_metrics) return;

  // Se arma una vez (y de nuevo al cambiar de idioma); al cambiar de zona solo cambia la línea del AOI.
  if (!el.dataset.built) {
    el.innerHTML = `
      ${buildHarmSteps(meta)}
      <div class="harm-charts">
        <div id="chartHarmValidation" class="harm-chart wide" role="img" aria-label="${t("harm.aria.v")}"></div>
        <div id="chartHarmFactors" class="harm-chart" role="img" aria-label="${t("harm.aria.k")}"></div>
      </div>
      ${buildHarmResults(meta)}`;
    el.dataset.built = "1";
    [chartHarmFactors, chartHarmValidation].forEach((c) => c && c.dispose());
    chartHarmFactors = null;
    chartHarmValidation = null;
  }
  renderHarmValidationChart();
  renderHarmFactorsChart(meta);
  updateHarmAoiLine();
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
          <div>${t("seasonal.days", { v: fmtDays(val) })}</div>
          <div style="color:${status.color}">${status.label}</div>
          ${b && b.hasNrt ? `<div style='color:#94a3b8;font-size:10px'>${t("cal.provisional")}</div>` : ""}`;
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
      text: [t("cal.more"), t("cal.less")],
      inRange: { color: CAL_RAMP },
      textStyle: { color: "#64748b", fontSize: 11, fontFamily: "Sora" }
    },
    series: [
      {
        name: t("series.days"),
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
    const w = cell.areaWeight !== undefined ? cell.areaWeight : 1.0;
    for (const r of cell.records) {
      if (r.year < state.yearStart || r.year > state.yearEnd) continue;
      rows.push([
        cell.cellId,
        cell.lat.toFixed(3),
        cell.lon.toFixed(3),
        cell.subregion,
        r.year,
        r.month,
        +(r.harm * w).toFixed(2),
        r.aqua !== null ? Math.round(r.aqua * w) : "",
        r.snpp !== null ? Math.round(r.snpp * w) : "",
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
    showError(t("coord.err.empty"));
    return;
  }
  if (latMin >= latMax || lonMin >= lonMax) {
    showError(t("coord.err.order"));
    return;
  }
  if (latMin < -90 || latMax > 90 || lonMin < -180 || lonMax > 180) {
    showError(t("coord.err.range"));
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

  const gridSel = document.getElementById("gridResolution");
  if (gridSel) {
    gridSel.addEventListener("change", async (e) => {
      const newRes = e.target.value;
      if (newRes === state.gridRes) return;
      gridSel.disabled = true;
      try {
        await loadAllData(newRes);
        if (gridLayerGroup) gridLayerGroup.clearLayers();
        cellLayers.clear();
        recomputeAoiSelection();
      } finally {
        gridSel.disabled = false;
      }
    });
  }

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

  // "Ver cómo": abre la pestaña Armonización (el proceso paso a paso)
  const trustBtn = document.getElementById("btnTrust");
  if (trustBtn) {
    trustBtn.addEventListener("click", () => switchView("harm"));
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

  // Botones ES | EN
  document.querySelectorAll(".lang-btn").forEach((btn) => {
    btn.addEventListener("click", () => setLang(btn.dataset.lang));
  });

  window.addEventListener("resize", refreshSizes);
}

/** Reajusta gráficos y mapa cuando cambia el espacio disponible. */
function refreshSizes() {
  [chartCalendar, chartSeries, chartSeasonal, chartMlEffects, chartMlPower, chartMlProjection, chartHarmFactors, chartHarmValidation].forEach((c) => {
    if (c) c.resize();
  });
  if (map) map.invalidateSize();
}

/* =========================================================================
 * 8. Idioma (ES / EN)
 * ========================================================================= */
/** Recalcula los textos guardados en variables (meses) y los del selector de mes. */
function refreshLangConstants() {
  MONTH_NAMES = t("months.short");
  MONTH_FULL_NAMES = t("months.full");
  const sel = document.getElementById("focusMonth");
  if (sel) {
    Array.from(sel.options).forEach((opt) => {
      opt.textContent = MONTH_FULL_NAMES[parseInt(opt.value, 10) - 1];
    });
  }
}

/** i18n.js llama a esta función después de cambiar de idioma: se redibuja todo. */
window.onLanguageChange = function onLanguageChange() {
  refreshLangConstants();
  buildLayersControl();
  buildDrawControl();
  updatePlayButton();
  const mlEl = document.getElementById("mlView");
  if (mlEl) delete mlEl.dataset.built; // el panel técnico se rehace con los nuevos textos
  const harmEl = document.getElementById("harmView");
  if (harmEl) delete harmEl.dataset.built;
  if (map) map.closePopup();
  recomputeAoiSelection(); // avisos, mapa, leyenda, resumen y gráfico visible
};

(async function initApp() {
  try {
    applyStaticI18n();
    refreshLangConstants();
    updatePlayButton();
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
      warnTxt.textContent = t("warn.initError") + (err.message || err);
      warnBar.classList.remove("hidden");
    }
  }
})();
