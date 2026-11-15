<!--suppress SpellCheckingInspection -->
# PixFire — Armonización de Focos de Calor MODIS & VIIRS (2003–2026)

**Proyecto para el NASA International Space Apps Challenge 2026**  
**Reto:** *Harmonization of MODIS and VIIRS Hot Spots*  
**Licencia:** [Apache License 2.0](LICENSE) · **Datos oficiales:** [NASA FIRMS](https://www.earthdata.nasa.gov/data/tools/firms)

---

## 1. El Problema

Los satélites de observación terrestre llevan más de dos décadas detectando focos de calor (*hotspots*), pero ese registro histórico está dividido entre dos generaciones de sensores que **no se pueden comparar directamente**:
- **MODIS (Terra y Aqua, desde 2000/2002):** píxeles nominales de **1 km × 1 km**. Sus satélites están llegando al final de su vida útil y sufriendo deriva orbital.
- **VIIRS (Suomi-NPP, NOAA-20, NOAA-21, desde 2012):** píxeles de **375 m × 375 m** (un área ~7 veces menor que MODIS). Detecta fuegos mucho más pequeños y genera múltiples píxeles por cada incendio grande.

Si se unen ambos registros en crudo, a partir de 2012 aparece un **salto artificial de +185 % en celdas-día (y hasta ~7 veces más en conteo de puntos)** debido al cambio de cámara, no a un aumento real del fuego.

---

## 2. Nuestra Solución y Resultados Reales (Caso de Estudio: Bolivia, 2003–2026)

Construimos un **pipeline reproducible en Python** ([scripts/build_dataset.py](scripts/build_dataset.py) y [scripts/ml_model.py](scripts/ml_model.py)) y una **aplicación web interactiva bilingüe (`EN | ES`, con inicio automático en inglés)** sin servidor ([index.html](index.html), [app.js](app.js), [i18n.js](i18n.js)) que armonizan **24 años de datos oficiales de NASA FIRMS (enero de 2003 a octubre de 2026)** en una serie mensual consistente expresada en **celdas-día con fuego equivalentes a MODIS Aqua** sobre tres grillas reales seleccionables (**0,25° (~27 km)**, **0,10° (~11 km)** y **0,05° (~5,5 km)**):

1. **Emparejamiento orbital a la 1:30 p. m. (Aqua + Suomi-NPP):** seleccionamos exclusivamente **MODIS Aqua** y **VIIRS Suomi-NPP**, que comparten la misma hora solar local de paso ecuatorial (~13:30 y ~01:30), eliminando el sesgo por el ciclo diurno del fuego y evitando saltos por la entrada de satélites adicionales.
2. **Filtrado físico de calidad (H3):** aplicamos los umbrales de las guías oficiales de usuario de NASA/UMD (`type == 0` para excluir volcanes y fuentes industriales; `confidence >= 30` en MODIS y `confidence ∈ {n, h}` en VIIRS para descartar falsas alarmas nocturnas de baja confianza asociadas a la Anomalía Magnética del Atlántico Sur).
3. **Agregación a celdas-día en grilla común (H1):** cada celda cuenta `1` por día si registró al menos una detección activa. Esto neutraliza la sobrerrepresentación de grandes incendios en VIIRS y el doble conteo por solapamiento entre órbitas consecutivas.
4. **Calibración estacional en el traslape limpio 2012–2021 y relevo por deriva orbital (H2):** calculamos los factores mensuales $k_m = \sum \text{Aqua} / \sum \text{S-NPP}$ entre febrero de 2012 y diciembre de 2021 (excluyendo y reparando el apagón del módulo FMU de Aqua de agosto–septiembre de 2020), y relevamos a Aqua a partir de enero de 2022, cuando dejó de realizar maniobras de mantenimiento orbital.
5. **Comparador interactivo *Antes (`⚠ Sin corregir`) vs. Después (`✓ Armonizado`)*:** permite alternar en tiempo real entre la serie armonizada y la serie con VIIRS sin corregir desde febrero de 2012, actualizando de forma sincronizada el **mapa**, el **banner de sobreconteo**, el **resumen del mes**, el **calendario de calor (Año × Mes)**, la **evolución temporal**, el **ciclo estacional** y el **ranking de peores años**.
6. **Monitoreo de Áreas Naturales Protegidas de Bolivia (SERNAP / WDPA / OSM):** integra los perímetros oficiales de las **7 principales Áreas Naturales Protegidas de interés nacional** ([data/processed/protected_areas.geojson](data/processed/protected_areas.geojson) y [data/processed/protected_areas_bundle.js](data/processed/protected_areas_bundle.js)) tanto en el selector de zonas como en la capa cartográfica y en las tarjetas/popups de celda.
7. **Modelado estadístico de riesgo y proyección 2027–2030:** mediante modelos lineales generalizados para datos de conteo sobredispersos (**Tweedie GLM**, **Binomial Negativa** y modelo **Hurdle** en dos etapas) evaluamos el efecto de la *persistencia anual (chaqueo)* frente a la *acumulación de combustible* y proyectamos rangos plausibles (`P10–P90`) mediante simulación Monte Carlo hasta 2030.

### Validación Cruzada Fuera de Muestra (Out-of-Sample Split-Half Validation, Umbral $\le \pm 15\%$)

| Grilla | Celdas activas | Factor anual ($k$) | Entrena 2012–16 → Prueba 2017–21 | Entrena 2017–21 → Prueba 2012–16 | Chiquitanía y Llanos | Amazonía y Beni | Andina y Valles |
|---|---|---|---|---|---|---|---|
| **0,25° (~27,5 km)** | 1 570 | 0,351 | `+177,1 %` → **`-6,73 %`** | `+194,0 %` → **`+8,09 %`** | **`-0,45 %`** | **`-11,56 %`** | **`+14,46 %`** |
| **0,10° (~11,0 km)** | 8 637 | 0,317 | `+208,9 %` → **`-5,49 %`** | `+224,8 %` → **`+6,27 %`** | **`+1,64 %`** | **`-13,01 %`** | **`+10,80 %`** |
| **0,05° (~5,5 km)** | 28 711 | 0,307 | `+219,7 %` → **`-4,55 %`** | `+233,7 %` → **`+5,05 %`** | **`+2,30 %`** | **`-13,34 %`** | **`+9,60 %`** |

### Áreas Naturales Protegidas Integradas (Fuentes: SERNAP · UNEP-WCMC WDPA · OpenStreetMap)

| Área Natural Protegida | Categoría SERNAP / UICN | Norma Legal de Creación | ID WDPA | Relación OSM | Superficie Oficial | Celdas `0,25°` |
|---|---|---|---|---|---|---|
| **ANMI San Matías** | Área Natural de Manejo Integrado (UICN VI) | D.S. N° 24734 (31/07/1997) | `98184` | `9504398` | 2 918 500 ha | 37 |
| **PN Noel Kempff Mercado** | Parque Nacional · Patrimonio UNESCO (UICN II) | D.S. N° 16646 (1979) · D.S. N° 21997 (1988) | `98183` | `421231` | 1 523 446 ha | 21 |
| **PN y ANMI Pantanal de Otuquis** | Parque Nacional y ANMI · Sitio Ramsar (UICN II) | D.S. N° 24762 (31/07/1997) | `98185` | `9504400` | 1 005 950 ha | 13 |
| **TIPNIS (Isiboro-Sécure)** | Territorio Indígena y Parque Nacional (UICN II) | D.L. N° 07401 (1965) · D.S. N° 22610 (1990) | `31` | `9514126` | 1 236 296 ha | 17 |
| **PN y ANMI Madidi** | Parque Nacional y ANMI (UICN II) | D.S. N° 24123 (21/09/1995) | `98182` | `420485` | 1 895 750 ha | 19 |
| **PN y ANMI Kaa-Iya del Gran Chaco** | Parque Nacional y ANMI (UICN II / VI) | D.S. N° 24122 (21/09/1995) | `98181` | `7728779` + `7728781` | 3 441 115 ha | 46 |
| **PN y ANMI Amboró** | Parque Nacional y ANMI (UICN II) | D.S. N° 20423 (1984) · D.S. N° 24137 (1995) | `2007` | `9576261` | 637 600 ha | 5 |

---

## 3. Cómo Ejecutar la Aplicación Web

Los datos ya procesados y armonizados (`data/processed/`, incluyendo `grid_0.10/`, `grid_0.05/`, `ml_bundle.js` y `protected_areas_bundle.js`) están incluidos en el repositorio. La grilla estándar de `0,25°` se carga al inicio y las grillas finas (`0,10°` y `0,05°`) se cargan bajo demanda (*lazy loading*), por lo que la aplicación funciona de inmediato tanto mediante un servidor local como abriendo `index.html` directamente en el navegador (`file:///`):

```bash
# Desde la raíz del repositorio:
python3 -m http.server 8000
```

Abre **`http://localhost:8000`** en tu navegador.

### Reproducibilidad completa desde los CSV crudos de NASA FIRMS:

```bash
# 1. Descargar los 37 archivos CSV anuales públicos de Bolivia (2003-2025) a data/raw/
python3 scripts/download_firms.py --country Bolivia --start-year 2003 --end-year 2025

# 2. Generar las tres grillas armonizadas (2003-2026) y sus validaciones
python3 scripts/build_dataset.py --country Bolivia --cell-size 0.25
python3 scripts/build_dataset.py --country Bolivia --cell-size 0.10 --out-dir data/processed/grid_0.10
python3 scripts/build_dataset.py --country Bolivia --cell-size 0.05 --out-dir data/processed/grid_0.05

# 3. Ejecutar el modelo estadístico Tweedie / Hurdle y la proyección Monte Carlo 2027-2030
python3 scripts/ml_model.py --n-sims 200
```

---

## 4. Estructura del Repositorio

- [index.html](index.html), [styles.css](styles.css), [app.js](app.js), [i18n.js](i18n.js): Aplicación web estática bilingüe (`EN | ES`) con mapa interactivo Leaflet (polígono libre, rectángulo, coordenadas, filtro y capa de 7 Áreas Naturales Protegidas del SERNAP, comparador *Antes vs. Después de armonizar*, clic por celda con *sparkline*, animación temporal y 3 resoluciones de grilla), y 6 vistas integradas: *Calendario*, *Armonización en 5 pasos*, *Evolución*, *¿Es normal?*, *Peores años* y *Pronóstico (técnico)*, además de exportación de CSV (serie y celdas) y PNG.
- [scripts/download_firms.py](scripts/download_firms.py) y [scripts/build_dataset.py](scripts/build_dataset.py): Pipeline de descarga, limpieza física (H3), agregación a celdas-día (H1), calibración estacional (H2) y validación cruzada fuera de muestra.
- [scripts/ml_model.py](scripts/ml_model.py): Modelado GLM Tweedie, Binomial Negativa, Hurdle (ocurrencia vs. intensidad) y simulación Monte Carlo 2027–2030.
- [data/processed/](data/processed): Salidas del pipeline para `0,25°`, `grid_0.10/`, `grid_0.05/`, resultados del modelo ML (`ml_results.json`, `ml_bundle.js`) y polígonos de áreas protegidas (`protected_areas.geojson`, `protected_areas_bundle.js`).
- [LICENSE](LICENSE): Licencia de código abierto Apache 2.0 exigida por las bases de NASA Space Apps 2026.

---

## 5. Reconocimiento Oficial

> *"We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://www.earthdata.nasa.gov/data/tools/firms), part of NASA's Earth Science Data and Information System (ESDIS)."*
