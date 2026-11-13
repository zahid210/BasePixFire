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

const STAGE_META = {
  "stage-calendar": {
    eyebrow: "SERIE ARMONIZADA 2003–2026 · EQUIVALENTE MODIS AQUA",
    title: "Calendario de Actividad de Quema (Año × Mes)"
  },
  "stage-map": {
    eyebrow: "SELECCIÓN GEOESPACIAL · GRILLA DE 0,25° (~27,5 KM)",
    title: "Mapa Interactivo del Área de Interés (AOI)"
  }
};

const state = {
  meta: null,
  cellsMeta: new Map(), // cell_id -> { cellId, row, col, lat, lon, subregion, totalHarm, records: [] }
  allRecords: [],
  validationRows: [],
  selectedCells: new Set(),
  customPolygon: null,
  preset: "all",
  activeStage: "stage-calendar",
  yearStart: 2003,
  yearEnd: 2026,
  focusYear: 2026,
  focusMonth: 10,
  colorRamp: "fire",
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
    const [yStr, mStr, aStr, sRawStr, sHarmStr] = line.split(",");
    state.validationRows.push({
      year: parseInt(yStr, 10),
      month: parseInt(mStr, 10),
      aqua: parseFloat(aStr),
      snpp_raw: parseFloat(sRawStr),
      snpp_harmonized: parseFloat(sHarmStr)
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
  const numYears = 23.8;

  state.cellsMeta.forEach((cell) => {
    const isSelected = state.selectedCells.has(cell.cellId);
    const annualAvg = cell.totalHarm / numYears;
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
      `Promedio: ${annualAvg.toFixed(1)} celdas-día/año<br>` +
      `Total 2003–2026: ${cell.totalHarm.toFixed(1)} celdas-día`,
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
  const approxKm2 = Math.round(count * 27.5 * 27.5).toLocaleString("es-BO");
  const badgeEl = document.getElementById("aoiStatsBadge");
  if (badgeEl) badgeEl.textContent = `${count} celdas activas · ~${approxKm2} km²`;

  const warnBar = document.getElementById("aoiWarning");
  const warnTxt = document.getElementById("aoiWarningText");
  const warnings = [];

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
      if (r.source === "snpp_nrt") bucket.hasNrt = true;
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
  renderCalendarChart();
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
  if (iqrEl) iqrEl.textContent = `${mStat.p25.toFixed(0)} – ${mStat.p75.toFixed(0)}`;

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
      anomEl.textContent = `${sign}${diffMean.toFixed(1)}`;
      anomEl.style.color = diffMean > 0 ? "#c2410c" : "#0f766e";
      anomTxt.textContent = `Mediana = 0; diferencia vs. promedio (${mStat.mean.toFixed(1)})`;
    }
  }

  // Actualizar marcador del gauge visual
  const markerEl = document.querySelector(".track-current-marker");
  if (markerEl && mStat.p75 > 0) {
    const pos = Math.min(95, Math.max(5, (currVal / (mStat.p75 * 1.6)) * 100));
    markerEl.style.left = `${pos}%`;
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
  const m1 = state.meta.validation_metrics?.train_2012_2016_test_2017_2021;
  if (m1) {
    const biasEl = document.getElementById("valSplit1Bias");
    const aquaEl = document.getElementById("valSplit1Aqua");
    const harmEl = document.getElementById("valSplit1Harm");
    const rawEl = document.getElementById("valSplit1Raw");

    if (biasEl) biasEl.textContent = `${m1.harmonized_bias_pct} % sesgo`;
    if (aquaEl) aquaEl.textContent = m1.aqua_total.toLocaleString("es-BO");
    if (harmEl) harmEl.textContent = m1.snpp_harmonized_total.toLocaleString("es-BO");
    if (rawEl) {
      rawEl.textContent = `Salto bruto eliminado: +${m1.raw_bias_pct.toFixed(1)} % → ${m1.harmonized_bias_pct} %`;
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
        const mIdx = params.value[0];
        const yLabel = chartCalendar._yearsList[params.value[1]];
        state.focusMonth = mIdx + 1;
        state.focusYear = parseInt(yLabel, 10);

        const mSel = document.getElementById("focusMonth");
        const ySel = document.getElementById("focusYear");
        if (mSel) mSel.value = String(state.focusMonth);
        if (ySel) ySel.value = String(state.focusYear);

        updateAllViews();
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
        const mName = MONTH_NAMES[p.value[0]];
        const year = years[p.value[1]];
        const val = p.value[2];
        const ym = `${year}-${String(p.value[0] + 1).padStart(2, "0")}`;
        const b = state.currentSeriesByYm.get(ym);
        const srcText =
          parseInt(year, 10) < 2022
            ? "MODIS Aqua (calibrado)"
            : b && b.hasNrt
              ? "VIIRS S-NPP (NRT provisional)"
              : "VIIRS S-NPP (armonizado)";
        return `
          <div style="font-weight:700;margin-bottom:3px">${mName} ${year}</div>
          <div>Actividad: <b>${val.toLocaleString("es-BO")}</b> celdas-día eq. Aqua</div>
          <div style="color:#94a3b8;font-size:10px;margin-top:2px">Fuente: ${srcText}</div>
        `;
      }
    },
    grid: {
      top: 15,
      bottom: 65,
      left: 50,
      right: 20
    },
    xAxis: {
      type: "category",
      data: MONTH_NAMES,
      position: "bottom",
      splitArea: { show: false },
      axisLine: { lineStyle: { color: "#e2e8f0" } },
      axisLabel: { color: "#475569", fontSize: 11, fontFamily: "Sora", margin: 8 },
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
      bottom: 2,
      itemHeight: 10,
      itemWidth: 160,
      inRange: { color: ramp },
      textStyle: { color: "#64748b", fontSize: 9.5, fontFamily: "Sora" }
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
 * 7. Alternancia de Escenario y Descarga CSV
 * ========================================================================= */
function switchStage(stageId) {
  state.activeStage = stageId;

  const info = STAGE_META[stageId] || STAGE_META["stage-calendar"];
  const eyebrowEl = document.getElementById("stageEyebrow");
  const titleEl = document.getElementById("stageTitle");
  if (eyebrowEl) eyebrowEl.textContent = info.eyebrow;
  if (titleEl) titleEl.textContent = info.title;

  setTimeout(() => {
    if (chartCalendar) chartCalendar.resize();
    if (map) map.invalidateSize();
  }, 50);
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
  const rows = [["year", "month", "count_harmonized_aqua_eq", "source", "aoi_preset", "selected_cells"]];
  const count = state.selectedCells.size;

  state.currentSeriesByYm.forEach((val, ym) => {
    const [yStr, mStr] = ym.split("-");
    const y = parseInt(yStr, 10);
    const m = parseInt(mStr, 10);
    if (y < state.yearStart || y > state.yearEnd) return;

    let src = "modis_aqua";
    if (y === 2020 && (m === 8 || m === 9)) src = "snpp_harmonized_outage";
    else if (y >= 2022) src = val.hasNrt ? "snpp_harmonized_nrt" : "snpp_harmonized";

    rows.push([y, m, val.harm.toFixed(2), src, state.preset, count]);
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
      updateAllViews();
    });
  }

  const colorSel = document.getElementById("colorRamp");
  if (colorSel) {
    colorSel.addEventListener("change", (e) => {
      state.colorRamp = e.target.value;
      renderCalendarChart();
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
      updateAllViews();
    });
  }

  const dlSeriesBtn = document.getElementById("btnDownloadSeries");
  if (dlSeriesBtn) {
    dlSeriesBtn.addEventListener("click", downloadAoiSeriesCsv);
  }

  window.addEventListener("resize", () => {
    if (chartCalendar) chartCalendar.resize();
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
