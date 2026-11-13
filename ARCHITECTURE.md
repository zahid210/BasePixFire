# ARCHITECTURE.md — Arquitectura (DEFINITIVA v3)

> **Estado: definitiva v3 (13/11/2026).** Lista para implementación tras la revisión cruzada (Prompt #3) y la confirmación de recursos oficiales y acceso a FIRMS Archive Download.

## 0. Registro de cambios (v1 → v2 → v3)

| # | Cambio | Por qué |
|---|---|---|
| 1 | Fuente base (2003–2025): CSV anuales por país de FIRMS (públicos, sin login) | Existen, son calidad estándar (no NRT) y traen el campo `type`. Descarga directa por script sin esperas |
| 2 | Fuente 2026: formulario Archive Download de FIRMS (con cuenta ya creada) | Cubre ene–oct 2026 para S-NPP ("hasta hoy", antes del fin de misión de S-NPP el 2/11/2026) |
| 3 | Pareja de satélites: **Aqua (MODIS) + S-NPP (VIIRS)** | Ambos cruzan el ecuador a la 1:30 p. m. (guías oficiales MODIS y VIIRS), eliminando sesgos por ciclo diurno |
| 4 | Serie: **2003–2025 (estándar) + ene–oct 2026 (provisional)**, mensual | Aqua completo desde 2003; S-NPP hasta oct 2026; resolución mensual evita sesgos < 8 días (guía MODIS §7.1.1) |
| 5 | Calibración: **2012–2021** (excluyendo 2020-08 y 2020-09 completos) | Inicio de S-NPP (2012) hasta inicio de deriva libre de Aqua (dic 2021). Se excluyen ago–sep 2020 por el apagón de Aqua (16 ago – 2 sep 2020) |
| 6 | Reemplazo del apagón 2020 en la serie final | En 2020-08 y 2020-09 la serie armonizada usa `snpp_converted` para evitar una caída artificial en pleno pico de quemas |
| 7 | Escala: **equivalente MODIS (Aqua)** en **celdas-día** | Habla el idioma del registro más largo y neutraliza tanto la diferencia de resolución como el solapamiento orbital |
| 8 | Método: **Enfoque A** con salvaguarda de muestra mínima y validación en subregiones | Factor mensual con fallback al factor anual si un mes tiene pocas detecciones; validación en dos mitades (umbral ±15 %) y chequeo en 3 subregiones |
| 9 | Optimización de tamaño y contrato (`DATA_CONTRACT.md` v3) | Grilla de **0,25°** por defecto (~27 km), sin repetir `lat`/`lon` en cada fila, garantizando un archivo ligero (< 5 MB) |
| 10 | Región confirmada: **Bolivia** (Buffer **0 km**) | Temporada marcada, salto S-NPP/Aqua ~7×, volumen manejable |

## 1. Visión general

Dos bloques desacoplados que se comunican **únicamente mediante archivos estáticos** definidos en `DATA_CONTRACT.md`:

```
[FIRMS Country CSV (2003–2025) + Archive Download (2026)]
        │
        ▼
[Pipeline Python (`scripts/`)]  → filtra, agrega a celdas-día, calibra, valida y exporta
        │  (`data/processed/monthly_cells.csv`, `metadata.json`, `validation.csv`)
        ▼
[App Web Estática (`web/`)]     → mapa + AOI + calendario + anomalías + gráfico validación + CSV
```

## 2. Bloque A — Pipeline de datos y armonización

### 2.1 Región y obtención de datos

**Región: Bolivia (país completo, Buffer 0 km).**

1. **Histórico 2003–2025 (automático por script):**
   - MODIS (2003–2025): `https://firms.modaps.eosdis.nasa.gov/data/country/modis/<AÑO>/modis_<AÑO>_Bolivia.csv`
   - VIIRS S-NPP (2012–2025): `https://firms.modaps.eosdis.nasa.gov/data/country/viirs-snpp/<AÑO>/viirs-snpp_<AÑO>_Bolivia.csv`
2. ** Extensión 2026 (formulario FIRMS Archive Download):**
   - En `https://firms.modaps.eosdis.nasa.gov/download/` pedir:
     - **Area:** `Country` → `Bolivia`
     - **Buffer:** `0 km` (para coincidir exactamente con el recorte de los CSV anuales de 2003–2025)
     - **Fire Source:** `MODIS` y `VIIRS S-NPP` (opcional: añadir `VIIRS NOAA-20` si se desea explorar nov 2026)
     - **Date Range:** `2026-01-01` a `2026-10-31`
     - **Format:** `Comma-Separated Text (.csv)`
   - Guardar en `data/raw/`. El pipeline funciona con 2003–2025 de inmediato y agrega 2026 automáticamente si los archivos están presentes.

### 2.2 Pasos del pipeline

1. **Limpiar y filtrar (H3):**
   - **MODIS:** `satellite == "Aqua"` y `confidence >= 30` (nominal y alta). Si la columna `type` está presente (archivos estándar ML), exigir `type == 0` (fuego de vegetación).
   - **VIIRS S-NPP:** `confidence` en `{"n", "h", "nominal", "high"}` (minúsculas o mayúsculas). Si `type` está presente, exigir `type == 0`. *(Nota: en datos NRT de 2026 `type` no viene; la columna `source` los etiqueta como `snpp_converted_nrt`).*
2. **Agregar a grilla común (H1):**
   - Tamaño de celda base: **`cell_size = 0.25` grados** (~27,5 km; el script permite probar `0.10` como comparación).
   - Índices enteros: `row = floor((lat + 90) / cell_size)`, `col = floor((lon + 180) / cell_size)`, `cell_id = f"{row}_{col}"`.
   - Para cada `(cell_id, acq_date)` y sensor, contar **1 si hubo ≥ 1 detección ese día** (**celda-día activa**). Sumar las celdas-día de cada `(cell_id, year, month)`.
3. **Calibrar (H2 — Enfoque A):**
   - Ventana de calibración limpia: **feb 2012 – dic 2021** (meses completos; S-NPP inició el 20/01/2012), **excluyendo 2020-08 y 2020-09** por el apagón de Aqua.
   - Para cada mes $m \in \{1..12\}$:
     $$k_m = \frac{\sum_{y \in \text{cal}} \text{Aqua}_{y,m}}{\sum_{y \in \text{cal}} \text{SNPP}_{y,m}}$$
   - **Salvaguarda de muestra mínima:** si en el mes $m$ la suma de celdas-día de Aqua en el periodo de calibración es $< 500$, se usa un factor suavizado/anual $k_{\text{global}} = \sum \text{Aqua} / \sum \text{SNPP}$ para evitar ruido por baja muestra en temporada de lluvias.
4. **Validar (antes de fijar el factor final):**
   - **Validación cruzada en 2 bloques:**
     - Calibrar en **2012–2016** → evaluar en **2017–2021** (sin ago–sep 2020).
     - Calibrar en **2017–2021** (sin ago–sep 2020) → evaluar en **2012–2016**.
   - **Criterio de éxito fijado de antemano:** error relativo del total acumulado en el bloque de validación **$\le \pm 15\%$** y reducción de al menos **80 %** del sesgo crudo entre sensores.
   - **Factor final de producción:** una vez superada la validación cruzada, los factores $k_m$ definitivos se calculan con todos los años válidos de **2012–2021**.
   - **Validación espacial (subregiones):** evaluar el error con esos factores en 3 subregiones de Bolivia (Llanos/Chiquitanía: `lon > -64, lat > -19`; Amazonía/Beni Norte: `lat >= -14`; Andina/Valles: `lon <= -64`) y reportarlo en `metadata.json` y `docs/METODO.md`.
5. **Construir la serie armonizada (`count_harmonized`):**
   - **2003-01 a 2021-12** (excepto 2020-08 y 2020-09): `count_harmonized = count_raw_aqua` (`source = "aqua"`).
   - **2020-08 y 2020-09** (apagón de Aqua): `count_harmonized = round(count_raw_snpp * k_m, 1)` (`source = "snpp_converted"`).
   - **2022-01 a 2025-12** (era de deriva orbital de Aqua): `count_harmonized = round(count_raw_snpp * k_m, 1)` (`source = "snpp_converted"`).
   - **2026-01 a 2026-10** (si hay datos 2026): `count_harmonized = round(count_raw_snpp * k_m, 1)` (`source = "snpp_converted_nrt"` si provienen de NRT, o `"snpp_converted"` si son estándar).

## 3. Bloque B — Aplicación web

Componentes en `web/`:
- **Mapa interactivo (Leaflet + Leaflet.draw):** muestra la grilla activa dentro del contorno de Bolivia, permite dibujar un rectángulo/polígono o elegir subregiones predefinidas, y advierte si el polígono sale de Bolivia o abarca muy pocas celdas (< 4 celdas).
- **Calendario de actividad (ECharts heatmap):** matriz Año (2003–2026) × Mes (Ene–Dic) con rampa de color accesible (Viridis / YlOrRd) para el AOI seleccionado.
- **Comparación histórica e indicadores:** compara el último mes seleccionado contra la **mediana y promedio histórico (2003–2025) de ese mismo mes calculados sobre la suma del AOI** (no sumando medianas por celda). Si la mediana es 0, muestra el promedio y el percentil 75.
- ** Pestaña / Gráfico de Validación Científica:** muestra `validation.csv` con las tres curvas (Aqua real, S-NPP crudo con el salto de ~5–7×, y S-NPP armonizado superpuesto a Aqua) para demostrar visualmente ante el jurado que el salto desapareció.
- **Descarga CSV:** exporta la serie mensual agregada del AOI (y/o las celdas-mes filtradas) respetando el contrato de datos.

## 4. Decisiones cerradas

- [x] **Región:** Bolivia (Buffer 0 km).
- [x] **Formulario Archive Download (2026):** Country = Bolivia, Buffer = 0 km, Sources = MODIS + VIIRS S-NPP, Dates = 2026-01-01 a 2026-10-31, Format = CSV.
- [x] **Satélites:** Aqua (MODIS) + S-NPP (VIIRS).
- [x] **Grilla por defecto:** 0,25° (con soporte parametrizable para 0,10°).
- [x] **Umbral de validación:** $\le \pm 15\%$ de error en el total del periodo de prueba.
- [x] **Manejo del apagón de Aqua (ago–sep 2020):** excluido de calibración y sustituido por S-NPP armonizado en la serie final.
