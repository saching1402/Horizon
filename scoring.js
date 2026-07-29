/* ============================================================
   Horizon — deterministic weighted scoring engine.
   Produces a 0–100 Horizon score plus a six-factor breakdown.
   ============================================================ */

function clamp(v, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, v)); }

/**
 * @param co        { valuation_musd, arr_musd, growth_pct, coverage, investors:[names], segment_short }
 * @param invByName { name: {tier} }
 * @param segByShort{ short: {flagged} }
 * @param config    { weights, tierMultipliers }
 */
function subScores(co, invByName, segByShort, config) {
  const growth = clamp(Number(co.growth_pct || 0) / 3.6);
  const val = clamp(100 - Math.min(70, Number(co.valuation_musd || 0) / 800));

  const tm = (config && config.tierMultipliers) || { '1': 3, '2': 2, '3': 1.3 };
  let invPts = 0;
  (co.investors || []).forEach((n) => {
    const tier = (invByName[n] && invByName[n].tier) || 3;
    // higher-tier funds contribute more
    invPts += tier === 1 ? 12 * (tm['1'] || 3) : tier === 2 ? 9 * (tm['2'] || 2) : 8 * (tm['3'] || 1.3);
  });
  const inv = clamp(40 + invPts);

  const covered = co.coverage && co.coverage !== '—' && co.coverage.trim() !== '';
  const cover = covered ? clamp(70 + (String(co.coverage).split(',').length) * 5) : 40;

  const flagged = (segByShort[co.segment_short] && segByShort[co.segment_short].flagged) || 0;
  const seg = clamp(58 + flagged * 0.9);

  const mom = clamp(52 + Number(co.growth_pct || 0) / 7);

  return { growth, inv, cover, seg, mom, val };
}

function overall(sub, config) {
  const w = (config && config.weights) || { growth: 25, investors: 20, coverage: 20, valuation: 15, segment: 10, momentum: 10 };
  const map = { growth: sub.growth, investors: sub.inv, coverage: sub.cover, valuation: sub.val, segment: sub.seg, momentum: sub.mom };
  let num = 0, den = 0;
  for (const k of Object.keys(map)) { const wk = Number(w[k] || 0); num += map[k] * wk; den += wk; }
  return den ? Math.round(num / den) : 0;
}

function score(co, invByName, segByShort, config) {
  const sub = subScores(co, invByName, segByShort, config);
  return { score: overall(sub, config), sc: sub };
}

module.exports = { score, subScores, overall };
