# REFERENCES.md — Fuentes, Datos, Literatura Científica y Licencias de Terceros

> Documento preparado en cumplimiento estricto de las secciones **"INTELLECTUAL PROPERTY RIGHTS IN SOLUTIONS"** y **"USE OF THIRD-PARTY MATERIALS"** de los *2026 NASA Space Apps Participant Terms and Conditions*. Todas las fuentes, conjuntos de datos, guías técnicas y librerías de código abierto empleadas en **PixFire** están registradas a continuación. Listo para copiar y pegar directamente en el campo *References* del formulario de entrega de Space Apps.

---

## 1. Declaración Oficial de Reconocimiento a NASA FIRMS / ESDIS

De acuerdo con las directrices de citación de la FAQ oficial de NASA FIRMS (`https://www.earthdata.nasa.gov/data/tools/firms/faq`):

> *"We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://www.earthdata.nasa.gov/data/tools/firms), part of NASA's Earth Science Data and Information System (ESDIS)."*

---

## 2. Conjuntos de Datos de NASA / NOAA Utilizados

1. **NASA FIRMS — MODIS Collection 6.1 Active Fire Product (`MCD14ML` Standard Monthly Fire Location & `MCD14DL` Near Real-Time):**
   - **Portal principal (Recurso oficial del reto):** https://www.earthdata.nasa.gov/data/tools/firms
   - **Repositorio de resúmenes anuales por país (2003–2025, Bolivia):** `https://firms.modaps.eosdis.nasa.gov/data/country/modis/<YEAR>/modis_<YEAR>_Bolivia.csv`
   - **Herramienta Archive Download (Solicitud `#845357` para Bolivia, `2026-01-01` a `2026-10-31`, Buffer `0 km`):** https://firms.modaps.eosdis.nasa.gov/download/
   - **DOI de referencia del producto MODIS C6.1:** https://doi.org/10.5067/FIRMS/MODIS/MCD14ML
   - **Política de uso:** NASA Open Data Policy — dominio público / acceso libre y abierto sin restricciones (*Full and Open Sharing of Data*, NASA ESDIS).

2. **NASA / NOAA FIRMS — VIIRS 375 m Collection 2 Active Fire Product (`VNP14IMGML` Standard Monthly Fire Location & `VNP14IMGTDL_NRT` Near Real-Time, Suomi-NPP):**
   - **Descripción oficial del instrumento y datos:** https://www.earthdata.nasa.gov/data/instruments/viirs/viirs-i-band-375m-active-fire-data
   - **Repositorio de resúmenes anuales por país (2012–2025, Bolivia):** `https://firms.modaps.eosdis.nasa.gov/data/country/viirs-snpp/<YEAR>/viirs-snpp_<YEAR>_Bolivia.csv`
   - **Herramienta Archive Download (Solicitud `#845358` para Bolivia, `2026-01-01` a `2026-10-31`, Buffer `0 km`):** https://firms.modaps.eosdis.nasa.gov/download/
   - **Catalogación en LP DAAC:** https://lpdaac.usgs.gov/products/vnp14imgv002/
   - **Política de uso:** NASA / NOAA Open Data Policy — libre y público sin restricciones.

---

## 3. Documentación Técnica Oficial y Literatura Científica Consultada

1. **Guía Oficial de Usuario MODIS (Colección 6 y 6.1):**
   - Giglio, L., Schroeder, W., Hall, J. V., & Justice, C. O. (May 2021). *MODIS Collection 6 and Collection 6.1 Active Fire Product User's Guide (Version 1.0)*. University of Maryland / NASA / NOAA.
   - **URL verificada:** https://www.earthdata.nasa.gov/s3fs-public/2023-09/MODIS_C6_C6.1_Fire_User_Guide_1.0.pdf (y https://modis-fire.umd.edu/files/MODIS_C6_C6.1_Fire_User_Guide_1.0.pdf).
   - **Uso en el proyecto:** Definición de clases de confianza (Tabla de §5.1.3: baja `< 30%`, nominal `30–80%`, alta `≥ 80%`), codificación del campo `type` (`0 = presumed vegetation fire`, `1 = active volcano`, `2 = other static land source`, `3 = offshore`), advertencia sobre intervalos menores a 8 días (§7.1.1) y documentación del apagón del módulo FMU de Aqua del 16 de agosto al 2 de septiembre de 2020 (§7.2.4).

2. **Guía Oficial de Usuario VIIRS 375 m (Colección 2):**
   - Schroeder, W., Giglio, L., & Hall, J. (June 2025). *Collection 2 Visible Infrared Imaging Radiometer Suite (VIIRS) 375-m Active Fire Product User's Guide (Version 1.2)*. NOAA NESDIS / University of Maryland / NASA.
   - **URL verificada:** https://www.earthdata.nasa.gov/s3fs-public/2025-06/VIIRS_C2_AF-375m_User_Guide_1.2.pdf
   - **Uso en el proyecto:** Hora nominal de cruce ecuatorial de Suomi-NPP (`1:30 p. m.` y `1:30 a. m.`, §7), fecha efectiva de inicio del registro (`20 de enero de 2012`, §4), clases de confianza (`l`, `n`, `h`, §3.2.2) y corrección del atributo `Type` en la versión 3 de `VNP14IMGML` (mayo de 2025, §6.1).

3. **Atributos y Preguntas Frecuentes de NASA FIRMS:**
   - NASA Earthdata. *Active Fire Data Attributes (MODIS and VIIRS)*: https://www.earthdata.nasa.gov/data/tools/firms/active-fire-data-attributes-modis-viirs (documentación de la Anomalía Magnética del Atlántico Sur sobre píxeles nocturnos de baja confianza).
   - NASA Earthdata. *FIRMS Frequently Asked Questions (FAQ)*: https://www.earthdata.nasa.gov/data/tools/firms/faq (confirmación del cese de distribución de datos de Suomi-NPP el 2 de noviembre de 2026 a las 15:40 UTC y diferencias entre flujos NRT y archivos mensuales estándar `ML`).

4. **Estado Orbital de las Misiones Aqua y Terra (Deriva Orbital):**
   - NASA Goddard Space Flight Center. *Aqua Project Science — Free-Drift Status & Mean Local Equator Crossing Time*: https://aqua.nasa.gov/ (confirmación del fin de maniobras de mantenimiento orbital de Aqua en diciembre de 2021 y deriva progresiva hacia horas más tardías de la tarde).
   - NASA Goddard Space Flight Center. *Terra Project Science — Orbit Drift*: https://terra.nasa.gov/
   - National Snow and Ice Data Center (NSIDC DAAC). *How will Terra and Aqua orbit drift affect MODIS data?*: https://nsidc.org/data/user-resources/help-center/how-will-terra-and-aqua-orbit-drift-affect-modis-data

5. **Artículos Científicos de los Algoritmos Base:**
   - Giglio, L., Schroeder, W., & Justice, C. O. (2016). *The Collection 6 MODIS active fire detection algorithm and fire products*. Remote Sensing of Environment, 178, 31–41. https://doi.org/10.1016/j.rse.2016.02.054
   - Schroeder, W., Oliva, P., Giglio, L., & Csiszar, I. (2014). *The new VIIRS 375 m active fire detection data product: Algorithm description and initial assessment*. Remote Sensing of Environment, 143, 85–96. https://doi.org/10.1016/j.rse.2013.12.008
   - Giglio, L., Descloitres, J., Justice, C. O., & Kaufman, Y. J. (2003). *An enhanced contextual fire detection algorithm for MODIS*. Remote Sensing of Environment, 87, 273–282.

---

## 4. Software, Librerías de Terceros y Mapas Base (Licencias OSI)

Todo el software de terceros utilizado en la aplicación web y en el pipeline cumple con la definición de código abierto de la *Open Source Initiative (OSI)* o corresponde a servicios de teselas gratuitos debidamente atribuidos:

| Componente | Versión / URL | Licencia | Uso en PixFire |
|---|---|---|---|
| **Python Standard Library** (`csv`, `json`, `math`, `urllib`, `concurrent.futures`) | Python 3 (https://www.python.org/) | PSF License (OSI-approved) | Pipeline de descarga, filtrado, agregación a grilla y validación (`scripts/`) |
| **Leaflet** | v1.9.4 (https://leafletjs.com/) | BSD-2-Clause (OSI-approved) | Renderizado del mapa interactivo y grilla de 0,25° |
| **Leaflet.draw** | v1.0.4 (https://github.com/Leaflet/Leaflet.draw) | MIT License (OSI-approved) | Dibujo interactivo de rectángulos y polígonos para definir el Área de Interés (AOI) |
| **Turf.js** (`@turf/turf`) | v6.5.0 (https://turfjs.org/) | MIT License (OSI-approved) | Cálculo geométrico en navegador (`booleanPointInPolygon`, `bbox`, `bboxPolygon`) |
| **Apache ECharts** | v5.5.0 (https://echarts.apache.org/) | Apache License 2.0 (OSI-approved) | Visualización del Calendario de Actividad (heatmap), perfil estacional con banda P25–P75 y curvas de validación |
| **Datos Geográficos de OpenStreetMap** | https://www.openstreetmap.org/copyright | Open Database License (ODbL) | Cartografía base debajo de las teselas del mapa |
| **CARTO Basemaps** (*Dark Matter* & *Voyager*) | https://carto.com/basemaps | Free Non-Commercial Tier (con atribución a CARTO y OpenStreetMap) | Teselas de fondo oscuro y claro en el visor geoespacial |
| **Esri World Imagery** | https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9 | Esri Master License Agreement (acceso público con atribución en el mapa) | Capa opcional de imagen satelital de referencia |
