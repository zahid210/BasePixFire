# METODO.md — Metodología de Armonización MODIS y VIIRS y Revisión Científica

> Documento requerido por `AGENTS.md` y `ARCHITECTURE.md`. Incluye tanto la especificación del método en lenguaje simple como su **evaluación crítica (Prompt #4 de `PROMPTS.md`)** para que cualquier integrante del equipo pueda defenderlo ante el jurado de NASA Space Apps.

---

## 1. El problema en palabras simples (para el jurado)

Imagina que cuentas incendios desde el espacio con dos cámaras distintas:
- **MODIS (satélite Aqua):** nuestra cámara veterana (desde 2002). Cada píxel mide **1 km × 1 km**. Ve los incendios medianos y grandes, pero los fuegos pequeños (como quemas de pastizales o parcelas agrícolas) muchas veces no calientan lo suficiente un kilómetro cuadrado entero y pasan desapercibidos.
- **VIIRS (satélite Suomi-NPP):** la cámara más moderna (desde 2012). Cada píxel mide **375 m × 375 m** (un área **~7 veces más pequeña** que la de MODIS). Detecta fuegos mucho más pequeños y, cuando ve un incendio grande, dibuja **muchos píxeles** donde MODIS dibujaba uno o dos.

**¿Qué pasa si juntamos ambos registros sin corregirlos?**
En 2012 la gráfica se dispara entre **5 y 7 veces hacia arriba**. Un gestor de emergencias pensaría que los incendios se multiplicaron por siete en 2012, cuando en realidad **solo cambiamos de cámara**.

---

## 2. Nuestro método de armonización en 4 pasos

Para que la serie de **2003 a 2026** hable un solo idioma ("equivalente MODIS Aqua"), aplicamos cuatro filtros de armonización física y estadística:

### Paso 1 — Emparejar la hora del día (Aqua + Suomi-NPP)
El fuego tiene un ciclo diario muy fuerte: arde mucho más a primera hora de la tarde (calor, viento y baja humedad) que por la mañana.
- En vez de mezclar los 5 satélites disponibles (Terra, Aqua, S-NPP, NOAA-20, NOAA-21), que cruzarían el ecuador a distintas horas y crearían saltos cada vez que entra un satélite nuevo (2018, 2024), elegimos la **pareja gemela en órbita**: **MODIS Aqua** y **VIIRS Suomi-NPP**.
- Ambos cruzan el ecuador a la **1:30 p. m. y 1:30 a. m. hora solar local** (hasta diciembre de 2021). Así observan exactamente el mismo estado del fuego.

### Paso 2 — Limpieza de calidad y de fuentes no vegetales (H3)
Aplicamos los criterios de las guías oficiales de usuario de NASA/UMD:
1. **Solo fuego de vegetación (`type == 0`):** eliminamos volcanes activos (`1`), mecheros petroleros e industrias (`2`) y detecciones marinas (`3`).
2. **Filtro de confianza:** en MODIS conservamos confianza nominal y alta (`confidence >= 30`); en VIIRS conservamos nominal y alta (`n`, `h`), descartando la confianza baja (`l`) que en Sudamérica sufre falsas alarmas nocturnas por la Anomalía Magnética del Atlántico Sur (VIIRS User Guide).

### Paso 3 — Grilla común y conteo por "celda-día" (H1)
En vez de contar puntos sueltos:
1. Dividimos la región (Bolivia) en una **grilla común de 0,25° × 0,25° (~27,5 km)**.
2. Para cada celda y cada día, nos hacemos una pregunta binaria por sensor: **¿detectó al menos un fuego hoy en esta celda? (Sí = 1, No = 0)** y sumamos las **celdas-día activas del mes**.
- **Qué resuelve esto de golpe:**
  1. Si un mismo incendio grande genera 15 píxeles en VIIRS (375 m) y 2 píxeles en MODIS (1 km), en nuestra grilla ambos cuentan como **1 celda-día**.
  2. Si un satélite ve el mismo fuego dos veces el mismo día por solapamiento de órbitas contiguas, sigue contando como **1 celda-día**.

### Paso 4 — Calibración estacional en el periodo de traslape limpio (H2)
Incluso contando celdas-día, VIIRS sigue activando más celdas-día que MODIS porque **descubre fuegos pequeños aislados** que MODIS no alcanza a ver.
- Usamos los **10 años en que Aqua y S-NPP volaron juntos con órbita estable (febrero 2012 – diciembre 2021)**, excluyendo agosto y septiembre de 2020 por el apagón de telemetría de Aqua (16 ago – 2 sep 2020, MODIS User Guide §7.2.4).
- Para cada mes del año $m \in \{1..12\}$, calculamos el factor de conversión:
  $$k_m = \frac{\sum \text{Celdas-día Aqua en el mes } m}{\sum \text{Celdas-día S-NPP en el mes } m}$$
  *(Si en un mes lluvioso hay menos de 500 celdas-día acumuladas, se usa el factor anual global para evitar ruido por muestra pequeña).*
- **Construcción de la serie final (2003–2026):**
  - **2003–2021** (salvo ago–sep 2020): usamos **MODIS Aqua** directamente.
  - **Ago–sep 2020** (apagón de Aqua): usamos **S-NPP × $k_m$** para no crear una caída falsa en plena temporada alta.
  - **2022–2026:** como Aqua dejó de hacer maniobras de mantenimiento orbital en diciembre de 2021 y su hora de paso empezó a derivar hacia el final de la tarde (llegando a ~3:50 p. m. en 2026), **a partir de enero de 2022 relevamos a Aqua** y usamos **S-NPP × $k_m$**.

---

## 3. Revisión científica crítica (Prompt #4)

### 3.1 ¿Qué sesgos introduce este método?
1. **Sesgo de compresión en incendios extremos (saturación de la celda-día):**
   - Al resumir una celda de 0,25° (~27 km) a "hubo o no hubo fuego ese día", una celda con 1 quema agrícola pequeña y una celda con 80 focos de un megaincendio valen ambas `1 celda-día`. El método mide **extensión y persistencia temporal de la actividad de quema**, no biomasa total quemada ni intensidad radiativa (FRP).
2. **Supuesto de estacionariedad en la distribución de tamaños de fuego:**
   - El factor $k_m$ asume que la proporción entre fuegos pequeños (solo vistos por VIIRS) y fuegos medianos/grandes (vistos por ambos) en cada mes del año se mantiene similar después de 2021. Si una regulación futura elimina las quemas pequeñas pero deja los grandes incendios forestales, el cociente real cambiaría.
3. **Heterogeneidad espacial dentro del país:**
   - Un factor $k_m$ calculado para toda Bolivia está dominado por los Llanos y la Chiquitanía (donde ocurre >80 % del fuego). En el Altiplano o los valles andinos, donde los fuegos son más pequeños y dispersos, el cociente real entre sensores puede diferir del promedio nacional.

### 3.2 ¿Qué casos borde podrían romperlo y cómo nos protegemos?
1. **Áreas de interés (AOI) diminutas (p. ej. 1 o 2 celdas):**
   - En un AOI muy pequeño los conteos son enteros bajos (0, 1, 2) y multiplicar por $k_m \approx 0.28$ produce decimales con varianza alta.
   - **Mitigación:** la app advierte al usuario cuando el AOI tiene $< 4$ celdas activas y recuerda que los valores decimales representan "celdas-día equivalentes esperadas".
2. **Meses de estación lluviosa con casi cero fuegos:**
   - Si en un mes casi no hay fuego, el cociente $k_m$ sería inestable o dividiría por cero.
   - **Mitigación:** salvaguarda automática de muestra mínima ($\ge 500$ celdas-día en calibración; si no se cumple, aplica el factor anual global).
3. **Datos de 2026 en modo Near Real-Time (NRT):**
   - Los últimos meses de 2026 aún no tienen el reprocesamiento científico estándar (`ML`) que etiqueta volcanes e industrias (`type`).
   - **Mitigación:** se marcan explícitamente como `"snpp_converted_nrt"` (provisionales) en la tabla y en la visualización.
4. **Cobertura de nubes:**
   - Ni los archivos CSV de MODIS ni los de VIIRS reportan qué días estuvo nublado (MODIS User Guide §7.1.1). Un valor `0` significa "0 fuegos detectados en días despejados", no necesariamente ausencia absoluta de fuego bajo las nubes. Trabajar a escala **mensual** reduce drásticamente este problema porque promedia ~30 pasadas diurnas y ~30 nocturnas por mes.

### 3.3 ¿Qué evidencia demuestra que de verdad corrige el salto entre sensores?
Para no caer en una validación circular (calibrar y evaluar con los mismos datos):
1. **Prueba fuera de muestra (Out-of-sample split-half validation):**
   - **Experimento 1:** entrenamos los factores $k_m$ **solo con 2012–2016** y predecimos la serie de Aqua en **2017–2021** usando únicamente S-NPP.
   - **Experimento 2:** entrenamos **solo con 2017–2021** y predecimos **2012–2016**.
2. **Criterio cuantitativo predefinido y resultados reales en Bolivia (grilla 0,25°):**
   - Sin armonizar, S-NPP sobrestima las celdas-día de Aqua en **`+184,6 %`** en promedio (y hasta `+600 %` en conteo de puntos crudos).
   - Exigimos que en el bloque de años **no vistos durante el entrenamiento** el error relativo total caiga dentro de **$\le \pm 15\%$**:
     - **Experimento 1 (entrena 2012–2016 → prueba 2017–2021):** el sesgo pasa de `+177,1 %` (crudo) a **`-6,73 %`** (armonizado), eliminando el **96,2 %** del salto.
     - **Experimento 2 (entrena 2017–2021 → prueba 2012–2016):** el sesgo pasa de `+194,0 %` (crudo) a **`+8,09 %`** (armonizado), eliminando el **95,8 %** del salto.
     - **Validación espacial por macrorregiones (2012–2021):** Chiquitanía y Llanos **`-0,45 %`**, Amazonía y Beni Norte **`-11,56 %`**, Región Andina y Valles **`+14,46 %`** (todas dentro del umbral de $\pm 15\%$).
3. **Prueba visual en la aplicación web:**
   - La app incluye la pestaña de validación con las 3 curvas en 2012–2025: **Aqua real**, **S-NPP crudo** y **S-NPP armonizado**, donde cualquier juez puede verificar visualmente que el salto desaparece en los años de prueba y que en agosto–septiembre de 2020 la serie armonizada repara el hueco del apagón de Aqua.

---

## 4. Guion de 60 segundos para defender el método ante el jurado

> *"MODIS y VIIRS no se pueden sumar directamente porque el píxel de VIIRS es siete veces más pequeño en área y detecta muchos más fuegos pequeños; si los juntamos en crudo, en 2012 aparece un salto falso enorme.*
> *Nosotros lo resolvimos en tres capas físicas antes de ajustar un solo número: primero elegimos **MODIS Aqua y VIIRS Suomi-NPP**, porque ambos pasan exactamente a la **1:30 de la tarde**, eliminando el sesgo por hora del día. Segundo, filtramos fuentes industriales y falsas alarmas de baja confianza según las guías oficiales de NASA. Tercero, pasamos los puntos a una **grilla común de 0,25° y contamos celdas-día con fuego**, de modo que un incendio grande visto como 15 píxeles en VIIRS y 2 en MODIS cuente igual en ambos.*
> *Finalmente, calibramos la diferencia restante por mes del año usando el traslape limpio de **2012 a 2021** —antes de que Aqua empezara a derivar de órbita en 2022— y lo validamos entrenando en una mitad de los años y probando en la otra mitad."*
