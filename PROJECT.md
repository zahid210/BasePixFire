# PROJECT.md — Contexto del proyecto

> Léelo completo antes de hacer cualquier cosa. Si algo aquí es ambiguo o falta, pregunta; no asumas.
> Recursos oficiales y decisiones actualizadas el viernes 13/11 en `ARCHITECTURE.md` y `DATA_CONTRACT.md`.

## 1. Evento y reto

- **Evento:** NASA Space Apps Challenge 2026.
- **Reto:** "Harmonization of MODIS and VIIRS Hot Spots".
- **Dificultad:** intermedia/avanzada. **Temas:** Earth Science y Software.
- **Fechas:** sábado 14/11/2026 9:00 a. m. → domingo 15/11/2026 11:59 p. m. (hora local). Son ~39 horas de reloj, no 48; el tiempo útil de trabajo es menor por descanso y entrega.
- **Equipo:** 6 personas. Nadie tiene experiencia previa en este tipo de reto. El desarrollador principal usa agentes de IA en terminal (Opencode, Antigravity) sobre Kali Linux.

## 2. El problema (en simple)

Los satélites detectan **focos de calor** (hotspots): píxeles donde hay fuego activo (incendios forestales, quemas agrícolas, etc.). Hay más de 20 años de registros, pero vienen de dos familias de sensores:

- **MODIS** (satélites Terra y Aqua): registro más largo (desde inicios de los 2000), píxeles de ~1 km. Sus satélites están llegando al final de su vida útil.
- **VIIRS** (Suomi NPP, NOAA-20, NOAA-21): desde ~2012, píxeles de ~375 m, detecta fuegos más pequeños y está reemplazando a MODIS.

Los dos registros **no se pueden comparar directamente**: difieren en resolución espacial, sensibilidad, horarios de paso y algoritmo de detección. Si se juntan sin más, la serie histórica muestra un "salto" artificial cuando aparece VIIRS (más focos por mejor detección, no por más fuego real).

## 3. Qué hay que construir

Una **aplicación web** que:

1. **Armoniza** los hotspots de MODIS y VIIRS en una serie temporal consistente, de modo que "el sensor de origen ya no importe" y se vean patrones, tendencias y anomalías.
2. Muestra un **calendario de actividad de quema** (número de hotspots a lo largo del tiempo, desde inicios de los 2000 hasta hoy) para un **área de interés** elegida por el usuario.
3. Permite elegir **región y rango de fechas** y descargar análisis y visualizaciones.

Caso de uso concreto mencionado en el reto: comparar la actividad del **mes actual contra la mediana histórica** del área seleccionada, y ver qué meses/años tuvieron más fuego.

### Requerido (núcleo del reto)
- Dataset armonizado MODIS + VIIRS.
- App web con selección de área y fechas.
- Calendario de actividad de quema integrado en la app.
- Explicación clara del método de armonización.

### Opcional (el reto dice "podrías considerar")
- Mapa interactivo donde el usuario dibuje el área, o entrada por latitud/longitud.
- Rampas de color accesibles.
- Indicadores clave: comparación histórica, anomalías vs. promedios multianuales, número de fuegos detectados.
- **Descarga de un CSV** con los hotspots de la búsqueda.

## 4. Usuarios objetivo

Respondedores de emergencias y alerta temprana, científicos, gestores de tierras y bomberos. Necesitan ver rápido: qué épocas del año tienen más fuego, qué años fueron peores y si lo actual es inusual.

## 5. Datos

- **Fuente sugerida por el reto:** NASA Earthdata **FIRMS** (hotspots de MODIS y VIIRS).
- **Recursos oficiales (publicados 13/11):** un único recurso NASA: **FIRMS** — https://www.earthdata.nasa.gov/data/tools/firms. Aviso del reto: para sitios no gubernamentales de EE. UU. hay que respetar sus condiciones de uso de datos.
- **Acceso (verificado 12–13/11):** los CSV anuales por país de FIRMS son públicos y sin login (calidad estándar, hasta 2025). El archivo histórico a medida requiere Earthdata Login o código por correo. MAP_KEY solo hace falta para la API/servicios de mapas (límite 5000 transacciones / 10 min). Ver `ARCHITECTURE.md` §0.
- **Región de trabajo:** **Bolivia** (país completo, Buffer 0 km; ver `ARCHITECTURE.md` §2.1).

## 6. Restricciones

- Tiempo muy limitado y equipo sin experiencia: **alcance mínimo realista antes que ambición**.
- Todo debe poder **explicarse ante un jurado** con palabras simples, especialmente el método de armonización.
- La app debe funcionar sin depender de procesar millones de puntos en el navegador.
- Se prefiere hosting estático (GitHub Pages / Vercel) por simplicidad.

## 7. Criterio de éxito

Una persona de emergencias abre la web, dibuja un área, y ve en pocos segundos el calendario armonizado, una comparación con el histórico y puede descargar un CSV, **y** el equipo puede demostrar que el salto entre MODIS y VIIRS fue corregido.

## 8. Glosario

- **Hotspot / foco de calor:** detección satelital de una anomalía térmica (probable fuego activo).
- **MODIS / VIIRS:** los dos sensores a armonizar.
- **FRP (Fire Radiative Power):** medida de la intensidad del fuego, disponible en los datos de FIRMS.
- **Armonizar:** hacer que conteos de dos sensores distintos signifiquen lo mismo y sean comparables.
- **AOI (área de interés):** región que dibuja o define el usuario.
- **Anomalía:** diferencia entre la actividad actual y lo típico histórico (por ejemplo, la mediana del mismo mes).
- **Periodo de traslape:** años en que MODIS y VIIRS operaron a la vez; base natural para calibrar.
