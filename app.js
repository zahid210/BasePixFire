/**
 * PixFire Bolivia — Interfaz rediseñada con filosofía Glassmorphism Cinematográfico.
 *
 * Mantiene intacta la lógica científica y el contrato de datos v3:
 *   - data/processed/metadata.json
 *   - data/processed/monthly_cells.csv
 *   - data/processed/validation.csv
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
  fire: ["#0b1320", "#1e3a5f", "#b45309", "#f97316", "#fde047"],
  viridis: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"],
  plasma: ["#0d0887", "#7e03a8", "#cc4778", "#f89540", "#f0f921"]
};

const STAGE_META = {
  "stage-calendar": {
    eyebrow: "SERIE ARMONIZADA 2003–2026 · EQUIVALENTE MODIS AQUA",
    title: "Calendario de Actividad de Quema (Año × Mes)"
  },
  "stage-map": {
    eyebrow: "SELECCIÓN GEOESPACIAL · GRILLA DE 0,25° (~27,5 KM)",
    title: "Mapa Interactivo del Área de Interés (AOI)"
  },
  "stage-seasonal": {
    eyebrow: "ANÁLISIS CLIMATOLÓGICO · LÍNEA BASE 2003–2025",
    title: "Ciclo Estacional, Mediana Histórica y Evolución Anual"
  },
  "stage-validation": {
    eyebrow: "PRUEBA FUERA DE MUESTRA · TRASLAPE LIMPIO 2012–2021",
    title: "Validación Científica: Eliminación del Salto MODIS vs. VIIRS"
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
let chartSeasonal = null;
let chartAnnual = null;
let chartValidation = null;

/* =========================================================================
 * 1. Carga y parseo de datos estáticos (sin backend)
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
 * 2. Mapa Geoespacial (se aloja en el Mini-Mapa o se expande al Escenario Central)
 * ========================================================================= */
function initMap() {
  map = L.map("map", {
    center: [-16.4, -64.2],
    zoom: 4,
    minZoom: 4,
    maxZoom: 10,
    zoomControl: true
  });

  const CARTO_KEY = "cb1_58lv_1_5016ded4d19a88b491106fc0";

  const cartoDark = L.tileLayer(`https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=${CARTO_KEY}`, {
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

  cartoDark.addTo(map);

  const baseMaps = {
    "Carto Dark Matter": cartoDark,
    "Carto Voyager": cartoVoyager,
    "Satélite Esri": satLayer
  };

  L.control.layers(baseMaps, null, { position: "topleft" }).addTo(map);

  gridLayerGroup = L.layerGroup().addTo(map);
  drawnItems = new L.FeatureGroup().addTo(map);

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
  if (annualAvg > 10) return "#f97316";
  if (annualAvg > 2) return "#fbbf24";
  return "#38bdf8";
}

function renderMapGrid() {
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
      color: isSelected ? fillColor : "#1e293b",
      weight: isSelected ? 0.5 : 0.15,
      fillColor: fillColor,
      fillOpacity: isSelected ? 0.65 : 0.1
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

function moveMapToStage(inMainStage) {
  const mapEl = document.getElementById("map");
  const targetSlot = inMainStage
    ? document.getElementById("mapStageSlot")
    : document.getElementById("mapDockSlot");

  if (mapEl && targetSlot && mapEl.parentElement !== targetSlot) {
    targetSlot.appendChild(mapEl);
    setTimeout(() => {
      if (map) {
        map.invalidateSize();
        map.setZoom(inMainStage ? 5 : 4);
      }
    }, 60);
  }
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
  document.getElementById("aoiStatsBadge").textContent = `${count} celdas activas · ~${approxKm2} km²`;

  const warnBar = document.getElementById("aoiWarning");
  const warnTxt = document.getElementById("aoiWarningText");
  const warnings = [];

  if (count === 0) {
    warnings.push("El área seleccionada no contiene celdas con detecciones históricas de fuego en Bolivia.");
  } else if (count < 4) {
    warnings.push(`Muestra espacial pequeña (${count} celdas): en áreas menores a 4 celdas la varianza del factor mensual es mayor.`);
  }

  if (state.customPolygon) {
    const [minLon, minLat, maxLon, maxLat] = turf.bbox(state.customPolygon);
    const [bMinLon, bMinLat, bMaxLon, bMaxLat] = state.meta.bbox;
    if (minLon < bMinLon - 0.5 || minLat < bMinLat - 0.5 || maxLon > bMaxLon + 0.5 || maxLat > bMaxLat + 0.5) {
      warnings.push("Parte del polígono se extiende fuera de la frontera de Bolivia (Buffer 0 km); los datos cubren solo territorio boliviano.");
    }
  }

  if (warnings.length > 0) {
    warnTxt.textContent = warnings.join(" ");
    warnBar.classList.remove("hidden");
  } else {
    warnBar.classList.add("hidden");
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
      if (r.aqua !== null) bucket.aqua += r.aqua;
      if (r.snpp !== null) {
        bucket.snpp = (bucket.snpp || 0) + r.snpp;
      }
      if (r.source === "snpp_converted_nrt") bucket.hasNrt = true;
    }
  });
}

/* =========================================================================
 * 4. Estadísticas históricas (Mediana, Promedio, P25, P75 sobre la suma del AOI)
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
 * 5. Actualización de Tarjetas Bento y Gráficos ECharts
 * ========================================================================= */
function updateAllViews() {
  const histStats = computeHistoricalStatsByMonth();
  updateTelemetryAndBottomCards(histStats);
  renderCalendarChart();
  renderSeasonalChart(histStats);
  renderAnnualChart();
  renderValidationChart();
}

function updateTelemetryAndBottomCards(histStats) {
  const ym = `${state.focusYear}-${String(state.focusMonth).padStart(2, "0")}`;
  const current = state.currentSeriesByYm.get(ym);
  const mStat = histStats[state.focusMonth];

  document.getElementById("diagPeriodTitle").textContent =
    `${MONTH_FULL_NAMES[state.focusMonth - 1]} ${state.focusYear}`;

  const currVal = current ? current.harm : 0;
  document.getElementById("kpiCurrentVal").textContent =
    currVal.toLocaleString("es-BO", { maximumFractionDigits: 1 });

  let sourceLabel = "MODIS Aqua directo";
  if (state.focusYear === 2020 && (state.focusMonth === 8 || state.focusMonth === 9)) {
    sourceLabel = "VIIRS S-NPP armonizado (reemplazo apagón Aqua)";
  } else if (state.focusYear >= 2022) {
    sourceLabel = current && current.hasNrt
      ? "VIIRS S-NPP armonizado (2026 NRT provisional)"
      : "VIIRS S-NPP armonizado (era deriva Aqua)";
  }
  document.getElementById("kpiCurrentSource").textContent = `Fuente: ${sourceLabel}`;

  document.getElementById("kpiMedianVal").textContent =
    mStat.median.toLocaleString("es-BO", { maximumFractionDigits: 1 });
  document.getElementById("kpiMeanVal").textContent =
    mStat.mean.toLocaleString("es-BO", { maximumFractionDigits: 1 });
  document.getElementById("kpiIqrVal").textContent =
    `${mStat.p25.toFixed(0)} – ${mStat.p75.toFixed(0)}`;

  const diff = currVal - mStat.median;
  const anomEl = document.getElementById("kpiAnomalyVal");
  const anomTxt = document.getElementById("kpiAnomalyText");

  if (mStat.median > 0) {
    const pct = (diff / mStat.median) * 100.0;
    const sign = diff >= 0 ? "+" : "";
    anomEl.textContent = `${sign}${pct.toFixed(1)} %`;
    anomEl.style.color = diff > 0 ? "#fbbf24" : "#7ff0e8";
    anomTxt.textContent = `${sign}${diff.toFixed(1)} celdas-día frente a la mediana de ${MONTH_NAMES[state.focusMonth - 1]}`;
  } else {
    const diffMean = currVal - mStat.mean;
    const sign = diffMean >= 0 ? "+" : "";
    anomEl.textContent = `${sign}${diffMean.toFixed(1)}`;
    anomEl.style.color = diffMean > 0 ? "#fbbf24" : "#7ff0e8";
    anomTxt.textContent = `Mediana = 0; diferencia vs. promedio (${mStat.mean.toFixed(1)})`;
  }

  // Calcular totales anuales y mes récord dentro del rango seleccionado
  let maxMonthVal = -1;
  let maxMonthLabel = "—";
  let maxMonthM = 1;
  let totalAll = 0;
  let totalDrySeason = 0; // ago, sep, oct
  const annualTotals = [];

  for (let y = state.yearStart; y <= state.yearEnd; y++) {
    let ySum = 0;
    for (let m = 1; m <= 12; m++) {
      if (y === 2026 && m > 10) continue;
      const b = state.currentSeriesByYm.get(`${y}-${String(m).padStart(2, "0")}`);
      if (!b) continue;
      ySum += b.harm;
      totalAll += b.harm;
      if (m >= 8 && m <= 10) totalDrySeason += b.harm;
      if (b.harm > maxMonthVal) {
        maxMonthVal = b.harm;
        maxMonthLabel = `${MONTH_NAMES[m - 1]} ${y}`;
        maxMonthM = m;
      }
    }
    annualTotals.push({ year: y, total: ySum });
  }

  // Ordenar Top 5 años más críticos para la tarjeta inferior 1
  const top5 = [...annualTotals].sort((a, b) => b.total - a.total).slice(0, 5);
  const peakYearObj = top5[0] || { year: "—", total: 0 };

  document.getElementById("kpiPeakYearNum").textContent = String(peakYearObj.year);
  document.getElementById("kpiPeakYearTotal").textContent =
    `${Math.round(peakYearObj.total).toLocaleString("es-BO")} celdas-día en el año récord`;

  const barsBox = document.getElementById("topYearsChart");
  const labelsBox = document.getElementById("topYearsLabels");
  barsBox.innerHTML = "";
  labelsBox.innerHTML = "";

  const maxTop = peakYearObj.total > 0 ? peakYearObj.total : 1;
  top5.forEach((item) => {
    const pct = Math.max(8, Math.round((item.total / maxTop) * 94));
    const col = document.createElement("div");
    col.className = "bar-col";
    col.title = `${item.year}: ${item.total.toFixed(1)} celdas-día`;
    col.innerHTML = `<div class="f" style="height:${pct}%"></div><i class="m" style="bottom:${pct}%"></i>`;
    barsBox.appendChild(col);

    const lbl = document.createElement("span");
    lbl.textContent = String(item.year);
    labelsBox.appendChild(lbl);
  });

  // Tarjeta inferior 2: Hitos del Registro en el AOI
  document.getElementById("msPeakMonthTag").textContent = maxMonthLabel;
  document.getElementById("msPeakMonthVal").textContent =
    maxMonthVal >= 0 ? `${Math.round(maxMonthVal).toLocaleString("es-BO")} celdas-día` : "—";
  const medOfPeak = histStats[maxMonthM] ? histStats[maxMonthM].median : 0;
  document.getElementById("msPeakMonthRatio").textContent =
    medOfPeak > 0 ? `${(maxMonthVal / medOfPeak).toFixed(1)}x la mediana del mes` : "Pico histórico";

  const dryPct = totalAll > 0 ? (totalDrySeason / totalAll) * 100.0 : 0;
  document.getElementById("msSeasonShare").textContent = `${dryPct.toFixed(1)} % del fuego`;
  const dryMedSum = (histStats[8]?.median || 0) + (histStats[9]?.median || 0) + (histStats[10]?.median || 0);
  document.getElementById("msSeasonMedian").textContent = `Mediana Ago–Oct: ${Math.round(dryMedSum)}`;

  const kVal = state.meta.factors_by_month[String(state.focusMonth)];
  document.getElementById("msFactorTag").textContent = `Factor ${MONTH_NAMES[state.focusMonth - 1]}`;
  document.getElementById("msFactorVal").textContent = `k = ${Number(kVal).toFixed(3)}`;
  document.getElementById("msSourceTag").textContent =
    `1 celda S-NPP = ${Number(kVal).toFixed(2)} eq. Aqua`;

  // Resumen accesible para lectores de pantalla
  document.getElementById("calendarSummarySR").textContent =
    `Área seleccionada con ${state.selectedCells.size} celdas. Año récord ${peakYearObj.year} con ${Math.round(peakYearObj.total)} celdas-día. Mes pico ${maxMonthLabel} con ${Math.round(maxMonthVal)} celdas-día.`;
}

function renderSubregionBars() {
  const container = document.getElementById("subregionBars");
  container.innerHTML = "";

  const totChiq = state.subregionTotals.chiquitania_llanos || 0;
  const totAmz = state.subregionTotals.amazonia_beni_norte || 0;
  const totAnd = state.subregionTotals.andina_valles || 0;
  const grandTotal = totChiq + totAmz + totAnd || 1;

  const items = [
    { key: "chiquitania", label: "Chiquitanía y Llanos", val: totChiq, bias: "-0,45 %" },
    { key: "amazonia", label: "Amazonía y Beni", val: totAmz, bias: "-11,56 %" },
    { key: "andina", label: "Andina y Valles", val: totAnd, bias: "+14,46 %" }
  ];

  items.forEach((it) => {
    const pct = Math.round((it.val / grandTotal) * 100);
    const row = document.createElement("div");
    row.className = "pl-row";
    row.title = `Filtrar ${it.label} (Sesgo de validación 2012–2021: ${it.bias})`;
    row.innerHTML = `
      <span>${it.label}</span>
      <i style="--w:${pct}%"></i>
      <b>${pct}% (${it.bias})</b>
    `;
    row.addEventListener("click", () => {
      resetToPreset(it.key);
    });
    container.appendChild(row);
  });
}

function populateScienceRailFromMeta() {
  const m1 = state.meta.validation_metrics?.train_2012_2016_test_2017_2021;
  const m2 = state.meta.validation_metrics?.train_2017_2021_test_2012_2016;
  if (m1) {
    document.getElementById("valSplit1Bias").textContent = `${m1.harmonized_bias_pct} % sesgo`;
    document.getElementById("valSplit1Aqua").textContent = m1.aqua_total.toLocaleString("es-BO");
    document.getElementById("valSplit1Harm").textContent = m1.snpp_harmonized_total.toLocaleString("es-BO");
    document.getElementById("valSplit1Raw").textContent =
      `Salto crudo eliminado: +${m1.raw_bias_pct.toFixed(1)} % → ${m1.harmonized_bias_pct} %`;
  }
  if (m2) {
    document.getElementById("valSplit2Bias").textContent = `+${m2.harmonized_bias_pct} % sesgo`;
    document.getElementById("valSplit2Aqua").textContent = m2.aqua_total.toLocaleString("es-BO");
    document.getElementById("valSplit2Harm").textContent = m2.snpp_harmonized_total.toLocaleString("es-BO");
    document.getElementById("valSplit2Raw").textContent =
      `Salto crudo eliminado: +${m2.raw_bias_pct.toFixed(1)} % → +${m2.harmonized_bias_pct} %`;
  }
}

/* =========================================================================
 * 6. Gráficos ECharts en el Escenario Central
 * ========================================================================= */
function renderCalendarChart() {
  const dom = document.getElementById("chartCalendar");
  if (!chartCalendar) {
    chartCalendar = echarts.init(dom);
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

  const ramp = COLOR_RAMPS[state.colorRamp] || COLOR_RAMPS.fire;

  chartCalendar.setOption({
    tooltip: {
      position: "top",
      backgroundColor: "rgba(8, 13, 22, 0.92)",
      borderColor: "rgba(127, 240, 232, 0.4)",
      textStyle: { color: "#f3f7fb", fontSize: 11 },
      formatter: (p) => {
        const mName = MONTH_FULL_NAMES[p.value[0]];
        const yName = years[p.value[1]];
        return `<strong>${mName} ${yName}</strong><br/>Actividad armonizada: <strong>${p.value[2]}</strong> celdas-día`;
      }
    },
    grid: { top: 10, bottom: 48, left: 48, right: 16 },
    xAxis: {
      type: "category",
      data: MONTH_NAMES,
      splitArea: { show: false },
      axisLine: { lineStyle: { color: "rgba(255,255,255,0.12)" } },
      axisLabel: { color: "#cbd5e1", fontSize: 10.5 }
    },
    yAxis: {
      type: "category",
      data: years,
      splitArea: { show: false },
      axisLine: { lineStyle: { color: "rgba(255,255,255,0.12)" } },
      axisLabel: { color: "#94a3b8", fontSize: 10 }
    },
    visualMap: {
      min: 0,
      max: maxVal,
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      itemWidth: 12,
      itemHeight: 110,
      inRange: { color: ramp },
      textStyle: { color: "#cbd5e1", fontSize: 10 }
    },
    series: [
      {
        name: "Celdas-día",
        type: "heatmap",
        data: data,
        itemStyle: {
          borderColor: "rgba(4, 7, 11, 0.55)",
          borderWidth: 1,
          borderRadius: 2
        },
        emphasis: {
          itemStyle: {
            borderColor: "#7ff0e8",
            borderWidth: 1.5,
            shadowBlur: 8,
            shadowColor: "rgba(127, 240, 232, 0.6)"
          }
        }
      }
    ]
  });
}

function renderSeasonalChart(histStats) {
  const dom = document.getElementById("chartSeasonal");
  if (!chartSeasonal) {
    chartSeasonal = echarts.init(dom);
  }

  const p25 = [];
  const iqrDiff = [];
  const median = [];
  const focusSeries = [];

  for (let m = 1; m <= 12; m++) {
    const st = histStats[m];
    p25.push(Number(st.p25.toFixed(1)));
    iqrDiff.push(Number((st.p75 - st.p25).toFixed(1)));
    median.push(Number(st.median.toFixed(1)));

    if (state.focusYear === 2026 && m > 10) {
      focusSeries.push(null);
    } else {
      const ym = `${state.focusYear}-${String(m).padStart(2, "0")}`;
      const b = state.currentSeriesByYm.get(ym);
      focusSeries.push(b ? Number(b.harm.toFixed(1)) : 0);
    }
  }

  chartSeasonal.setOption({
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(8, 13, 22, 0.92)",
      borderColor: "rgba(127, 240, 232, 0.4)",
      textStyle: { color: "#f3f7fb", fontSize: 11 }
    },
    legend: {
      data: [`Año ${state.focusYear}`, "Mediana (2003–2025)", "Banda P25–P75"],
      textStyle: { color: "#cbd5e1", fontSize: 10 },
      top: 0
    },
    grid: { top: 32, bottom: 26, left: 48, right: 14 },
    xAxis: {
      type: "category",
      data: MONTH_NAMES,
      axisLabel: { color: "#cbd5e1", fontSize: 10 }
    },
    yAxis: {
      type: "value",
      axisLabel: { color: "#94a3b8", fontSize: 10 },
      splitLine: { lineStyle: { color: "rgba(255,255,255,0.07)" } }
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
        areaStyle: { color: "rgba(127, 240, 232, 0.16)" },
        stack: "iqr",
        symbol: "none"
      },
      {
        name: "Mediana (2003–2025)",
        type: "line",
        data: median,
        lineStyle: { color: "#7ff0e8", width: 2, type: "dashed" },
        itemStyle: { color: "#7ff0e8" }
      },
      {
        name: `Año ${state.focusYear}`,
        type: "line",
        data: focusSeries,
        lineStyle: { color: "#f97316", width: 2.8 },
        itemStyle: { color: "#fbbf24" }
      }
    ]
  });
}

function renderAnnualChart() {
  const dom = document.getElementById("chartAnnual");
  if (!chartAnnual) {
    chartAnnual = echarts.init(dom);
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
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(8, 13, 22, 0.92)",
      borderColor: "rgba(127, 240, 232, 0.4)",
      textStyle: { color: "#f3f7fb", fontSize: 11 }
    },
    legend: {
      data: ["Serie Armonizada", "MODIS Aqua", "VIIRS S-NPP Crudo"],
      textStyle: { color: "#cbd5e1", fontSize: 10 },
      top: 0
    },
    grid: { top: 32, bottom: 26, left: 52, right: 14 },
    xAxis: {
      type: "category",
      data: years,
      axisLabel: { color: "#cbd5e1", fontSize: 9.5 }
    },
    yAxis: {
      type: "value",
      axisLabel: { color: "#94a3b8", fontSize: 10 },
      splitLine: { lineStyle: { color: "rgba(255,255,255,0.07)" } }
    },
    series: [
      {
        name: "VIIRS S-NPP Crudo",
        type: "line",
        data: snppRawTotals,
        lineStyle: { color: "#ef4444", width: 1.5, type: "dotted" },
        itemStyle: { color: "#ef4444" }
      },
      {
        name: "MODIS Aqua",
        type: "line",
        data: aquaTotals,
        lineStyle: { color: "#4aa8ff", width: 1.8 },
        itemStyle: { color: "#4aa8ff" }
      },
      {
        name: "Serie Armonizada",
        type: "bar",
        data: harmTotals,
        itemStyle: { color: "rgba(249, 115, 22, 0.78)", borderRadius: [3, 3, 0, 0] }
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
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(8, 13, 22, 0.92)",
      borderColor: "rgba(127, 240, 232, 0.4)",
      textStyle: { color: "#f3f7fb", fontSize: 11 }
    },
    legend: {
      data: [
        "MODIS Aqua Real (Referencia)",
        "VIIRS S-NPP Armonizado (Equivalente Aqua)",
        "VIIRS S-NPP Crudo (Salto +185%)"
      ],
      textStyle: { color: "#cbd5e1", fontSize: 10.5 },
      top: 0
    },
    grid: { top: 34, bottom: 52, left: 54, right: 18 },
    dataZoom: [
      { type: "inside", start: 0, end: 100 },
      { type: "slider", bottom: 6, height: 18, textStyle: { color: "#cbd5e1" } }
    ],
    xAxis: {
      type: "category",
      data: xLabels,
      axisLabel: { color: "#cbd5e1", fontSize: 10 }
    },
    yAxis: {
      type: "value",
      name: "Celdas-día / mes",
      nameTextStyle: { color: "#94a3b8", fontSize: 10 },
      axisLabel: { color: "#94a3b8", fontSize: 10 },
      splitLine: { lineStyle: { color: "rgba(255,255,255,0.07)" } }
    },
    series: [
      {
        name: "VIIRS S-NPP Crudo (Salto +185%)",
        type: "line",
        data: snppRawData,
        lineStyle: { color: "#ef4444", width: 1.3, type: "dotted" },
        itemStyle: { color: "#ef4444" },
        symbol: "none"
      },
      {
        name: "MODIS Aqua Real (Referencia)",
        type: "line",
        data: aquaData,
        lineStyle: { color: "#4aa8ff", width: 2.1 },
        itemStyle: { color: "#4aa8ff" },
        symbol: "none"
      },
      {
        name: "VIIRS S-NPP Armonizado (Equivalente Aqua)",
        type: "line",
        data: snppConvData,
        lineStyle: { color: "#7ff0e8", width: 2.1 },
        itemStyle: { color: "#7ff0e8" },
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
 * 7. Navegación del Escenario Central y Descarga CSV
 * ========================================================================= */
function switchStage(stageId) {
  state.activeStage = stageId;

  document.querySelectorAll(".nav-pill").forEach((btn) => {
    btn.classList.toggle("on", btn.dataset.view === stageId);
  });

  document.querySelectorAll(".stage-pane").forEach((pane) => {
    pane.classList.toggle("active", pane.id === stageId);
  });

  const info = STAGE_META[stageId] || STAGE_META["stage-calendar"];
  document.getElementById("stageEyebrow").textContent = info.eyebrow;
  document.getElementById("stageTitle").textContent = info.title;

  const quickBtn = document.getElementById("btnQuickSwitchMap");
  if (stageId === "stage-map") {
    quickBtn.textContent = "Volver al Calendario";
    moveMapToStage(true);
  } else {
    quickBtn.textContent = "Dibujar AOI en Mapa";
    moveMapToStage(false);
  }

  setTimeout(() => {
    if (chartCalendar) chartCalendar.resize();
    if (chartSeasonal) chartSeasonal.resize();
    if (chartAnnual) chartAnnual.resize();
    if (chartValidation) chartValidation.resize();
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
 * 8. Eventos de interfaz e inicialización
 * ========================================================================= */
function syncBboxInputsFromPolygon(poly) {
  const [minLon, minLat, maxLon, maxLat] = turf.bbox(poly);
  document.getElementById("inLatMin").value = minLat.toFixed(2);
  document.getElementById("inLatMax").value = maxLat.toFixed(2);
  document.getElementById("inLonMin").value = minLon.toFixed(2);
  document.getElementById("inLonMax").value = maxLat.toFixed(2);
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
  document.querySelectorAll(".nav-pill").forEach((btn) => {
    btn.addEventListener("click", () => switchStage(btn.dataset.view));
  });

  document.getElementById("btnQuickSwitchMap").addEventListener("click", () => {
    switchStage(state.activeStage === "stage-map" ? "stage-calendar" : "stage-map");
  });

  document.getElementById("btnExpandMap").addEventListener("click", () => {
    switchStage(state.activeStage === "stage-map" ? "stage-calendar" : "stage-map");
  });

  document.querySelectorAll("[data-goto]").forEach((el) => {
    el.addEventListener("click", () => switchStage(el.dataset.goto));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        switchStage(el.dataset.goto);
      }
    });
  });

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
      const warnBar = document.getElementById("aoiWarning");
      document.getElementById("aoiWarningText").textContent =
        "Ingresa un rango BBox válido: Latitud Sur menor que Latitud Norte y Longitud Oeste menor que Longitud Este.";
      warnBar.classList.remove("hidden");
      return;
    }
    const poly = turf.bboxPolygon([lonMin, latMin, lonMax, latMax]);
    drawnItems.clearLayers();
    const layer = L.geoJSON(poly, {
      style: { color: "#7ff0e8", weight: 2, fillOpacity: 0.16 }
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
    populateScienceRailFromMeta();
    renderSubregionBars();
    renderFactorsGrid();
    recomputeAoiSelection();
  } catch (err) {
    console.error("Error inicializando la aplicación:", err);
    const warnBar = document.getElementById("aoiWarning");
    document.getElementById("aoiWarningText").textContent =
      "Error cargando data/processed/. Abre la aplicación mediante un servidor local (ej. python3 -m http.server 8000).";
    warnBar.classList.remove("hidden");
  }
})();
