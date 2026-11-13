# PixFire — Armonización de Focos de Calor MODIS & VIIRS (2003–2026)

**Proyecto para el NASA International Space Apps Challenge 2026**  
**Reto:** *Harmonization of MODIS and VIIRS Hot Spots*  
**Licencia:** [Apache License 2.0](file:///home/kali/Desktop/BasePixFire/LICENSE) · **Referencias y Atribuciones:** [REFERENCES.md](file:///home/kali/Desktop/BasePixFire/REFERENCES.md) · **Metodología Científica:** [docs/METODO.md](file:///home/kali/Desktop/BasePixFire/docs/METODO.md)

---

## 1. El Problema

Los satélites de observación terrestre llevan más de dos décadas detectando focos de calor (*hotspots*), pero ese registro histórico está dividido entre dos generaciones de sensores que **no se pueden comparar directamente**:
- **MODIS (Terra y Aqua, desde 2000/2002):** píxeles nominales de **1 km × 1 km**. Sus satélites están llegando al final de su vida útil y sufriendo deriva orbital.
- **VIIRS (Suomi-NPP, NOAA-20, NOAA-21, desde 2012):** píxeles de **375 m × 375 m** (un área ~7 veces menor que MODIS). Detecta fuegos mucho más pequeños y genera múltiples píxeles por cada incendio grande.

Si se unen ambos registros en crudo, a partir de 2012 aparece un **salto artificial de +185 % en celdas-día (y hasta ~7 veces más en conteo de puntos)** debido al cambio de cámara, no a un aumento real del fuego.

---

## 2. Nuestra Solución y Resultados Reales (Caso de Estudio: Bolivia, 2003–2026)

Construimos un **pipeline reproducible en Python** ([scripts/build_dataset.py](file:///home/kali/Desktop/BasePixFire/scripts/build_dataset.py)) y una **aplicación web interactiva sin servidor** ([index.html](file:///home/kali/Desktop/BasePixFire/index.html), [app.js](file:///home/kali/Desktop/BasePixFire/app.js)) que armonizan **24 años de datos oficiales de NASA FIRMS (enero de 2003 a octubre de 2026)** en una serie mensual consistente expresada en **celdas-día con fuego equivalentes a MODIS Aqua** sobre una grilla común de **0,25° × 0,25° (~27,5 km)**:

1. **Emparejamiento orbital a la 1:30 p. m. (Aqua + Suomi-NPP):** seleccionamos exclusivamente **MODIS Aqua** y **VIIRS Suomi-NPP**, que comparten la misma hora solar local de paso ecuatorial (~13:30 y ~01:30), eliminando el sesgo por el ciclo diurno del fuego y evitando saltos por la entrada de satélites adicionales.
2. **Filtrado físico de calidad (H3):** aplicamos los umbrales de las guías oficiales de usuario de NASA/UMD (`type == 0` para excluir volcanes y fuentes industriales; `confidence >= 30` en MODIS y `confidence ∈ {n, h}` en VIIRS para descartar falsas alarmas nocturnas de baja confianza asociadas a la Anomalía Magnética del Atlántico Sur).
3. **Agregación a celdas-día en grilla de 0,25° (H1):** cada celda cuenta `1` por día si registró al menos una detección activa. Esto neutraliza la sobrerrepresentación de grandes incendios en VIIRS y el doble conteo por solapamiento entre órbitas consecutivas.
4. **Calibración estacional en el traslape limpio 2012–2021 y relevo por deriva orbital (H2):** calculamos los factores mensuales $k_m = \sum \text{Aqua} / \sum \text{S-NPP}$ entre febrero de 2012 y diciembre de 2021 (excluyendo y reparando el apagón del módulo FMU de Aqua de agosto–septiembre de 2020), y relevamos a Aqua a partir de enero de 2022, cuando dejó de realizar maniobras de mantenimiento orbital.

### Validación Cruzada Fuera de Muestra (Out-of-Sample Split-Half Validation)

| Experimento de validación | Total MODIS Aqua (celdas-día) | VIIRS S-NPP Crudo (Sesgo %) | VIIRS S-NPP Armonizado (Sesgo %) | MAE Mensual |
|---|---|---|---|---|
| **Entrena 2012–2016 → Prueba 2017–2021** | 59 822 | 165 737 (**+177,05 %**) | 55 795,3 (**-6,73 %**) | 109,6 |
| **Entrena 2017–2021 → Prueba 2012–2016** | 47 776 | 140 480 (**+194,04 %**) | 51 640,1 (**+8,09 %**) | 99,4 |
| **Subregión: Chiquitanía y Llanos (2012–2021)** | 49 984 | 144 995 (**+190,08 %**) | 49 758,5 (**-0,45 %**) | 48,2 |
| **Subregión: Amazonía y Beni Norte (2012–2021)** | 31 155 | 76 646 (**+146,02 %**) | 27 554,2 (**-11,56 %**) | 34,5 |
| **Subregión: Andina y Valles (2012–2021)** | 26 459 | 84 576 (**+219,65 %**) | 30 285,3 (**+14,46 %**) | 39,9 |

---

## 3. Cómo Ejecutar la Aplicación Web

Los datos ya procesados y armonizados (`data/processed/monthly_cells.csv`, `validation.csv`, `metadata.json` y `data_bundle.js`) están incluidos en el repositorio (`monthly_cells.csv` pesa **4,20 MB**), por lo que la aplicación funciona de inmediato tanto mediante un servidor local como abriendo `index.html` directamente en el navegador (`file:///`):

```bash
# Desde la raíz del repositorio:
python3 -m http.server 8000
```

Abre **`http://localhost:8000`** en tu navegador.

### Si deseas volver a correr el pipeline desde cero con los datos crudos de NASA FIRMS:

```bash
# 1. Descargar los 37 archivos CSV anuales públicos de Bolivia (2003-2025) a data/raw/
python3 scripts/download_firms.py --country Bolivia --start-year 2003 --end-year 2025

# 2. Procesar, ejecutar la validación cruzada y generar data/processed/
python3 scripts/build_dataset.py --country Bolivia --cell-size 0.25
```

---

## 4. Estructura del Repositorio

- [index.html](file:///home/kali/Desktop/BasePixFire/index.html), [styles.css](file:///home/kali/Desktop/BasePixFire/styles.css), [app.js](file:///home/kali/Desktop/BasePixFire/app.js): Aplicación web estática (Mapa Leaflet con dibujo de AOI y selector de capas Carto/Esri, Calendario de Actividad Año × Mes en ECharts con rampas accesibles, cálculo dinámico de mediana e IQR históricos sobre el AOI, pestaña de Validación Científica y exportación CSV).
- [scripts/download_firms.py](file:///home/kali/Desktop/BasePixFire/scripts/download_firms.py) y [scripts/build_dataset.py](file:///home/kali/Desktop/BasePixFire/scripts/build_dataset.py): Pipeline de descarga, limpieza, agregación a celdas-día, calibración y validación.
- [data/processed/](file:///home/kali/Desktop/BasePixFire/data/processed): Salidas del pipeline (`monthly_cells.csv`, `validation.csv`, `metadata.json`).
- [docs/METODO.md](file:///home/kali/Desktop/BasePixFire/docs/METODO.md): Explicación detallada del método, revisión crítica de sesgos y limitaciones, y guion de defensa ante el jurado.
- [ARCHITECTURE.md](file:///home/kali/Desktop/BasePixFire/ARCHITECTURE.md) y [DATA_CONTRACT.md](file:///home/kali/Desktop/BasePixFire/DATA_CONTRACT.md): Diseño de arquitectura y contrato de datos v3.
- [REFERENCES.md](file:///home/kali/Desktop/BasePixFire/REFERENCES.md) y [LICENSE](file:///home/kali/Desktop/BasePixFire/LICENSE): Citación completa de fuentes de NASA/NOAA, artículos científicos y licencias de código abierto exigidas por las bases de NASA Space Apps 2026.

---

## 5. Reconocimiento Oficial

> *"We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://www.earthdata.nasa.gov/data/tools/firms), part of NASA's Earth Science Data and Information System (ESDIS)."*
