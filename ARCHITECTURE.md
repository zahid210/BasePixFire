# ARCHITECTURE.md — Arquitectura (BORRADOR v2)

> **Estado: borrador v2 (13/11/2026).** Actualizado tras verificar fuentes oficiales de FIRMS/NASA y revisar archivos reales de FIRMS. Las marcas **🔄 CAMBIO** indican qué cambió respecto al v1 y por qué. Lo marcado **[PENDIENTE]** se cierra con los recursos oficiales del reto o con el spike de datos. Un agente de IA debe proponer mejoras y preguntar, no tratar esto como definitivo.

## 0. Registro de cambios (v1 → v2)

| # | Cambio | Por qué |
|---|---|---|
| 1 | Fuente de datos: CSV anuales por país de FIRMS (públicos, sin login) | Verificado: existen, son calidad estándar (no NRT) y traen el campo `type`. Elimina la dependencia de cuentas o descargas lentas |
| 2 | Pareja de satélites: **Aqua (MODIS) + S-NPP (VIIRS)** | Ambos cruzan el ecuador a la 1:30 p. m. (guías oficiales MODIS y VIIRS), lo que elimina diferencias por hora del día |
| 3 | Serie: **2003–2025**, mensual | Aqua desde jul 2002; los CSV anuales llegan hasta 2025; la guía MODIS advierte sesgos con intervalos < ~8 días |
| 4 | Calibración: **20 ene 2012 – dic 2021**, sin 16 ago – 2 sep 2020 | Inicio de S-NPP; Aqua deriva de órbita desde dic 2021 (aqua.nasa.gov); apagón de Aqua de 2020 (guía MODIS §7.2.4) |
| 5 | Escala: **equivalente MODIS (Aqua)** | La serie habla el idioma del registro más largo |
| 6 | Método elegido: **Enfoque A** (grilla + celdas-día + factor por mes del año) | Simple, explicable y validable. B (regresión) y C (cuantiles) son plan B |
| 7 | Validación con años separados (no circular) | Calibrar y validar con los mismos años "aprueba" por construcción |
| 8 | Corte fijo a dic 2025, sin NRT | NRT ≠ estándar; mes en curso incompleto |
| 9 | Stack: Python + pandas / JS vanilla + Leaflet + ECharts | Un solo desarrollador; mínimas dependencias |
| 10 | Región propuesta: **Bolivia** [PENDIENTE confirmación] | Ver §2.1 |

## 1. Visión general

Dos bloques que se comunican **solo a través de archivos de datos** definidos en `DATA_CONTRACT.md`:

```
[FIRMS: CSV anuales por país — Aqua MODIS + S-NPP VIIRS]
        │  (descarga, sin login)
        ▼
[Pipeline Python / armonización]  → genera archivos agregados
        │  (CSV/JSON estáticos)
        ▼
[Aplicación web estática]  → mapa + selección de área + calendario + anomalías + descarga CSV
```

Idea clave: **el pipeline hace el trabajo pesado una vez** y la web solo lee datos ya agregados. Procesar millones de puntos en el navegador sería lento e inviable.

**Equipo de software:** un solo desarrollador (con apoyo de agentes de IA). El resto del equipo puede apoyar en verificación de recursos, presentación y revisión del método.

## 2. Bloque A — Pipeline de datos y armonización

### 2.1 Región 🔄 CAMBIO

**Propuesta: Bolivia (país completo). [PENDIENTE confirmación del equipo]**

Razones (datos reales FIRMS 2019, puntos filtrados, solo ilustrativos):
- Mucha actividad y temporada marcada (ago–sep concentran la mayoría de detecciones) → el calendario se ve claro.
- El "salto" es grande: S-NPP detectó ~7 veces más puntos que Aqua → la armonización se nota.
- Volumen manejable: ~38 MB/año de CSV crudo (ambos sensores) → < 1 GB para toda la serie; trivial para pandas.
- Plan B más liviano: **Paraguay** (~15 MB/año).

Hallazgo útil para el método: el cociente S-NPP/Aqua varía **entre países** (≈4,8 a 8,7 en 2019) y **entre meses** del mismo país (Bolivia ≈5,3 a 9,0). Un único factor global no sirve. *(Estos cocientes son de puntos crudos filtrados, no de celdas-día; el spike debe recalcularlos con el método real.)*

### 2.2 Pasos

1. **Descargar** CSV anuales de FIRMS por país:
   - `https://firms.modaps.eosdis.nasa.gov/data/country/modis/<AÑO>/modis_<AÑO>_<País>.csv` (Terra + Aqua; quedarse con `satellite == "Aqua"`)
   - `https://firms.modaps.eosdis.nasa.gov/data/country/viirs-snpp/<AÑO>/viirs-snpp_<AÑO>_<País>.csv`
2. **Limpiar y filtrar (H3)** 🔄 CAMBIO — umbrales definidos con fuentes oficiales:
   - `type == 0` (presunto fuego de vegetación; descarta volcanes, fuentes estáticas y offshore).
   - MODIS: `confidence >= 30` (nominal + alta; umbrales de la guía MODIS: baja < 30, nominal 30–80, alta ≥ 80).
   - VIIRS: `confidence in {"n","h"}` (descarta baja; la guía VIIRS advierte falsas alarmas nocturnas de baja confianza sobre la Anomalía del Atlántico Sur, que cubre casi toda Sudamérica).
3. **Agregar a grilla común (H1):** contar **celdas-día con al menos una detección**, por satélite, y sumar por mes. Un fuego visto como muchos píxeles VIIRS y pocos MODIS cuenta igual (1 por celda-día). **[PENDIENTE spike]** tamaño de celda (probar p. ej. 0,1° y 0,25° y elegir con qué factor queda más estable).
4. **Calibrar (H2)** 🔄 CAMBIO — **Enfoque A**:
   - En la ventana de calibración: `factor[mes] = Σ Aqua / Σ S-NPP` (celdas-día), por mes del año (1–12), para toda la región.
   - Si un solo factor anual valida igual de bien que los 12 mensuales, usar el más simple.
5. **Construir la serie armonizada (equivalente Aqua):**
   - 2003–2021: Aqua (filtrado y agregado igual).
   - 2022–2025: S-NPP × `factor[mes]` (Aqua ya está en deriva orbital).
6. **Validar** 🔄 CAMBIO (ver §2.3).
7. **Exportar** archivos según `DATA_CONTRACT.md`.
8. **Documentar** método y límites en `docs/METODO.md`.

### 2.3 Validación 🔄 CAMBIO

- **Separar años:** calibrar con 2012–2016 y validar con 2017–2021 (y al revés, para comprobar estabilidad).
- **Gráfico clave para el jurado** (años de validación): tres líneas — Aqua real, S-NPP crudo (el salto), S-NPP convertido (debe quedar sobre Aqua).
- **Métricas simples:** diferencia % del total anual y error mensual medio. **[PENDIENTE]** fijar el umbral de éxito **antes** de ver los resultados.
- **Evidencia extra:** comparar Aqua 2022–2025 contra S-NPP convertido; si divergen, muestra el efecto de la deriva de Aqua (argumento a favor del método).
- **Chequeo de etiquetas de versión MODIS:** el campo `version` cambia (6.2 hasta 2017, 6.03 en 2018–2022, 61.03 desde 2023). Comprobar que no aparezca un escalón en ene 2018 ni en ene 2023 (la guía MODIS indica diferencias de solo 0,001 % entre C6 y C6.1).

### 2.4 Enfoques alternativos (plan B)

- **B. Regresión lineal** (Aqua = a + b·S-NPP): si el factor proporcional deja errores sistemáticos en meses de poco fuego.
- **C. Emparejar distribuciones (quantile mapping):** si la relación es claramente no lineal. Más difícil de explicar.

## 3. Bloque B — Aplicación web

Responsable: el desarrollador (único).

Componentes:
- **Mapa** con selección de área de interés (rectángulo/polígono; opcional: lat/lon).
- **Calendario de actividad:** mapa de calor mes × año con rampa de color accesible.
- **Comparación histórica:** mes seleccionado vs. referencia histórica **del área seleccionada**; anomalías.
- **Filtros:** rango de fechas.
- **Exportación:** descarga de CSV de los conteos agregados consultados.
- **Transparencia:** mostrar (o permitir activar) las series crudas de Aqua y S-NPP junto a la armonizada.

Stack 🔄 CAMBIO (decidido salvo objeción):
- JavaScript vanilla (sin framework).
- Mapa: Leaflet + Leaflet.draw.
- Gráficos: ECharts.
- Geometría en cliente (celdas dentro del polígono): Turf.js.
- Hosting estático: GitHub Pages (o Vercel).

Flujo en la app: el usuario dibuja un área → la app suma las celdas agregadas que caen dentro → calcula la referencia histórica de ese total → muestra calendario y estadísticas → permite descargar CSV.

🔄 CAMBIO: la referencia histórica se calcula sobre el **total del área** (en el navegador, son pocos números), no sumando medianas por celda: la suma de medianas ≠ la mediana de la suma.

## 4. Riesgos conocidos

| Riesgo | Mitigación |
|---|---|
| Volumen de datos demasiado grande | Una región (país); agregar en el pipeline; servir archivos estáticos pequeños |
| Armonización que "suena bien" pero no corrige el salto | Validación con años separados y umbral fijado de antemano |
| Datos y web desincronizados | Contrato de datos fijo (`DATA_CONTRACT.md`) y datos de prueba desde el inicio |
| Acceso a FIRMS | 🔄 Mitigado: CSV anuales por país públicos (verificado). Plan B: descarga del archivo histórico con Earthdata Login |
| Deriva orbital de Aqua (desde dic 2021) | 🔄 Calibrar solo hasta dic 2021; usar S-NPP convertido desde 2022 |
| Mezclar satélites crea saltos nuevos (NOAA-20/21, Terra) | 🔄 Usar solo la pareja Aqua + S-NPP |
| Ausencia de puntos ≠ ausencia de fuego (nubes, cobertura) | Documentar como limitación en `docs/METODO.md` (guía MODIS §7.1.1) |
| Mediana histórica = 0 en zonas con poco fuego | Mostrar también promedio/percentiles; avisar cuando la referencia sea 0 |
| Un solo desarrollador, poco tiempo | Alcance mínimo; agentes de IA con revisión cruzada; resto del equipo en presentación y validación |

## 5. Decisiones

- [x] Fuente de datos: CSV anuales por país de FIRMS
- [x] Satélites: Aqua + S-NPP
- [x] Escala: equivalente MODIS (Aqua)
- [x] Resolución temporal: mensual
- [x] Periodo: 2003–2025; calibración 2012–2021 (sin 16/08–02/09/2020)
- [x] Método: Enfoque A (B y C como plan B)
- [x] CSV descargable: conteos agregados (no puntos crudos)
- [x] Stack web: JS vanilla + Leaflet + ECharts + Turf.js, hosting estático
- [ ] Región: propuesta Bolivia — **[PENDIENTE confirmación]**
- [ ] Tamaño de celda — **[PENDIENTE spike]**
- [ ] Umbral de éxito de la validación — **[PENDIENTE, fijar antes del spike]**
- [ ] Revisar recursos oficiales del reto (13/11) por si exigen otra cosa

## 6. Límites conocidos (fuera de alcance del prototipo)

- S-NPP dejó de entregar datos el 2/11/2026. Extender la serie más allá exigiría enlazar NOAA-20 con S-NPP (traslape 2018–2026).
- Terra (2000–2002) no se incluye; la serie empieza en 2003.
- Los archivos de puntos no traen información de nubes ni de cobertura; los productos Level 2G sí, pero son más complejos (la FAQ de FIRMS los recomienda para análisis cuantitativo).
