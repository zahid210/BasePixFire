# ARCHITECTURE.md — Arquitectura (BORRADOR)

> **Estado: borrador.** Se escribió antes de ver los recursos oficiales (publicados el 13/11) y antes de probar la armonización con datos reales. Las decisiones marcadas **[DECIDIR]** se validan el viernes tras el spike de datos. Un agente de IA debe proponer mejoras y preguntar, no tratar esto como definitivo.

## 1. Visión general

Dos bloques que se comunican **solo a través de archivos de datos** definidos en `DATA_CONTRACT.md`:

```
[FIRMS: MODIS + VIIRS]
        │  (descarga)
        ▼
[Pipeline de datos / armonización]  → genera archivos agregados
        │  (JSON/CSV/Parquet estáticos)
        ▼
[Aplicación web]  → mapa + selección de área + calendario + anomalías + descarga CSV
```

Idea clave: **el pipeline hace el trabajo pesado una vez** y la web solo lee datos ya agregados. Procesar millones de puntos en el navegador sería lento e inviable.

## 2. Bloque A — Pipeline de datos y armonización

Responsables: equipo de datos.

Pasos previstos:
1. Descargar hotspots de MODIS y VIIRS para la(s) región(es) de trabajo. **[DECIDIR]** alcance geográfico (un país, una región, varias zonas de prueba) según volumen y tiempo.
2. Limpiar y unificar columnas (fecha, hora, coordenadas, sensor, confianza, FRP, día/noche).
3. **Armonizar.** Hipótesis a evaluar (no decididas):
   - **H1. Agregar a una grilla común y contar celdas-día con detección** en vez de puntos crudos. Reduce el efecto de que VIIRS (375 m) genere más puntos que MODIS (1 km) por el mismo fuego.
   - **H2. Factor de calibración con el periodo de traslape** (años con ambos sensores): comparar conteos mensuales por zona y escalar la serie de MODIS al "equivalente VIIRS" (o al revés).
   - **H3. Filtros de calidad** consistentes (nivel de confianza, tipo de píxel) aplicados a ambos sensores.
   - Lo más probable: combinar H1 + H2 (+ H3). **[DECIDIR]** tras el spike.
4. **Validar:** comprobar que el salto de conteos al aparecer VIIRS desaparece tras la armonización; registrar el resultado.
5. Exportar archivos agregados según `DATA_CONTRACT.md`.
6. Documentar el método y sus límites en `docs/METODO.md`.

## 3. Bloque B — Aplicación web

Responsables: desarrollo web.

Componentes:
- **Mapa** con selección de área de interés (dibujar polígono/rectángulo; opcional: entrada por lat/lon).
- **Calendario de actividad:** mapa de calor mes × año (o día del año × año) con rampa de color accesible.
- **Comparación histórica:** mes actual vs. mediana histórica del área; anomalías.
- **Filtros:** rango de fechas.
- **Exportación:** descarga de CSV de lo consultado.

Stack propuesto **[DECIDIR]**:
- Vanilla JS o un framework ligero (el que el equipo domine).
- Mapa: Leaflet o MapLibre + herramienta de dibujo.
- Gráficos: D3 o ECharts.
- Cálculo geoespacial en cliente (puntos/celdas dentro del polígono): Turf.js.
- Hosting estático: GitHub Pages o Vercel.

Flujo en la app: el usuario dibuja un área → la app suma las celdas agregadas que caen dentro → muestra calendario y estadísticas → permite descargar CSV.

## 4. Riesgos conocidos

| Riesgo | Mitigación |
|---|---|
| Volumen de datos demasiado grande | Limitar región; agregar en el pipeline; servir archivos estáticos pequeños |
| Armonización que "suena bien" pero no corrige el salto | Validar siempre contra el periodo de traslape y documentar |
| Datos y web desincronizados | Contrato de datos fijo (`DATA_CONTRACT.md`) y datos de prueba desde el inicio |
| Límites/claves de acceso a FIRMS |
| Equipo sin experiencia | Revisión cruzada entre modelos

## 5. Decisiones abiertas

- [ ] Región(es) de trabajo
- [ ] Método de armonización final (H1/H2/H3)
- [ ] Resolución temporal de los agregados (diaria / mensual)
- [ ] Tamaño de celda de la grilla
- [ ] Stack web definitivo
- [ ] ¿CSV de hotspots crudos o de conteos agregados? (depende de lo que permitan los recursos)
