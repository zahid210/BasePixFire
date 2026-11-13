# SESSION_NOTES.md — Estado del proyecto y guía de continuación

> Proyecto completo y funcional (Pipeline + Dataset 2003–2026 + App Web Estática). Lee `PROJECT.md`, `ARCHITECTURE.md` (v3), `DATA_CONTRACT.md` (v3) y `docs/METODO.md`.

## 1. Qué está hecho (100 % del núcleo y opcionales del reto)

1. **Investigación y documentación científica (`ARCHITECTURE.md` v3, `DATA_CONTRACT.md` v3, `docs/METODO.md`):**
   - Pareja limpia de las 1:30 p. m.: **MODIS Aqua** + **VIIRS Suomi-NPP (S-NPP)**.
   - Grilla común de **0,25° (~27,5 km)** en **celdas-día equivalentes Aqua**, resolución **mensual** (**2003-01 a 2026-10**).
   - Calibración estacional en el traslape limpio **feb 2012 – dic 2021** (sin el apagón de Aqua de ago–sep 2020) y relevo de Aqua desde enero de 2022 por deriva orbital.
2. **Pipeline de datos (`scripts/download_firms.py` y `scripts/build_dataset.py`):**
   - Descargados los 37 archivos CSV anuales de Bolivia (2003–2025) + integrados los archivos Archive y NRT de 2026 en `data/raw/`.
   - Generados y versionados en `data/processed/`:
     - `monthly_cells.csv` (139 036 filas, 4,10 MB)
     - `validation.csv` (serie mensual 2003–2026 con `harmonized`, `aqua`, `snpp_raw`, `snpp_converted`)
     - `metadata.json` (factores $k_m$ y métricas de validación)
   - **Resultados de validación cruzada fuera de muestra (umbral $\le \pm 15\%$):**
     - `2012–2016 → 2017–2021`: sesgo crudo `+177,1 %` → armonizado **`-6,73 %`**.
     - `2017–2021 → 2012–2016`: sesgo crudo `+194,0 %` → armonizado **`+8,09 %`**.
     - Subregiones (`2012–2021`): Chiquitanía/Llanos **`-0,45 %`**, Amazonía/Beni **`-11,56 %`**, Andina/Valles **`+14,46 %`**.
3. **Aplicación Web Estática (`index.html`, `styles.css`, `app.js`):**
   - Mapa interactivo (Leaflet + Leaflet.draw + Turf.js) con grilla de densidad, dibujo de rectángulo/polígono, filtro por coordenadas BBox y selector de macrorregiones.
   - Calendario de actividad de quema Año × Mes (ECharts) con rampas de color accesibles (*Viridis*, *YlOrRd*, *Plasma*).
   - Tarjetas KPI y gráficos de ciclo estacional / anomalías calculadas dinámicamente sobre la **mediana, promedio e IQR (P25–P75) históricos (2003–2025) del total del AOI**.
   - Pestaña de **Validación Científica** con la comparativa *MODIS Aqua vs. VIIRS S-NPP Crudo vs. VIIRS S-NPP Armonizado* y tabla de factores $k_m$.
   - Descarga de CSV tanto de la serie agregada del AOI como del detalle de celdas-mes.

## 2. Cómo ejecutar y probar

```bash
# 1. Regenerar el dataset (opcional, ya está en data/processed/)
python3 scripts/build_dataset.py --cell-size 0.25

# 2. Levantar la aplicación web localmente
python3 -m http.server 8000
# Abrir http://localhost:8000 en el navegador
```
