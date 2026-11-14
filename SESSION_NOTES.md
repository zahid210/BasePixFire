# SESSION_NOTES.md — Estado del proyecto y guía de continuación

> Proyecto completo y funcional (Pipeline + Dataset 2003–2026 en 3 resoluciones + Modelo ML + App Web Estática Bilingüe ES/EN). Lee `PROJECT.md`, `ARCHITECTURE.md` (v3), `DATA_CONTRACT.md` (v3) y `docs/METODO.md`.

## 1. Qué está hecho (100 % del núcleo, opcionales y extensiones científicas)

1. **Investigación y documentación científica (`ARCHITECTURE.md` v3, `DATA_CONTRACT.md` v3, `docs/METODO.md`, `README.md`):**
   - Pareja limpia de la 1:30 p. m.: **MODIS Aqua** + **VIIRS Suomi-NPP (S-NPP)**.
   - Tres grillas reales calculadas desde los CSV originales de FIRMS: **0,25° (~27,5 km)**, **0,10° (~11 km)** y **0,05° (~5,5 km)** en **celdas-día equivalentes Aqua**, resolución **mensual** (**2003-01 a 2026-10** en las tres grillas).
   - Calibración estacional en el traslape limpio **feb 2012 – dic 2021** (sin el apagón de Aqua de ago–sep 2020) y relevo de Aqua desde enero de 2022 por deriva orbital.
2. **Pipeline de datos (`scripts/download_firms.py`, `scripts/build_dataset.py` y `scripts/ml_model.py`):**
   - Descargados los 37 archivos CSV anuales de Bolivia (2003–2025) + integrados los archivos Archive y NRT de 2026 en `data/raw/`.
   - Generados y versionados en `data/processed/`, `data/processed/grid_0.10/` y `data/processed/grid_0.05/`:
     - `monthly_cells.csv`, `validation.csv`, `metadata.json` y `data_bundle.js` (todos con cobertura completa 2003–octubre 2026).
     - `ml_results.json` y `ml_bundle.js` (modelo GLM Tweedie, Binomial Negativa, Hurdle y proyección Monte Carlo 2027–2030, sin imputar nov–dic 2026).
   - **Resultados de validación cruzada fuera de muestra (umbral $\le \pm 15\%$):**
     - Grilla `0,25°`: `2012–16 → 2017–21` **`-6,73 %`** | `2017–21 → 2012–16` **`+8,09 %`**.
     - Grilla `0,10°`: `2012–16 → 2017–21` **`-5,49 %`** | `2017–21 → 2012–16` **`+6,27 %`**.
     - Grilla `0,05°`: `2012–16 → 2017–21` **`-4,55 %`** | `2017–21 → 2012–16` **`+5,05 %`**.
3. **Aplicación Web Estática Bilingüe (`index.html`, `styles.css`, `app.js`, `i18n.js`):**
   - Soporte completo en vivo **Español (ES) / Inglés (EN)**.
   - Mapa interactivo (Leaflet + Leaflet.draw + Turf.js) con 3 modos (*Lo habitual*, *El mes elegido*, *Pronóstico 2030*), animación mes a mes, selección de grilla (`0,25°`, `0,10°`, `0,05°` con *lazy loading*), popup por celda con *sparkline*, dibujo de polígono/rectángulo y filtro por coordenadas.
   - 6 pestañas analíticas: *Calendario*, *Armonización (5 pasos)*, *Evolución*, *¿Es normal?*, *Peores años* y *Pronóstico (técnico)*.
   - Exportación de CSV (serie agregada del AOI y detalle por celda-mes) e imagen PNG del gráfico activo.

## 2. Cómo ejecutar y probar

```bash
# 1. Regenerar las grillas (opcional, ya están en data/processed/)
python3 scripts/build_dataset.py --cell-size 0.25
python3 scripts/build_dataset.py --cell-size 0.10 --out-dir data/processed/grid_0.10
python3 scripts/build_dataset.py --cell-size 0.05 --out-dir data/processed/grid_0.05

# 2. Levantar la aplicación web localmente
python3 -m http.server 8000
# Abrir http://localhost:8000 en el navegador
```
