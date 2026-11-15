#!/usr/bin/env python3
"""
Pipeline de armonización de focos de calor MODIS (Aqua) y VIIRS (Suomi-NPP).

Lee los CSV crudos de data/raw/ (2003-2025 anuales + 2026 Archive/NRT),
aplica filtros oficiales de calidad (H3), agrega a celdas-día en grilla común (H1),
calibra factores estacionales en el periodo de traslape limpio 2012-2021 (H2),
ejecuta validación cruzada fuera de muestra y por subregiones, y exporta:
  - data/processed/monthly_cells.csv
  - data/processed/validation.csv
  - data/processed/metadata.json
  - data/processed/data_bundle.js

Grillas más finas (mismo método, calibrado y validado a esa escala):
  python scripts/build_dataset.py --cell-size 0.10 --out-dir data/processed/grid_0.10
  python scripts/build_dataset.py --cell-size 0.05 --out-dir data/processed/grid_0.05
"""

import argparse
import csv
import glob
import json
import math
import zipfile
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Dict, Iterable, List, Set, Tuple

ROOT_DIR = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT_DIR / "data" / "raw"
OUT_DIR = ROOT_DIR / "data" / "processed"

# Meses excluidos de la calibración (inicio parcial ene 2012 y apagón de Aqua ago-sep 2020)
EXCLUDED_CALIB_YM = {(2012, 1), (2020, 8), (2020, 9)}
OUTAGE_YM = {(2020, 8), (2020, 9)}
MIN_CALIB_AQUA_SAMPLES = 500


def latlon_to_cell(lat: float, lon: float, cell_size: float) -> Tuple[int, int]:
    """Convierte latitud/longitud al índice entero (row, col) de la grilla."""
    row = math.floor((lat + 90.0) / cell_size)
    col = math.floor((lon + 180.0) / cell_size)
    return row, col


def cell_to_center(row: int, col: int, cell_size: float) -> Tuple[float, float]:
    """Devuelve (lat, lon) del centro de una celda (row, col)."""
    lat = (row + 0.5) * cell_size - 90.0
    lon = (col + 0.5) * cell_size - 180.0
    return lat, lon


def classify_subregion(lat: float, lon: float) -> str:
    """Clasifica una celda en una de las 3 macrorregiones de Bolivia para validación espacial."""
    if lon <= -64.0 and lat < -14.0:
        return "andina_valles"
    if lat >= -14.0:
        return "amazonia_beni_norte"
    return "chiquitania_llanos"


def iter_modis_files(country: str, years: Set[int], include_2026: bool) -> List[Tuple[Path, bool]]:
    """Lista los archivos de MODIS a procesar: (ruta, es_nrt)."""
    files: List[Tuple[Path, bool]] = []
    for y in sorted(years):
        p = RAW_DIR / "modis" / f"modis_{y}_{country}.csv"
        if p.exists():
            files.append((p, False))
    if include_2026:
        for p_str in sorted(glob.glob(str(RAW_DIR / "2026" / "*M-C61*.csv"))):
            p = Path(p_str)
            files.append((p, "nrt" in p.name.lower()))
    return files


def iter_snpp_files(country: str, years: Set[int], include_2026: bool) -> List[Tuple[Path, bool]]:
    """Lista los archivos de VIIRS S-NPP a procesar: (ruta, es_nrt)."""
    files: List[Tuple[Path, bool]] = []
    for y in sorted(years):
        if y < 2012:
            continue
        p = RAW_DIR / "viirs-snpp" / f"viirs-snpp_{y}_{country}.csv"
        if p.exists():
            files.append((p, False))
    if include_2026:
        for p_str in sorted(glob.glob(str(RAW_DIR / "2026" / "*SV-C2*.csv"))):
            p = Path(p_str)
            files.append((p, "nrt" in p.name.lower()))
    return files


def collect_cell_days(
    files: Iterable[Tuple[Path, bool]],
    sensor_type: str,
    cell_size: float,
    allowed_years: Set[int],
) -> Tuple[Dict[Tuple[int, int, int, int], int], Set[Tuple[int, int]], List[float]]:
    """
    Lee archivos CSV de un sensor, filtra según H3 y devuelve:
      - conteo mensual de celdas-día por (row, col, year, month)
      - conjunto de (year, month) que provienen de archivos NRT
      - bbox [min_lon, min_lat, max_lon, max_lat]
    """
    # Conjunto de días únicos con detección por (row, col, year, month)
    active_days: Dict[Tuple[int, int, int, int], Set[int]] = defaultdict(set)
    nrt_ym: Set[Tuple[int, int]] = set()
    bbox = [180.0, 90.0, -180.0, -90.0]

    for path, is_nrt in files:
        with open(path, "r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            has_type = reader.fieldnames is not None and "type" in reader.fieldnames

            for r in reader:
                if has_type and r.get("type", "") != "0":
                    continue

                if sensor_type == "aqua":
                    if r.get("satellite") != "Aqua":
                        continue
                    try:
                        if int(float(r.get("confidence", "0"))) < 30:
                            continue
                    except ValueError:
                        continue
                else:
                    conf = r.get("confidence", "").strip().lower()
                    if conf not in ("n", "h", "nominal", "high"):
                        continue

                acq_date = r.get("acq_date", "")
                if len(acq_date) < 10:
                    continue
                year = int(acq_date[0:4])
                if year not in allowed_years:
                    continue
                month = int(acq_date[5:7])
                day = int(acq_date[8:10])

                lat = float(r["latitude"])
                lon = float(r["longitude"])
                if lon < bbox[0]:
                    bbox[0] = lon
                if lat < bbox[1]:
                    bbox[1] = lat
                if lon > bbox[2]:
                    bbox[2] = lon
                if lat > bbox[3]:
                    bbox[3] = lat

                row, col = latlon_to_cell(lat, lon, cell_size)
                active_days[(row, col, year, month)].add(day)
                if is_nrt or not has_type:
                    nrt_ym.add((year, month))

    monthly_counts = {k: len(days) for k, days in active_days.items()}
    return monthly_counts, nrt_ym, bbox


def compute_factors(
    aqua_ym_totals: Dict[Tuple[int, int], int],
    snpp_ym_totals: Dict[Tuple[int, int], int],
    train_years: Set[int],
) -> Tuple[Dict[int, float], float]:
    """Calcula los factores mensuales k_m = Σ Aqua / Σ S-NPP en los años de entrenamiento."""
    aqua_by_m = defaultdict(int)
    snpp_by_m = defaultdict(int)

    for (y, m), val in aqua_ym_totals.items():
        if y in train_years and (y, m) not in EXCLUDED_CALIB_YM:
            aqua_by_m[m] += val
    for (y, m), val in snpp_ym_totals.items():
        if y in train_years and (y, m) not in EXCLUDED_CALIB_YM:
            snpp_by_m[m] += val

    total_aqua = sum(aqua_by_m.values())
    total_snpp = sum(snpp_by_m.values())
    annual_fallback = total_aqua / total_snpp if total_snpp > 0 else 1.0

    factors: Dict[int, float] = {}
    for m in range(1, 13):
        if aqua_by_m[m] >= MIN_CALIB_AQUA_SAMPLES and snpp_by_m[m] > 0:
            factors[m] = aqua_by_m[m] / snpp_by_m[m]
        elif snpp_by_m[m] > 0 and total_aqua < MIN_CALIB_AQUA_SAMPLES * 2:
            # Modo muestra pequeña (spike de pocos años): usar cociente directo del mes si existe
            factors[m] = aqua_by_m[m] / snpp_by_m[m] if aqua_by_m[m] > 0 else annual_fallback
        else:
            factors[m] = annual_fallback

    return factors, annual_fallback


def evaluate_split(
    aqua_ym_totals: Dict[Tuple[int, int], int],
    snpp_ym_totals: Dict[Tuple[int, int], int],
    factors: Dict[int, float],
    test_years: Set[int],
) -> Dict[str, float]:
    """Evalúa el sesgo relativo crudo y armonizado y el MAE mensual en test_years."""
    sum_aqua = 0.0
    sum_snpp_raw = 0.0
    sum_snpp_conv = 0.0
    abs_errors: List[float] = []

    for y in sorted(test_years):
        for m in range(1, 13):
            if (y, m) in EXCLUDED_CALIB_YM:
                continue
            a = float(aqua_ym_totals.get((y, m), 0))
            s = float(snpp_ym_totals.get((y, m), 0))
            if a == 0 and s == 0:
                continue
            s_conv = s * factors[m]
            sum_aqua += a
            sum_snpp_raw += s
            sum_snpp_conv += s_conv
            abs_errors.append(abs(s_conv - a))

    raw_bias_pct = ((sum_snpp_raw - sum_aqua) / sum_aqua * 100.0) if sum_aqua > 0 else 0.0
    harm_bias_pct = ((sum_snpp_conv - sum_aqua) / sum_aqua * 100.0) if sum_aqua > 0 else 0.0
    mae_monthly = (sum(abs_errors) / len(abs_errors)) if abs_errors else 0.0

    return {
        "aqua_total": round(sum_aqua, 1),
        "snpp_raw_total": round(sum_snpp_raw, 1),
        "snpp_harmonized_total": round(sum_snpp_conv, 1),
        "raw_bias_pct": round(raw_bias_pct, 2),
        "harmonized_bias_pct": round(harm_bias_pct, 2),
        "mae_monthly": round(mae_monthly, 1),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Construye dataset armonizado MODIS+VIIRS.")
    parser.add_argument("--country", default="Bolivia", help="País (default: Bolivia)")
    parser.add_argument("--cell-size", type=float, default=0.25, help="Tamaño de celda en grados (default: 0.25)")
    parser.add_argument("--start-year", type=int, default=2003, help="Año inicial (default: 2003)")
    parser.add_argument("--end-year", type=int, default=2025, help="Año final estándar (default: 2025)")
    parser.add_argument("--include-2026", action="store_true", default=True, help="Incluir datos 2026 si existen")
    parser.add_argument("--out-dir", type=Path, default=OUT_DIR, help="Directorio de salida")
    args = parser.parse_args()

    allowed_years = set(range(args.start_year, args.end_year + 1))
    # 2026 solo se incluye si existen sus CSV (o sus ZIP originales de Archive Download):
    # si están los ZIP pero aún no se extrajeron los CSV, los descomprimimos automáticamente.
    dir_2026 = RAW_DIR / "2026"
    if args.include_2026 and dir_2026.exists() and not any(dir_2026.glob("*.csv")):
        for zpath in sorted(dir_2026.glob("*.zip")):
            with zipfile.ZipFile(zpath, "r") as zf:
                zf.extractall(dir_2026)
    has_2026_files = any(dir_2026.glob("*.csv")) if dir_2026.exists() else False
    if args.include_2026 and not has_2026_files:
        print("AVISO: no hay CSV de 2026 en data/raw/2026/; el dataset llegará hasta", args.end_year)
    args.include_2026 = args.include_2026 and has_2026_files
    if args.include_2026:
        allowed_years.add(2026)

    modis_files = iter_modis_files(args.country, allowed_years, args.include_2026)
    snpp_files = iter_snpp_files(args.country, allowed_years, args.include_2026)

    print(f"Procesando {len(modis_files)} archivos MODIS y {len(snpp_files)} archivos S-NPP (cell_size={args.cell_size}°)...")
    aqua_counts, _, bbox_a = collect_cell_days(modis_files, "aqua", args.cell_size, allowed_years)
    snpp_counts, snpp_nrt_ym, bbox_s = collect_cell_days(snpp_files, "snpp", args.cell_size, allowed_years)

    bbox = [
        round(min(bbox_a[0], bbox_s[0]), 4),
        round(min(bbox_a[1], bbox_s[1]), 4),
        round(max(bbox_a[2], bbox_s[2]), 4),
        round(max(bbox_a[3], bbox_s[3]), 4),
    ]

    # Totales regionales por (year, month)
    aqua_ym: Dict[Tuple[int, int], int] = defaultdict(int)
    snpp_ym: Dict[Tuple[int, int], int] = defaultdict(int)
    for (r, c, y, m), v in aqua_counts.items():
        aqua_ym[(y, m)] += v
    for (r, c, y, m), v in snpp_counts.items():
        snpp_ym[(y, m)] += v

    # Validación cruzada en dos mitades (2012-2016 vs 2017-2021)
    years_a = {2012, 2013, 2014, 2015, 2016} & allowed_years
    years_b = {2017, 2018, 2019, 2020, 2021} & allowed_years
    all_calib_years = (years_a | years_b)

    factors_a, _ = compute_factors(aqua_ym, snpp_ym, years_a)
    eval_a_on_b = evaluate_split(aqua_ym, snpp_ym, factors_a, years_b)

    factors_b, _ = compute_factors(aqua_ym, snpp_ym, years_b)
    eval_b_on_a = evaluate_split(aqua_ym, snpp_ym, factors_b, years_a)

    # Factores finales sobre todo el periodo limpio 2012-2021
    final_factors, annual_fallback = compute_factors(aqua_ym, snpp_ym, all_calib_years)
    eval_full = evaluate_split(aqua_ym, snpp_ym, final_factors, all_calib_years)

    # Validación por subregiones en 2012-2021
    sub_aqua: Dict[str, Dict[Tuple[int, int], int]] = defaultdict(lambda: defaultdict(int))
    sub_snpp: Dict[str, Dict[Tuple[int, int], int]] = defaultdict(lambda: defaultdict(int))
    for (r, c, y, m), v in aqua_counts.items():
        if y in all_calib_years:
            lat, lon = cell_to_center(r, c, args.cell_size)
            sub_aqua[classify_subregion(lat, lon)][(y, m)] += v
    for (r, c, y, m), v in snpp_counts.items():
        if y in all_calib_years:
            lat, lon = cell_to_center(r, c, args.cell_size)
            sub_snpp[classify_subregion(lat, lon)][(y, m)] += v

    subregion_metrics = {}
    for sub_name in ("chiquitania_llanos", "amazonia_beni_norte", "andina_valles"):
        subregion_metrics[sub_name] = evaluate_split(
            sub_aqua[sub_name], sub_snpp[sub_name], final_factors, all_calib_years
        )

    # Construir monthly_cells.csv
    args.out_dir.mkdir(parents=True, exist_ok=True)
    all_keys = sorted(set(aqua_counts.keys()) | set(snpp_counts.keys()), key=lambda x: (x[2], x[3], x[0], x[1]))

    harm_ym: Dict[Tuple[int, int], float] = defaultdict(float)
    cells_csv_path = args.out_dir / "monthly_cells.csv"

    with open(cells_csv_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow([
            "cell_id", "year", "month", "count_harmonized",
            "count_raw_aqua", "count_raw_snpp", "source"
        ])

        for r, c, y, m in all_keys:
            a_val = aqua_counts.get((r, c, y, m), 0)
            s_val = snpp_counts.get((r, c, y, m), 0)

            # Determinar fuente y valor armonizado según reglas de ARCHITECTURE.md v3
            if y < 2012:
                source = "aqua"
                harm = float(a_val)
                a_str = str(a_val)
                s_str = ""
            elif (y, m) in OUTAGE_YM or y >= 2022:
                is_nrt = (y, m) in snpp_nrt_ym
                source = "snpp_converted_nrt" if is_nrt else "snpp_converted"
                harm = round(s_val * final_factors[m], 4)
                a_str = "" if (y >= 2026 and m > 10) else str(a_val)
                s_str = str(s_val)
            else:
                source = "aqua"
                harm = float(a_val)
                a_str = str(a_val)
                s_str = str(s_val)

            if harm == 0.0 and a_val == 0 and s_val == 0:
                continue

            harm_str = f"{int(harm)}" if harm.is_integer() else f"{harm:.4f}".rstrip("0").rstrip(".")
            writer.writerow([f"{r}_{c}", y, m, harm_str, a_str, s_str, source])
            harm_ym[(y, m)] += harm

    # Construir validation.csv
    val_csv_path = args.out_dir / "validation.csv"
    max_year = max(y for (_, _, y, _) in all_keys) if all_keys else args.end_year
    with open(val_csv_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow(["year", "month", "harmonized", "aqua", "snpp_raw", "snpp_converted", "split"])
        for y in range(args.start_year, max_year + 1):
            for m in range(1, 13):
                if y == 2026 and m > 10:
                    continue
                a_tot = aqua_ym.get((y, m), 0)
                s_tot = snpp_ym.get((y, m), 0)
                h_tot = round(harm_ym.get((y, m), 0.0), 1)

                if y < 2012:
                    split = "pre_viirs"
                    s_raw_str = ""
                    s_conv_str = ""
                else:
                    s_raw_str = str(s_tot)
                    s_conv_str = f"{round(s_tot * final_factors[m], 1):.1f}"
                    if (y, m) == (2012, 1):
                        split = "partial_start"
                    elif (y, m) in OUTAGE_YM:
                        split = "excluded_outage"
                    elif y in years_a:
                        split = "calibration_a"
                    elif y in years_b:
                        split = "calibration_b"
                    elif y <= 2025:
                        split = "drift"
                    else:
                        split = "provisional_2026"

                writer.writerow([y, m, f"{h_tot:.1f}", a_tot, s_raw_str, s_conv_str, split])

    # Construir metadata.json
    meta = {
        "region": args.country,
        "bbox": bbox,
        "cell_size_deg": args.cell_size,
        "temporal_resolution": "monthly",
        "date_range": [f"{args.start_year}-01", f"{args.end_year}-12"],
        "provisional_range": ["2026-01", "2026-10"] if 2026 in allowed_years else [],
        "baseline_years": [args.start_year, args.end_year],
        "unit": "celdas-día con fuego (equivalente MODIS Aqua)",
        "sensors": {
            "reference": "MODIS Aqua (MYD14 / MCD14ML)",
            "converted": "VIIRS Suomi-NPP 375 m (VNP14IMGML)",
        },
        "sensor_coverage": {
            "aqua": [f"{args.start_year}-01", "2026-10" if 2026 in allowed_years else f"{args.end_year}-12"],
            "snpp": ["2012-02", "2026-10" if 2026 in allowed_years else f"{args.end_year}-12"],
        },
        "calibration_period": ["2012-02", "2021-12"],
        "excluded_months": ["2012-01", "2020-08", "2020-09"],
        "harmonized_source_switch": "2022-01",
        "factors_by_month": {str(m): round(final_factors[m], 6) for m in range(1, 13)},
        "factor_annual_fallback": round(annual_fallback, 6),
        "validation_metrics": {
            "threshold_pct": 15.0,
            "train_2012_2016_test_2017_2021": eval_a_on_b,
            "train_2017_2021_test_2012_2016": eval_b_on_a,
            "full_2012_2021_in_sample": eval_full,
            "subregions_2012_2021": subregion_metrics,
        },
        "filters": {
            "type": [0],
            "modis_satellite": "Aqua",
            "modis_confidence_min": 30,
            "viirs_confidence": ["n", "h"],
        },
        "generated_on": str(date.today()),
    }

    meta_path = args.out_dir / "metadata.json"
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)

    # Generar data_bundle.js para compatibilidad directa file:///
    bundle_path = args.out_dir / "data_bundle.js"
    with open(cells_csv_path, "r", encoding="utf-8") as fc, open(val_csv_path, "r", encoding="utf-8") as fv:
        cells_text = fc.read()
        val_text = fv.read()
    # La grilla base (0,25°) se publica como window.PIXFIRE_DATA (la web la carga al inicio).
    # Las otras grillas se registran en window.PIXFIRE_GRIDS["0.10"], etc.; la web las carga
    # solo cuando el usuario las elige (ver loadGridBundle en app.js).
    grid_key = f"{args.cell_size:.2f}"
    target = "window.PIXFIRE_DATA" if grid_key == "0.25" else f'window.PIXFIRE_GRIDS["{grid_key}"]'
    with open(bundle_path, "w", encoding="utf-8") as fb:
        if grid_key != "0.25":
            fb.write("window.PIXFIRE_GRIDS = window.PIXFIRE_GRIDS || {};\n")
        fb.write(f"{target} = {{\n")
        fb.write(f"  meta: {json.dumps(meta, ensure_ascii=False)},\n")
        fb.write(f"  cellsCsv: {json.dumps(cells_text, ensure_ascii=False)},\n")
        fb.write(f"  valCsv: {json.dumps(val_text, ensure_ascii=False)}\n")
        fb.write("};\n")

    size_mb = cells_csv_path.stat().st_size / 1e6
    print(f"\n=== RESUMEN DEL PIPELINE (cell_size = {args.cell_size}°) ===")
    print(f"Archivo principal: {cells_csv_path} ({len(all_keys)} filas, {size_mb:.2f} MB)")
    print(f"Factor anual global (Aqua/SNPP): {annual_fallback:.4f} (SNPP/Aqua = {1/annual_fallback if annual_fallback else 0:.2f}x)")
    print("Factores mensuales (k_m):")
    print(" ", " ".join(f"M{m:02d}:{final_factors[m]:.3f}" for m in range(1, 13)))
    print(f"Validación 2012-16 -> 2017-21: sesgo crudo = {eval_a_on_b['raw_bias_pct']:+.1f}% | sesgo armonizado = {eval_a_on_b['harmonized_bias_pct']:+.2f}% | MAE = {eval_a_on_b['mae_monthly']}")
    print(f"Validación 2017-21 -> 2012-16: sesgo crudo = {eval_b_on_a['raw_bias_pct']:+.1f}% | sesgo armonizado = {eval_b_on_a['harmonized_bias_pct']:+.2f}% | MAE = {eval_b_on_a['mae_monthly']}")
    print("Subregiones (2012-2021):")
    for k, v in subregion_metrics.items():
        print(f"  - {k:22s}: sesgo crudo = {v['raw_bias_pct']:+.1f}% -> armonizado = {v['harmonized_bias_pct']:+.2f}%")


if __name__ == "__main__":
    main()
