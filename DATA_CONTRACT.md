# DATA_CONTRACT.md — Contrato de datos (BORRADOR v2)

> Es el acuerdo entre el pipeline (que produce) y la web (que consume). **Una vez acordado, no se cambia sin avisar.** Mientras tanto, la web se desarrolla con datos de prueba que respeten este formato.
> **🔄 CAMBIO** marca lo que cambió respecto al v1 y por qué. Los nombres de columnas de entrada ya están **verificados en archivos reales de FIRMS** (13/11/2026).

## 1. Entrada cruda 🔄 CAMBIO (verificada)

Fuente: CSV anuales por país de FIRMS (públicos, calidad estándar, no NRT).

**MODIS** (`modis_<AÑO>_<País>.csv`):
`latitude, longitude, brightness, scan, track, acq_date, acq_time, satellite, instrument, confidence, version, bright_t31, frp, daynight, type`

**VIIRS S-NPP** (`viirs-snpp_<AÑO>_<País>.csv`):
`latitude, longitude, bright_ti4, scan, track, acq_date, acq_time, satellite, instrument, confidence, version, bright_ti5, frp, daynight, type`

Detalles comprobados (difieren de parte de la documentación):

| Campo | MODIS | VIIRS S-NPP |
|---|---|---|
| `satellite` | `Aqua` / `Terra` (palabra completa) | `N` |
| `confidence` | entero 0–100 | `l` / `n` / `h` (minúsculas) |
| `acq_date` | `YYYY-MM-DD` | `YYYY-MM-DD` |
| `acq_time` | HHMM en **UTC** | HHMM en **UTC** |
| `type` | 0 vegetación, 1 volcán, 2 estática, 3 offshore | igual |
| `version` | varía por año (6.2 / 6.03 / 61.03) | `2` |

Filtros que aplica el pipeline: `type == 0`; MODIS `satellite == "Aqua"` y `confidence >= 30`; VIIRS `confidence in {n, h}`.

**Nota sobre fechas:** el mes se asigna por `acq_date` en UTC. En Bolivia (UTC−4) las pasadas nominales de Aqua/S-NPP (~13:30 y ~01:30 hora local) equivalen a ~17:30 y ~05:30 UTC del **mismo día**, así que la fecha UTC coincide con la local. Las pasadas alejadas del nadir pueden variar algo de hora, pero el efecto en totales **mensuales** es despreciable. Se documenta en `docs/METODO.md`.

## 2. Salida del pipeline (lo que consume la web)

### 2.1 Archivo principal: `monthly_cells.csv`

**Una fila por celda y mes**, solo para celdas-mes con al menos una detección de algún sensor (archivo disperso; ver reglas de faltantes en §4).

| Campo | Tipo | Descripción |
|---|---|---|
| `cell_id` | texto | 🔄 Regla: `"<fila>_<col>"` con `fila = floor((lat + 90) / cell_size)` y `col = floor((lon + 180) / cell_size)` |
| `lat` | número | Latitud del centro de la celda |
| `lon` | número | Longitud del centro de la celda |
| `year` | entero | Año (2003–2025) |
| `month` | entero (1–12) | Mes |
| `count_harmonized` | número (decimal, 2 decimales) | 🔄 **Celdas-día con fuego en equivalente Aqua.** 2003–2021 = valor Aqua; 2022–2025 = S-NPP × factor del mes. Es decimal porque proviene de un factor; se lee como "celdas-día equivalentes" |
| `count_raw_aqua` | entero o vacío | 🔄 (antes `count_raw_modis`) Celdas-día con detección Aqua. Vacío si no hay dato del sensor |
| `count_raw_snpp` | entero o vacío | 🔄 (antes `count_raw_viirs`) Celdas-día con detección S-NPP. **Vacío antes de 2012** (el sensor no existía) |
| `source` | texto | 🔄 Nuevo: `aqua` o `snpp_converted`, según qué alimentó `count_harmonized` |

🔄 Unidad: **celdas-día**, no puntos. Por qué: un mismo fuego genera más puntos VIIRS que MODIS; contar "¿hubo fuego en esta celda este día?" reduce ese efecto (H1).

**[PENDIENTE spike]** `cell_size` (candidatos 0,1° y 0,25°).

### 2.2 Archivo de metadatos: `metadata.json`

```json
{
  "region": "Bolivia [PENDIENTE confirmación]",
  "bbox": [0, 0, 0, 0],
  "cell_size_deg": "[PENDIENTE spike]",
  "temporal_resolution": "monthly",
  "date_range": ["2003-01", "2025-12"],
  "unit": "cell-days with fire (Aqua-equivalent)",
  "sensors": {"reference": "MODIS Aqua", "converted": "VIIRS S-NPP 375 m"},
  "calibration_period": ["2012-01", "2021-12"],
  "calibration_excluded": ["2020-08-16/2020-09-02"],
  "harmonized_source_switch": "2022-01",
  "factors_by_month": {"1": null, "2": null, "...": null, "12": null},
  "filters": {"type": [0], "modis_confidence_min": 30, "viirs_confidence": ["n", "h"]},
  "data_source": "NASA FIRMS country yearly CSV (standard quality)",
  "method": "Ver docs/METODO.md",
  "generated_on": "YYYY-MM-DD"
}
```

🔄 Se agregan `unit`, `sensors`, periodo de calibración, factores y filtros para que la web pueda **mostrar el método** (transparencia ante el jurado).

### 2.3 Archivo de validación: `validation.csv` 🔄 Nuevo

Serie mensual **de toda la región** para el gráfico antes/después.

| Campo | Descripción |
|---|---|
| `year`, `month` | Periodo (2012–2025) |
| `aqua` | Celdas-día Aqua (región completa) |
| `snpp_raw` | Celdas-día S-NPP sin convertir |
| `snpp_converted` | S-NPP × factor del mes |
| `split` | `calibration`, `validation`, `drift` (2022+) o `excluded` |

### 2.4 Referencia histórica 🔄 CAMBIO

Se **elimina** el archivo opcional `median_hist` por celda: la mediana del área seleccionada no se puede obtener sumando medianas de celdas. La web calcula la referencia histórica (mediana, promedio y percentiles) sobre el **total del área seleccionada**, a partir de `monthly_cells.csv` (son ≤ 276 valores por área).

## 3. Datos de prueba (para que la web arranque ya)

El pipeline entrega cuanto antes `monthly_cells.csv` + `metadata.json` con este formato para una zona pequeña y pocos años, aunque los valores aún no estén armonizados. La web se construye contra eso.

## 4. Reglas

- Los nombres de campos y tipos de arriba no cambian sin aviso.
- 🔄 Faltantes: en `monthly_cells.csv`, **una celda-mes ausente significa 0 detecciones** (archivo disperso). Dentro de una fila, **vacío = sin dato del sensor** (p. ej. S-NPP antes de 2012) y `0` = el sensor operaba y no detectó.
- Fechas siempre numéricas (`year`, `month`).
- 🔄 Tamaño objetivo: `monthly_cells.csv` ≤ ~5 MB sin comprimir (GitHub Pages lo sirve comprimido). Si se excede, aumentar `cell_size` o dividir por década. **[Revisar tras el spike]**
