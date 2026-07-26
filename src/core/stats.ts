/**
 * Statistical primitives.
 *
 * Everything the agent claims is computed here, in plain code, so a claim can
 * be re-derived and checked. No approximations that are not documented as such.
 */

export function mean(xs: ArrayLike<number>): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]!;
  return s / xs.length;
}

export function sum(xs: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]!;
  return s;
}

/** Sample standard deviation (n-1 denominator). */
export function stdev(xs: ArrayLike<number>): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (let i = 0; i < xs.length; i++) {
    const d = xs[i]! - m;
    acc += d * d;
  }
  return Math.sqrt(acc / (xs.length - 1));
}

export function variance(xs: ArrayLike<number>): number {
  const s = stdev(xs);
  return s * s;
}

/** Linear-interpolated percentile. `q` in 0..1. Input need not be sorted. */
export function percentile(xs: ArrayLike<number>, q: number): number {
  if (xs.length === 0) return NaN;
  const sorted = Array.from(xs).sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function median(xs: ArrayLike<number>): number {
  return percentile(xs, 0.5);
}

/**
 * Median absolute deviation, scaled by 1.4826 so that for normally distributed
 * data it estimates the same quantity as the standard deviation. Used instead
 * of stdev for outlier detection, because stdev is itself inflated by the
 * outliers we are trying to find.
 */
export function mad(xs: ArrayLike<number>): number {
  if (xs.length === 0) return 0;
  const med = median(xs);
  const devs = new Float64Array(xs.length);
  for (let i = 0; i < xs.length; i++) devs[i] = Math.abs(xs[i]! - med);
  return 1.4826 * median(devs);
}

export interface Regression {
  slope: number;
  intercept: number;
  /** Coefficient of determination, 0..1. */
  r2: number;
  /** Standard error of the slope. */
  slopeStdErr: number;
  /** t = slope / slopeStdErr, for testing slope != 0. */
  tStatistic: number;
  pValue: number;
  n: number;
}

/** Ordinary least squares fit of y on x. */
export function linearRegression(x: ArrayLike<number>, y: ArrayLike<number>): Regression {
  const n = Math.min(x.length, y.length);
  const empty: Regression = {
    slope: 0, intercept: 0, r2: 0, slopeStdErr: 0, tStatistic: 0, pValue: 1, n,
  };
  if (n < 3) return empty;

  const mx = mean(Array.from({ length: n }, (_, i) => x[i]!));
  const my = mean(Array.from({ length: n }, (_, i) => y[i]!));

  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return empty;

  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);

  // Residual variance -> standard error of the slope.
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const pred = intercept + slope * x[i]!;
    const r = y[i]! - pred;
    sse += r * r;
  }
  const df = n - 2;
  const slopeStdErr = df > 0 ? Math.sqrt(sse / df / sxx) : 0;

  /*
   * Zero residual variance means the points sit exactly on the line. The
   * t statistic is then slope/0, which is Infinity for a non-zero slope — the
   * strongest possible evidence, not the weakest. Returning t = 0 here (the
   * naive guard against dividing by zero) would report a perfect relationship
   * as perfectly insignificant, silently discarding exactly the cleanest
   * signals a dataset can contain.
   */
  let tStatistic: number;
  if (slopeStdErr > 0) {
    tStatistic = slope / slopeStdErr;
  } else {
    tStatistic = slope === 0 ? 0 : Infinity * Math.sign(slope);
  }
  const pValue = df > 0 ? twoSidedTTest(Math.abs(tStatistic), df) : 1;

  return { slope, intercept, r2, slopeStdErr, tStatistic, pValue, n };
}

export interface CorrelationResult {
  r: number;
  pValue: number;
  n: number;
}

/** Pearson product-moment correlation with a t-based significance test. */
export function pearson(x: ArrayLike<number>, y: ArrayLike<number>): CorrelationResult {
  const n = Math.min(x.length, y.length);
  if (n < 3) return { r: 0, pValue: 1, n };
  const mx = mean(Array.from({ length: n }, (_, i) => x[i]!));
  const my = mean(Array.from({ length: n }, (_, i) => y[i]!));
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return { r: 0, pValue: 1, n };
  const r = Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
  const df = n - 2;
  const denom = 1 - r * r;
  const t = denom <= 1e-12 ? Infinity : Math.abs(r) * Math.sqrt(df / denom);
  return { r, pValue: twoSidedTTest(t, df), n };
}

/**
 * Spearman rank correlation. Reported alongside Pearson because a large gap
 * between the two is a reliable signal that a "correlation" is being driven by
 * a handful of extreme points rather than a real monotone relationship.
 */
export function spearman(x: ArrayLike<number>, y: ArrayLike<number>): CorrelationResult {
  const n = Math.min(x.length, y.length);
  if (n < 3) return { r: 0, pValue: 1, n };
  const rx = rank(Array.from({ length: n }, (_, i) => x[i]!));
  const ry = rank(Array.from({ length: n }, (_, i) => y[i]!));
  return pearson(rx, ry);
}

/** Average ranks, ties share the mean of the positions they span. */
export function rank(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]!.v === idx[i]!.v) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k]!.i] = avgRank;
    i = j + 1;
  }
  return out;
}

export interface WelchResult {
  tStatistic: number;
  df: number;
  pValue: number;
  meanA: number;
  meanB: number;
  /** Cohen's d using a pooled standard deviation. */
  cohensD: number;
  nA: number;
  nB: number;
}

/**
 * Welch's t-test — unequal variances, which is the realistic case when
 * comparing segments of wildly different size.
 */
export function welchTTest(a: ArrayLike<number>, b: ArrayLike<number>): WelchResult {
  const nA = a.length, nB = b.length;
  const base: WelchResult = {
    tStatistic: 0, df: 0, pValue: 1, meanA: mean(a), meanB: mean(b), cohensD: 0, nA, nB,
  };
  if (nA < 2 || nB < 2) return base;

  const mA = mean(a), mB = mean(b);
  const vA = variance(a), vB = variance(b);
  const seSq = vA / nA + vB / nB;

  /*
   * Both groups constant. If their means also match, the samples are
   * identical and there is nothing to detect. If the means differ, the groups
   * are perfectly separated with no overlap whatsoever — the strongest
   * possible evidence of a difference. Falling through to the "no result"
   * base case would report a clean regime change as no change at all.
   */
  if (seSq <= 0) {
    if (mA === mB) return { ...base, meanA: mA, meanB: mB };
    const pooledSdZero = Math.sqrt(((nA - 1) * vA + (nB - 1) * vB) / (nA + nB - 2));
    return {
      tStatistic: Infinity * Math.sign(mA - mB),
      df: nA + nB - 2,
      pValue: 0,
      meanA: mA,
      meanB: mB,
      // Cohen's d is unbounded here; cap it so downstream formatting and
      // scoring stay finite. Anything past 10 is "as separated as it gets".
      cohensD: pooledSdZero === 0 ? 10 * Math.sign(mA - mB) : (mA - mB) / pooledSdZero,
      nA,
      nB,
    };
  }

  const t = (mA - mB) / Math.sqrt(seSq);
  // Welch–Satterthwaite degrees of freedom.
  const df =
    (seSq * seSq) /
    ((vA * vA) / (nA * nA * (nA - 1)) + (vB * vB) / (nB * nB * (nB - 1)));

  const pooledSd = Math.sqrt(((nA - 1) * vA + (nB - 1) * vB) / (nA + nB - 2));
  const cohensD = pooledSd === 0 ? 0 : (mA - mB) / pooledSd;

  return {
    tStatistic: t,
    df,
    pValue: twoSidedTTest(Math.abs(t), df),
    meanA: mA,
    meanB: mB,
    cohensD,
    nA,
    nB,
  };
}

// ---------------------------------------------------------------------------
// Distributions
// ---------------------------------------------------------------------------

/** Two-sided p-value for Student's t with `df` degrees of freedom. */
export function twoSidedTTest(absT: number, df: number): number {
  if (!isFinite(absT)) return 0;
  if (df <= 0) return 1;
  // p = I_{df/(df+t^2)}(df/2, 1/2) via the regularised incomplete beta.
  const x = df / (df + absT * absT);
  return clampP(regularisedIncompleteBeta(x, df / 2, 0.5));
}

/** Two-sided p-value for a standard normal deviate. */
export function normalTwoSided(z: number): number {
  return clampP(2 * (1 - normalCdf(Math.abs(z))));
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Abramowitz & Stegun 7.1.26, max abs error 1.5e-7. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

function clampP(p: number): number {
  if (!isFinite(p)) return 1;
  return Math.min(1, Math.max(0, p));
}

/** Log-gamma, Lanczos approximation (g=7, n=9). */
export function logGamma(z: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    // Reflection formula.
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  z -= 1;
  let x = c[0]!;
  for (let i = 1; i < g + 2; i++) x += c[i]! / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Regularised incomplete beta I_x(a,b), by continued fraction (Lentz's
 * algorithm), with the standard symmetry swap for convergence.
 */
export function regularisedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta);
  // Converges quickly only on this side; otherwise use I_x(a,b) = 1 - I_{1-x}(b,a).
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - regularisedIncompleteBeta(1 - x, b, a);
  }
  return (front * betaContinuedFraction(x, a, b)) / a;
}

function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-30;
  const maxIter = 300;
  const eps = 3e-12;

  let f = 1, c = 1, d = 0;
  for (let i = 0; i <= maxIter; i++) {
    const m = Math.floor(i / 2);
    let numerator: number;
    if (i === 0) {
      numerator = 1;
    } else if (i % 2 === 0) {
      numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    } else {
      numerator = (-((a + m) * (a + b + m)) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    }

    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;

    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;

    const delta = c * d;
    f *= delta;
    if (Math.abs(1 - delta) < eps) break;
  }
  return f - 1;
}

/** Chi-square survival function, for independence tests. */
export function chiSquarePValue(chi2: number, df: number): number {
  if (df <= 0 || chi2 <= 0) return 1;
  return clampP(1 - lowerRegularisedGamma(df / 2, chi2 / 2));
}

/** Regularised lower incomplete gamma P(s,x). */
export function lowerRegularisedGamma(s: number, x: number): number {
  if (x < 0 || s <= 0) return 0;
  if (x === 0) return 0;
  if (x < s + 1) {
    // Series expansion.
    let sum = 1 / s;
    let term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (s + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return sum * Math.exp(-x + s * Math.log(x) - logGamma(s));
  }
  // Continued fraction for the upper function, then complement.
  const tiny = 1e-300;
  let b = x + 1 - s;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  const q = Math.exp(-x + s * Math.log(x) - logGamma(s)) * h;
  return 1 - q;
}

/**
 * Benjamini–Hochberg step-up procedure. The agent tests many hypotheses at
 * once, so raw p-values would produce a steady drip of false "insights";
 * this controls the expected share of false discoveries instead.
 *
 * Returns, for each input p-value, the adjusted (q) value in original order.
 */
export function benjaminiHochberg(pValues: number[]): number[] {
  const n = pValues.length;
  if (n === 0) return [];
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const q = new Array<number>(n);
  let prev = 1;
  for (let k = n - 1; k >= 0; k--) {
    const entry = order[k]!;
    const adjusted = Math.min(prev, (entry.p * n) / (k + 1));
    q[entry.i] = Math.min(1, adjusted);
    prev = adjusted;
  }
  return q;
}

/**
 * Herfindahl–Hirschman index on shares, 0..1. 1 means a single value holds
 * everything; 1/n means perfectly even.
 */
export function herfindahl(shares: number[]): number {
  let h = 0;
  for (const s of shares) h += s * s;
  return h;
}

/** Gini coefficient of a non-negative distribution, 0..1. */
export function gini(values: number[]): number {
  const xs = values.filter((v) => v >= 0 && isFinite(v)).sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return 0;
  const total = xs.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i + 1) * xs[i]!;
  return (2 * cum) / (n * total) - (n + 1) / n;
}

/**
 * Robust z-scores using median and MAD. Falls back to the classical z-score
 * when MAD is zero (a majority-constant series), which is flagged by the
 * `robust` field so callers can weaken their confidence accordingly.
 */
export function robustZScores(xs: number[]): { scores: number[]; robust: boolean; centre: number; scale: number } {
  const centre = median(xs);
  let scale = mad(xs);
  let robust = true;
  if (scale < 1e-12) {
    scale = stdev(xs);
    robust = false;
  }
  if (scale < 1e-12) {
    return { scores: xs.map(() => 0), robust: false, centre, scale: 0 };
  }
  return { scores: xs.map((v) => (v - centre) / scale), robust, centre, scale };
}

/**
 * Single most likely level-shift changepoint, by maximising the Welch t
 * statistic over all interior split points. Returns null when no split beats
 * the significance threshold.
 */
export function findChangepoint(
  xs: number[],
  /**
   * Minimum points on each side. Defaults to 15% of the series: a split four
   * points from the end is almost always the tail of a trend rather than a
   * regime change, and reporting it as one is worse than reporting nothing.
   */
  minSegment = Math.max(4, Math.floor(xs.length * 0.15)),
  alpha = 0.01,
): { index: number; tStatistic: number; pValue: number; meanBefore: number; meanAfter: number } | null {
  if (xs.length < minSegment * 2) return null;
  let best: { index: number; t: number; p: number; mb: number; ma: number } | null = null;
  for (let i = minSegment; i <= xs.length - minSegment; i++) {
    const left = xs.slice(0, i);
    const right = xs.slice(i);
    const res = welchTTest(left, right);
    const absT = Math.abs(res.tStatistic);
    if (!best || absT > best.t) {
      best = { index: i, t: absT, p: res.pValue, mb: res.meanA, ma: res.meanB };
    }
  }
  if (!best) return null;
  // Bonferroni over the candidate split points we searched.
  const candidates = xs.length - 2 * minSegment + 1;
  const adjusted = Math.min(1, best.p * candidates);
  if (adjusted > alpha) return null;
  return {
    index: best.index,
    tStatistic: best.t,
    pValue: adjusted,
    meanBefore: best.mb,
    meanAfter: best.ma,
  };
}
