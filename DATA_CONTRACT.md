# DATA_CONTRACT.md — Contrato de datos (DEFINITIVO v3)

> Acuerdo fijo entre el pipeline de datos (`scripts/`) y la aplicación web (`web/`). **No cambiar nombres de columnas ni tipos sin actualizar ambos bloques.**

## 1. Entrada cruda (`data/raw/`)

### 1.1 Histórico 2003–2025 (CSV anuales públicos por país de FIRMS)
- **MODIS (`modis_<AÑO>_Bolivia.csv`, 2003–2025):**
  `latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight,type`
- **VIIRS S-NPP (`viirs-snpp_<AÑO>_Bolivia.csv`, 2012–2025):**
  `latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight,type`

### 1.2 Extensión 2026 (FIRMS Archive Download, cuenta Earthdata)
Archivos CSV descargados del formulario con **Country = Bolivia, Buffer = 0 km, Dates = 2026-01-01 a 2026-10-31, Format = CSV**.
- Nota importante: para los meses de 2026 que aún estén en procesamiento NRT (`version` con sufijo `NRT`), FIRMS **no incluye la columna `type`**. El pipeline debe verificar si la columna `type` existe: si existe, filtra `type == 0`; si no existe (NRT), aplica los filtros de satélite y confianza y marca `source = "snpp_converted_nrt"`.

### 1.3 Reglas de filtrado de entrada
- **MODIS:** `satellite == "Aqua"`, `int(confidence) >= 30`, y (si existe `type`) `int(type) == 0`.
- **VIIRS S-NPP:** `confidence.lower() in {"n", "h", "nominal", "high"}`, y (si existe `type`) `int(type) == 0`.

---

## 2. Salida del pipeline (`data/processed/`)

### 2.1 Archivo principal: `monthly_cells.csv`

Una fila por celda y mes con al menos una detección en cualquiera de los dos sensores. Para mantener el archivo por debajo de **5 MB sin comprimir**, no se repiten `lat`/`lon` en cada fila (la web calcula el centro de la celda a partir de `cell_id` y `cell_size_deg`).

| Campo | Tipo | Descripción |
|---|---|---|
| `cell_id` | texto | `"<row>_<col>"` donde `row = floor((lat + 90) / cell_size_deg)` y `col = floor((lon + 180) / cell_size_deg)`. El centro es `lat = (row + 0.5) * cell_size_deg - 90`, `lon = (col + 0.5) * cell_size_deg - 180` |
| `year` | entero | Año (`2003` a `2026`) |
| `month` | entero | Mes (`1` a `12`) |
| `count_harmonized` | decimal (hasta 4 dec) | **Celdas-día con fuego en equivalente Aqua.** Entero cuando proviene de Aqua; decimal redondeado a 4 decimales cuando proviene de S-NPP × `factor[month]` para preservar linealidad exacta al sumar celdas |
| `count_raw_aqua` | entero o vacío | Celdas-día con detección Aqua en ese mes. Vacío (`""`) si Aqua no tiene cobertura válida |
| `count_raw_snpp` | entero o vacío | Celdas-día con detección S-NPP en ese mes. **Vacío (`""`) antes de 2012-01** y después de 2026-10 |
| `source` | texto | `"aqua"`, `"snpp_converted"` o `"snpp_converted_nrt"` |

### 2.2 Archivo de validación regional: `validation.csv`

Serie mensual agregada de toda la región (2003–2026) para graficar la serie completa y la validación del traslape en la web sin recorrer todas las celdas:

| Campo | Tipo | Descripción |
|---|---|---|
| `year` | entero | Año (`2003` a `2026`) |
| `month` | entero | Mes (`1` a `12`) |
| `harmonized` | decimal (1 dec) | Suma regional de `count_harmonized` |
| `aqua` | entero o vacío | Suma regional de celdas-día Aqua |
| `snpp_raw` | entero o vacío | Suma regional de celdas-día S-NPP sin escalar |
| `snpp_converted` | decimal o vacío | `snpp_raw * factor[month]` (calculado en todos los meses desde 2012 para comparar contra `aqua`) |
| `split` | texto | `"pre_viirs"` (2003–2011), `"partial_start"` (2012-01), `"calibration_a"` (2012-02 a 2016-12), `"calibration_b"` (2017-01 a 2021-12 sin apagón), `"excluded_outage"` (2020-08 y 2020-09), `"drift"` (2022–2025), `"provisional_2026"` (2026) |

### 2.3 Archivo de metadatos: `metadata.json`

```json
{
  "region": "Bolivia",
  "bbox": [-69.65, -22.90, -57.45, -9.68],
  "cell_size_deg": 0.25,
  "temporal_resolution": "monthly",
  "date_range": ["2003-01", "2025-12"],
  "provisional_range": ["2026-01", "2026-10"],
  "baseline_years": [2003, 2025],
  "unit": "celdas-día con fuego (equivalente MODIS Aqua)",
  "sensors": {
    "reference": "MODIS Aqua (MYD14 / MCD14ML)",
    "converted": "VIIRS Suomi-NPP 375 m (VNP14IMGML)"
  },
  "sensor_coverage": {
    "aqua": ["2003-01", "2025-12"],
    "snpp": ["2012-02", "2026-10"]
  },
  "calibration_period": ["2012-02", "2021-12"],
  "excluded_months": ["2012-01", "2020-08", "2020-09"],
  "harmonized_source_switch": "2022-01",
  "factors_by_month": {
    "1": 0.0, "2": 0.0, "3": 0.0, "4": 0.0, "5": 0.0, "6": 0.0,
    "7": 0.0, "8": 0.0, "9": 0.0, "10": 0.0, "11": 0.0, "12": 0.0
  },
  "factor_annual_fallback": 0.0,
  "validation_metrics": {
    "threshold_pct": 15.0,
    "train_2012_2016_test_2017_2021": {
      "raw_bias_pct": 0.0,
      "harmonized_bias_pct": 0.0,
      "mae_monthly": 0.0
    },
    "train_2017_2021_test_2012_2016": {
      "raw_bias_pct": 0.0,
      "harmonized_bias_pct": 0.0,
      "mae_monthly": 0.0
    },
    "subregions_2012_2021": {
      "chiquitania_llanos": {"harmonized_bias_pct": 0.0},
      "amazonia_beni_norte": {"harmonized_bias_pct": 0.0},
      "andina_valles": {"harmonized_bias_pct": 0.0}
    }
  },
  "filters": {
    "type": [0],
    "modis_satellite": "Aqua",
    "modis_confidence_min": 30,
    "viirs_confidence": ["n", "h"]
  },
  "generated_on": "2026-11-13"
}
```

## 3. Reglas de interpretación en la web

1. **Celdas ausentes:** dentro del rango válido de un sensor (`sensor_coverage`), una celda-mes que no aparece en `monthly_cells.csv` vale `0`. Fuera de `sensor_coverage` (p. ej. S-NPP antes de 2012), vale `null` (sin dato).
2. **Cálculo de la mediana histórica del AOI:**
   - Para el conjunto de celdas seleccionadas por el usuario y cada mes $m \in \{1..12\}$, primero se **suma** `count_harmonized` sobre las celdas seleccionadas para cada año base $y \in [2003, 2025]$, obteniendo $S_{y,m}$ (si en un año ninguna celda seleccionada tuvo fuego en el mes $m$, $S_{y,m} = 0$).
   - Luego se calcula la **mediana**, el **promedio** y el **percentil 75** de $\{S_{2003,m}, \dots, S_{2025,m}\}$.
3. **Aviso de muestra baja / borde:** si el AOI seleccionado contiene $< 4$ celdas activas históricas o se extiende fuera de `bbox`, la interfaz muestra una advertencia de mayor incertidumbre.
