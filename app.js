/**
 * PixFire Bolivia — Interfaz Minimalista y Compacta para NASA Space Apps 2026.
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

const COLOR_RAMPS = {
  fire: ["#fff7ed", "#fed7aa", "#fb923c", "#ea580c", "#b91c1c", "#7c2d12"],
  viridis: ["#edf8fb", "#b2e2e2", "#66c2a4", "#2ca25f", "#006d2c"],
  plasma: ["#f0f921", "#f89540", "#cc4778", "#7e03a8", "#0d0887"]
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
  colorRamp: "fire",
  activeView: "calendar", // calendar | series | seasonal
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
let chartCalendar = null;
let chartSeries = null;
let chartSeasonal = null;

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
      cellObj = { cellId, row, col, lat, lon, subregion, totalHarm: 0, records: [] };
      state.cellsMeta.set(cellId, cellObj);
    }

    const rec = { cellId, year, month, harm, aqua, snpp, source };
    cellObj.totalHarm += harm;
    cellObj.records.push(rec);
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
    zoomControl: true
  });

  const CARTO_KEY = "cb1_58lv_1_5016ded4d19a88b491106fc0";

  const cartoPositron = L.tileLayer(`https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=${CARTO_KEY}`, {
    attribution: "&copy; OpenStreetMap &copy; CARTO | NASA FIRMS",
    subdomains: "abcd",
    maxZoom: 19
  });

  const cartoVoyager = L.tileLayer(`https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=${CARTO_KEY}`, {
    attribution: "&copy; OpenStreetMap &copy; CARTO | NASA FIRMS",
    subdomains: "abcd",
    maxZoom: 19
  });

  const satLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    attribution: "Tiles &copy; Esri | NASA FIRMS",
    maxZoom: 18
  });

  cartoPositron.addTo(map);

  const baseMaps = {
    "Carto Positron (Claro)": cartoPositron,
    "Carto Voyager": cartoVoyager,
    "Satélite Esri": satLayer
  };

  L.control.layers(baseMaps, null, { position: "topleft" }).addTo(map);

  gridLayerGroup = L.layerGroup().addTo(map);
  drawnItems = new L.FeatureGroup().addTo(map);

  if (typeof L.Control !== "undefined" && typeof L.Control.Draw !== "undefined") {
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

      map.on(L.Draw.Event.DELETED, () => {
        resetToPreset("all");
      });
    }
  }
}

function getDensityColor(annualAvg) {
  if (annualAvg > 25) return "#b91c1c";
  if (annualAvg > 10) return "#ea580c";
  if (annualAvg > 2) return "#fb923c";
  return "#0284c7";
}

function renderMapGrid() {
  if (!gridLayerGroup || !state.meta) return;
  gridLayerGroup.clearLayers();
  const half = state.meta.cell_size_deg / 2.0;

  let activeMonths = 0;
  for (let y = state.yearStart; y <= state.yearEnd; y++) {
    activeMonths += y === 2026 ? 10 : 12;
  }
  const numYears = Math.max(0.833, activeMonths / 12.0);

  state.cellsMeta.forEach((cell) => {
    const isSelected = state.selectedCells.has(cell.cellId);
    let periodHarm = 0;
    for (const r of cell.records) {
      if (r.year >= state.yearStart && r.year <= state.yearEnd) {
        periodHarm += r.harm;
      }
    }
    const annualAvg = periodHarm / numYears;
    const fillColor = getDensityColor(annualAvg);

    const bounds = [
      [cell.lat - half, cell.lon - half],
      [cell.lat + half, cell.lon + half]
    ];

    const rect = L.rectangle(bounds, {
      color: isSelected ? fillColor : "#cbd5e1",
      weight: isSelected ? 0.75 : 0.25,
      fillColor: fillColor,
      fillOpacity: isSelected ? 0.6 : 0.12
    });

    rect.bindTooltip(
      `<strong>Celda ${cell.cellId}</strong><br>` +
      `Centro: ${cell.lat.toFixed(3)}°, ${cell.lon.toFixed(3)}°<br>` +
      `Promedio (${state.yearStart}–${state.yearEnd}): ${annualAvg.toFixed(1)} celdas-día/año<br>` +
      `Acumulado (${state.yearStart}–${state.yearEnd}): ${periodHarm.toFixed(1)} celdas-día`,
      { sticky: true }
    );

    gridLayerGroup.addLayer(rect);
  });
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
  const cellSize = state.meta ? state.meta.cell_size_deg : 0.25;
  const dLatKm = 110.67 * cellSize;
  const dLonEqKm = 111.32 * cellSize;
  let totalAreaKm2 = 0;
  state.selectedCells.forEach((cellId) => {
    const c = state.cellsMeta.get(cellId);
    if (c) {
      totalAreaKm2 += dLatKm * dLonEqKm * Math.cos((c.lat * Math.PI) / 180.0);
    }
  });
  const approxKm2 = Math.round(totalAreaKm2).toLocaleString("es-BO");
  const badgeEl = document.getElementById("aoiStatsBadge");
  if (badgeEl) badgeEl.textContent = `${count} celdas activas · ~${approxKm2} km²`;

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
      warnings.push("Parte del polígono se extiende fuera de la cobertura de Bolivia; solo se incluyen las celdas dentro del país.");
    }
  }

  if (count === 0) {
    warnings.push("El área seleccionada no contiene celdas con detecciones de fuego en Bolivia.");
  } else if (count < 4) {
    warnings.push(`Muestra espacial pequeña (${count} celdas): en áreas muy reducidas la varianza local es mayor.`);
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
  updateTelemetryCard(histStats);
  populateScienceRailFromMeta();
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
}

/* =========================================================================
 * 5b. Pestañas de vistas temporales
 * ========================================================================= */
const VIEW_TEXTS = {
  calendar: {
    eyebrow: "SERIE HISTÓRICA CONTINUA · CLIC EN UNA CELDA PARA EVALUAR ESE MES",
    title: () => "Calendario de Actividad de Quema (Año × Mes)"
  },
  series: {
    eyebrow: "AQUA vs. VIIRS · ARRASTRA PARA ZOOM · CLIC EN LA LEYENDA PARA OCULTAR LÍNEAS",
    title: () => "Serie Mensual y Corrección del Salto entre Sensores"
  },
  seasonal: {
    eyebrow: "AÑO EVALUADO vs. MEDIANA Y BANDA NORMAL 2003–2025 · CLIC EN UNA BARRA",
    title: () => `Ciclo Estacional ${state.focusYear} vs. Histórico`
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
  renderActiveView();
}

/** Dibuja solo la vista visible (ECharts no puede medir un div oculto). */
function renderActiveView() {
  const texts = VIEW_TEXTS[state.activeView];
  if (texts) {
    const eyebrowEl = document.getElementById("stageEyebrow");
    const titleEl = document.getElementById("stageTitle");
    if (eyebrowEl) eyebrowEl.textContent = texts.eyebrow;
    if (titleEl) titleEl.textContent = texts.title();
  }

  if (state.activeView === "series") {
    renderSeriesChart();
    if (chartSeries) chartSeries.resize();
  } else if (state.activeView === "seasonal") {
    renderSeasonalChart();
    if (chartSeasonal) chartSeasonal.resize();
  } else {
    renderCalendarChart();
    if (chartCalendar) chartCalendar.resize();
  }
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
    // Clic en cualquier punto del área del gráfico → evaluar ese mes
    chartSeries.getZr().on("click", (e) => {
      const px = [e.offsetX, e.offsetY];
      if (!chartSeries.containPixel("grid", px)) return;
      const idx = chartSeries.convertFromPixel({ seriesIndex: 0 }, px)[0];
      const label = chartSeries._labels && chartSeries._labels[idx];
      if (!label) return;
      const [y, m] = label.split("-").map((s) => parseInt(s, 10));
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

  const harm = rows.map((r) => round1(r.harm));
  const aqua = rows.map((r) => (r.aqua === null ? null : r.aqua));
  const snppRaw = rows.map((r) => (r.snpp === null ? null : r.snpp));
  const snppConv = rows.map((r) => (r.snpp === null ? null : round1(r.snpp * getFactor(r.month))));

  // Franjas de contexto, recortadas al rango de años visible
  const first = labels[0];
  const last = labels[labels.length - 1];
  const areas = [];
  const addArea = (name, from, to, color) => {
    const a = from < first ? first : from;
    const b = to > last ? last : to;
    if (a <= b) {
      areas.push([
        { name, xAxis: a, itemStyle: { color } },
        { xAxis: b }
      ]);
    }
  };
  addArea("Calibración k_m", "2012-02", "2021-12", "rgba(15, 118, 110, 0.07)");
  addArea("Apagón Aqua", "2020-08", "2020-09", "rgba(100, 116, 139, 0.30)");
  addArea("Relevo VIIRS (deriva Aqua)", "2022-01", "2026-10", "rgba(245, 158, 11, 0.10)");

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

  const option = {
    backgroundColor: "#ffffff",
    animation: false,
    tooltip: {
      ...TOOLTIP_STYLE,
      trigger: "axis",
      valueFormatter: (v) => (v === null || v === undefined || Number.isNaN(v) ? "—" : fmtNum(v))
    },
    legend: {
      top: 0,
      itemWidth: 14,
      itemHeight: 8,
      textStyle: { fontSize: 10, color: "#475569", fontFamily: "Sora" }
    },
    grid: { top: 30, bottom: 50, left: 48, right: 16 },
    xAxis: {
      type: "category",
      data: labels,
      boundaryGap: false,
      axisLine: { lineStyle: { color: "#cbd5e1" } },
      axisLabel: { color: "#475569", fontSize: 10, fontFamily: "Sora" },
      axisTick: { show: false }
    },
    yAxis: {
      type: "value",
      name: "celdas-día",
      nameTextStyle: { fontSize: 9, color: "#64748b" },
      splitLine: { lineStyle: { color: "#f1f5f9" } },
      axisLabel: { color: "#475569", fontSize: 10, fontFamily: "Sora" }
    },
    dataZoom: [
      { type: "inside" },
      { type: "slider", height: 14, bottom: 6, borderColor: "#e2e8f0", textStyle: { fontSize: 9 } }
    ],
    series: [
      {
        name: "Armonizada (eq. Aqua)",
        type: "line",
        data: harm,
        showSymbol: false,
        z: 5,
        lineStyle: { width: 2.2, color: "#0f172a" },
        itemStyle: { color: "#0f172a" },
        markArea: {
          silent: true,
          label: { fontSize: 9, color: "#475569", position: "insideTop" },
          data: areas
        },
        markLine: focusLine
      },
      {
        name: "Aqua crudo",
        type: "line",
        data: aqua,
        showSymbol: false,
        lineStyle: { width: 1.2, color: "#0284c7" },
        itemStyle: { color: "#0284c7" }
      },
      {
        name: "S-NPP crudo",
        type: "line",
        data: snppRaw,
        showSymbol: false,
        lineStyle: { width: 1.2, color: "#dc2626", opacity: 0.8 },
        itemStyle: { color: "#dc2626" }
      },
      {
        name: "S-NPP × k_m",
        type: "line",
        data: snppConv,
        showSymbol: false,
        lineStyle: { width: 1.2, color: "#0f766e", type: "dashed" },
        itemStyle: { color: "#0f766e" }
      }
    ]
  };

  // notMerge=false para conservar el zoom del usuario entre actualizaciones
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
  const p25 = [];
  const band = [];
  const median = [];
  const current = [];

  for (let m = 1; m <= 12; m++) {
    const s = hist[m];
    p25.push(round1(s.p25));
    band.push(round1(s.p75 - s.p25));
    median.push(round1(s.median));

    const bucket = state.currentSeriesByYm.get(ymKey(state.focusYear, m));
    if (!bucket) {
      current.push({ value: null });
      continue;
    }
    const v = round1(bucket.harm);
    // Color según dónde cae el mes respecto a lo normal
    let color = "#94a3b8";
    if (v > s.p75) color = "#c2410c";
    else if (v < s.p25) color = "#0f766e";
    const isFocus = m === state.focusMonth;
    current.push({
      value: v,
      itemStyle: {
        color,
        borderColor: isFocus ? "#0f172a" : color,
        borderWidth: isFocus ? 2 : 0
      }
    });
  }

  const option = {
    backgroundColor: "#ffffff",
    animation: false,
    tooltip: {
      ...TOOLTIP_STYLE,
      trigger: "axis",
      formatter: (items) => {
        const m = items[0].dataIndex + 1;
        const s = hist[m];
        const b = state.currentSeriesByYm.get(ymKey(state.focusYear, m));
        const val = b ? fmtNum(b.harm) : "sin datos";
        let estado = "";
        if (b) {
          if (b.harm > s.p75) estado = "<span style='color:#fdba74'>▲ Por encima de lo normal</span>";
          else if (b.harm < s.p25) estado = "<span style='color:#5eead4'>▼ Por debajo de lo normal</span>";
          else estado = "<span style='color:#cbd5e1'>● Dentro de lo normal</span>";
        }
        return `
          <div style="font-weight:700;margin-bottom:3px">${MONTH_FULL_NAMES[m - 1]} ${state.focusYear}</div>
          <div>Valor: <b>${val}</b> celdas-día</div>
          <div>Mediana 2003–2025: <b>${fmtNum(s.median)}</b></div>
          <div>Banda normal: ${fmtNum(s.p25)} – ${fmtNum(s.p75)}</div>
          <div style="margin-top:3px">${estado}</div>`;
      }
    },
    legend: {
      top: 0,
      data: [`Año ${state.focusYear}`, "Mediana 2003–2025", "Banda normal (P25–P75)"],
      itemWidth: 14,
      itemHeight: 8,
      textStyle: { fontSize: 10, color: "#475569", fontFamily: "Sora" }
    },
    grid: { top: 30, bottom: 26, left: 48, right: 16 },
    xAxis: {
      type: "category",
      data: MONTH_NAMES,
      axisLine: { lineStyle: { color: "#cbd5e1" } },
      axisLabel: { color: "#475569", fontSize: 11, fontFamily: "Sora" },
      axisTick: { show: false }
    },
    yAxis: {
      type: "value",
      name: "celdas-día",
      nameTextStyle: { fontSize: 9, color: "#64748b" },
      splitLine: { lineStyle: { color: "#f1f5f9" } },
      axisLabel: { color: "#475569", fontSize: 10, fontFamily: "Sora" }
    },
    series: [
      // Banda P25–P75 como área apilada (base invisible + ancho de banda)
      {
        name: "P25",
        type: "line",
        stack: "iqr",
        data: p25,
        symbol: "none",
        lineStyle: { opacity: 0 },
        tooltip: { show: false },
        silent: true
      },
      {
        name: "Banda normal (P25–P75)",
        type: "line",
        stack: "iqr",
        data: band,
        symbol: "none",
        lineStyle: { opacity: 0 },
        areaStyle: { color: "rgba(148, 163, 184, 0.28)" },
        itemStyle: { color: "rgba(148, 163, 184, 0.6)" },
        silent: true
      },
      {
        name: `Año ${state.focusYear}`,
        type: "bar",
        data: current,
        barWidth: "45%",
        itemStyle: { color: "#94a3b8" }
      },
      {
        name: "Mediana 2003–2025",
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

function updateTelemetryCard(histStats) {
  const ym = `${state.focusYear}-${String(state.focusMonth).padStart(2, "0")}`;
  const current = state.currentSeriesByYm.get(ym);
  const mStat = histStats[state.focusMonth] || { median: 0, mean: 0, p25: 0, p75: 0 };

  const titleEl = document.getElementById("diagPeriodTitle");
  if (titleEl) {
    titleEl.textContent = `${MONTH_FULL_NAMES[state.focusMonth - 1]} ${state.focusYear}`;
  }

  const currVal = current ? current.harm : 0;
  const currValEl = document.getElementById("kpiCurrentVal");
  if (currValEl) {
    currValEl.textContent = currVal.toLocaleString("es-BO", { maximumFractionDigits: 1 });
  }

  let sourceLabel = "MODIS Aqua directo";
  if (state.focusYear === 2020 && (state.focusMonth === 8 || state.focusMonth === 9)) {
    sourceLabel = "VIIRS S-NPP armonizado (reemplazo apagón Aqua)";
  } else if (state.focusYear >= 2022) {
    sourceLabel = current && current.hasNrt
      ? "VIIRS S-NPP armonizado (2026 NRT provisional)"
      : "VIIRS S-NPP armonizado (era deriva Aqua)";
  }
  const srcEl = document.getElementById("kpiCurrentSource");
  if (srcEl) srcEl.textContent = `Fuente: ${sourceLabel}`;

  const medEl = document.getElementById("kpiMedianVal");
  if (medEl) medEl.textContent = mStat.median.toLocaleString("es-BO", { maximumFractionDigits: 1 });

  const meanEl = document.getElementById("kpiMeanVal");
  if (meanEl) meanEl.textContent = mStat.mean.toLocaleString("es-BO", { maximumFractionDigits: 1 });

  const iqrEl = document.getElementById("kpiIqrVal");
  if (iqrEl) {
    const p25Fmt = mStat.p25.toLocaleString("es-BO", { maximumFractionDigits: 1 });
    const p75Fmt = mStat.p75.toLocaleString("es-BO", { maximumFractionDigits: 1 });
    iqrEl.textContent = `${p25Fmt} – ${p75Fmt}`;
  }

  const diff = currVal - mStat.median;
  const anomEl = document.getElementById("kpiAnomalyVal");
  const anomTxt = document.getElementById("kpiAnomalyText");

  if (anomEl && anomTxt) {
    if (mStat.median > 0) {
      const pct = (diff / mStat.median) * 100.0;
      const sign = diff >= 0 ? "+" : "";
      anomEl.textContent = `${sign}${pct.toFixed(1)} %`;
      anomEl.style.color = diff > 0 ? "#c2410c" : "#0f766e";
      anomTxt.textContent = `${sign}${diff.toFixed(1)} celdas-día frente a la mediana histórica`;
    } else {
      const diffMean = currVal - mStat.mean;
      const sign = diffMean >= 0 ? "+" : "";
      anomEl.textContent = `${sign}${diffMean.toFixed(1)} vs. media`;
      anomEl.style.color = diffMean > 0 ? "#c2410c" : "#0f766e";
      anomTxt.textContent = `Mediana = 0; diferencia frente al promedio histórico (${mStat.mean.toFixed(1)} celdas-día)`;
    }
  }

  // Actualizar marcador del gauge visual con interpolación lineal por tramos (P25=25%, Mediana=50%, P75=75%)
  const markerEl = document.querySelector(".track-current-marker");
  if (markerEl) {
    const p25 = mStat.p25;
    const med = mStat.median;
    const p75 = mStat.p75;
    let pos = 50;
    if (p75 <= 0 && currVal <= 0) {
      pos = 25;
    } else if (currVal <= p25) {
      pos = p25 > 0 ? 3 + (currVal / p25) * 22 : 25;
    } else if (currVal <= med) {
      pos = med > p25 ? 25 + ((currVal - p25) / (med - p25)) * 25 : 50;
    } else if (currVal <= p75) {
      pos = p75 > med ? 50 + ((currVal - med) / (p75 - med)) * 25 : 75;
    } else {
      const upperCap = Math.max(p75 * 2.0, p75 + (p75 - p25) * 1.5, 10);
      const ratio = Math.min(1, (currVal - p75) / Math.max(1, upperCap - p75));
      pos = 75 + ratio * 22;
    }
    markerEl.style.left = `${Math.min(97, Math.max(3, pos)).toFixed(1)}%`;
  }

  const factorEl = document.getElementById("msFactorVal");
  if (factorEl && state.meta && state.meta.factors_by_month) {
    const kVal = state.meta.factors_by_month[String(state.focusMonth)];
    factorEl.textContent = `k = ${Number(kVal).toFixed(3)}`;
  }

  const srEl = document.getElementById("calendarSummarySR");
  if (srEl) {
    srEl.textContent = `Área seleccionada con ${state.selectedCells.size} celdas activas. Periodo evaluado: ${MONTH_FULL_NAMES[state.focusMonth - 1]} ${state.focusYear} con ${currVal.toFixed(1)} celdas-día.`;
  }
}

function populateScienceRailFromMeta() {
  if (!state.meta) return;

  const eyebrowEl = document.getElementById("valScopeEyebrow");
  const rawNumEl = document.getElementById("valSplit1RawNum");
  const biasEl = document.getElementById("valSplit1Bias");
  const aquaEl = document.getElementById("valSplit1Aqua");
  const harmEl = document.getElementById("valSplit1Harm");
  const rawEl = document.getElementById("valSplit1Raw");

  const subMap = {
    chiquitania: "chiquitania_llanos",
    amazonia: "amazonia_beni_norte",
    andina: "andina_valles"
  };

  let metrics = null;
  if (state.preset === "all") {
    if (eyebrowEl) eyebrowEl.textContent = "EVALUACIÓN CIENTÍFICA · PRUEBA FUERA DE MUESTRA (2017–2021)";
    metrics = state.meta.validation_metrics?.train_2012_2016_test_2017_2021;
  } else if (subMap[state.preset]) {
    if (eyebrowEl) eyebrowEl.textContent = "EVALUACIÓN CIENTÍFICA · TRASLAPE EN SUBREGIÓN (2012–2021)";
    metrics = state.meta.validation_metrics?.subregions_2012_2021?.[subMap[state.preset]];
  } else if (state.preset === "custom") {
    if (eyebrowEl) eyebrowEl.textContent = "EVALUACIÓN CIENTÍFICA · TRASLAPE EN POLÍGONO (2012–2021)";
    let sumAqua = 0;
    let sumSnppRaw = 0;
    let sumSnppHarm = 0;
    const factors = state.meta.factors_by_month || {};
    state.selectedCells.forEach((cellId) => {
      const cell = state.cellsMeta.get(cellId);
      if (!cell) return;
      for (const r of cell.records) {
        if (r.year < 2012 || r.year > 2021) continue;
        if (r.year === 2012 && r.month === 1) continue;
        if (r.year === 2020 && (r.month === 8 || r.month === 9)) continue;
        const a = r.aqua || 0;
        const s = r.snpp || 0;
        const k = Number(factors[String(r.month)] || state.meta.factor_annual_fallback || 0.3514);
        sumAqua += a;
        sumSnppRaw += s;
        sumSnppHarm += s * k;
      }
    });
    if (sumAqua > 0) {
      metrics = {
        aqua_total: Math.round(sumAqua * 10) / 10,
        snpp_raw_total: Math.round(sumSnppRaw * 10) / 10,
        snpp_harmonized_total: Math.round(sumSnppHarm * 10) / 10,
        raw_bias_pct: Math.round(((sumSnppRaw - sumAqua) / sumAqua) * 10000) / 100,
        harmonized_bias_pct: Math.round(((sumSnppHarm - sumAqua) / sumAqua) * 10000) / 100
      };
    } else {
      if (rawNumEl) rawNumEl.textContent = "—";
      if (biasEl) biasEl.textContent = "—";
      if (aquaEl) aquaEl.textContent = "0";
      if (harmEl) harmEl.textContent = sumSnppHarm.toFixed(1);
      if (rawEl) rawEl.textContent = "Sin detecciones de referencia MODIS Aqua en 2012–2021 dentro del polígono.";
      return;
    }
  }

  if (metrics) {
    const rawSign = metrics.raw_bias_pct >= 0 ? "+" : "";
    const harmSign = metrics.harmonized_bias_pct > 0 ? "+" : "";

    if (rawNumEl) rawNumEl.textContent = `${rawSign}${metrics.raw_bias_pct.toFixed(1).replace(".", ",")} %`;
    if (biasEl) biasEl.textContent = `${harmSign}${metrics.harmonized_bias_pct.toFixed(2).replace(".", ",")} % sesgo`;
    if (aquaEl) aquaEl.textContent = metrics.aqua_total.toLocaleString("es-BO");
    if (harmEl) harmEl.textContent = metrics.snpp_harmonized_total.toLocaleString("es-BO", { maximumFractionDigits: 1 });
    if (rawEl) {
      rawEl.textContent = `Salto bruto eliminado: ${rawSign}${metrics.raw_bias_pct.toFixed(1)} % → ${harmSign}${metrics.harmonized_bias_pct} %`;
    }
  }
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
  for (let y = state.yearStart; y <= state.yearEnd; y++) {
    years.push(String(y));
  }
  chartCalendar._yearsList = years;

  const data = [];
  let maxVal = 0;

  years.forEach((yStr, yIdx) => {
    const y = parseInt(yStr, 10);
    for (let m = 1; m <= 12; m++) {
      if (y === 2026 && m > 10) continue;
      const ym = `${y}-${String(m).padStart(2, "0")}`;
      const bucket = state.currentSeriesByYm.get(ym);
      const val = bucket ? bucket.harm : 0;
      if (val > maxVal) maxVal = val;
      data.push([m - 1, yIdx, Math.round(val * 10) / 10]);
    }
  });

  const ramp = COLOR_RAMPS[state.colorRamp] || COLOR_RAMPS.fire;

  const option = {
    backgroundColor: "#ffffff",
    tooltip: {
      position: "top",
      backgroundColor: "rgba(15, 23, 42, 0.96)",
      borderColor: "#e2e8f0",
      borderWidth: 1,
      textStyle: { color: "#ffffff", fontFamily: "Sora, sans-serif", fontSize: 11 },
      formatter: (p) => {
        const mIdx = p.value[0];
        const mNum = mIdx + 1;
        const mName = MONTH_NAMES[mIdx];
        const year = years[p.value[1]];
        const yNum = parseInt(year, 10);
        const val = p.value[2];
        const ym = `${year}-${String(mNum).padStart(2, "0")}`;
        const b = state.currentSeriesByYm.get(ym);
        let srcText = "MODIS Aqua directo (referencia)";
        if (yNum === 2020 && (mNum === 8 || mNum === 9)) {
          srcText = "VIIRS S-NPP (armonizado, apagón Aqua)";
        } else if (yNum >= 2022) {
          srcText = b && b.hasNrt
            ? "VIIRS S-NPP (NRT provisional)"
            : "VIIRS S-NPP (armonizado)";
        }
        return `
          <div style="font-weight:700;margin-bottom:3px">${mName} ${year}</div>
          <div>Actividad: <b>${val.toLocaleString("es-BO")}</b> celdas-día eq. Aqua</div>
          <div style="color:#94a3b8;font-size:10px;margin-top:2px">Fuente: ${srcText}</div>
        `;
      }
    },
    grid: {
      top: 15,
      bottom: 76,
      left: 50,
      right: 20
    },
    xAxis: {
      type: "category",
      data: MONTH_NAMES,
      splitArea: { show: false },
      axisLine: { lineStyle: { color: "#e2e8f0" } },
      axisLabel: { color: "#475569", fontSize: 11, fontFamily: "Sora" },
      axisTick: { show: false }
    },
    yAxis: {
      type: "category",
      data: years,
      splitArea: { show: false },
      axisLine: { lineStyle: { color: "#e2e8f0" } },
      axisLabel: { color: "#0f172a", fontSize: 11, fontFamily: "Sora", fontWeight: 600 },
      axisTick: { show: false }
    },
    visualMap: {
      min: 0,
      max: maxVal > 0 ? maxVal : 100,
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      inRange: { color: ramp },
      textStyle: { color: "#64748b", fontSize: 10, fontFamily: "Sora" }
    },
    series: [
      {
        name: "Celdas-día con fuego",
        type: "heatmap",
        data: data,
        label: { show: false },
        itemStyle: {
          borderWidth: 1,
          borderColor: "#ffffff",
          borderRadius: 0
        },
        emphasis: {
          itemStyle: {
            shadowBlur: 8,
            shadowColor: "rgba(15, 23, 42, 0.35)",
            borderColor: "#0f172a",
            borderWidth: 1.5
          }
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

  const colorSel = document.getElementById("colorRamp");
  if (colorSel) {
    colorSel.addEventListener("change", (e) => {
      state.colorRamp = e.target.value;
      renderActiveView();
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
      syncFocusMonthOptions();
      updateAllViews();
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
      syncFocusMonthOptions();
      updateAllViews();
    });
  }

  syncFocusMonthOptions();

  const dlSeriesBtn = document.getElementById("btnDownloadSeries");
  if (dlSeriesBtn) {
    dlSeriesBtn.addEventListener("click", downloadAoiSeriesCsv);
  }

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  window.addEventListener("resize", () => {
    [chartCalendar, chartSeries, chartSeasonal].forEach((c) => {
      if (c) c.resize();
    });
    if (map) map.invalidateSize();
  });
}

(async function initApp() {
  try {
    populateYearSelectors();
    initMap();
    bindEvents();
    await loadAllData();
    populateScienceRailFromMeta();
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
