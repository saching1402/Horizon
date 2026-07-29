/* ============================================================
   Horizon — Express API + static frontend + agent scheduler.
   ============================================================ */
const path = require('path');
const express = require('express');
const db = require('./db');
const scoring = require('./scoring');
const agents = require('./agents');

const app = express();
app.use(express.json({ limit: '2mb' }));

let DB_READY = false;

/* ---------------- shaping helpers ---------------- */
async function getConfig() {
  const r = await db.q('SELECT data FROM config WHERE id=1');
  return (r.rows[0] && r.rows[0].data) || db.DEFAULT_CONFIG;
}
async function getLookups() {
  const inv = (await db.q('SELECT * FROM investors ORDER BY tier, name')).rows;
  const seg = (await db.q('SELECT * FROM segments ORDER BY sort')).rows;
  return {
    investors: inv,
    segments: seg,
    invByName: Object.fromEntries(inv.map((i) => [i.name, i])),
    segByShort: Object.fromEntries(seg.map((s) => [s.short, s])),
  };
}
function shapeInvestor(i) {
  return { n: i.name, t: i.tier, aum: i.aum, hq: i.hq, stage: i.stage, geo: i.geo, focus: i.focus || [], partners: i.partners || [], desc: i.description, media: i.media };
}
async function investorsFor(companyIds) {
  if (!companyIds.length) return {};
  const rows = (await db.q('SELECT company_id, investor_name, lead FROM company_investors WHERE company_id = ANY($1)', [companyIds])).rows;
  const map = {};
  rows.forEach((r) => { (map[r.company_id] = map[r.company_id] || []).push(r.investor_name); });
  return map;
}
async function historyFor(companyIds) {
  if (!companyIds.length) return {};
  const rows = (await db.q('SELECT company_id, seq, arr_musd, valuation_musd FROM financials WHERE company_id = ANY($1) ORDER BY seq ASC', [companyIds])).rows;
  const map = {};
  rows.forEach((r) => {
    const m = (map[r.company_id] = map[r.company_id] || { rev: [], val: [] });
    m.rev.push(Number(r.arr_musd)); m.val.push(Number(r.valuation_musd));
  });
  return map;
}
async function shapeCompanies(cfg, look) {
  const cos = (await db.q('SELECT * FROM companies ORDER BY name')).rows;
  const ids = cos.map((c) => c.id);
  const invMap = await investorsFor(ids);
  const histMap = await historyFor(ids);
  return cos.map((c) => {
    const investors = invMap[c.id] || [];
    const s = scoring.score({ ...c, investors }, look.invByName, look.segByShort, cfg);
    const h = histMap[c.id] || { rev: [], val: [] };
    return {
      id: c.id,
      name: c.name,
      seg: c.segment_short,
      stage: c.stage,
      valn: Number(c.valuation_musd),
      val: db.fmtUsd(c.valuation_musd),
      arr: db.fmtUsd(c.arr_musd),
      growth: Number(c.growth_pct),
      coverage: c.coverage || '—',
      round: c.round,
      hq: c.hq,
      flagged: c.personally_flagged,
      notes: c.notes || '',
      investors,
      score: s.score,
      sc: s.sc,
      revHist: h.rev.slice(-8),
      valHist: h.val.slice(-8),
    };
  });
}

/* ---------------- routes ---------------- */
app.get('/api/health', async (req, res) => {
  let dbok = false;
  try { await db.q('SELECT 1'); dbok = true; } catch (_) {}
  res.json({ ok: true, db: dbok, ready: DB_READY });
});

function guard(req, res, next) {
  if (!DB_READY) return res.status(503).json({ error: 'database initialising — retry shortly' });
  next();
}

app.get('/api/bootstrap', guard, async (req, res, next) => {
  try {
    const cfg = await getConfig();
    const look = await getLookups();
    const companies = await shapeCompanies(cfg, look);
    const stages = (cfg.stages || db.DEFAULT_CONFIG.stages).map((s, i) => ({
      id: s.id, short: s.short, full: s.full, c: `var(--s${s.id})`,
      count: (cfg.funnelCounts && cfg.funnelCounts[i]) || companies.filter((c) => c.stage === s.id).length,
    }));
    const segments = look.segments.map((s) => [s.short, s.name, s.flagged]);
    const investors = look.investors.map(shapeInvestor);
    const recipients = (await db.q('SELECT id,email,role,active FROM recipients ORDER BY id')).rows;
    const sources = (await db.q('SELECT id,kind,name,detail,reliability,url FROM sources ORDER BY id')).rows;
    const lastRun = (await db.q(`SELECT summary FROM agent_runs WHERE status='done' ORDER BY id DESC LIMIT 1`)).rows[0];
    res.json({ stages, segments, investors, companies, recipients, sources, config: cfg, digest: lastRun ? lastRun.summary.digest : null });
  } catch (e) { next(e); }
});

app.get('/api/companies/:id', guard, async (req, res, next) => {
  try {
    const c = (await db.q('SELECT * FROM companies WHERE id=$1', [req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: 'not found' });
    const financials = (await db.q('SELECT * FROM financials WHERE company_id=$1 ORDER BY seq', [c.id])).rows;
    const announcements = (await db.q('SELECT * FROM announcements WHERE company_id=$1 ORDER BY created_at DESC', [c.id])).rows;
    const investors = (await db.q('SELECT investor_name, lead FROM company_investors WHERE company_id=$1', [c.id])).rows;
    res.json({ ...c, financials, announcements, investors });
  } catch (e) { next(e); }
});

app.post('/api/companies', guard, async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await db.q(
      `INSERT INTO companies (name, segment_short, stage, valuation_musd, arr_musd, growth_pct, coverage, round, hq, personally_flagged)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [b.name, b.segment_short || b.seg, b.stage || 1, b.valuation_musd || 0, b.arr_musd || 0, b.growth_pct || 0, b.coverage || '—', b.round || '', b.hq || '', !!b.personally_flagged]);
    const id = r.rows[0].id;
    for (let k = 0; k < (b.investors || []).length; k++) {
      await db.q('INSERT INTO company_investors (company_id, investor_name, lead) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, b.investors[k], k === 0]);
    }
    res.json({ id });
  } catch (e) { next(e); }
});

app.patch('/api/companies/:id', guard, async (req, res, next) => {
  try {
    const b = req.body || {};
    const fields = [], vals = [];
    ['stage', 'valuation_musd', 'arr_musd', 'growth_pct', 'coverage', 'round', 'hq', 'notes', 'personally_flagged', 'segment_short']
      .forEach((k) => { if (b[k] !== undefined) { vals.push(b[k]); fields.push(`${k}=$${vals.length}`); } });
    if (b.flag) { vals.push(4); fields.push(`stage=$${vals.length}`); vals.push(true); fields.push(`personally_flagged=$${vals.length}`); }
    if (!fields.length) return res.json({ ok: true });
    vals.push(req.params.id);
    await db.q(`UPDATE companies SET ${fields.join(', ')}, updated_at=now() WHERE id=$${vals.length}`, vals);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.delete('/api/companies/:id', guard, async (req, res, next) => {
  try { await db.q('DELETE FROM companies WHERE id=$1', [req.params.id]); res.json({ ok: true }); } catch (e) { next(e); }
});

app.get('/api/investors', guard, async (req, res, next) => {
  try { res.json((await db.q('SELECT * FROM investors ORDER BY tier, name')).rows.map(shapeInvestor)); } catch (e) { next(e); }
});
app.post('/api/investors', guard, async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await db.q(
      `INSERT INTO investors (name, tier, aum, hq, stage, geo, focus, partners, description, media)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (name) DO UPDATE SET tier=EXCLUDED.tier, aum=EXCLUDED.aum, hq=EXCLUDED.hq, stage=EXCLUDED.stage,
         geo=EXCLUDED.geo, focus=EXCLUDED.focus, partners=EXCLUDED.partners, description=EXCLUDED.description, media=EXCLUDED.media
       RETURNING id`,
      [b.name, b.tier || 3, b.aum, b.hq, b.stage, b.geo, b.focus || [], b.partners || [], b.description || b.desc, b.media]);
    res.json({ id: r.rows[0].id });
  } catch (e) { next(e); }
});
app.delete('/api/investors/:id', guard, async (req, res, next) => {
  try { await db.q('DELETE FROM investors WHERE id=$1', [req.params.id]); res.json({ ok: true }); } catch (e) { next(e); }
});

app.get('/api/segments', guard, async (req, res, next) => {
  try { res.json((await db.q('SELECT * FROM segments ORDER BY sort')).rows); } catch (e) { next(e); }
});
app.patch('/api/segments/:short', guard, async (req, res, next) => {
  try {
    const b = req.body || {};
    await db.q('UPDATE segments SET flagged=COALESCE($1,flagged), blurb=COALESCE($2,blurb), signal=COALESCE($3,signal) WHERE short=$4',
      [b.flagged, b.blurb, b.signal, req.params.short]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.get('/api/sources', guard, async (req, res, next) => {
  try { res.json((await db.q('SELECT * FROM sources ORDER BY id')).rows); } catch (e) { next(e); }
});
app.post('/api/sources', guard, async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await db.q('INSERT INTO sources (kind, name, detail, reliability, url) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [b.kind || 'link', b.name, b.detail || '', b.reliability || 'medium', b.url || null]);
    res.json({ id: r.rows[0].id });
  } catch (e) { next(e); }
});
app.delete('/api/sources/:id', guard, async (req, res, next) => {
  try { await db.q('DELETE FROM sources WHERE id=$1', [req.params.id]); res.json({ ok: true }); } catch (e) { next(e); }
});

app.get('/api/recipients', guard, async (req, res, next) => {
  try { res.json((await db.q('SELECT * FROM recipients ORDER BY id')).rows); } catch (e) { next(e); }
});
app.post('/api/recipients', guard, async (req, res, next) => {
  try {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'invalid email' });
    const r = await db.q('INSERT INTO recipients (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET active=true RETURNING *', [email]);
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});
app.delete('/api/recipients/:id', guard, async (req, res, next) => {
  try { await db.q('DELETE FROM recipients WHERE id=$1 AND role<>$2', [req.params.id, 'owner']); res.json({ ok: true }); } catch (e) { next(e); }
});

app.get('/api/config', guard, async (req, res, next) => { try { res.json(await getConfig()); } catch (e) { next(e); } });
app.put('/api/config', guard, async (req, res, next) => {
  try {
    const cur = await getConfig();
    const merged = { ...cur, ...(req.body || {}) };
    await db.q('UPDATE config SET data=$1, updated_at=now() WHERE id=1', [merged]);
    await agents.schedule(db); // re-arm cron if cadence changed
    res.json(merged);
  } catch (e) { next(e); }
});

app.get('/api/agents/runs', guard, async (req, res, next) => {
  try { res.json((await db.q('SELECT id, started_at, finished_at, status, trigger, summary FROM agent_runs ORDER BY id DESC LIMIT 20')).rows); } catch (e) { next(e); }
});
app.post('/api/agents/run', guard, async (req, res, next) => {
  try { const r = await agents.runAll(db, { trigger: 'manual' }); res.json(r); } catch (e) { next(e); }
});
app.get('/api/digest/latest', guard, async (req, res, next) => {
  try { const d = await agents.buildDigest(db); res.json(d); } catch (e) { next(e); }
});

/* ---------------- static + SPA fallback ---------------- */
app.use(express.static(path.join(__dirname, 'public')));
app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ---------------- error handler ---------------- */
app.use((err, req, res, next) => {
  console.error('[api] error:', err.message);
  res.status(500).json({ error: err.message });
});

/* ---------------- boot ---------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[horizon] listening on :${PORT}`));

async function initWithRetry(attempt = 1) {
  try {
    await db.init();
    DB_READY = true;
    await agents.schedule(db);
    console.log('[horizon] database ready');
  } catch (e) {
    const wait = Math.min(30000, 2000 * attempt);
    console.error(`[horizon] db init failed (attempt ${attempt}): ${e.message} — retrying in ${wait}ms`);
    setTimeout(() => initWithRetry(attempt + 1), wait);
  }
}
if (process.env.DATABASE_URL) initWithRetry();
else console.warn('[horizon] DATABASE_URL not set — API will return 503 until configured');
