# DATA_CONTRACT.md — Contrato de datos (BORRADOR)

> Es el acuerdo entre el equipo de datos (que produce) y el equipo web (que consume). **Una vez acordado el viernes, no se cambia sin avisar a ambos equipos.** Mientras tanto, la web se desarrolla con datos de prueba que respeten este formato.
> Nombres de columnas de FIRMS: **verificar con los recursos oficiales** antes de fijarlos.

## 1. Entrada cruda (referencia)

Hotspots descargados de FIRMS. Campos habituales (a verificar): latitud, longitud, fecha y hora de adquisición, satélite, instrumento (MODIS/VIIRS), confianza, FRP, indicador día/noche.

## 2. Salida del pipeline (lo que consume la web)

### Archivo principal: conteos agregados armonizados

Formato propuesto: CSV (o JSON/Parquet si el equipo lo prefiere) con **una fila por celda de grilla y periodo**.

| Campo | Tipo | Descripción |
|---|---|---|
| `cell_id` | texto | Identificador de la celda de grilla |
| `lat` | número | Latitud del centro de la celda |
| `lon` | número | Longitud del centro de la celda |
| `year` | entero | Año |
| `month` | entero (1–12) | Mes |
| `count_harmonized` | número | Conteo armonizado de actividad de quema (comparable entre sensores) |
| `count_raw_modis` | entero | Conteo crudo de MODIS (opcional, para transparencia) |
| `count_raw_viirs` | entero | Conteo crudo de VIIRS (opcional, para transparencia) |

**[DECIDIR]** si la resolución temporal es mensual o diaria, y el tamaño de celda.

### Archivo de metadatos

```json
{
  "region": "[PENDIENTE]",
  "bbox": [0, 0, 0, 0],
  "cell_size": "[PENDIENTE]",
  "temporal_resolution": "monthly",
  "date_range": ["YYYY-MM", "YYYY-MM"],
  "method": "Ver docs/METODO.md",
  "generated_on": "YYYY-MM-DD"
}
```

### Archivo de referencia histórica (opcional, acelera la app)

Mediana histórica por celda y mes para calcular anomalías sin recalcular en el navegador:

| Campo | Descripción |
|---|---|
| `cell_id` | Celda |
| `month` | Mes (1–12) |
| `median_hist` | Mediana histórica de `count_harmonized` para ese mes |

## 3. Datos de prueba (para que la web arranque ya)

El equipo de datos entrega cuanto antes un archivo pequeño (una región chica, pocos años) con este formato, aunque los valores aún no estén armonizados. La web se construye contra eso.

## 4. Reglas

- Los nombres de campos y tipos de arriba no cambian sin aviso.
- Valores faltantes: usar `0` para "sin detección" y reservar vacío para "sin dato".
- Fechas siempre numéricas (`year`, `month`), sin formatos de texto ambiguos.
- Tamaño objetivo de los archivos para la web: lo bastante pequeños para cargar rápido en un navegador. **[DECIDIR]** el límite.
