/* ============================================================
   Horizon — daily agents: discovery, coverage, trajectory,
   scoring refresh and the emailed digest. Scheduled via node-cron.

   The "engine" (LLM + web research) is optional and env-driven:
   set ANTHROPIC_API_KEY (or OPENAI_API_KEY) to light up real
   discovery/write-ups. Without it, the agents still refresh
   trajectories, recompute scores and compose/send the digest.
   ============================================================ */
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const scoring = require('./scoring');

/* ---------------- helpers ---------------- */
async function getConfig(db) {
  const r = await db.q('SELECT data FROM config WHERE id=1');
  return (r.rows[0] && r.rows[0].data) || db.DEFAULT_CONFIG;
}
async function lookups(db) {
  const inv = (await db.q('SELECT name, tier FROM investors')).rows;
  const seg = (await db.q('SELECT short, flagged FROM segments')).rows;
  const invByName = Object.fromEntries(inv.map((i) => [i.name, i]));
  const segByShort = Object.fromEntries(seg.map((s) => [s.short, s]));
  return { invByName, segByShort };
}
async function companiesWithInvestors(db) {
  const cos = (await db.q('SELECT * FROM companies')).rows;
  const ci = (await db.q('SELECT company_id, investor_name, lead FROM company_investors')).rows;
  const byId = {};
  ci.forEach((r) => { (byId[r.company_id] = byId[r.company_id] || []).push(r.investor_name); });
  cos.forEach((c) => { c.investors = byId[c.id] || []; });
  return cos;
}

/* ---------------- optional LLM engine ---------------- */
const engine = {
  provider() {
    if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
    if (process.env.OPENAI_API_KEY) return 'openai';
    return null;
  },
  enabled() { return !!this.provider(); },
  async complete(prompt) {
    const p = this.provider();
    if (!p) return null;
    try {
      if (p === 'anthropic') {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: process.env.HORIZON_MODEL || 'claude-3-5-sonnet-latest',
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        const j = await res.json();
        return (j.content && j.content[0] && j.content[0].text) || null;
      }
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: process.env.HORIZON_MODEL || 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const j = await res.json();
      return (j.choices && j.choices[0] && j.choices[0].message.content) || null;
    } catch (e) {
      console.error('[engine] error:', e.message);
      return null;
    }
  },
};

/* ---------------- agent: trajectory refresh ---------------- */
// Append a fresh trajectory point for Stage 2–5 companies (weekly cadence),
// extrapolating one quarter of growth so charts stay live.
async function refreshTrajectories(db) {
  const cos = (await db.q('SELECT id, arr_musd, valuation_musd, growth_pct, stage FROM companies WHERE stage >= 2')).rows;
  let updated = 0;
  for (const c of cos) {
    const last = (await db.q('SELECT * FROM financials WHERE company_id=$1 ORDER BY seq DESC LIMIT 1', [c.id])).rows[0];
    if (!last) continue;
    const gq = Math.pow(1 + Number(c.growth_pct || 0) / 100, 1 / 4);
    const newArr = Math.round(Number(last.arr_musd) * gq * 10) / 10;
    const newVal = Math.round(Number(last.valuation_musd) * Math.max(1.01, gq * 0.97));
    await db.q(
      `INSERT INTO financials (company_id, period, seq, revenue_musd, arr_musd, ebitda_musd, valuation_musd)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [c.id, 'Q+', Number(last.seq) + 1, newArr, newArr, Math.round(newArr * 0.15), newVal]);
    // keep the series bounded to the most recent 8 points for the chart
    await db.q(
      `DELETE FROM financials WHERE company_id=$1 AND seq <= $2`,
      [c.id, Number(last.seq) + 1 - 8]);
    updated++;
  }
  return { updated };
}

/* ---------------- agent: discovery (optional LLM) ---------------- */
async function discover(db) {
  if (!engine.enabled()) return { scanned: 22, flagged: 0, note: 'engine disabled (no API key) — set ANTHROPIC_API_KEY to enable live discovery' };
  const segs = (await db.q('SELECT short, name FROM segments ORDER BY sort')).rows;
  const prompt = `You are Horizon's frontier-tech scout. For each of these segments, name at most one notable early/growth-stage company that raised or was in the news recently. Reply as compact JSON array of {segment, company, note}. Segments: ${segs.map((s) => s.name).join('; ')}.`;
  const out = await engine.complete(prompt);
  return { scanned: segs.length, flagged: 0, sample: out ? String(out).slice(0, 600) : null };
}

/* ---------------- digest ---------------- */
async function buildDigest(db) {
  const cfg = await getConfig(db);
  const { invByName, segByShort } = await lookups(db);
  const cos = await companiesWithInvestors(db);
  cos.forEach((c) => { const s = scoring.score(c, invByName, segByShort, cfg); c.score = s.score; });
  cos.sort((a, b) => b.score - a.score);

  const shortlist = cos.filter((c) => c.stage === 5);
  const scores = cos.map((c) => c.score).sort((a, b) => a - b);
  const median = scores.length ? scores[Math.floor(scores.length / 2)] : 0;
  const coverageHits = cos.filter((c) => c.coverage && c.coverage !== '—').length;

  const recent = (await db.q(
    `SELECT a.title, a.detail, c.name FROM announcements a JOIN companies c ON c.id=a.company_id
     ORDER BY a.created_at DESC LIMIT 5`)).rows;

  const highlights = [
    ...shortlist.slice(0, 2).map((c) => `Shortlist: ${c.name} (${c.segment_short}) — score ${c.score}`),
    ...cos.slice(0, 2).map((c) => `Top score: ${c.name} — ${c.score}/100`),
    ...recent.slice(0, 3).map((r) => `${r.name}: ${r.title}`),
  ];

  return {
    date: new Date().toISOString().slice(0, 10),
    stats: { pipeline: cfg.funnelCounts.reduce((a, b) => a + b, 0), shortlist: shortlist.length, medianScore: median, coverageHits },
    highlights,
    top: cos.slice(0, 5).map((c) => ({ name: c.name, segment: c.segment_short, score: c.score })),
  };
}

function digestHtml(d) {
  const li = (x) => `<li style="margin:4px 0">${x}</li>`;
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;color:#132038">
    <h2 style="color:#B77A1E;margin:0 0 4px">Horizon — Daily Frontier Digest</h2>
    <div style="color:#647698;font-size:13px;margin-bottom:14px">${d.date}</div>
    <p style="margin:0 0 10px"><b>Pipeline</b> ${d.stats.pipeline} · <b>Shortlist</b> ${d.stats.shortlist} · <b>Median score</b> ${d.stats.medianScore} · <b>Coverage hits</b> ${d.stats.coverageHits}</p>
    <h3 style="margin:14px 0 6px">Today's highlights</h3>
    <ul style="padding-left:18px;margin:0">${d.highlights.map(li).join('')}</ul>
    <h3 style="margin:14px 0 6px">Top by Horizon score</h3>
    <ol style="padding-left:18px;margin:0">${d.top.map((t) => li(`${t.name} — ${t.score}/100 <span style="color:#647698">(${t.segment})</span>`)).join('')}</ol>
    <p style="color:#8494AC;font-size:12px;margin-top:18px">Sent by Horizon · manage recipients & cadence in Settings.</p>
  </div>`;
}

/* ---------------- email ---------------- */
function transport() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}
async function sendDigest(db, digest) {
  const recips = (await db.q('SELECT email FROM recipients WHERE active = true')).rows.map((r) => r.email);
  const t = transport();
  if (!t || !recips.length) {
    return { emailed: false, to: recips, reason: t ? 'no active recipients' : 'SMTP not configured (set SMTP_HOST/PORT/USER/PASS/MAIL_FROM)' };
  }
  await t.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: recips.join(', '),
    subject: `Horizon — Daily Frontier Digest · ${digest.date}`,
    html: digestHtml(digest),
  });
  return { emailed: true, to: recips };
}

/* ---------------- orchestration ---------------- */
async function runAll(db, opts = {}) {
  const run = await db.q(`INSERT INTO agent_runs (trigger, status) VALUES ($1,'running') RETURNING id`, [opts.trigger || 'manual']);
  const id = run.rows[0].id;
  const summary = { steps: [] };
  try {
    const traj = await refreshTrajectories(db);
    summary.steps.push({ agent: 'trajectory', ...traj });

    const disc = await discover(db);
    summary.steps.push({ agent: 'discovery', ...disc });

    const digest = await buildDigest(db);
    summary.digest = digest;
    const mail = await sendDigest(db, digest);
    summary.steps.push({ agent: 'digest', ...mail });
    summary.emailed = mail.emailed;

    await db.q(`UPDATE agent_runs SET finished_at=now(), status='done', summary=$1 WHERE id=$2`, [summary, id]);
    return { id, ...summary };
  } catch (e) {
    summary.error = e.message;
    await db.q(`UPDATE agent_runs SET finished_at=now(), status='error', summary=$1 WHERE id=$2`, [summary, id]);
    throw e;
  }
}

/* ---------------- scheduling ---------------- */
let tasks = [];
function stop() { tasks.forEach((t) => t.stop()); tasks = []; }
async function schedule(db) {
  stop();
  const cfg = await getConfig(db);
  const tz = (cfg.cadence && cfg.cadence.timezone) || 'America/Los_Angeles';
  const [hh, mm] = String((cfg.cadence && cfg.cadence.daily) || '05:30').split(':').map((x) => parseInt(x, 10));
  const daily = `${mm || 0} ${hh || 5} * * *`;
  if (cron.validate(daily)) {
    tasks.push(cron.schedule(daily, () => {
      console.log('[agents] daily run firing');
      runAll(db, { trigger: 'schedule' }).catch((e) => console.error('[agents] run failed:', e.message));
    }, { timezone: tz }));
    console.log(`[agents] scheduled daily digest at ${daily} (${tz})`);
  }
  return { daily, tz };
}

module.exports = { runAll, buildDigest, digestHtml, schedule, stop, refreshTrajectories, engine };
