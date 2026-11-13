#!/usr/bin/env python3
"""
Descarga los archivos CSV anuales por país de NASA FIRMS (2003-2025).
Reutiliza archivos ya existentes en data/raw/ para evitar descargas repetidas.
"""

import argparse
import concurrent.futures
import os
import shutil
import urllib.request
from pathlib import Path

BASE_URL = "https://firms.modaps.eosdis.nasa.gov/data/country"
RAW_DIR = Path(__file__).resolve().parent.parent / "data" / "raw"


def download_one(sensor: str, year: int, country: str, out_dir: Path) -> str:
    """Descarga un archivo anual de un sensor si no existe localmente."""
    filename = f"{sensor}_{year}_{country}.csv"
    dest = out_dir / sensor / filename
    dest.parent.mkdir(parents=True, exist_ok=True)

    if dest.exists() and dest.stat().st_size > 100:
        return f"[OK - ya existe] {filename} ({dest.stat().st_size / 1e6:.2f} MB)"

    url = f"{BASE_URL}/{sensor}/{year}/{filename}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    tmp_dest = dest.with_suffix(".csv.part")

    try:
        with urllib.request.urlopen(req, timeout=120) as resp, open(tmp_dest, "wb") as f:
            shutil.copyfileobj(resp, f)
        tmp_dest.rename(dest)
        return f"[DESCARGADO]     {filename} ({dest.stat().st_size / 1e6:.2f} MB)"
    except Exception as exc:
        if tmp_dest.exists():
            tmp_dest.unlink()
        return f"[ERROR]          {filename}: {exc}"


def main() -> None:
    parser = argparse.ArgumentParser(description="Descarga CSV anuales de FIRMS por país.")
    parser.add_argument("--country", default="Bolivia", help="Nombre del país en FIRMS (default: Bolivia)")
    parser.add_argument("--start-year", type=int, default=2003, help="Año inicial (default: 2003)")
    parser.add_argument("--end-year", type=int, default=2025, help="Año final (default: 2025)")
    parser.add_argument("--workers", type=int, default=6, help="Descargas en paralelo (default: 6)")
    args = parser.parse_args()

    tasks = []
    for year in range(args.start_year, args.end_year + 1):
        tasks.append(("modis", year, args.country, RAW_DIR))
        if year >= 2012:
            tasks.append(("viirs-snpp", year, args.country, RAW_DIR))

    print(f"Verificando/descargando {len(tasks)} archivos para {args.country} ({args.start_year}-{args.end_year})...")
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(download_one, *t) for t in tasks]
        for fut in concurrent.futures.as_completed(futures):
            print(" ", fut.result())


if __name__ == "__main__":
    main()
