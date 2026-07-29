/* ============================================================
   Horizon — PostgreSQL layer: pool, schema, migration & seed.
   ============================================================ */
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
// Railway's private network needs no SSL; public URLs do. Default off,
// set PGSSL=true (or use a non-local host with PGSSL unset -> ssl on).
let ssl = false;
if (process.env.PGSSL === 'true') ssl = { rejectUnauthorized: false };
else if (process.env.PGSSL === 'false') ssl = false;
else if (connectionString && !/localhost|127\.0\.0\.1|\.railway\.internal/.test(connectionString)) {
  ssl = { rejectUnauthorized: false };
}

const pool = new Pool({ connectionString, ssl });
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

async function q(text, params) {
  const res = await pool.query(text, params);
  return res;
}

/* ---------------------- schema ---------------------- */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS config (
  id INT PRIMARY KEY DEFAULT 1,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT config_singleton CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS segments (
  id SERIAL PRIMARY KEY,
  short TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  flagged INT DEFAULT 0,
  blurb TEXT,
  signal TEXT,
  sort INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS investors (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  tier INT NOT NULL DEFAULT 3,
  aum TEXT,
  hq TEXT,
  stage TEXT,
  geo TEXT,
  focus TEXT[] DEFAULT '{}',
  partners TEXT[] DEFAULT '{}',
  description TEXT,
  media TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  segment_short TEXT REFERENCES segments(short),
  stage INT NOT NULL DEFAULT 1,
  valuation_musd NUMERIC,
  arr_musd NUMERIC,
  growth_pct NUMERIC,
  coverage TEXT,
  round TEXT,
  hq TEXT,
  personally_flagged BOOLEAN DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS company_investors (
  company_id INT REFERENCES companies(id) ON DELETE CASCADE,
  investor_name TEXT NOT NULL,
  lead BOOLEAN DEFAULT false,
  PRIMARY KEY (company_id, investor_name)
);

CREATE TABLE IF NOT EXISTS financials (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  seq INT NOT NULL,
  revenue_musd NUMERIC,
  arr_musd NUMERIC,
  ebitda_musd NUMERIC,
  valuation_musd NUMERIC
);

CREATE TABLE IF NOT EXISTS announcements (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies(id) ON DELETE CASCADE,
  at TEXT,
  title TEXT,
  detail TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sources (
  id SERIAL PRIMARY KEY,
  kind TEXT,
  name TEXT NOT NULL,
  detail TEXT,
  reliability TEXT DEFAULT 'medium',
  url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recipients (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  role TEXT DEFAULT 'member',
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id SERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT DEFAULT 'running',
  trigger TEXT DEFAULT 'schedule',
  summary JSONB
);

CREATE INDEX IF NOT EXISTS idx_companies_stage ON companies(stage);
CREATE INDEX IF NOT EXISTS idx_companies_segment ON companies(segment_short);
CREATE INDEX IF NOT EXISTS idx_financials_company ON financials(company_id);
CREATE INDEX IF NOT EXISTS idx_ci_company ON company_investors(company_id);
`;

/* ---------------------- default config ---------------------- */
const DEFAULT_CONFIG = {
  weights: { growth: 25, investors: 20, coverage: 20, valuation: 15, segment: 10, momentum: 10 },
  tierMultipliers: { '1': 3.0, '2': 2.0, '3': 1.3 },
  funnelCounts: [487, 163, 64, 29, 12],
  stages: [
    { id: 1, short: 'Web-Flagged', full: 'Flagged through web analysis' },
    { id: 2, short: 'VC-Backed', full: 'Invested by marquee early-stage managers' },
    { id: 3, short: 'Leader-Quoted', full: 'Quoted by hyperscalers / NVIDIA / pharma leaders' },
    { id: 4, short: 'My Flag', full: 'Personally flagged or added' },
    { id: 5, short: 'Shortlist', full: 'Final key shortlist' },
  ],
  cadence: { daily: '05:30', timezone: 'America/Los_Angeles', trajectory: 'weekly', deep: 'monthly' },
  sourceWeights: { investor: 78, reports: 70, youtube: 52, social: 40 },
};

/* ---------------------- seed data ---------------------- */
const SEG = [
  ['Frontier AI', 'Frontier AI Models', 38, 'Frontier model labs & foundational research spinouts.', 'hot'],
  ['Agentic', 'Agentic AI Apps', 44, 'Autonomous agents & agentic workflow companies.', 'hot'],
  ['Infra', 'Infra-layer AI', 31, 'Inference, serving, orchestration & the data layer.', 'rising'],
  ['Semis', 'Semiconductor Value Chain', 36, 'Memory, compute, alternative architectures & custom silicon.', 'hot'],
  ['Quantum', 'Quantum Computing', 17, 'Gate-model, neutral-atom & photonic quantum.', 'watch'],
  ['Robotics', 'Robotics', 26, 'Humanoids & foundation models for physical control.', 'hot'],
  ['Drug Disc.', 'Drug Discovery', 22, 'AI-native therapeutics & computational biology.', 'rising'],
  ['Quant Models', 'Large Quant Models', 9, 'Large quantitative & financial world models.', 'watch'],
  ['Defense', 'Defense Tech', 19, 'Autonomy, sensing & defense platforms.', 'hot'],
  ['Vector DB', 'Vector Databases', 8, 'Vector & retrieval infrastructure.', 'watch'],
  ['AI Apps', 'AI-Native Applications', 41, 'Vertical AI-native software.', 'rising'],
  ['Compute Mkt', 'Compute Marketplaces', 12, 'GPU clouds & compute marketplaces.', 'hot'],
  ['AV', 'Autonomous Vehicles', 15, 'Self-driving & embodied autonomy.', 'rising'],
  ['World Models', 'Large World Models', 7, 'Spatial intelligence & world models.', 'watch'],
  ['AI Tooling', 'AI Tooling', 23, 'Dev tools, eval & observability for AI.', 'rising'],
  ['AI Services', 'AI Services', 14, 'AI-enabled services businesses.', 'watch'],
  ['Materials', 'Material Discovery', 10, 'AI-driven materials & chemistry.', 'watch'],
  ['Energy', 'Energy / Nuclear for Compute', 13, 'Power for data centers — nuclear, behind-the-meter.', 'rising'],
  ['Water/Min', 'Water & Critical Minerals', 6, 'Critical minerals & water for the compute buildout.', 'watch'],
  ['Next-Gen HW', 'Next-Generation Hardware', 11, 'Photonics & novel compute hardware.', 'rising'],
  ['Space', 'Space Access', 9, 'Launch & space infrastructure.', 'watch'],
  ['Biotech', 'Biotech', 18, 'Frontier biotech platforms.', 'rising'],
];

const INV = [
  ['Founders Fund', 1, '$12.0B', 'San Francisco', 'Seed–Growth', 'Global', ['Frontier AI', 'Defense', 'Space'], ['Peter Thiel', 'Brian Singerman', 'Trae Stephens'], 'Contrarian, high-conviction fund backing hard-tech and frontier science. Concentrated, long-hold.', 'Anduril & SpaceX anchor a defense/space thesis.'],
  ['Andreessen Horowitz', 1, '$44B', 'Menlo Park', 'Seed–Growth', 'Global', ['Frontier AI', 'Agentic', 'Infra'], ['Marc Andreessen', 'Ben Horowitz', 'Martin Casado'], 'Full-stack platform fund with dedicated AI Infra & American Dynamism practices.', 'Leading AI infra rounds across the stack.'],
  ['Lightspeed', 1, '$25B', 'Menlo Park', 'Seed–Growth', 'Global', ['Infra', 'AI Apps', 'Semis'], ['Ravi Mhatre', 'Nnamdi Okike'], 'Multi-stage global platform, strong enterprise & infra franchise.', 'Active in inference & data-layer deals.'],
  ['Lux Capital', 1, '$5.3B', 'New York', 'Seed–Series B', 'US', ['Robotics', 'Quantum', 'Defense', 'Materials'], ['Josh Wolfe', 'Peter Hébert'], 'Deep-tech specialist backing science-heavy frontier categories.', 'Thesis-driven; frequent early mover in hard science.'],
  ['Thrive Capital', 1, '$15B', 'New York', 'Growth', 'US', ['Frontier AI', 'AI Apps'], ['Josh Kushner', 'Vince Hankes'], 'Concentrated growth investor; anchor positions in category leaders.', 'Large frontier-model positions.'],
  ['Radical Ventures', 1, '$1.4B', 'Toronto', 'Seed–Growth', 'Global', ['Frontier AI', 'Infra', 'Robotics'], ['Jordan Jacobs', 'Tomi Poutanen'], 'AI-native venture firm, close ties to academic AI labs.', 'Backs applied AI and foundational research spinouts.'],
  ['DCVC', 1, '$4B', 'San Francisco', 'Seed–Series B', 'US', ['Materials', 'Biotech', 'Semis'], ['Matt Ocko', 'Zachary Bogue'], 'Deep-tech & computational science across bio, materials, compute.', 'Long computational-biology track record.'],
  ['Khosla Ventures', 1, '$15B', 'Menlo Park', 'Seed–Growth', 'US', ['Frontier AI', 'Energy', 'Biotech'], ['Vinod Khosla', 'Keith Rabois'], 'Early OpenAI backer; bold bets on energy, AI and health.', 'Anchor in several frontier categories.'],
  ['Eclipse Ventures', 2, '$4B', 'Palo Alto', 'Seed–Series B', 'US', ['Robotics', 'Next-Gen HW', 'Semis'], ['Lior Susan'], 'Industrial & physical-economy deep tech.', 'Manufacturing / hardware focus.'],
  ['8VC', 2, '$6B', 'Austin', 'Seed–Growth', 'US', ['Defense', 'Biotech', 'AI Apps'], ['Joe Lonsdale'], 'Data & defense-leaning platform fund.', 'Government & bio-adjacent bets.'],
  ['IVP', 2, '$8.5B', 'Menlo Park', 'Growth', 'US', ['AI Apps', 'Infra'], ['Somesh Dash'], 'Later-stage growth franchise.', 'Scaling software leaders.'],
  ['Bessemer', 2, '$18B', 'San Francisco', 'Seed–Growth', 'Global', ['Infra', 'AI Apps', 'Space'], ['Byron Deeter'], 'Cloud & infrastructure heritage.', 'Cloud index authors.'],
  ['Index Ventures', 2, '$13B', 'London / SF', 'Seed–Growth', 'Global', ['AI Apps', 'Agentic'], ['Mike Volpi'], 'Transatlantic multi-stage platform.', 'European + US coverage.'],
  ['Jolt Capital', 3, '€1.2B', 'Paris', 'Growth', 'Europe', ['Semis', 'Next-Gen HW'], ['Jean Schmitt'], 'European growth deep-tech.', 'EU sovereignty-tech thesis.'],
];

// name, segShort, stage, valuationMusd, arrMusd, growth, coverage, round, hq, [investors]
const CO = [
  ['Mistral AI', 'Frontier AI', 4, 14000, 310, 118, 'NVIDIA, Microsoft', 'Series C', 'Paris', ['Andreessen Horowitz', 'Lightspeed', 'Founders Fund']],
  ['Cognition', 'Agentic', 5, 4200, 96, 240, 'NVIDIA, 8VC', 'Series B', 'San Francisco', ['Founders Fund', 'Thrive Capital']],
  ['Groq', 'Semis', 5, 6900, 210, 165, 'Saudi PIF, Samsung', 'Series D', 'Mountain View', ['Lightspeed', 'DCVC']],
  ['Figure AI', 'Robotics', 4, 39500, 52, 210, 'NVIDIA, OpenAI, Microsoft', 'Series C', 'Sunnyvale', ['Lux Capital', 'Founders Fund']],
  ['Physical Intelligence', 'Robotics', 4, 2400, 8, 320, 'OpenAI, Jeff Bezos', 'Series A', 'San Francisco', ['Thrive Capital', 'Lux Capital']],
  ['Anduril', 'Defense', 5, 30500, 1000, 95, 'US DoD', 'Series G', 'Costa Mesa', ['Founders Fund', '8VC']],
  ['PsiQuantum', 'Quantum', 3, 6000, 18, 70, 'BlackRock, Microsoft (Azure)', 'Series D', 'Palo Alto', ['DCVC', 'Lux Capital']],
  ['Etched', 'Semis', 4, 1500, 26, 280, 'NVIDIA ecosystem', 'Series A', 'Cupertino', ['Lux Capital', 'Radical Ventures']],
  ['Xaira Therapeutics', 'Drug Disc.', 3, 3000, 14, 140, 'Genentech, ARCH', 'Series A', 'SF Bay', ['Lux Capital', 'DCVC']],
  ['Isomorphic Labs', 'Drug Disc.', 4, 5600, 40, 120, 'Alphabet, Eli Lilly, Novartis', 'Growth', 'London', ['Thrive Capital']],
  ['CoreWeave', 'Compute Mkt', 5, 23000, 1900, 420, 'NVIDIA, Microsoft', 'Post-IPO', 'Roseland NJ', ['Founders Fund']],
  ['Together AI', 'Infra', 4, 3300, 130, 190, 'NVIDIA', 'Series B', 'San Francisco', ['Lightspeed', 'Radical Ventures']],
  ['Pinecone', 'Vector DB', 3, 750, 60, 85, '—', 'Series B', 'New York', ['Andreessen Horowitz']],
  ['Sierra', 'Agentic', 4, 4500, 45, 300, '—', 'Series B', 'San Francisco', ['Thrive Capital', 'Index Ventures']],
  ['Cerebras', 'Semis', 4, 8100, 400, 130, 'G42, NVIDIA rivalry', 'Pre-IPO', 'Sunnyvale', ['Eclipse Ventures']],
  ['World Labs', 'World Models', 4, 1000, 4, 380, 'NVIDIA', 'Series A', 'San Francisco', ['Andreessen Horowitz', 'Radical Ventures']],
  ['Base Power', 'Energy', 3, 1000, 30, 260, '—', 'Series B', 'Austin', ['Lightspeed', 'Eclipse Ventures']],
  ['Wayve', 'AV', 3, 3000, 20, 150, 'NVIDIA, Microsoft, Uber', 'Series C', 'London', ['Eclipse Ventures']],
  ['Skild AI', 'Robotics', 3, 1500, 6, 340, 'NVIDIA, SoftBank', 'Series A', 'Pittsburgh', ['Lightspeed', 'Bessemer']],
  ['EvolutionaryScale', 'Drug Disc.', 3, 1600, 5, 290, 'NVIDIA, Amazon', 'Seed', 'New York', ['Lux Capital', 'Radical Ventures']],
  ['Atom Computing', 'Quantum', 2, 500, 3, 90, 'Microsoft', 'Series C', 'Boulder', ['Radical Ventures']],
  ['Lightmatter', 'Next-Gen HW', 4, 4400, 35, 175, 'GV, HPE', 'Series D', 'Boston', ['Lightspeed', 'Eclipse Ventures']],
  ['Crusoe', 'Compute Mkt', 4, 2800, 400, 200, 'NVIDIA, Oracle', 'Series D', 'Denver', ['Founders Fund']],
  ['Chai Discovery', 'Drug Disc.', 2, 300, 2, 300, 'OpenAI', 'Seed', 'San Francisco', ['Thrive Capital']],
  ['Turbopuffer', 'Vector DB', 2, 180, 9, 260, '—', 'Seed', 'San Francisco', ['Andreessen Horowitz']],
  ['Saronic', 'Defense', 3, 4000, 40, 230, 'US Navy', 'Series C', 'Austin', ['8VC', 'Andreessen Horowitz']],
];

const SOURCES = [
  ['Investor websites', 'Investor websites', '24 marquee portfolios auto-crawled nightly', 'high'],
  ['Industry reports', 'Industry reports', 'SemiAnalysis, Epoch AI, State of AI', 'high'],
  ['YouTube transcripts', 'YouTube transcripts', 'a16z, Lux, Latent Space, Dwarkesh', 'medium'],
  ['Leader feeds', 'Leader feeds', 'Jensen, Nadella, Altman, Hassabis mentions', 'medium'],
];

/* Build 8-quarter trajectory ending at the current arr / valuation. */
function history(endArr, endVal, growthPct) {
  const n = 8;
  const gq = Math.pow(1 + growthPct / 100, 1 / 4); // per-quarter growth factor
  const rev = [], val = [];
  for (let i = 0; i < n; i++) {
    const back = n - 1 - i;
    rev.push(Math.max(1, Math.round((endArr / Math.pow(gq, back)) * 10) / 10));
    val.push(Math.round(endVal / Math.pow(Math.max(1.02, gq * 0.96), back)));
  }
  return { rev, val };
}

async function migrate() {
  await q(SCHEMA);
}

async function isSeeded() {
  const r = await q('SELECT COUNT(*)::int AS n FROM companies');
  return r.rows[0].n > 0;
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO config (id, data) VALUES (1, $1)
       ON CONFLICT (id) DO NOTHING`, [DEFAULT_CONFIG]);

    for (let i = 0; i < SEG.length; i++) {
      const [short, name, flagged, blurb, signal] = SEG[i];
      await client.query(
        `INSERT INTO segments (short, name, flagged, blurb, signal, sort)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (short) DO NOTHING`,
        [short, name, flagged, blurb, signal, i]);
    }

    for (const [name, tier, aum, hq, stage, geo, focus, partners, description, media] of INV) {
      await client.query(
        `INSERT INTO investors (name, tier, aum, hq, stage, geo, focus, partners, description, media)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (name) DO NOTHING`,
        [name, tier, aum, hq, stage, geo, focus, partners, description, media]);
    }

    for (const [name, seg, stage, val, arr, growth, coverage, round, hq, investors] of CO) {
      const r = await client.query(
        `INSERT INTO companies (name, segment_short, stage, valuation_musd, arr_musd, growth_pct, coverage, round, hq)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (name) DO NOTHING RETURNING id`,
        [name, seg, stage, val, arr, growth, coverage, round, hq]);
      if (!r.rows.length) continue;
      const cid = r.rows[0].id;
      for (let k = 0; k < investors.length; k++) {
        await client.query(
          `INSERT INTO company_investors (company_id, investor_name, lead) VALUES ($1,$2,$3)
           ON CONFLICT DO NOTHING`, [cid, investors[k], k === 0]);
      }
      const h = history(arr, val, growth);
      const labs = ['Q1', 'Q2', 'Q3', 'Q4', 'Q1', 'Q2', 'Q3', 'Q4'];
      for (let s = 0; s < h.rev.length; s++) {
        await client.query(
          `INSERT INTO financials (company_id, period, seq, revenue_musd, arr_musd, ebitda_musd, valuation_musd)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [cid, labs[s], s, h.rev[s], h.rev[s], Math.round(h.rev[s] * 0.15), h.val[s]]);
      }
      await client.query(
        `INSERT INTO announcements (company_id, at, title, detail) VALUES
         ($1,'Jul 2026',$2,$3),($1,'May 2026',$4,$5),($1,'Mar 2026',$6,$7)`,
        [cid,
          `${round} at ${fmtUsd(val)}`, `Led by ${investors[0]}.${coverage !== '—' ? ' Strategic interest: ' + coverage + '.' : ''}`,
          `ARR reached ${fmtUsd(arr, true)}`, `+${growth}% YoY — flagged by the trajectory agent.`,
          `Promoted to Stage ${stage}`, 'Qualifying event detected in a daily sweep.']);
    }

    for (const [kind, name, detail, reliability] of SOURCES) {
      await client.query(
        `INSERT INTO sources (kind, name, detail, reliability) VALUES ($1,$2,$3,$4)`,
        [kind, name, detail, reliability]);
    }

    const owner = (process.env.OWNER_EMAIL || 'sachinganeshan14@gmail.com').toLowerCase();
    await client.query(
      `INSERT INTO recipients (email, role) VALUES ($1,'owner') ON CONFLICT (email) DO NOTHING`,
      [owner]);

    await client.query('COMMIT');
    console.log('[db] seeded initial dataset');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

function fmtUsd(m, arr) {
  const n = Number(m);
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'B';
  return '$' + (Math.round(n * 10) / 10) + 'M';
}

async function init() {
  await migrate();
  if (!(await isSeeded())) await seed();
}

module.exports = { pool, q, init, migrate, seed, isSeeded, DEFAULT_CONFIG, fmtUsd };
