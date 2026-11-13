/**
 * PixFire Bolivia — Aplicación web de visualización y análisis de la serie
 * armonizada MODIS (Aqua) + VIIRS (Suomi-NPP) 2003–2026.
 *
 * Consume los archivos estáticos definidos en DATA_CONTRACT.md v3:
 *   - data/processed/metadata.json
 *   - data/processed/monthly_cells.csv
 *   - data/processed/validation.csv
 */

const MONTH_NAMES = [
  "Ene", "Feb", "Mar", "Abr", "May", "Jun",
  "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"
];

const COLOR_RAMPS = {
  viridis: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"],
  ylorrd: ["#ffffcc", "#fed976", "#fd8d3c", "#e31a1c", "#800026"],
  plasma: ["#0d0887", "#7e03a8", "#cc4778", "#f89540", "#f0f921"]
};

const state = {
  meta: null,
  cellsMeta: new Map(), // cell_id -> { row, col, lat, lon, totalHarm, records: [] }
  allRecords: [],       // { cellId, year, month, harm, aqua, snpp, source }
  validationRows: [],
  selectedCells: new Set(),
  customPolygon: null,  // GeoJSON Polygon si el usuario dibuja en el mapa
  preset: "all",
  yearStart: 2003,
  yearEnd: 2026,
  focusYear: 2026,
  focusMonth: 10,
  colorRamp: "viridis",
   currentSeriesByYm: new Map() // "YYYY-MM" -> { harm, aqua, snpp, hasNrt }
};

let map = null;
let gridLayerGroup = null;
let drawnItems = null;
let chartCalendar = null;
let chartSeasonal = null;
let chartAnnual = null;
let chartValidation = null;

/* =========================================================================
 * 1. Carga y parseo de datos
 * ========================================================================= */
async function loadAllData() {
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
      cellObj = { cellId, row, col, lat, lon, totalHarm: 0, records: [] };
      state.cellsMeta.set(cellId, cellObj);
    }

    const rec = { cellId, year, month, harm, aqua, snpp, source };
    cellObj.totalHarm += harm;
    cellObj.records.push(rec);
    state.allRecords.push(rec);
  }
}

function parseValidationCsv(csvText) {
  const lines = csvText.trim().split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const [yStr, mStr, hStr, aStr, srStr, scStr, split] = line.split(",");
    state.validationRows.push({
      year: parseInt(yStr, 10),
      month: parseInt(mStr, 10),
      ym: `${yStr}-${mStr.padStart(2, "0")}`,
      harmonized: parseFloat(hStr),
      aqua: aStr === "" ? null : parseFloat(aStr),
      snppRaw: srStr === "" ? null : parseFloat(srStr),
      snppConverted: scStr === "" ? null : parseFloat(scStr),
      split
    });
  }
}

/* =========================================================================
 * 2. Mapa interactivo (Leaflet + Leaflet.draw + Turf.js)
 * ========================================================================= */
function initMap() {
  map = L.map("map", {
    center: [-16.4, -64.2],
    zoom: 5,
    minZoom: 4,
    maxZoom: 10
  });

  const darkLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; OpenStreetMap &copy; CARTO | Datos: NASA FIRMS',
    subdomains: 'abcd',
    maxZoom: 19
  });

  const osmLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; OpenStreetMap contributors | Datos: NASA FIRMS',
    maxZoom: 19
  });

  const satLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community | Datos: NASA FIRMS',
    maxZoom: 18
  });

  darkLayer.addTo(map);

  const baseMaps = {
    "Mapa Claro (Carto/OSM)": darkLayer,
    "OpenStreetMap Estándar": osmLayer,
    "Satélite (Esri World Imagery)": satLayer
  };

  L.control.layers(baseMaps, null, { position: "topleft" }).addTo(map);

  gridLayerGroup = L.layerGroup().addTo(map);
  drawnItems = new L.FeatureGroup().addTo(map);

  const drawControl = new L.Control.Draw({
    position: "topright",
    draw: {
      polygon: {
        allowIntersection: false,
        shapeOptions: { color: "#38bdf8", weight: 2, fillOpacity: 0.15 }
      },
      rectangle: {
        shapeOptions: { color: "#38bdf8", weight: 2, fillOpacity: 0.15 }
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

  map.on(L.Draw.Event.CREATED, (e) => {
    drawnItems.clearLayers();
    drawnItems.addLayer(e.layer);
    state.customPolygon = e.layer.toGeoJSON();
    state.preset = "custom";
    document.getElementById("presetRegion").value = "custom";
    syncBboxInputsFromPolygon(state.customPolygon);
    recomputeAoiSelection();
  });

  map.on(L.Draw.Event.DELETED, () => {
    resetToPreset("all");
  });
}

function getDensityColor(annualAvg) {
  if (annualAvg > 25) return "#ef4444";
  if (annualAvg > 12) return "#fde725";
  if (annualAvg > 5) return "#5ec962";
  if (annualAvg > 1.5) return "#21918c";
  return "#3b528b";
}

function renderMapGrid() {
  gridLayerGroup.clearLayers();
  const half = state.meta.cell_size_deg / 2.0;
  const numYears = 23.8; // 2003-2026

  state.cellsMeta.forEach((cell) => {
    const isSelected = state.selectedCells.has(cell.cellId);
    const annualAvg = cell.totalHarm / numYears;
    const fillColor = getDensityColor(annualAvg);

    const bounds = [
      [cell.lat - half, cell.lon - half],
      [cell.lat + half, cell.lon + half]
    ];

    const rect = L.rectangle(bounds, {
      color: isSelected ? "#f8fafc" : fillColor,
      weight: isSelected ? 0.6 : 0.2,
      fillColor: fillColor,
      fillOpacity: isSelected ? 0.68 : 0.12
    });

    rect.bindTooltip(
      `<strong>Celda ${cell.cellId}</strong><br>` +
      `Centro: ${cell.lat.toFixed(3)}°, ${cell.lon.toFixed(3)}°<br>` +
      `Promedio anual: ${annualAvg.toFixed(1)} celdas-día/año<br>` +
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
  if (preset === "chiquitania") return cell.lon > -64.0 && cell.lat < -14.0;
  if (preset === "amazonia") return cell.lat >= -14.0;
  if (preset === "andina") return cell.lon <= -64.0 && cell.lat < -14.0;
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

  // Actualizar badge y avisos de casos borde (DATA_CONTRACT.md §3.3)
  const count = state.selectedCells.size;
  document.getElementById("aoiStatsBadge").textContent =
    `${count} celdas activas (${Math.round(count * 27.5 * 27.5).toLocaleString("es-BO")} km²)`;

  const warnEl = document.getElementById("aoiWarning");
  const warnings = [];
  if (count === 0) {
    warnings.push("El área dibujada no contiene celdas con detecciones históricas de fuego en Bolivia.");
  } else if (count < 4) {
    warnings.push(
      `Muestra espacial pequeña (${count} celdas): en áreas menores a 4 celdas la incertidumbre del factor estacional es mayor.`
    );
  }

  if (state.customPolygon) {
    const [minLon, minLat, maxLon, maxLat] = turf.bbox(state.customPolygon);
    const [bMinLon, bMinLat, bMaxLon, bMaxLat] = state.meta.bbox;
    if (minLon < bMinLon - 0.5 || minLat < bMinLat - 0.5 || maxLon > bMaxLon + 0.5 || maxLat > bMaxLat + 0.5) {
      warnings.push(
        "Parte del polígono se extiende fuera de la frontera de Bolivia (Buffer 0 km); los datos cubren únicamente territorio boliviano."
      );
    }
  }

  if (warnings.length > 0) {
    warnEl.textContent = "⚠️ " + warnings.join(" ");
    warnEl.classList.remove("hidden");
  } else {
    warnEl.classList.add("hidden");
  }

  renderMapGrid();
  aggregateSelectedCells();
  updateAllViews();
}

function aggregateSelectedCells() {
  state.currentSeriesByYm.clear();

  // Inicializar todos los meses 2003-01 a 2026-10 en 0 dentro de su cobertura
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
      if (r.aqua !== null) bucket.aqua += r.aqua;
      if (r.snpp !== null) {
        bucket.snpp = (bucket.snpp || 0) + r.snpp;
      }
      if (r.source === "snpp_converted_nrt") bucket.hasNrt = true;
    }
  });
}

/* =========================================================================
 * 4. Estadísticas históricas (Mediana, Promedio, P25, P75 sobre el total del AOI)
 * ========================================================================= */
function quantile(sortedArr, q) {
  if (sortedArr.length === 0) return 0;
  const pos = (sortedArr.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedArr[base + 1] !== undefined) {
    return sortedArr[base] + rest * (sortedArr[base + 1] - sortedArr[base]);
  }
  return sortedArr[base];
}

function computeHistoricalStatsByMonth() {
  const stats = {};
  const [baseStart, baseEnd] = state.meta.baseline_years; // [2003, 2025]

  for (let m = 1; m <= 12; m++) {
    const values = [];
    for (let y = baseStart; y <= baseEnd; y++) {
      const ym = `${y}-${String(m).padStart(2, "0")}`;
      const item = state.currentSeriesByYm.get(ym);
      values.push(item ? item.harm : 0.0);
    }
    values.sort((a, b) => a - b);
    const sum = values.reduce((acc, v) => acc + v, 0);
    stats[m] = {
      median: quantile(values, 0.5),
      p25: quantile(values, 0.25),
      p75: quantile(values, 0.75),
      mean: values.length ? sum / values.length : 0,
      max: values.length ? values[values.length - 1] : 0
    };
  }
  return stats;
}

/* =========================================================================
 * 5. Actualización de KPIs y Gráficos ECharts
 * ========================================================================= */
function updateAllViews() {
  const histStats = computeHistoricalStatsByMonth();
  updateKpis(histStats);
  renderCalendarChart();
  renderSeasonalChart(histStats);
  renderAnnualChart();
  renderValidationChart();
}

function updateKpis(histStats) {
  const ym = `${state.focusYear}-${String(state.focusMonth).padStart(2, "0")}`;
  const current = state.currentSeriesByYm.get(ym);
  const mStat = histStats[state.focusMonth];

  const currVal = current ? current.harm : 0;
  document.getElementById("kpiCurrentVal").textContent =
    `${currVal.toLocaleString("es-BO", { maximumFractionDigits: 1 })}`;

  let sourceLabel = "Fuente: MODIS Aqua directo";
  if (state.focusYear === 2020 && (state.focusMonth === 8 || state.focusMonth === 9)) {
    sourceLabel = "Fuente: VIIRS S-NPP armonizado (reemplazo apagón Aqua)";
  } else if (state.focusYear >= 2022) {
    sourceLabel = current && current.hasNrt
      ? "Fuente: VIIRS S-NPP armonizado (2026 NRT provisional)"
      : "Fuente: VIIRS S-NPP armonizado (era deriva Aqua)";
  }
  document.getElementById("kpiCurrentSource").textContent = sourceLabel;

  document.getElementById("kpiMedianVal").textContent =
    `${mStat.median.toLocaleString("es-BO", { maximumFractionDigits: 1 })}`;
  document.getElementById("kpiIqrVal").textContent =
    `Promedio: ${mStat.mean.toFixed(1)} · P25–P75: ${mStat.p25.toFixed(1)} – ${mStat.p75.toFixed(1)}`;

  // Anomalía
  const diff = currVal - mStat.median;
  const anomEl = document.getElementById("kpiAnomalyVal");
  const anomTxt = document.getElementById("kpiAnomalyText");

  if (mStat.median > 0) {
    const pct = (diff / mStat.median) * 100.0;
    const sign = diff >= 0 ? "+" : "";
    anomEl.textContent = `${sign}${pct.toFixed(1)} % (${sign}${diff.toFixed(1)})`;
    anomEl.style.color = diff > 0 ? "#ef4444" : "#22c55e";
    anomTxt.textContent = diff > 0
      ? `Por encima de la mediana de ${MONTH_NAMES[state.focusMonth - 1]} (2003–2025)`
      : `Por debajo de la mediana de ${MONTH_NAMES[state.focusMonth - 1]} (2003–2025)`;
  } else {
    const diffMean = currVal - mStat.mean;
    const sign = diffMean >= 0 ? "+" : "";
    anomEl.textContent = `${sign}${diffMean.toFixed(1)} vs. prom.`;
    anomEl.style.color = diffMean > 0 ? "#eab308" : "#22c55e";
    anomTxt.textContent = `Mediana histórica = 0; comparado contra promedio (${mStat.mean.toFixed(1)})`;
  }

  // Récord en el rango de años seleccionado
  let maxMonthVal = -1;
  let maxYm = "—";
  const annualTotals = new Map();

  state.currentSeriesByYm.forEach((val, key) => {
    if (val.year < state.yearStart || val.year > state.yearEnd) return;
    if (val.harm > maxMonthVal) {
      maxMonthVal = val.harm;
      maxYm = `${MONTH_NAMES[val.month - 1]} ${val.year}`;
    }
    annualTotals.set(val.year, (annualTotals.get(val.year) || 0) + val.harm);
  });

  let peakYear = "—";
  let peakYearVal = -1;
  annualTotals.forEach((tot, y) => {
    if (tot > peakYearVal) {
      peakYearVal = tot;
      peakYear = y;
    }
  });

  document.getElementById("kpiPeakVal").textContent =
    maxMonthVal >= 0 ? `${maxYm} (${maxMonthVal.toFixed(0)})` : "—";
  document.getElementById("kpiPeakYear").textContent =
    peakYearVal >= 0 ? `Año más crítico: ${peakYear} (${peakYearVal.toFixed(0)} celdas-día)` : "—";
}

function renderCalendarChart() {
  if (!chartCalendar) {
    chartCalendar = echarts.init(document.getElementById("chartCalendar"));
    chartCalendar.on("click", (params) => {
      if (params.value && params.value.length === 3) {
        const mIdx = params.value[0];
        const yLabel = chartCalendar._yearsList[params.value[1]];
        state.focusMonth = mIdx + 1;
        state.focusYear = parseInt(yLabel, 10);
        document.getElementById("focusMonth").value = String(state.focusMonth);
        document.getElementById("focusYear").value = String(state.focusYear);
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
  let maxVal = 10;

  years.forEach((yStr, yIdx) => {
    const y = parseInt(yStr, 10);
    for (let m = 1; m <= 12; m++) {
      if (y === 2026 && m > 10) continue;
      const ym = `${y}-${String(m).padStart(2, "0")}`;
      const bucket = state.currentSeriesByYm.get(ym);
      const val = bucket ? Number(bucket.harm.toFixed(1)) : 0;
      if (val > maxVal) maxVal = val;
      data.push([m - 1, yIdx, val]);
    }
  });

  const ramp = COLOR_RAMPS[state.colorRamp] || COLOR_RAMPS.viridis;

  chartCalendar.setOption({
    tooltip: {
      position: "top",
      formatter: (p) => {
        const mName = MONTH_NAMES[p.value[0]];
        const yName = years[p.value[1]];
        return `<strong>${mName} ${yName}</strong><br/>Actividad armonizada: <strong>${p.value[2]}</strong> celdas-día`;
      }
    },
    grid: { top: 20, bottom: 55, left: 60, right: 25 },
    xAxis: {
      type: "category",
      data: MONTH_NAMES,
      splitArea: { show: true },
      axisLabel: { color: "#cbd5e1", fontWeight: 600 }
    },
    yAxis: {
      type: "category",
      data: years,
      splitArea: { show: true },
      axisLabel: { color: "#cbd5e1" }
    },
    visualMap: {
      min: 0,
      max: maxVal,
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 5,
      inRange: { color: ramp },
      textStyle: { color: "#cbd5e1" }
    },
    series: [
      {
        name: "Celdas-día",
        type: "heatmap",
        data: data,
        label: {
          show: years.length <= 14,
          formatter: (p) => (p.value[2] > 0 ? Math.round(p.value[2]) : ""),
          color: "#0f172a",
          fontSize: 10
        },
        emphasis: {
          itemStyle: {
            shadowBlur: 8,
            shadowColor: "rgba(255, 255, 255, 0.8)"
          }
        }
      }
    ]
  });
}

function renderSeasonalChart(histStats) {
  if (!chartSeasonal) {
    chartSeasonal = echarts.init(document.getElementById("chartSeasonal"));
  }

  const p25 = [];
  const iqrDiff = [];
  const median = [];
  const mean = [];
  const focusSeries = [];

  for (let m = 1; m <= 12; m++) {
    const st = histStats[m];
    p25.push(Number(st.p25.toFixed(1)));
    iqrDiff.push(Number((st.p75 - st.p25).toFixed(1)));
    median.push(Number(st.median.toFixed(1)));
    mean.push(Number(st.mean.toFixed(1)));

    if (state.focusYear === 2026 && m > 10) {
      focusSeries.push(null);
    } else {
      const ym = `${state.focusYear}-${String(m).padStart(2, "0")}`;
      const b = state.currentSeriesByYm.get(ym);
      focusSeries.push(b ? Number(b.harm.toFixed(1)) : 0);
    }
  }

  chartSeasonal.setOption({
    tooltip: { trigger: "axis" },
    legend: {
      data: [`Año ${state.focusYear}`, "Mediana Histórica (2003–2025)", "Promedio Histórico", "Banda P25–P75"],
      textStyle: { color: "#cbd5e1", fontSize: 11 }
    },
    grid: { top: 40, bottom: 30, left: 55, right: 20 },
    xAxis: {
      type: "category",
      data: MONTH_NAMES,
      axisLabel: { color: "#cbd5e1" }
    },
    yAxis: {
      type: "value",
      name: "Celdas-día",
      nameTextStyle: { color: "#94a3b8" },
      axisLabel: { color: "#cbd5e1" },
      splitLine: { lineStyle: { color: "#334155" } }
    },
    series: [
      {
        name: "P25_base",
        type: "line",
        data: p25,
        lineStyle: { opacity: 0 },
        stack: "iqr",
        symbol: "none",
        tooltip: { show: false }
      },
      {
        name: "Banda P25–P75",
        type: "line",
        data: iqrDiff,
        lineStyle: { opacity: 0 },
        areaStyle: { color: "rgba(56, 189, 248, 0.2)" },
        stack: "iqr",
        symbol: "none"
      },
      {
        name: "Mediana Histórica (2003–2025)",
        type: "line",
        data: median,
        lineStyle: { color: "#38bdf8", width: 2, type: "dashed" },
        itemStyle: { color: "#38bdf8" }
      },
      {
        name: "Promedio Histórico",
        type: "line",
        data: mean,
        lineStyle: { color: "#94a3b8", width: 1.5, type: "dotted" },
        itemStyle: { color: "#94a3b8" }
      },
      {
        name: `Año ${state.focusYear}`,
        type: "line",
        data: focusSeries,
        lineStyle: { color: "#f97316", width: 3 },
        itemStyle: { color: "#f97316" }
      }
    ]
  });
}

function renderAnnualChart() {
  if (!chartAnnual) {
    chartAnnual = echarts.init(document.getElementById("chartAnnual"));
  }

  const years = [];
  const harmTotals = [];
  const aquaTotals = [];
  const snppRawTotals = [];

  for (let y = state.yearStart; y <= state.yearEnd; y++) {
    years.push(y === 2026 ? "2026*" : String(y));
    let hSum = 0;
    let aSum = 0;
    let sSum = 0;
    let hasS = false;

    for (let m = 1; m <= 12; m++) {
      if (y === 2026 && m > 10) continue;
      const ym = `${y}-${String(m).padStart(2, "0")}`;
      const b = state.currentSeriesByYm.get(ym);
      if (!b) continue;
      hSum += b.harm;
      aSum += b.aqua || 0;
      if (b.snpp !== null) {
        sSum += b.snpp;
        hasS = true;
      }
    }
    harmTotals.push(Number(hSum.toFixed(1)));
    aquaTotals.push(aSum);
    snppRawTotals.push(hasS ? sSum : null);
  }

  chartAnnual.setOption({
    tooltip: { trigger: "axis" },
    legend: {
      data: ["Serie Armonizada", "MODIS Aqua Crudo", "VIIRS S-NPP Crudo (con salto)"],
      textStyle: { color: "#cbd5e1", fontSize: 11 }
    },
    grid: { top: 40, bottom: 30, left: 60, right: 20 },
    xAxis: {
      type: "category",
      data: years,
      axisLabel: { color: "#cbd5e1" }
    },
    yAxis: {
      type: "value",
      name: "Celdas-día / año",
      nameTextStyle: { color: "#94a3b8" },
      axisLabel: { color: "#cbd5e1" },
      splitLine: { lineStyle: { color: "#334155" } }
    },
    series: [
      {
        name: "VIIRS S-NPP Crudo (con salto)",
        type: "line",
        data: snppRawTotals,
        lineStyle: { color: "#ef4444", width: 1.8, type: "dashed" },
        itemStyle: { color: "#ef4444" }
      },
      {
        name: "MODIS Aqua Crudo",
        type: "line",
        data: aquaTotals,
        lineStyle: { color: "#38bdf8", width: 1.8 },
        itemStyle: { color: "#38bdf8" }
      },
      {
        name: "Serie Armonizada",
        type: "bar",
        data: harmTotals,
        itemStyle: { color: "rgba(249, 115, 22, 0.75)" }
      }
    ]
  });
}

function renderValidationChart() {
  const dom = document.getElementById("chartValidation");
  if (!chartValidation) {
    chartValidation = echarts.init(dom);
  }

  const rows = state.validationRows.filter((r) => r.year >= 2011);
  const xLabels = rows.map((r) => r.ym);
  const aquaData = rows.map((r) => r.aqua);
  const snppRawData = rows.map((r) => r.snppRaw);
  const snppConvData = rows.map((r) => r.snppConverted);

  chartValidation.setOption({
    tooltip: { trigger: "axis" },
    legend: {
      data: [
        "MODIS Aqua Real (Referencia)",
        "VIIRS S-NPP Armonizado (Convertido a Aqua)",
        "VIIRS S-NPP Crudo (Salto artificial +185%)"
      ],
      textStyle: { color: "#cbd5e1" }
    },
    grid: { top: 42, bottom: 65, left: 60, right: 25 },
    dataZoom: [
      { type: "inside", start: 0, end: 100 },
      { type: "slider", bottom: 10, height: 22, textStyle: { color: "#cbd5e1" } }
    ],
    xAxis: {
      type: "category",
      data: xLabels,
      axisLabel: { color: "#cbd5e1" }
    },
    yAxis: {
      type: "value",
      name: "Celdas-día / mes (Bolivia)",
      nameTextStyle: { color: "#94a3b8" },
      axisLabel: { color: "#cbd5e1" },
      splitLine: { lineStyle: { color: "#334155" } }
    },
    series: [
      {
        name: "VIIRS S-NPP Crudo (Salto artificial +185%)",
        type: "line",
        data: snppRawData,
        lineStyle: { color: "#ef4444", width: 1.4, type: "dotted" },
        itemStyle: { color: "#ef4444" },
        symbol: "none"
      },
      {
        name: "MODIS Aqua Real (Referencia)",
        type: "line",
        data: aquaData,
        lineStyle: { color: "#38bdf8", width: 2.2 },
        itemStyle: { color: "#38bdf8" },
        symbol: "none"
      },
      {
        name: "VIIRS S-NPP Armonizado (Convertido a Aqua)",
        type: "line",
        data: snppConvData,
        lineStyle: { color: "#22c55e", width: 2.2 },
        itemStyle: { color: "#22c55e" },
        symbol: "none"
      }
    ]
  });
}

function renderFactorsGrid() {
  const container = document.getElementById("factorsTable");
  container.innerHTML = "";
  const factors = state.meta.factors_by_month;
  for (let m = 1; m <= 12; m++) {
    const chip = document.createElement("div");
    chip.className = "factor-chip";
    chip.innerHTML = `
      <span class="m-label">${MONTH_NAMES[m - 1]}</span>
      <span class="m-val">${Number(factors[String(m)]).toFixed(3)}</span>
    `;
    container.appendChild(chip);
  }
}

/* =========================================================================
 * 6. Descarga de CSV (Serie del AOI y Celdas-Mes)
 * ========================================================================= */
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
  const rows = [
    "year,month,count_harmonized,count_raw_aqua,count_raw_snpp,median_hist_2003_2025,anomaly_vs_median,aoi_active_cells"
  ];

  const numCells = state.selectedCells.size;
  state.currentSeriesByYm.forEach((b) => {
    if (b.year < state.yearStart || b.year > state.yearEnd) return;
    const med = histStats[b.month].median;
    const anom = b.harm - med;
    rows.push([
      b.year,
      b.month,
      b.harm.toFixed(1),
      b.aqua !== null ? b.aqua : "",
      b.snpp !== null ? b.snpp : "",
      med.toFixed(1),
      anom.toFixed(1),
      numCells
    ].join(","));
  });

  triggerCsvDownload(
    `pixfire_bolivia_serie_aoi_${state.preset}_${state.yearStart}_${state.yearEnd}.csv`,
    rows.join("\n") + "\n"
  );
}

function downloadAoiCellsCsv() {
  const rows = [
    "cell_id,lat_center,lon_center,year,month,count_harmonized,count_raw_aqua,count_raw_snpp,source"
  ];

  state.selectedCells.forEach((cellId) => {
    const cell = state.cellsMeta.get(cellId);
    if (!cell) return;
    for (const r of cell.records) {
      if (r.year < state.yearStart || r.year > state.yearEnd) continue;
      rows.push([
        r.cellId,
        cell.lat.toFixed(4),
        cell.lon.toFixed(4),
        r.year,
        r.month,
        r.harm,
        r.aqua !== null ? r.aqua : "",
        r.snpp !== null ? r.snpp : "",
        r.source
      ].join(","));
    }
  });

  triggerCsvDownload(
    `pixfire_bolivia_celdas_${state.preset}_${state.yearStart}_${state.yearEnd}.csv`,
    rows.join("\n") + "\n"
  );
}

/* =========================================================================
 * 7. Eventos de interfaz e inicialización
 * ========================================================================= */
function syncBboxInputsFromPolygon(poly) {
  const [minLon, minLat, maxLon, maxLat] = turf.bbox(poly);
  document.getElementById("inLatMin").value = minLat.toFixed(2);
  document.getElementById("inLatMax").value = maxLat.toFixed(2);
  document.getElementById("inLonMin").value = minLon.toFixed(2);
  document.getElementById("inLonMax").value = maxLon.toFixed(2);
}

function resetToPreset(presetName) {
  drawnItems.clearLayers();
  state.customPolygon = null;
  state.preset = presetName;
  document.getElementById("presetRegion").value = presetName;
  document.getElementById("inLatMin").value = "";
  document.getElementById("inLatMax").value = "";
  document.getElementById("inLonMin").value = "";
  document.getElementById("inLonMax").value = "";
  recomputeAoiSelection();
}

function populateYearSelectors() {
  const yStartSel = document.getElementById("yearStart");
  const yEndSel = document.getElementById("yearEnd");
  const focusYearSel = document.getElementById("focusYear");

  for (let y = 2003; y <= 2026; y++) {
    yStartSel.add(new Option(String(y), String(y), y === 2003, y === 2003));
    yEndSel.add(new Option(String(y), String(y), y === 2026, y === 2026));
    focusYearSel.add(new Option(String(y), String(y), y === 2026, y === 2026));
  }
}

function bindEvents() {
  document.getElementById("presetRegion").addEventListener("change", (e) => {
    resetToPreset(e.target.value);
  });

  document.getElementById("btnResetAoi").addEventListener("click", () => {
    resetToPreset("all");
  });

  document.getElementById("btnApplyBbox").addEventListener("click", () => {
    const latMin = parseFloat(document.getElementById("inLatMin").value);
    const latMax = parseFloat(document.getElementById("inLatMax").value);
    const lonMin = parseFloat(document.getElementById("inLonMin").value);
    const lonMax = parseFloat(document.getElementById("inLonMax").value);
    if ([latMin, latMax, lonMin, lonMax].some(Number.isNaN) || latMin >= latMax || lonMin >= lonMax) {
      alert("Ingresa un rango válido de Latitud (Sur < Norte) y Longitud (Oeste < Este).");
      return;
    }
    const poly = turf.bboxPolygon([lonMin, latMin, lonMax, latMax]);
    drawnItems.clearLayers();
    const layer = L.geoJSON(poly, {
      style: { color: "#38bdf8", weight: 2, fillOpacity: 0.15 }
    });
    drawnItems.addLayer(layer);
    map.fitBounds(layer.getBounds());
    state.customPolygon = poly;
    state.preset = "custom";
    document.getElementById("presetRegion").value = "custom";
    recomputeAoiSelection();
  });

  document.getElementById("yearStart").addEventListener("change", (e) => {
    state.yearStart = parseInt(e.target.value, 10);
    if (state.yearStart > state.yearEnd) {
      state.yearEnd = state.yearStart;
      document.getElementById("yearEnd").value = String(state.yearEnd);
    }
    updateAllViews();
  });

  document.getElementById("yearEnd").addEventListener("change", (e) => {
    state.yearEnd = parseInt(e.target.value, 10);
    if (state.yearEnd < state.yearStart) {
      state.yearStart = state.yearEnd;
      document.getElementById("yearStart").value = String(state.yearStart);
    }
    updateAllViews();
  });

  document.getElementById("colorRamp").addEventListener("change", (e) => {
    state.colorRamp = e.target.value;
    renderCalendarChart();
  });

  document.getElementById("focusYear").addEventListener("change", (e) => {
    state.focusYear = parseInt(e.target.value, 10);
    if (state.focusYear === 2026 && state.focusMonth > 10) {
      state.focusMonth = 10;
      document.getElementById("focusMonth").value = "10";
    }
    updateAllViews();
  });

  document.getElementById("focusMonth").addEventListener("change", (e) => {
    state.focusMonth = parseInt(e.target.value, 10);
    if (state.focusYear === 2026 && state.focusMonth > 10) {
      state.focusYear = 2025;
      document.getElementById("focusYear").value = "2025";
    }
    updateAllViews();
  });

  document.getElementById("btnDownloadSeries").addEventListener("click", downloadAoiSeriesCsv);
  document.getElementById("btnDownloadCells").addEventListener("click", downloadAoiCellsCsv);

  // Pestañas
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      const target = document.getElementById(btn.dataset.tab);
      if (target) target.classList.add("active");

      setTimeout(() => {
        if (chartCalendar) chartCalendar.resize();
        if (chartSeasonal) chartSeasonal.resize();
        if (chartAnnual) chartAnnual.resize();
        if (chartValidation) chartValidation.resize();
      }, 50);
    });
  });

  window.addEventListener("resize", () => {
    if (chartCalendar) chartCalendar.resize();
    if (chartSeasonal) chartSeasonal.resize();
    if (chartAnnual) chartAnnual.resize();
    if (chartValidation) chartValidation.resize();
  });
}

(async function initApp() {
  try {
    populateYearSelectors();
    initMap();
    bindEvents();
    await loadAllData();
    renderFactorsGrid();
    recomputeAoiSelection();
  } catch (err) {
    console.error("Error inicializando la aplicación:", err);
    const warnEl = document.getElementById("aoiWarning");
    warnEl.textContent = "Error cargando data/processed/. Asegúrate de abrir la app mediante un servidor local (ej. python3 -m http.server 8000).";
    warnEl.classList.remove("hidden");
  }
})();
