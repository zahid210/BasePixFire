"""
ml_model.py — Modelo de riesgo de fuego por celda y proyección hasta 2030.

Pregunta científica (ver docs/METODO.md §5):
  1. ¿La historia reciente de fuego de una celda predice el fuego de este año
     mejor que su "normal" histórico (climatología)?
  2. ¿Qué pesa más en Bolivia?
       - PERSISTENCIA: donde hubo fuego el año pasado vuelve a haber (chaqueo).
       - ACUMULACIÓN: muchos años sin fuego → más combustible → fuego mayor.
  3. ¿Qué rango de actividad de fuego es plausible entre 2026 y 2030 si las
     condiciones se parecen a las de 2003–2025?

Por qué NO usamos regresión normal:
  El dato es un CONTEO (celdas-día con fuego por celda y mes): no negativo,
  lleno de ceros y con varianza >> media (sobredispersión). Modelos usados:
    - Tweedie (GLM): la varianza crece como una POTENCIA de la media,
      Var = phi * mu^p, con 1 < p < 2 (masa en cero + valores positivos continuos).
      p se estima de los datos. Es el modelo usado para proyectar.
    - Binomial negativa (GLM): alternativa clásica para conteos sobredispersos.
    - Modelo "hurdle" en dos partes, para explicar:
        a) Ocurrencia: ¿hay fuego? (regresión logística)
        b) Intensidad: si hay fuego, ¿cuánto? (binomial negativa sobre los positivos)
    - Gradient boosting con pérdida Poisson (scikit-learn), solo para comparar.
  Todos se comparan contra la línea base de la app: la climatología de la celda.

Unidad: celda (0,25°) × año × mes. Las variables explicativas usan SOLO
información hasta el año anterior (pronóstico de pretemporada, sin fuga de datos).

Validación temporal (no aleatoria):
  - Entrenamiento: 2009–2016 (2003–2008 solo sirven como historia).
  - Prueba:        2017–2021 (era Aqua pura; sin 2020-08 y 2020-09 por el apagón).
  - Prueba retrospectiva de la proyección multianual: desde fines de 2016 se
    simula 2017–2021 sin mirar esos años y se compara con lo observado.

Proyección 2026–2030 (Monte Carlo):
  Se simula año por año: el fuego simulado de 2027 pasa a ser la "historia" que
  alimenta 2028, y así hasta 2030. Cada simulación incluye tres fuentes de
  incertidumbre: (1) azar del fuego en cada celda (distribución Tweedie),
  (2) incertidumbre de los coeficientes y (3) un "efecto año" común a todo el
  país (años secos o húmedos), estimado de la variabilidad 2009–2021.
  Supuesto clave: clima y uso del suelo se comportan como en el periodo histórico.

Uso:
  python scripts/ml_model.py                                   # completo
  python scripts/ml_model.py --sample-cells 150 --n-sims 50 --out-dir <tmp>   # prueba rápida
Salidas:
  data/processed/ml_results.json
  data/processed/ml_bundle.js   (window.PIXFIRE_ML, para abrir la web con file://)
"""

import argparse
import calendar
import json
import warnings
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import scipy.sparse as sp
import statsmodels.api as sm
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import roc_auc_score

# joblib (dentro de scikit-learn) avisa en Windows que no puede contar núcleos; es inofensivo.
warnings.filterwarnings("ignore", message="Could not find the number of physical cores")

ROOT = Path(__file__).resolve().parent.parent
FIRST_YEAR, LAST_YEAR = 2003, 2026
TRAIN_YEARS = range(2009, 2017)
TEST_YEARS = range(2017, 2022)
EXCLUDED_YM = {(2020, 8), (2020, 9)}  # apagón de Aqua: el dato del mes es S-NPP convertido
FORECAST_YEAR = 2026
FORECAST_LAST_MONTH = 10  # S-NPP disponible hasta oct 2026
PROJECTION_END = 2030
YS_CAP = 6  # "años desde el último fuego" se agrupa en 6+ (la historia empieza en 2003)
YS_LABELS = {1: "1 año", 2: "2 años", 3: "3 años", 4: "4–5 años", 6: "6+ años / sin registro"}
QUANTILES = {"p05": 0.05, "p10": 0.10, "p50": 0.50, "p90": 0.90, "p95": 0.95}


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
    cube = np.zeros((len(cell_ids), n_years, 12), dtype=float)
    cube[df["cell_id"].map(idx).to_numpy(), (df["year"] - FIRST_YEAR).to_numpy(),
         (df["month"] - 1).to_numpy()] = df["count_harmonized"].to_numpy()
    cube[:, LAST_YEAR - FIRST_YEAR, FORECAST_LAST_MONTH:] = np.nan  # nov–dic 2026 sin dato
    return cell_ids, cube


def cell_geometry(cell_ids, cell_size=0.25):
    """Centro de cada celda y subregión (mismas reglas que app.js → classifySubregion)."""
    rc = np.array([[int(p) for p in c.split("_")] for c in cell_ids])
    lat = (rc[:, 0] + 0.5) * cell_size - 90
    lon = (rc[:, 1] + 0.5) * cell_size - 180
    sub = np.where((lon <= -64.0) & (lat < -14.0), "andina",
                   np.where(lat >= -14.0, "amazonia", "chiquitania"))
    return rc, sub


def neighbor_matrix(rc):
    """Matriz dispersa: fila i suma las 8 celdas vecinas de i (las ausentes valen 0)."""
    pos = {(r, c): i for i, (r, c) in enumerate(rc)}
    rows, cols = [], []
    for i, (r, c) in enumerate(rc):
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                j = pos.get((r + dr, c + dc))
                if (dr or dc) and j is not None:
                    rows.append(i)
                    cols.append(j)
    n = len(rc)
    return sp.csr_matrix((np.ones(len(rows)), (rows, cols)), shape=(n, n))


# ---------------------------------------------------------------------------
# 2. Variables explicativas de un año (solo pasado: hasta el año y-1)
# ---------------------------------------------------------------------------
def year_frame(cell_ids, cube, y, adj, skip_excluded=True):
    """Tabla de 12 meses × celdas para el año y, con variables calculadas del pasado."""
    yi = y - FIRST_YEAR
    hist = cube[:, :yi, :]
    annual = np.nansum(hist, axis=2)
    # "Hubo fuego" = al menos 1 celda-día equivalente Aqua en el año.
    # Con datos VIIRS (2022+) evita contar como "quemada" una celda con 1 sola
    # detección S-NPP (que equivale a ~0,3 celdas-día Aqua).
    burned = annual >= 1.0
    clim = np.nanmean(hist, axis=1)                   # (celdas, 12) normal de la celda
    last_same = hist[:, -1, :].copy()                 # mismo mes del año anterior
    if yi >= 2:
        # nov–dic 2026 no existen (no se completan): para 2027 se usa el último dato real
        # de ese mes, el de 2025, en vez de inventar un valor.
        missing = np.isnan(last_same)
        last_same[missing] = hist[:, -2, :][missing]
    neigh = (adj @ annual[:, -1]) / 8.0
    ys = np.full(len(cell_ids), YS_CAP)
    for k in range(min(YS_CAP - 1, yi), 0, -1):
        ys = np.where(burned[:, yi - k], k, ys)
    ys_bucket = np.where(ys >= YS_CAP, 6, np.where(ys >= 4, 4, ys))

    target = cube[:, yi, :] if yi < cube.shape[1] else np.full((len(cell_ids), 12), np.nan)
    months = [m for m in range(12) if not (skip_excluded and (y, m + 1) in EXCLUDED_YM)]
    n = len(cell_ids)
    df = pd.DataFrame({
        "cell_idx": np.tile(np.arange(n), len(months)),
        "year": y,
        "month": np.repeat([m + 1 for m in months], n),
        "y": np.concatenate([target[:, m] for m in months]),
        "clim": np.concatenate([clim[:, m] for m in months]),
        "last_same": np.concatenate([last_same[:, m] for m in months]),
        "ys_bucket": np.tile(ys_bucket, len(months)),
        "neigh": np.tile(neigh, len(months)),
    })
    df["log_clim"] = np.log1p(df["clim"])
    df["log_last_same"] = np.log1p(df["last_same"])
    df["log_neigh"] = np.log1p(df["neigh"])
    return df


def build_features(cell_ids, cube, years, adj):
    return pd.concat([year_frame(cell_ids, cube, y, adj) for y in years], ignore_index=True)


def design_matrix(df):
    """Matriz para los GLM: mes y 'años desde el último fuego' como categorías."""
    X = pd.DataFrame({
        "const": 1.0,
        "log_clim": df["log_clim"],
        "log_last_same": df["log_last_same"],
        "log_neigh": df["log_neigh"],
    })
    for b in (2, 3, 4, 6):  # referencia: fuego el año pasado (1 año)
        X[f"ys_{b}"] = (df["ys_bucket"] == b).astype(float)
    for m in range(2, 13):  # referencia: enero
        X[f"m_{m}"] = (df["month"] == m).astype(float)
    return X


HGB_COLS = ["month", "log_clim", "log_last_same", "ys_bucket", "log_neigh"]


# ---------------------------------------------------------------------------
# 3. Modelos
# ---------------------------------------------------------------------------
def estimate_tweedie_power(y, mu, n_bins=20):
    """
    Ley de potencia de la varianza: agrupa las celdas-mes por su media esperada
    y ajusta log(varianza) = log(phi) + p * log(media). La pendiente es p.
    """
    bins = pd.qcut(mu, q=n_bins, duplicates="drop")
    g = pd.DataFrame({"y": y, "bin": bins}).groupby("bin", observed=True)["y"]
    stats = pd.DataFrame({"mean": g.mean(), "var": g.var()}).dropna()
    stats = stats[(stats["mean"] > 0) & (stats["var"] > 0)]
    slope, intercept = np.polyfit(np.log(stats["mean"]), np.log(stats["var"]), 1)
    p = float(np.clip(slope, 1.05, 1.95))
    points = [{"mean": round(float(m), 4), "var": round(float(v), 4)}
              for m, v in zip(stats["mean"], stats["var"])]
    return p, float(slope), float(np.exp(intercept)), points


def fit_models(train):
    X = design_matrix(train)
    y = train["y"].round().astype(int)

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        nb = sm.NegativeBinomial(y, X).fit(method="lbfgs", maxiter=500, disp=False)
        occ = sm.Logit((y > 0).astype(int), X).fit(method="lbfgs", maxiter=500, disp=False)
        pos = y > 0
        inten = sm.NegativeBinomial(y[pos], X[pos]).fit(method="lbfgs", maxiter=500, disp=False)

        mu_nb, _ = predict_nb(nb, train)
        p, p_raw, phi_bins, var_points = estimate_tweedie_power(train["y"].to_numpy(), mu_nb)
        tw = sm.GLM(train["y"], X, family=sm.families.Tweedie(
            var_power=p, link=sm.families.links.Log())).fit()

    hgb = HistGradientBoostingRegressor(
        loss="poisson", max_iter=300, learning_rate=0.05, max_leaf_nodes=31,
        min_samples_leaf=100, categorical_features=[0], random_state=0)
    hgb.fit(train[HGB_COLS], train["y"])

    tweedie_info = {"power": round(p, 4), "power_raw_slope": round(p_raw, 4),
                    "phi": round(float(tw.scale), 4), "phi_from_bins": round(phi_bins, 4),
                    "mean_var_points": var_points}
    return {"nb": nb, "occ": occ, "inten": inten, "hgb": hgb, "tw": tw,
            "tw_power": p, "tw_phi": float(tw.scale), "tweedie_info": tweedie_info}


def predict_nb(model, df):
    X = design_matrix(df)
    params = model.params
    alpha = float(params["alpha"])
    mu = np.exp(X.to_numpy() @ params.drop("alpha").to_numpy())
    p_fire = 1.0 - (1.0 + alpha * mu) ** (-1.0 / alpha)
    return mu, p_fire


def predict_tweedie(models, df, params=None):
    X = design_matrix(df).to_numpy()
    beta = models["tw"].params.to_numpy() if params is None else params
    mu = np.exp(X @ beta)
    p, phi = models["tw_power"], models["tw_phi"]
    lam = mu ** (2 - p) / (phi * (2 - p))   # nº esperado de "eventos" del Poisson compuesto
    return mu, 1.0 - np.exp(-lam)           # P(y > 0) = 1 - P(ningún evento)


def sample_tweedie(mu, p, phi, rng):
    """Tweedie 1<p<2 = suma de N ~ Poisson eventos con tamaño ~ Gamma (Poisson compuesta)."""
    lam = mu ** (2 - p) / (phi * (2 - p))
    n = rng.poisson(lam)
    shape = (2 - p) / (p - 1)
    scale = phi * (p - 1) * mu ** (p - 1)
    out = np.zeros_like(mu)
    pos = n > 0
    out[pos] = rng.gamma(n[pos] * shape, scale[pos])
    return out


def poisson_deviance(y, mu):
    mu = np.clip(mu, 1e-9, None)
    term = np.where(y > 0, y * np.log(np.where(y > 0, y, 1) / mu), 0.0)
    return float(np.mean(2 * (term - (y - mu))))


def evaluate(key, name, test, mu, score):
    y = test["y"].to_numpy()
    month_tot = test.assign(mu=mu).groupby(["year", "month"])[["y", "mu"]].sum()
    has_both_classes = len(np.unique(y > 0)) > 1
    return {
        "key": key,
        "model": name,
        "poisson_deviance": round(poisson_deviance(y, mu), 4),
        "mae_cell_month": round(float(np.mean(np.abs(y - mu))), 4),
        "auc_fire_occurrence": round(float(roc_auc_score(y > 0, score)), 4) if has_both_classes else 0.0,
        "mae_bolivia_monthly_total": round(float((month_tot["y"] - month_tot["mu"]).abs().mean()), 1),
        "total_bias_pct": round(float((mu.sum() - y.sum()) / y.sum() * 100), 2) if y.sum() > 0 else 0.0,
    }


def evaluate_all(models, df):
    mu_nb, p_nb = predict_nb(models["nb"], df)
    mu_tw, p_tw = predict_tweedie(models, df)
    mu_hgb = models["hgb"].predict(df[HGB_COLS])
    clim = df["clim"].to_numpy()
    return [
        evaluate("clim", "Climatología de la celda (línea base)", df, clim, clim),
        evaluate("nb", "Binomial negativa (GLM)", df, mu_nb, p_nb),
        evaluate("tweedie", "Tweedie (GLM, varianza ∝ media^p)", df, mu_tw, p_tw),
        evaluate("hgb", "Gradient boosting Poisson", df, mu_hgb, mu_hgb),
    ]


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
    res = []
    for b, s in df.groupby("ys_bucket")["y"]:
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
# 4. Simulación multianual (Monte Carlo)
# ---------------------------------------------------------------------------
def year_effect_sigma(models, df):
    """
    'Efecto año': cuánto se desvía cada año el total observado de Bolivia del total
    predicho (años secos/húmedos que el modelo no conoce). Desvío estándar en log.
    """
    mu, _ = predict_tweedie(models, df)
    tot = df.assign(mu=mu).groupby("year")[["y", "mu"]].sum()
    r = np.log(tot["y"] / tot["mu"])
    return float(r.std(ddof=1)), {int(k): round(float(v), 4) for k, v in r.items()}


def simulate(cell_ids, cube, adj, models, start_year, end_year, n_sims, rng, sigma_year):
    """
    Devuelve sims[s, celda, k] = celdas-día anuales simuladas para cada año
    start_year..end_year (k = 0..). La historia observada (incluido 2026 ene–oct, sin
    completar nov–dic) es el punto de partida.
    """
    p, phi = models["tw_power"], models["tw_phi"]
    beta_hat = models["tw"].params.to_numpy()
    cov = models["tw"].cov_params().to_numpy()
    years = list(range(start_year, end_year + 1))
    n_cells = len(cell_ids)
    out = np.zeros((n_sims, n_cells, len(years)))

    base_len = start_year - FIRST_YEAR
    for s in range(n_sims):
        beta = rng.multivariate_normal(beta_hat, cov)          # incertidumbre de coeficientes
        sim_cube = np.concatenate(
            [cube[:, :base_len, :], np.zeros((n_cells, len(years), 12))], axis=1)
        for k, y in enumerate(years):
            yi = y - FIRST_YEAR
            df = year_frame(cell_ids, sim_cube, y, adj, skip_excluded=False)
            eps = rng.normal(-sigma_year ** 2 / 2, sigma_year)  # efecto año (media 1 en escala real)
            mu, _ = predict_tweedie(models, df, beta)
            mu = mu * np.exp(eps)
            draw = sample_tweedie(mu, p, phi, rng)
            days = np.array([calendar.monthrange(y, m)[1] for m in df["month"]])
            draw = np.minimum(draw, days)                     # nunca más días que los del mes
            block = draw.reshape(12, n_cells).T               # (celdas, 12)
            sim_cube[:, yi, :] = block
            out[s, :, k] = sim_cube[:, yi, :].sum(axis=1)
    return years, out


def summarize(values):
    return {k: round(float(np.quantile(values, q)), 1) for k, q in QUANTILES.items()} | {
        "mean": round(float(values.mean()), 1)}


def region_masks(sub):
    return {"all": np.ones(len(sub), bool), "chiquitania": sub == "chiquitania",
            "amazonia": sub == "amazonia", "andina": sub == "andina"}


# ---------------------------------------------------------------------------
# 5. Programa principal
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cells", type=Path, default=ROOT / "data/processed/monthly_cells.csv")
    ap.add_argument("--out-dir", type=Path, default=ROOT / "data/processed")
    ap.add_argument("--sample-cells", type=int, default=None, help="Usar solo N celdas (prueba rápida)")
    ap.add_argument("--n-sims", type=int, default=200, help="Simulaciones Monte Carlo (default 200)")
    args = ap.parse_args()
    rng = np.random.default_rng(2026)

    cell_ids, cube = build_panel(args.cells, args.sample_cells)
    rc, sub = cell_geometry(cell_ids)
    adj = neighbor_matrix(rc)
    masks = region_masks(sub)
    print(f"Celdas: {len(cell_ids)}")

    train = build_features(cell_ids, cube, TRAIN_YEARS, adj)
    test = build_features(cell_ids, cube, TEST_YEARS, adj)
    print(f"Filas entrenamiento: {len(train):,} | prueba: {len(test):,} | "
          f"ceros en entrenamiento: {(train['y'] == 0).mean():.1%}")
    print(f"Sobredispersión (entrenamiento): media = {train['y'].mean():.3f}, varianza = {train['y'].var():.3f}")

    # --- Evaluación fuera de muestra (2009–2016 → 2017–2021) ---
    models = fit_models(train)
    print(f"Tweedie: p = {models['tw_power']:.3f} (pendiente log-log = {models['tweedie_info']['power_raw_slope']:.3f}), "
          f"phi = {models['tw_phi']:.3f}")
    metrics = evaluate_all(models, test)
    for m in metrics:
        print(f"  {m['model']:<40} deviance={m['poisson_deviance']:.4f} MAE={m['mae_cell_month']:.4f} "
              f"AUC={m['auc_fire_occurrence']:.3f} MAE_total_Bolivia={m['mae_bolivia_monthly_total']} "
              f"sesgo={m['total_bias_pct']:+.1f}%")

    # --- Prueba retrospectiva de la proyección multianual: desde 2016 simular 2017–2021 ---
    sigma_train, _ = year_effect_sigma(models, train)
    bt_years, bt = simulate(cell_ids, cube, adj, models, 2017, 2021, args.n_sims, rng, sigma_train)
    clim_annual = np.nansum(cube[:, :2017 - FIRST_YEAR, :], axis=2).mean(axis=1).sum()
    backtest = []
    for k, y in enumerate(bt_years):
        obs = float(np.nansum(cube[:, y - FIRST_YEAR, :]))
        s = summarize(bt[:, :, k].sum(axis=1))
        backtest.append({"year": y, "observed": round(obs, 1), "climatology": round(float(clim_annual), 1), **s})
    inside80 = sum(b["p10"] <= b["observed"] <= b["p90"] for b in backtest)
    inside90 = sum(b["p05"] <= b["observed"] <= b["p95"] for b in backtest)
    mape_model = np.mean([abs(b["p50"] - b["observed"]) / b["observed"] for b in backtest]) * 100
    mape_clim = np.mean([abs(b["climatology"] - b["observed"]) / b["observed"] for b in backtest]) * 100
    print(f"\nPrueba retrospectiva 2017–2021 (Bolivia, {args.n_sims} simulaciones):")
    for b in backtest:
        print(f"  {b['year']}: observado={b['observed']:.0f} | mediana={b['p50']:.0f} "
              f"[P10 {b['p10']:.0f} – P90 {b['p90']:.0f}] | climatología={b['climatology']:.0f}")
    print(f"  Dentro de la banda 80 %: {inside80}/5 | banda 90 %: {inside90}/5 | "
          f"error medio mediana = {mape_model:.1f} % vs climatología = {mape_clim:.1f} %")

    # --- Modelo final (2009–2021): efectos, pronóstico 2026 y proyección 2026–2030 ---
    full = pd.concat([train, test], ignore_index=True)
    final = fit_models(full)
    sigma_full, year_resid = year_effect_sigma(final, full)
    print(f"\nModelo final: Tweedie p = {final['tw_power']:.3f}, phi = {final['tw_phi']:.3f}, "
          f"efecto año sigma = {sigma_full:.3f}")
    effects = {
        "occurrence": effects_table(final["occ"], "odds_ratio"),
        "intensity": effects_table(final["inten"], "rate_ratio"),
        "tweedie": effects_table(final["tw"], "rate_ratio"),
    }

    fc = year_frame(cell_ids, cube, FORECAST_YEAR, adj)
    fc_obs = fc[fc["month"] <= FORECAST_LAST_MONTH]
    forecast_metrics = evaluate_all(final, fc_obs)

    # La proyección empieza en 2027: 2026 se deja solo con lo observado (ene–oct)
    pj_years, pj = simulate(cell_ids, cube, adj, final, FORECAST_YEAR + 1, PROJECTION_END,
                            args.n_sims, rng, sigma_full)
    obs_2026 = np.nansum(cube[:, FORECAST_YEAR - FIRST_YEAR, :], axis=1)
    observed_partial = {name: round(float(obs_2026[mask].sum()), 1) for name, mask in masks.items()}
    projection = {name: [{"year": y, **summarize(pj[:, mask, k].sum(axis=1))}
                         for k, y in enumerate(pj_years)]
                  for name, mask in masks.items()}
    hist_annual = np.nansum(cube[:, :FORECAST_YEAR - FIRST_YEAR, :], axis=2)  # 2003–2025
    history = {name: [{"year": FIRST_YEAR + i, "value": round(float(v), 1)}
                      for i, v in enumerate(hist_annual[mask].sum(axis=0))]
               for name, mask in masks.items()}
    cells_projection = {cid: [round(float(v), 2) for v in pj[:, i, :].mean(axis=0)]
                        for i, cid in enumerate(cell_ids)}

    print(f"\n2026 observado (solo ene–oct, sin completar): {observed_partial['all']:.0f}")
    print("Proyección Bolivia (celdas-día/año):")
    for r in projection["all"]:
        print(f"  {r['year']}: mediana={r['p50']:.0f} [P10 {r['p10']:.0f} – P90 {r['p90']:.0f}]")

    results = {
        "description": "Modelo de riesgo de fuego por celda-mes y proyección Monte Carlo 2027–2030 (2026 solo observado ene–oct).",
        "unit": "celdas-día con fuego (equivalente MODIS Aqua)",
        "n_cells": int(len(cell_ids)),
        "n_sims": args.n_sims,
        "train_years": [min(TRAIN_YEARS), max(TRAIN_YEARS)],
        "test_years": [min(TEST_YEARS), max(TEST_YEARS)],
        "final_fit_years": [min(TRAIN_YEARS), max(TEST_YEARS)],
        "excluded_months": ["2020-08", "2020-09"],
        "forecast_year": FORECAST_YEAR,
        "forecast_observed_through_month": FORECAST_LAST_MONTH,
        "projection_years": pj_years,
        "distribution_check": {
            "share_zeros_train": round(float((train["y"] == 0).mean()), 4),
            "mean_train": round(float(train["y"].mean()), 4),
            "variance_train": round(float(train["y"].var()), 4),
        },
        "tweedie": final["tweedie_info"] | {"year_effect_sigma": round(sigma_full, 4),
                                             "year_effect_log_residuals": year_resid},
        "metrics_test": metrics,
        "metrics_forecast_2026_provisional": forecast_metrics,
        "backtest_projection": {
            "description": "Desde fines de 2016 se simula 2017–2021 sin ver esos años (modelo entrenado en 2009–2016).",
            "years": backtest,
            "inside_p10_p90": inside80,
            "inside_p05_p95": inside90,
            "mape_median_pct": round(float(mape_model), 1),
            "mape_climatology_pct": round(float(mape_clim), 1),
        },
        "effects": effects,
        "empirical_by_years_since_fire": empirical_by_ys(full),
        "history_annual": history,
        "observed_partial_2026": observed_partial,
        "projection": projection,
        "cells_projection": cells_projection,
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
