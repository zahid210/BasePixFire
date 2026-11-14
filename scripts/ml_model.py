"""
ml_model.py — Modelo de riesgo de fuego por celda (Machine Learning explicable).

Pregunta científica (ver docs/METODO.md §ML):
  1. ¿La historia reciente de fuego de una celda predice el fuego de este año
     mejor que su "normal" histórico (climatología)?
  2. ¿Qué pesa más en Bolivia?
       - PERSISTENCIA: donde hubo fuego el año pasado vuelve a haber (chaqueo).
       - ACUMULACIÓN: muchos años sin fuego → más combustible → fuego mayor.

Por qué NO usamos regresión normal:
  El dato es un CONTEO (celdas-día con fuego por celda y mes): no negativo,
  lleno de ceros y con varianza >> media (sobredispersión). Por eso usamos:
    - Binomial negativa (conteos sobredispersos), para predecir.
    - Modelo "hurdle" en dos partes, para explicar:
        a) Ocurrencia: ¿hay fuego? (regresión logística)
        b) Intensidad: si hay fuego, ¿cuánto? (binomial negativa sobre los positivos)
    - Gradient boosting con pérdida Poisson (scikit-learn), para captar no linealidades.
  Y lo comparamos contra la línea base que ya usa la app: la climatología de la celda.

Unidad de análisis: celda (0,25°) × año × mes. Todas las variables explicativas usan
SOLO información hasta el año anterior (pronóstico de pretemporada, sin fuga de datos).

Validación temporal (no aleatoria):
  - Entrenamiento: 2009–2016 (2003–2008 se usan solo como historia para las variables).
  - Prueba:        2017–2021 (era Aqua pura; se excluyen 2020-08 y 2020-09 por el apagón).
  - Prueba provisional: pronóstico de 2026 (ene–oct) con variables 2022–2025 derivadas de
    VIIRS armonizado. Ver limitaciones en docs/METODO.md.

Uso:
  python scripts/ml_model.py                      # datos completos
  python scripts/ml_model.py --sample-cells 200   # prueba rápida con pocas celdas
Salidas:
  data/processed/ml_results.json
  data/processed/ml_bundle.js   (window.PIXFIRE_ML, para abrir la web con file://)
"""

import argparse
import os

os.environ.setdefault("LOKY_MAX_CPU_COUNT", "4")  # evita aviso de joblib en Windows
import json
import warnings
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.api as sm
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import roc_auc_score

ROOT = Path(__file__).resolve().parent.parent
FIRST_YEAR, LAST_YEAR = 2003, 2026
TRAIN_YEARS = range(2009, 2017)
TEST_YEARS = range(2017, 2022)
EXCLUDED_YM = {(2020, 8), (2020, 9)}  # apagón de Aqua: el dato del mes es S-NPP convertido
FORECAST_YEAR = 2026
FORECAST_LAST_MONTH = 10  # S-NPP disponible hasta oct 2026
YS_CAP = 6  # "años desde el último fuego" se agrupa en 6+ (la historia empieza en 2003)
YS_LABELS = {1: "1 año", 2: "2 años", 3: "3 años", 4: "4–5 años", 6: "6+ años / sin registro"}


# ---------------------------------------------------------------------------
# 1. Panel completo celda × año × mes (los ausentes valen 0)
# ---------------------------------------------------------------------------
def build_panel(cells_csv: Path, sample_cells: int | None):
    df = pd.read_csv(cells_csv, usecols=["cell_id", "year", "month", "count_harmonized"])
    cell_ids = np.sort(df["cell_id"].unique())
    if sample_cells:
        rng = np.random.default_rng(42)
        cell_ids = np.sort(rng.choice(cell_ids, size=min(sample_cells, len(cell_ids)), replace=False))
        df = df[df["cell_id"].isin(cell_ids)]

    idx = {c: i for i, c in enumerate(cell_ids)}
    n_years = LAST_YEAR - FIRST_YEAR + 1
    # cube[c, año, mes] = celdas-día con fuego (equivalente Aqua)
    cube = np.zeros((len(cell_ids), n_years, 12), dtype=float)
    cube[df["cell_id"].map(idx).to_numpy(), (df["year"] - FIRST_YEAR).to_numpy(),
         (df["month"] - 1).to_numpy()] = df["count_harmonized"].to_numpy()
    # Meses sin cobertura en 2026 (nov–dic) → sin dato
    cube[:, LAST_YEAR - FIRST_YEAR, FORECAST_LAST_MONTH:] = np.nan
    return cell_ids, cube


def neighbor_mean(annual: np.ndarray, cell_ids: np.ndarray) -> np.ndarray:
    """Promedio anual de las 8 celdas vecinas (las que no existen en el dataset valen 0)."""
    rc = np.array([[int(p) for p in c.split("_")] for c in cell_ids])
    pos = {(r, c): i for i, (r, c) in enumerate(rc)}
    out = np.zeros_like(annual)
    for i, (r, c) in enumerate(rc):
        neigh = [pos[(r + dr, c + dc)] for dr in (-1, 0, 1) for dc in (-1, 0, 1)
                 if (dr or dc) and (r + dr, c + dc) in pos]
        if neigh:
            out[i] = annual[neigh].sum(axis=0) / 8.0
    return out


# ---------------------------------------------------------------------------
# 2. Variables explicativas (solo pasado: hasta el año y-1)
# ---------------------------------------------------------------------------
def build_features(cell_ids, cube, years):
    annual = np.nansum(cube, axis=2)                 # celdas-día por celda y año
    # "Hubo fuego" = al menos 1 celda-día equivalente Aqua en el año.
    # Con datos VIIRS (2022+) este umbral evita contar como "quemada" una celda con
    # 1 sola detección S-NPP (que equivale a ~0,3 celdas-día Aqua).
    burned = annual >= 1.0
    neigh = neighbor_mean(annual, cell_ids)

    rows = []
    for y in years:
        yi = y - FIRST_YEAR
        hist = cube[:, :yi, :]                        # 2003 .. y-1
        clim = hist.mean(axis=1)                      # (celdas, 12) normal de la celda
        last_same = cube[:, yi - 1, :]                # mismo mes del año anterior
        # años desde el último año con fuego (1 = el año pasado)
        ys = np.full(len(cell_ids), YS_CAP)
        for k in range(min(YS_CAP - 1, yi), 0, -1):
            ys = np.where(burned[:, yi - k], k, ys)
        ys_bucket = np.where(ys >= YS_CAP, 6, np.where(ys >= 4, 4, ys))
        for m in range(12):
            if (y, m + 1) in EXCLUDED_YM:
                continue
            target = cube[:, yi, m]
            rows.append(pd.DataFrame({
                "cell_id": cell_ids,
                "year": y,
                "month": m + 1,
                "y": target,
                "clim": clim[:, m],
                "last_same": last_same[:, m],
                "ys_bucket": ys_bucket,
                "neigh": neigh[:, yi - 1],
            }))
    df = pd.concat(rows, ignore_index=True)
    df["log_clim"] = np.log1p(df["clim"])
    df["log_last_same"] = np.log1p(df["last_same"])
    df["log_neigh"] = np.log1p(df["neigh"])
    return df


def design_matrix(df):
    """Matriz para los GLM: mes y 'años desde el último fuego' como categorías."""
    X = pd.DataFrame({
        "log_clim": df["log_clim"],
        "log_last_same": df["log_last_same"],
        "log_neigh": df["log_neigh"],
    })
    for b in (2, 3, 4, 6):  # referencia: fuego el año pasado (1 año)
        X[f"ys_{b}"] = (df["ys_bucket"] == b).astype(float)
    for m in range(2, 13):  # referencia: enero
        X[f"m_{m}"] = (df["month"] == m).astype(float)
    return sm.add_constant(X, has_constant="add")


HGB_COLS = ["month", "log_clim", "log_last_same", "ys_bucket", "log_neigh"]


# ---------------------------------------------------------------------------
# 3. Modelos
# ---------------------------------------------------------------------------
def fit_models(train):
    X = design_matrix(train)
    y = train["y"].round().astype(int)

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        nb = sm.NegativeBinomial(y, X).fit(method="lbfgs", maxiter=500, disp=False)
        occ = sm.Logit((y > 0).astype(int), X).fit(method="lbfgs", maxiter=500, disp=False)
        pos = y > 0
        inten = sm.NegativeBinomial(y[pos], X[pos]).fit(method="lbfgs", maxiter=500, disp=False)

    hgb = HistGradientBoostingRegressor(
        loss="poisson", max_iter=300, learning_rate=0.05, max_leaf_nodes=31,
        min_samples_leaf=100, categorical_features=[0], random_state=0)
    hgb.fit(train[HGB_COLS], train["y"])
    return {"nb": nb, "occ": occ, "inten": inten, "hgb": hgb}


def predict_nb(model, df):
    X = design_matrix(df)
    params = model.params
    alpha = float(params["alpha"])
    mu = np.exp(X.to_numpy() @ params.drop("alpha").to_numpy())
    p_fire = 1.0 - (1.0 + alpha * mu) ** (-1.0 / alpha)
    return mu, p_fire


def poisson_deviance(y, mu):
    mu = np.clip(mu, 1e-9, None)
    term = np.where(y > 0, y * np.log(np.where(y > 0, y, 1) / mu), 0.0)
    return float(np.mean(2 * (term - (y - mu))))


def evaluate(name, test, mu, score):
    y = test["y"].to_numpy()
    month_tot = test.assign(mu=mu).groupby(["year", "month"])[["y", "mu"]].sum()
    return {
        "model": name,
        "poisson_deviance": round(poisson_deviance(y, mu), 4),
        "mae_cell_month": round(float(np.mean(np.abs(y - mu))), 4),
        "auc_fire_occurrence": round(float(roc_auc_score(y > 0, score)), 4),
        "mae_bolivia_monthly_total": round(float((month_tot["y"] - month_tot["mu"]).abs().mean()), 1),
        "total_bias_pct": round(float((mu.sum() - y.sum()) / y.sum() * 100), 2),
    }


def effects_table(model, kind):
    """Coeficientes como razones (exp(beta)) con IC 95 %: >1 aumenta, <1 reduce."""
    names = {
        "log_clim": "Normal histórico de la celda (log, ese mes)",
        "log_last_same": "Fuego el mismo mes del año anterior (log)",
        "log_neigh": "Fuego en celdas vecinas el año anterior (log)",
        "ys_2": "Último fuego hace 2 años (vs. el año pasado)",
        "ys_3": "Último fuego hace 3 años (vs. el año pasado)",
        "ys_4": "Último fuego hace 4–5 años (vs. el año pasado)",
        "ys_6": "6+ años sin fuego / sin registro (vs. el año pasado)",
    }
    ci = model.conf_int()
    out = []
    for key, label in names.items():
        out.append({
            "term": key,
            "label": label,
            "ratio": round(float(np.exp(model.params[key])), 4),
            "ci_low": round(float(np.exp(ci.loc[key, 0])), 4),
            "ci_high": round(float(np.exp(ci.loc[key, 1])), 4),
            "p_value": float(f"{model.pvalues[key]:.3g}"),
        })
    return {"kind": kind, "terms": out}


def empirical_by_ys(df):
    """Descriptivo simple (sin controles): fuego observado según años desde el último fuego."""
    g = df.groupby("ys_bucket")["y"]
    res = []
    for b, s in g:
        pos = s[s > 0]
        res.append({
            "bucket": int(b),
            "label": YS_LABELS[int(b)],
            "n_cell_months": int(len(s)),
            "p_fire": round(float((s > 0).mean()), 4),
            "mean_if_fire": round(float(pos.mean()), 3) if len(pos) else None,
        })
    return res


# ---------------------------------------------------------------------------
# 4. Programa principal
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cells", type=Path, default=ROOT / "data/processed/monthly_cells.csv")
    ap.add_argument("--out-dir", type=Path, default=ROOT / "data/processed")
    ap.add_argument("--sample-cells", type=int, default=None, help="Usar solo N celdas (prueba rápida)")
    args = ap.parse_args()

    cell_ids, cube = build_panel(args.cells, args.sample_cells)
    print(f"Celdas: {len(cell_ids)}")

    train = build_features(cell_ids, cube, TRAIN_YEARS)
    test = build_features(cell_ids, cube, TEST_YEARS)
    print(f"Filas entrenamiento: {len(train):,} | prueba: {len(test):,} | "
          f"ceros en entrenamiento: {(train['y'] == 0).mean():.1%}")
    print(f"Sobredispersión (entrenamiento): media = {train['y'].mean():.3f}, varianza = {train['y'].var():.3f}")

    # --- Evaluación fuera de muestra (2009–2016 → 2017–2021) ---
    models = fit_models(train)
    mu_nb, p_nb = predict_nb(models["nb"], test)
    mu_hgb = models["hgb"].predict(test[HGB_COLS])
    metrics = [
        evaluate("Climatología de la celda (línea base)", test, test["clim"].to_numpy(), test["clim"].to_numpy()),
        evaluate("Binomial negativa (GLM)", test, mu_nb, p_nb),
        evaluate("Gradient boosting Poisson", test, mu_hgb, mu_hgb),
    ]
    for m in metrics:
        print(f"  {m['model']:<40} deviance={m['poisson_deviance']:.4f} MAE={m['mae_cell_month']:.4f} "
              f"AUC={m['auc_fire_occurrence']:.3f} MAE_total_Bolivia={m['mae_bolivia_monthly_total']} "
              f"sesgo={m['total_bias_pct']:+.1f}%")

    # --- Modelo final (2009–2021) para explicar y pronosticar 2026 ---
    full = pd.concat([train, test], ignore_index=True)
    final = fit_models(full)
    effects = {
        "occurrence": effects_table(final["occ"], "odds_ratio"),
        "intensity": effects_table(final["inten"], "rate_ratio"),
        "full_nb": effects_table(final["nb"], "rate_ratio"),
        "nb_alpha": round(float(final["nb"].params["alpha"]), 4),
    }

    fc = build_features(cell_ids, cube, [FORECAST_YEAR])
    fc["mu_nb"], fc["p_fire"] = predict_nb(final["nb"], fc)
    fc["mu_hgb"] = final["hgb"].predict(fc[HGB_COLS])
    fc_obs = fc[fc["month"] <= FORECAST_LAST_MONTH]
    forecast_metrics = [
        evaluate("Climatología de la celda (línea base)", fc_obs, fc_obs["clim"].to_numpy(), fc_obs["clim"].to_numpy()),
        evaluate("Binomial negativa (GLM)", fc_obs, fc_obs["mu_nb"].to_numpy(), fc_obs["p_fire"].to_numpy()),
        evaluate("Gradient boosting Poisson", fc_obs, fc_obs["mu_hgb"].to_numpy(), fc_obs["mu_hgb"].to_numpy()),
    ]

    # Pronóstico por celda: 12 valores esperados (binomial negativa) + observado ene–oct
    pred_cells = {}
    for cid, g in fc.sort_values("month").groupby("cell_id"):
        pred_cells[cid] = {
            "pred": [round(float(v), 3) for v in g["mu_nb"]],
            "clim": [round(float(v), 3) for v in g["clim"]],
            "obs": [None if np.isnan(v) else round(float(v), 3) for v in g["y"]],
        }

    results = {
        "description": "Modelo de riesgo de fuego por celda-mes (pronóstico de pretemporada).",
        "unit": "celdas-día con fuego (equivalente MODIS Aqua) por celda y mes",
        "n_cells": int(len(cell_ids)),
        "train_years": [min(TRAIN_YEARS), max(TRAIN_YEARS)],
        "test_years": [min(TEST_YEARS), max(TEST_YEARS)],
        "final_fit_years": [min(TRAIN_YEARS), max(TEST_YEARS)],
        "excluded_months": ["2020-08", "2020-09"],
        "forecast_year": FORECAST_YEAR,
        "forecast_observed_through_month": FORECAST_LAST_MONTH,
        "distribution_check": {
            "share_zeros_train": round(float((train["y"] == 0).mean()), 4),
            "mean_train": round(float(train["y"].mean()), 4),
            "variance_train": round(float(train["y"].var()), 4),
        },
        "metrics_test": metrics,
        "metrics_forecast_2026_provisional": forecast_metrics,
        "effects": effects,
        "empirical_by_years_since_fire": empirical_by_ys(full),
        "feature_importance_note": "Gradient boosting usado solo para comparar capacidad predictiva.",
        "cells_forecast": pred_cells,
        "generated_on": str(date.today()),
    }

    args.out_dir.mkdir(parents=True, exist_ok=True)
    suffix = f"_sample{args.sample_cells}" if args.sample_cells else ""
    json_path = args.out_dir / f"ml_results{suffix}.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, separators=(",", ":"))
    if not args.sample_cells:
        with open(args.out_dir / "ml_bundle.js", "w", encoding="utf-8") as f:
            f.write("window.PIXFIRE_ML = ")
            json.dump(results, f, ensure_ascii=False, separators=(",", ":"))
            f.write(";\n")

    print("\nEfectos (modelo final 2009–2021):")
    for part in ("occurrence", "intensity"):
        print(f"  [{part}]")
        for t in effects[part]["terms"]:
            print(f"    {t['label']:<55} {t['ratio']:.3f} [{t['ci_low']:.3f}–{t['ci_high']:.3f}] p={t['p_value']}")
    print("\nPronóstico 2026 (ene–oct, provisional):")
    for m in forecast_metrics:
        print(f"  {m['model']:<40} deviance={m['poisson_deviance']:.4f} AUC={m['auc_fire_occurrence']:.3f} "
              f"sesgo={m['total_bias_pct']:+.1f}%")
    print(f"\nGuardado: {json_path} ({json_path.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
