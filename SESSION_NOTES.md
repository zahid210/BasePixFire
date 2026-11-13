# SESSION_NOTES.md — Estado del proyecto y guía de continuación

> Documento de traspaso para continuar el desarrollo con cualquier modelo o agente. Lee primero `PROJECT.md`, `ARCHITECTURE.md` (v3), `DATA_CONTRACT.md` (v3) y `docs/METODO.md`.

## 1. Qué está hecho

1. **Investigación y verificación oficial completada (`verificacion_fuentes.md`):**
   - Verificados en la web oficial de NASA Earthdata / FIRMS los nombres exactos de columnas, umbrales de confianza (`MODIS >= 30`, `VIIRS in {n, h}`), horarios de paso (Aqua y S-NPP ambos a la 1:30 p. m. / 1:30 a. m. local), el apagón de Aqua del 16 ago al 2 sep 2020, el inicio de la deriva orbital libre de Aqua tras diciembre de 2021 y el fin de datos de S-NPP el 2 de noviembre de 2026.
   - Descubiertos y verificados los archivos CSV anuales públicos por país de FIRMS (`https://firms.modaps.eosdis.nasa.gov/data/country/<sensor>/<año>/<sensor>_<año>_<País>.csv`), que ya traen calidad estándar (`MCD14ML` / `VNP14IMGML`) y el atributo `type` hasta diciembre de 2025 sin necesidad de login.
2. **Prompts #1, #2, #3 y #4 de `PROMPTS.md` completados:**
   - `PROJECT.md` actualizado con los recursos oficiales de NASA Space Apps y la región confirmada (**Bolivia**).
   - `ARCHITECTURE.md` (v3 definitiva) y `DATA_CONTRACT.md` (v3 definitivo) actualizados con todas las correcciones de la revisión cruzada.
   - `docs/METODO.md` redactado con la explicación simple del método, la evaluación científica crítica (Prompt #4) y el guion de 60 segundos para el jurado.

## 2. Decisiones cerradas (NO reabrir salvo fallo en datos reales)

- **Región:** **Bolivia** (país completo, `Buffer = 0 km`).
- **Pareja de satélites:** **MODIS Aqua** + **VIIRS Suomi-NPP (S-NPP)**.
- **Escala y unidad:** **celdas-día con fuego en equivalente MODIS Aqua**, resolución **mensual**, en una grilla de **`0.25°`**.
- **Ventana de calibración:** **febrero 2012 – diciembre 2021**, excluyendo **2020-08 y 2020-09** (apagón de Aqua).
- **Construcción de la serie armonizada (2003–2026):**
  - `2003-01` a `2021-12` (excepto `2020-08` y `2020-09`): `Aqua` directo (`source = "aqua"`).
  - `2020-08` y `2020-09`: `S-NPP * factor[mes]` (`source = "snpp_converted"`).
  - `2022-01` a `2025-12` (deriva orbital de Aqua): `S-NPP * factor[mes]` (`source = "snpp_converted"`).
  - `2026-01` a `2026-10` (datos de Archive Download): `S-NPP * factor[mes]` (`source = "snpp_converted"` o `"snpp_converted_nrt"`).

## 3. Cómo llenar el formulario de FIRMS Archive Download (para 2026)

En `https://firms.modaps.eosdis.nasa.gov/download/` (donde ya tienes cuenta creada):
1. **Area of Interest:** `Country` → seleccionar **`Bolivia`**.
2. **Buffer:** **`0 km`** (imprescindible para que coincida exactamente con la frontera sin buffer de los CSV anuales 2003–2025).
3. **Fire Source:** marcar **`MODIS`** y **`VIIRS S-NPP`**.
4. **Date Range:** **`2026-01-01`** a **`2026-10-31`**.
5. **Output Format:** **`Comma-Separated Text (.csv)`**.
6. Cuando llegue el correo con el enlace, descargar y guardar los CSV en `data/raw/2026/` (p. ej. `data/raw/2026/modis_2026_Bolivia.csv` y `data/raw/2026/viirs-snpp_2026_Bolivia.csv`).
   - *Nota:* No hace falta esperar este correo para empezar a programar ni para correr el pipeline 2003–2025.

## 4. Qué falta por hacer (plan de implementación paso a paso)

### Paso A — Spike y Pipeline de datos (`scripts/`)
1. Crear `.gitignore` (ignorando `data/raw/`, `.env`, `__pycache__/`, `.venv/`).
2. Crear `scripts/download_firms.py`:
   - Descarga en `data/raw/` los CSV anuales de `Bolivia` desde `https://firms.modaps.eosdis.nasa.gov/data/country/`:
     - `modis` para `2003..2025`
     - `viirs-snpp` para `2012..2025`
   - Reutiliza archivos ya descargados si existen en `data/raw/`.
3. Crear `scripts/build_dataset.py`:
   - Lee `data/raw/` (incluyendo `2026` si está presente).
   - Aplica los filtros de `DATA_CONTRACT.md` §1.3.
   - Agrega a celdas-día en grilla de `0.25°` (y permite `--cell-size 0.10` para comparar en el spike).
   - Ejecuta la validación cruzada (`2012–2016` vs `2017–2021` y en las 3 subregiones), verifica que el error sea $\le \pm 15\%$ e imprime el reporte por consola.
   - Calcula los factores finales $k_m$ con `2012-02..2021-12` (sin `2020-08` ni `2020-09`).
   - Genera `data/processed/monthly_cells.csv`, `data/processed/validation.csv` y `data/processed/metadata.json` cumpliendo al 100 % `DATA_CONTRACT.md` v3.
4. Ejecutar primero con una muestra de prueba rápida (p. ej. 2 años) según la regla #5 de `AGENTS.md`, verificar formato y luego correr la serie completa 2003–2025.

### Paso B — Aplicación web estática (`web/`)
1. `web/index.html`, `web/styles.css`, `web/app.js` (JS vanilla + Leaflet + Leaflet.draw + ECharts + Turf.js vía CDN).
2. Funcionalidades requeridas:
   - Mapa de Bolivia con la grilla de celdas activas y selector de AOI (dibujar rectángulo/polígono o elegir Todo el país / Chiquitanía-Llanos / Amazonía-Beni / Andina-Valles).
   - Calendario de actividad de quema (heatmap Año × Mes con paleta accesible Viridis/YlOrRd).
   - Tarjetas de indicadores y gráfico de comparación del mes elegido contra la **mediana histórica (2003–2025) calculada sobre el total del AOI**, más promedio e IQR (percentiles 25–75).
   - Gráfico interactivo de validación científica ("Antes vs. Después de armonizar": Aqua real, S-NPP crudo y S-NPP armonizado).
   - Botón de descarga de CSV de la consulta actual.
