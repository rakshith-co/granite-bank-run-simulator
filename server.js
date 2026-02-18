const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 8787;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');

const PHASES = ['lobby', 'phase1', 'phase2', 'phase3', 'phase4', 'end'];
const DEPOSITOR_TARGET = 50;
const WHOLESALE_TARGET = 13;
const FSCS_LIMIT = 35000;
const WHOLESALE_QUIZ_THRESHOLD = 2;

const joinQuiz = [
  {
    id: 'q1',
    prompt: 'If all lenders demand repayment at once, what risk is most immediate?',
    options: [
      { id: 'a', text: 'Liquidity risk' },
      { id: 'b', text: 'FX translation risk' },
      { id: 'c', text: 'Tax accounting risk' },
    ],
    correct: 'a',
  },
  {
    id: 'q2',
    prompt: 'LCR below 100% signals that:',
    options: [
      { id: 'a', text: 'The bank has enough high-quality liquid assets for stressed outflows' },
      { id: 'b', text: 'The bank may not have enough liquid assets for stressed outflows' },
      { id: 'c', text: 'The bank is automatically insolvent' },
    ],
    correct: 'b',
  },
  {
    id: 'q3',
    prompt: 'In a bank run, which usually leaves faster?',
    options: [
      { id: 'a', text: 'Long-term insured retail deposits' },
      { id: 'b', text: 'Short-term wholesale funding' },
      { id: 'c', text: 'Core equity capital' },
    ],
    correct: 'b',
  },
];

const MAX_BODY_SIZE = 8_000_000;

const depositorProducts = {
  current: { label: 'Current Account', rate: 2.1, lockBucket: '0-3m', lockRisk: 'low' },
  notice_3m: { label: '3-Month Notice', rate: 5.4, lockBucket: '0-3m', lockRisk: 'medium' },
  fixed_1y: { label: '1-Year Fixed', rate: 7.2, lockBucket: '3-12m', lockRisk: 'medium' },
  bond_3y: { label: '3-Year Premier Bond', rate: 9.8, lockBucket: '12-36m', lockRisk: 'high' },
  premier_142: { label: 'Premier Bond 14.2%', rate: 14.2, lockBucket: '12-36m', lockRisk: 'extreme' },
};

const wholesaleFacilities = {
  overnight: { label: 'Overnight Repo', spreadBps: 8, lockBucket: '0-3m' },
  week_1: { label: '1-Week Facility', spreadBps: 12, lockBucket: '0-3m' },
  month_3: { label: '3-Month Facility', spreadBps: 18, lockBucket: '0-3m' },
  year_1: { label: '12-Month Facility', spreadBps: 28, lockBucket: '3-12m' },
};

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function now() {
  return Date.now();
}

function uid(length = 12) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

function randomCode() {
  return uid(6).toUpperCase();
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function baseState() {
  return {
    session: {
      id: uid(10),
      code: randomCode(),
      phase: 'lobby',
      phaseStartedAt: now(),
      createdAt: now(),
      join: {
        token: uid(16),
        expiresAt: now() + 10 * 60 * 1000,
      },
      activeEvents: [],
      eventTriggeredAt: {},
      eventFeed: [],
      boeStatus: 'PENDING',
      bankStatus: 'STABLE',
      revealNames: false,
    },
    metrics: {
      lcr: 100,
      nsfr: 100,
      liquidityBuffer: 1_100_000_000,
      survivalHours: 96,
      fundingConcentrationPct: 74,
      wholesaleDependencyPct: 74,
      contractualMaturityPct: 88,
      behavioralMaturityPct: 88,
      scenario: 'BASE CASE',
      liborPct: 5.25,
      panicMeter: 4,
      assetLiquidity: {
        bidOfferSpreadPct: 0.12,
        marketDepth: 'Deep',
        immediacy: 'Minutes',
        resilience: 'Fast',
      },
      cfpStage: {
        stage1: 'ACTIVE',
        stage2: 'READY',
        stage3: 'STANDBY',
      },
      stressTypes: {
        institutionSpecific: true,
        marketWide: false,
      },
      assumptions: {
        fundingCostStable: true,
        prepaymentRatePct: 12,
        depositStability: true,
      },
      outcomes: {
        boeInjected: false,
        rescueInjectionAmount: 0,
      },
    },
    players: {},
    meta: {
      ticks: 0,
      lastTickAt: now(),
    },
  };
}

let state = loadState();

function sanitizeState(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return baseState();
  }
  const rebuilt = baseState();
  return {
    ...rebuilt,
    ...candidate,
    session: {
      ...rebuilt.session,
      ...(candidate.session || {}),
      eventTriggeredAt: {
        ...rebuilt.session.eventTriggeredAt,
        ...((candidate.session || {}).eventTriggeredAt || {}),
      },
      join: {
        ...rebuilt.session.join,
        ...((candidate.session || {}).join || {}),
      },
    },
    metrics: {
      ...rebuilt.metrics,
      ...(candidate.metrics || {}),
      assetLiquidity: {
        ...rebuilt.metrics.assetLiquidity,
        ...((candidate.metrics || {}).assetLiquidity || {}),
      },
      cfpStage: {
        ...rebuilt.metrics.cfpStage,
        ...((candidate.metrics || {}).cfpStage || {}),
      },
      stressTypes: {
        ...rebuilt.metrics.stressTypes,
        ...((candidate.metrics || {}).stressTypes || {}),
      },
      assumptions: {
        ...rebuilt.metrics.assumptions,
        ...((candidate.metrics || {}).assumptions || {}),
      },
      outcomes: {
        ...rebuilt.metrics.outcomes,
        ...((candidate.metrics || {}).outcomes || {}),
      },
    },
    players: candidate.players || {},
    meta: {
      ...rebuilt.meta,
      ...(candidate.meta || {}),
    },
  };
}

function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const fresh = baseState();
      fs.writeFileSync(DATA_FILE, JSON.stringify(fresh, null, 2));
      return fresh;
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return sanitizeState(parsed);
  } catch (error) {
    console.error('Failed to load state, creating a fresh one.', error);
    return baseState();
  }
}

function saveState() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

function resetState() {
  state = baseState();
  pushEvent('System reset. Session restarted.');
  saveState();
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        req.socket.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sendJson(res, code, payload) {
  const content = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(content);
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { ok: false, error: 'Not found' });
      return;
    }
    res.writeHead(200, { 'Content-Type': map[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function hostUrl(req) {
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  return `${protocol}://${req.headers.host || `localhost:${PORT}`}`;
}

function buildJoinUrl(req) {
  const base = hostUrl(req);
  return `${base}/#/join?code=${encodeURIComponent(state.session.code)}&token=${encodeURIComponent(state.session.join.token)}`;
}

function playerList() {
  return Object.values(state.players);
}

function countRoles() {
  const players = playerList();
  return {
    depositor: players.filter((p) => p.role === 'depositor').length,
    wholesale: players.filter((p) => p.role === 'wholesale').length,
    total: players.length,
  };
}

function assignRole() {
  const counts = countRoles();
  if (counts.depositor >= DEPOSITOR_TARGET && counts.wholesale < WHOLESALE_TARGET) {
    return 'wholesale';
  }
  if (counts.wholesale >= WHOLESALE_TARGET && counts.depositor < DEPOSITOR_TARGET) {
    return 'depositor';
  }
  const dRemaining = Math.max(DEPOSITOR_TARGET - counts.depositor, 1);
  const wRemaining = Math.max(WHOLESALE_TARGET - counts.wholesale, 1);
  const probabilityWholesale = wRemaining / (dRemaining + wRemaining);
  return Math.random() < probabilityWholesale ? 'wholesale' : 'depositor';
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function evaluateQuizScore(answers) {
  if (!answers || typeof answers !== 'object') return 0;
  let score = 0;
  for (const q of joinQuiz) {
    if (String(answers[q.id] || '') === q.correct) score += 1;
  }
  return score;
}

function assignRoleByQuiz(score) {
  const counts = countRoles();
  if (counts.wholesale >= WHOLESALE_TARGET) return 'depositor';
  if (score >= WHOLESALE_QUIZ_THRESHOLD) return 'wholesale';
  return 'depositor';
}

function extractNameFromRawText(rawText) {
  const lines = String(rawText || '')
    .split('\n')
    .map((line) =>
      line
        .toUpperCase()
        .replace(/[^A-Z\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter((line) => line.length >= 4);

  const hardBlacklist =
    /UNIVERSITY|DEEMED|COLLEGE|SCHOOL|CHRIST|BANGALORE|INDIA|VALID|TILL|AUTHORITY|REPUBLIC|GOVT|GOVERNMENT|IDENTITY|ID CARD|DEPARTMENT|CAMPUS|BCOMAFA/i;
  const personHints = /\b(KUMAR|RAKSHITH|RAKSHIT|SINGH|REDDY|SHARMA|GUPTA|MOHAN|KUMARI)\b/i;

  let best = '';
  let bestScore = -999;

  for (const line of lines) {
    const words = line.split(' ').filter(Boolean);
    if (words.length < 2 || words.length > 5) continue;
    if (line.length > 40) continue;

    let score = 0;
    if (/^[A-Z ]+$/.test(line)) score += 2;
    if (words.length >= 2 && words.length <= 4) score += 3;
    if (personHints.test(line)) score += 5;
    if (hardBlacklist.test(line)) score -= 8;
    if (/\b(MALE|FEMALE|DOB|YEAR|MONTH|DATE)\b/.test(line)) score -= 5;

    if (score > bestScore) {
      bestScore = score;
      best = line;
    }
  }

  // Fallback: try to find explicit "X KUMAR Y" pattern in full text.
  if (!best || bestScore <= 0) {
    const full = String(rawText || '').toUpperCase().replace(/[^A-Z\s]/g, ' ').replace(/\s+/g, ' ');
    const m = full.match(/\b([A-Z]{2,}\s+KUMAR\s+[A-Z]{1,})\b/);
    if (m) best = m[1];
  }

  return best.replace(/\s+/g, ' ').trim().slice(0, 40);
}

function extractFallbackNameFromRawText(rawText) {
  const words = String(rawText || '')
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => w.length >= 3 && w.length <= 14);
  const blacklist =
    /UNIVERSITY|DEEMED|COLLEGE|SCHOOL|CHRIST|BANGALORE|INDIA|VALID|TILL|AUTHORITY|REPUBLIC|GOVT|GOVERNMENT|IDENTITY|CARD|DEPARTMENT|CAMPUS|DOB|MALE|FEMALE|YEAR|MONTH|DATE|ISSUE|ENROL|AADHAAR|STUDENT|ID/;
  const filtered = words.filter((w) => !blacklist.test(w));
  if (!filtered.length) return '';
  const pick = filtered.slice(0, 2).join(' ');
  return pick.slice(0, 30);
}

function pushEvent(text, type = 'info') {
  state.session.eventFeed.unshift({
    id: uid(8),
    type,
    text,
    at: now(),
  });
  state.session.eventFeed = state.session.eventFeed.slice(0, 60);
}

function getPlayerByResume(resumeToken) {
  return playerList().find((p) => p.resumeToken === resumeToken);
}

function getPlayerRate(player) {
  if (!player) return 0;
  if (player.role === 'depositor') {
    if (state.session.phase === 'phase1' && !player.meta.phase1Confirmed) {
      return 0;
    }
    const product = depositorProducts[player.product] || depositorProducts.current;
    return product.rate;
  }
  if (state.session.phase === 'phase1' && !player.meta.phase1Deployed) {
    return 0;
  }
  const facility = wholesaleFacilities[player.facility] || wholesaleFacilities.overnight;
  const extraSpread = Math.max(0, Number(player.spreadBpsOverride || 0)) / 100;
  return state.metrics.liborPct + facility.spreadBps / 100 + extraSpread;
}

function getPlayerScore(player) {
  if (player.role === 'depositor') {
    let score = player.balance;
    if (player.meta.hedged) score += 800;
    if (player.meta.panicSignals > 0) score += player.meta.panicSignals * 200;
    if (player.meta.withdrawnAtPhase === 'phase1' || player.meta.withdrawnAtPhase === 'phase2') score -= 1200;
    if (player.meta.withdrawnAtPhase === 'phase3') score += 500;
    if (player.meta.withdrawnAtPhase === 'phase4') score += 350;
    if (state.session.bankStatus === 'COLLAPSED' && player.balance > FSCS_LIMIT && !player.meta.withdrew) score -= 4000;
    return Math.max(0, Math.round(score));
  }

  let score = player.balance / 1_000_000;
  if (player.meta.refusedAtPhase === 'phase3') score += 300;
  if (player.meta.refusedAtPhase === 'phase4') score += 200;
  if (player.meta.heldThroughPhase4 && state.session.bankStatus === 'RESCUED') score += 900;
  if (player.meta.heldThroughPhase4 && state.session.bankStatus === 'COLLAPSED') score -= 1200;
  return Math.round(score * 100);
}

function getPlayerLabel(player) {
  if (player.role === 'depositor') {
    if (state.session.phase === 'end' || state.session.revealNames) {
      if (player.meta.withdrawnAtPhase === 'phase3') return 'Shrewd Exit';
      if (player.meta.withdrawnAtPhase === 'phase1' || player.meta.withdrawnAtPhase === 'phase2') return 'Panicked Early';
      if (!player.meta.withdrew && state.session.bankStatus === 'RESCUED') return 'Brave Hold';
      if (!player.meta.withdrew && state.session.bankStatus === 'COLLAPSED' && player.balance > FSCS_LIMIT) return 'Gone';
      if (!player.meta.withdrew && state.session.bankStatus === 'COLLAPSED') return 'Safe but Low';
      if (player.meta.panicSignals > 1) return 'Greedy';
    }
    return 'Active';
  }

  if (state.session.phase === 'end' || state.session.revealNames) {
    if (player.meta.refusedAtPhase === 'phase3') return 'Shrewd Exit';
    if (player.meta.heldThroughPhase4 && state.session.bankStatus === 'RESCUED') return 'Hero Hold';
    if (player.meta.heldThroughPhase4 && state.session.bankStatus === 'COLLAPSED') return 'Trapped';
    return 'Strategic';
  }
  return 'Active';
}

function getLeaderboard() {
  const reveal = state.session.revealNames || state.session.phase === 'end';
  return playerList()
    .map((player) => ({
      id: player.id,
      role: player.role,
      displayName: reveal ? player.name : `User_${player.id.slice(-4)}`,
      score: getPlayerScore(player),
      label: getPlayerLabel(player),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 16);
}

function initialPlayer(role, name) {
  if (role === 'depositor') {
    return {
      id: uid(10),
      name,
      role,
      joinedAt: now(),
      resumeToken: uid(24),
      balance: 10000,
      principal: 10000,
      product: null,
      facility: null,
      spreadBpsOverride: 0,
      exposurePct: 100,
      actions: [],
      meta: {
        hedged: false,
        hedgeType: null,
        withdrew: false,
        withdrawnAtPhase: null,
        exitPayout: 0,
        exitLoss: 0,
        exitPrincipal: 0,
        exitInterest: 0,
        phase2BankedInterest: 0,
        phase2UpgradedAt: null,
        phase3SwitchedToCurrent: false,
        phase3QueueState: 'none',
        phase3QueueMode: 'full',
        phase3QueueRef: null,
        phase3QueueRequestedAmount: 0,
        phase3QueueEtaHours: 0,
        phase3QueuePosition: 0,
        phase3QueueUpdatedAt: null,
        panicSignals: 0,
        phase1Confirmed: false,
        phase1DraftProduct: null,
        phase1PendingProduct: null,
        phase1DraftAdditional: 0,
        phase1InterestCycleBaseBalance: 10000,
        phase1InterestCycleStartedAt: null,
        phase1BankedInterest: 0,
        verifiedName: false,
        quizScore: 0,
        lastActionAt: now(),
      },
    };
  }

  return {
    id: uid(10),
    name,
    role,
    joinedAt: now(),
    resumeToken: uid(24),
    balance: 500_000_000,
    principal: 500_000_000,
    product: null,
    facility: null,
    spreadBpsOverride: 0,
    exposurePct: 100,
    actions: [],
    meta: {
      refused: false,
      refusedAtPhase: null,
      heldThroughPhase4: false,
      withdrew: false,
      phase1Deployed: false,
      phase1DraftFacility: null,
      phase1PendingFacility: null,
      phase1SpreadCycleBaseBalance: 500_000_000,
      phase1SpreadCycleStartedAt: null,
      phase1BankedSpread: 0,
      verifiedName: false,
      quizScore: 0,
      lastActionAt: now(),
    },
  };
}

function finalizeDepositorPhase1Choice(player, forceProduct = null) {
  if (!player || player.role !== 'depositor') return;

  const chosenProduct = forceProduct || player.meta.phase1DraftProduct || player.product || 'current';
  const chosenAdditional = clampNumber(Number(player.meta.phase1DraftAdditional || 0), 0, 40000);

  if (!player.meta.phase1Confirmed) {
    const total = 10000 + chosenAdditional;
    player.product = chosenProduct;
    player.balance = roundMoney(total);
    player.principal = roundMoney(total);
    player.meta.phase1Confirmed = true;
    player.meta.phase1DraftProduct = chosenProduct;
    player.meta.phase1PendingProduct = null;
    player.meta.phase1DraftAdditional = chosenAdditional;
    player.meta.phase1InterestCycleBaseBalance = roundMoney(player.balance);
    player.meta.phase1InterestCycleStartedAt = now();
    player.meta.phase1BankedInterest = roundMoney(player.meta.phase1BankedInterest || 0);
    return;
  }

  const cycleBase = Number(player.meta.phase1InterestCycleBaseBalance || player.balance);
  const cycleEarned = Math.max(0, roundMoney(player.balance - cycleBase));
  player.meta.phase1BankedInterest = roundMoney((player.meta.phase1BankedInterest || 0) + cycleEarned);
  player.product = chosenProduct;
  player.meta.phase1DraftProduct = chosenProduct;
  player.meta.phase1PendingProduct = null;
  player.meta.phase1DraftAdditional = Math.max(0, roundMoney(player.principal - 10000));
  player.meta.phase1InterestCycleBaseBalance = roundMoney(player.balance);
  player.meta.phase1InterestCycleStartedAt = now();
}

function finalizeWholesalePhase1Deployment(player, forceFacility = null) {
  if (!player || player.role !== 'wholesale') return;

  const chosenFacility = forceFacility || player.meta.phase1DraftFacility || player.facility || 'overnight';

  if (!player.meta.phase1Deployed) {
    player.facility = chosenFacility;
    player.meta.phase1Deployed = true;
    player.meta.phase1DraftFacility = chosenFacility;
    player.meta.phase1PendingFacility = null;
    player.meta.phase1SpreadCycleBaseBalance = roundMoney(player.balance);
    player.meta.phase1SpreadCycleStartedAt = now();
    player.meta.phase1BankedSpread = roundMoney(player.meta.phase1BankedSpread || 0);
    return;
  }

  const cycleBase = Number(player.meta.phase1SpreadCycleBaseBalance || player.balance);
  const cycleEarned = Math.max(0, roundMoney(player.balance - cycleBase));
  player.meta.phase1BankedSpread = roundMoney((player.meta.phase1BankedSpread || 0) + cycleEarned);
  player.facility = chosenFacility;
  player.meta.phase1DraftFacility = chosenFacility;
  player.meta.phase1PendingFacility = null;
  player.meta.phase1SpreadCycleBaseBalance = roundMoney(player.balance);
  player.meta.phase1SpreadCycleStartedAt = now();
}

function ensurePhase3QueueState(player) {
  if (!player || player.role !== 'depositor') return;
  if (player.meta.phase3QueueState) return;
  player.meta.phase3QueueState = 'none';
  player.meta.phase3QueueMode = 'full';
  player.meta.phase3QueueRef = null;
  player.meta.phase3QueueRequestedAmount = 0;
  player.meta.phase3QueueEtaHours = 0;
  player.meta.phase3QueuePosition = 0;
  player.meta.phase3QueueUpdatedAt = null;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function applyAccrualTick() {
  state.meta.ticks += 1;
  state.meta.lastTickAt = now();

  if (state.session.phase === 'lobby' || state.session.phase === 'end') {
    return;
  }

  for (const player of playerList()) {
    if (player.role === 'depositor' && player.meta.withdrew) {
      continue;
    }
    if (player.role === 'wholesale' && player.meta.refused) {
      continue;
    }

    const rate = getPlayerRate(player);
    const exposureFactor = player.role === 'wholesale' ? Math.max(0.1, Number(player.exposurePct || 100) / 100) : 1;
    const tickGain = player.balance * exposureFactor * (rate / 100) * 0.0008;
    player.balance = roundMoney(player.balance + tickGain);
  }

  adjustMacroMetrics();
}

function getDepositorBuckets() {
  const buckets = {
    '0-3m': 0,
    '3-12m': 0,
    '12-36m': 0,
    other: 0,
  };
  for (const player of playerList()) {
    if (player.role !== 'depositor') continue;
    if (player.meta.withdrew) continue;
    if (state.session.phase === 'phase1' && !player.meta.phase1Confirmed) continue;
    const product = depositorProducts[player.product] || depositorProducts.current;
    buckets[product.lockBucket] = (buckets[product.lockBucket] || 0) + player.balance;
  }
  return buckets;
}

function getWholesaleBuckets() {
  const buckets = {
    '0-3m': 0,
    '3-12m': 0,
    '12-36m': 0,
    other: 0,
  };
  for (const player of playerList()) {
    if (player.role !== 'wholesale') continue;
    if (player.meta.refused) continue;
    if (state.session.phase === 'phase1' && !player.meta.phase1Deployed) continue;
    const facility = wholesaleFacilities[player.facility] || wholesaleFacilities.overnight;
    const deployed = player.balance * (player.exposurePct / 100);
    buckets[facility.lockBucket] = (buckets[facility.lockBucket] || 0) + deployed;
  }
  return buckets;
}

function computeAssetBuckets(depositorBuckets, wholesaleBuckets) {
  const totalLiabilities =
    Object.values(depositorBuckets).reduce((a, b) => a + b, 0) + Object.values(wholesaleBuckets).reduce((a, b) => a + b, 0) + 1;
  const mortgageBook = totalLiabilities * 0.82;
  const tradingBook = totalLiabilities * 0.06;
  const hqla = Math.max(0, Number(state.metrics.liquidityBuffer || 0));

  const prepayRate = Math.max(0.02, Math.min(0.16, Number(state.metrics.assumptions.prepaymentRatePct || 12) / 100));
  const severePhase = state.session.phase === 'phase3' || state.session.phase === 'phase4';
  const scenarioHaircut = state.metrics.scenario === 'SEVERE STRESS' ? 0.9 : state.metrics.scenario === 'MODERATE STRESS' ? 0.96 : 1;
  const marketHaircut = severePhase ? 0.82 : 1;
  const stressHaircut = scenarioHaircut * marketHaircut;

  const bucket03 = (hqla * 0.55 + mortgageBook * (prepayRate * 0.22) + tradingBook * 0.18) * stressHaircut;
  const bucket312 = (hqla * 0.18 + mortgageBook * 0.09 + tradingBook * 0.22) * stressHaircut;
  const bucket1236 = (hqla * 0.07 + mortgageBook * 0.24 + tradingBook * 0.16) * stressHaircut;
  const totalAssets = (hqla + mortgageBook + tradingBook) * stressHaircut;
  const other = Math.max(0, totalAssets - bucket03 - bucket312 - bucket1236);

  return {
    '0-3m': roundMoney(bucket03),
    '3-12m': roundMoney(bucket312),
    '12-36m': roundMoney(bucket1236),
    other: roundMoney(other),
  };
}

function adjustMacroMetrics() {
  const depositors = playerList().filter((p) => p.role === 'depositor');
  const wholesale = playerList().filter((p) => p.role === 'wholesale');

  const depositorBuckets = getDepositorBuckets();
  const wholesaleBuckets = getWholesaleBuckets();

  const totalRetail = Object.values(depositorBuckets).reduce((a, b) => a + b, 0);
  const totalWholesaleLive = Object.values(wholesaleBuckets).reduce((a, b) => a + b, 0);
  const totalLiabilities = totalRetail + totalWholesaleLive + 1;

  const shortTermLiabilities = depositorBuckets['0-3m'] + wholesaleBuckets['0-3m'] + 1;
  const assetBuckets = computeAssetBuckets(depositorBuckets, wholesaleBuckets);

  state.metrics.wholesaleDependencyPct = Math.min(95, Math.max(8, (totalWholesaleLive / totalLiabilities) * 100));
  state.metrics.fundingConcentrationPct = Math.min(
    95,
    Math.max(8, ((wholesaleBuckets['0-3m'] + depositorBuckets['0-3m']) / totalLiabilities) * 100)
  );

  const withdrawals = depositors.filter((p) => p.meta.withdrew).length;
  const refusals = wholesale.filter((p) => p.meta.refused).length;
  const refusalRate = wholesale.length ? refusals / wholesale.length : 0;
  const severePhase = state.session.phase === 'phase3' || state.session.phase === 'phase4';

  const retailRunoff = Math.min(
    0.22,
    Math.max(0.03, (state.metrics.assumptions.depositStability ? 0.04 : 0.1) + Number(state.metrics.panicMeter || 0) / 1000)
  );
  const wholesaleRunoff = Math.min(
    1,
    Math.max(0.2, (state.metrics.assumptions.fundingCostStable ? 0.25 : 0.45) + (severePhase ? 0.35 : 0.1) + refusalRate * 0.4)
  );
  const netOutflows30d =
    depositorBuckets['0-3m'] * retailRunoff + wholesaleBuckets['0-3m'] * wholesaleRunoff + depositorBuckets['3-12m'] * 0.02 + 1;
  const hqlaForLcr = Math.max(1, assetBuckets['0-3m'] * 0.9);
  state.metrics.lcr = Math.max(0, Math.min(300, (hqlaForLcr / netOutflows30d) * 100));

  const asf =
    depositorBuckets['12-36m'] * 0.95 +
    depositorBuckets['3-12m'] * 0.9 +
    depositorBuckets['0-3m'] * 0.5 +
    wholesaleBuckets['12-36m'] * 1 +
    wholesaleBuckets['3-12m'] * 0.5 +
    totalLiabilities * 0.08;
  const rsf = assetBuckets['0-3m'] * 0.1 + assetBuckets['3-12m'] * 0.5 + assetBuckets['12-36m'] * 0.85 + assetBuckets.other * 1;
  state.metrics.nsfr = Math.max(0, Math.min(250, (asf / (rsf + 1)) * 100));

  const lockedContracts = depositors.filter((p) => !p.meta.withdrew).length;
  const behavedLocked = depositors.filter((p) => !p.meta.withdrew && p.meta.withdrawnAtPhase == null).length;
  state.metrics.contractualMaturityPct = Math.max(0, Math.min(100, (lockedContracts / (depositors.length || 1)) * 100));
  state.metrics.behavioralMaturityPct = Math.max(0, Math.min(100, (behavedLocked / (depositors.length || 1)) * 100 - state.metrics.panicMeter));

  const drainBase = state.session.phase === 'phase3' || state.session.phase === 'phase4' ? 2_800_000 : 220_000;
  const withdrawalDrain = withdrawals * 800_000;
  const refusalDrain = refusals * 5_200_000;
  const stressMultiplier = state.metrics.scenario === 'SEVERE STRESS' ? 2.4 : state.metrics.scenario === 'MODERATE STRESS' ? 1.5 : 1;

  if (state.session.phase !== 'lobby' && state.session.phase !== 'end') {
    const totalDrain = (drainBase + withdrawalDrain + refusalDrain) * stressMultiplier;
    state.metrics.liquidityBuffer = Math.max(0, state.metrics.liquidityBuffer - totalDrain);
  }

  if (state.metrics.outcomes.boeInjected && state.session.bankStatus !== 'COLLAPSED') {
    state.metrics.liquidityBuffer = Math.min(1_400_000_000, state.metrics.liquidityBuffer + 3_100_000);
  }

  const normalizedOutflow = Math.max(120_000, netOutflows30d / 30);
  state.metrics.survivalHours = Math.max(0, Math.floor(state.metrics.liquidityBuffer / normalizedOutflow));

  if (state.session.phase === 'phase3' || state.session.phase === 'phase4') {
    state.metrics.assetLiquidity.bidOfferSpreadPct = Math.min(
      4.5,
      state.metrics.assetLiquidity.bidOfferSpreadPct + 0.02 + refusals * 0.005
    );

    if (state.metrics.assetLiquidity.bidOfferSpreadPct > 1) {
      state.metrics.assetLiquidity.marketDepth = 'Thin';
      state.metrics.assetLiquidity.immediacy = 'Hours';
      state.metrics.assetLiquidity.resilience = 'Weak';
    }
    if (state.metrics.assetLiquidity.bidOfferSpreadPct > 2.2) {
      state.metrics.assetLiquidity.marketDepth = 'Very Thin';
      state.metrics.assetLiquidity.immediacy = 'Days';
      state.metrics.assetLiquidity.resilience = 'Absent';
    }
  }

  if (state.metrics.survivalHours <= 48 && state.session.phase === 'phase3') {
    pushEvent('Survival horizon dropped below 48 hours.', 'alert');
  }

  if (state.metrics.liquidityBuffer <= 0 && state.session.bankStatus !== 'RESCUED') {
    state.session.bankStatus = 'COLLAPSED';
    state.session.phase = 'end';
    state.session.revealNames = true;
    state.session.boeStatus = 'REJECTED';
    pushEvent('Liquidity buffer exhausted. Granite Bank collapsed.', 'critical');
  }
}

function recordAction(player, type, payload = {}) {
  player.actions.unshift({
    id: uid(8),
    at: now(),
    phase: state.session.phase,
    type,
    payload,
  });
  player.actions = player.actions.slice(0, 40);
  player.meta.lastActionAt = now();
}

function getPhase4DepositorOutcome(player) {
  const balance = roundMoney(Math.max(0, Number(player.balance || 0)));
  const guaranteed = roundMoney(Math.min(balance, FSCS_LIMIT));
  const loss = roundMoney(Math.max(0, balance - FSCS_LIMIT));

  if (player.meta.withdrew && ['phase2', 'phase3', 'phase4'].includes(player.meta.withdrawnAtPhase)) {
    return {
      type: 'secured_exit',
      status: 'CLEARED',
      accountType: 'Exited Position',
      totalBalance: balance,
      guaranteed,
      loss: 0,
      immediateCash: balance,
      timelinePrimary: `${formatAmount(balance)} available immediately`,
      timelineSecondary: null,
      lesson: 'Liquidity decisions were executed before final halt.',
      label: 'THE SURVIVOR',
    };
  }

  if (player.meta.phase3SwitchedToCurrent && player.meta.phase3QueueMode === 'protected') {
    return {
      type: 'cynic',
      status: 'CLEARED',
      accountType: 'Instant Access',
      totalBalance: balance,
      guaranteed,
      loss: 0,
      immediateCash: balance,
      timelinePrimary: `${formatAmount(balance)} available immediately`,
      timelineSecondary: null,
      lesson: 'You prioritized liquidity over yield when stress escalated.',
      label: 'THE SURVIVOR',
    };
  }

  if (player.meta.phase3QueueState === 'processing' && player.meta.phase3QueueMode === 'full') {
    return {
      type: 'panic_runner',
      status: 'TRANSACTION FAILED',
      accountType: 'Premier Bond',
      totalBalance: balance,
      guaranteed,
      loss,
      immediateCash: guaranteed,
      timelinePrimary: `${formatAmount(guaranteed)} in 7-10 days`,
      timelineSecondary: `${formatAmount(loss)} pending administration`,
      lesson: 'Operational risk: queue congestion prevented full execution.',
      label: 'TOO LATE',
    };
  }

  return {
    type: 'bag_holder',
    status: 'FROZEN',
    accountType: player.product ? depositorProducts[player.product]?.label || 'Locked Product' : 'Premier Bond',
    totalBalance: balance,
    guaranteed,
    loss,
    immediateCash: guaranteed,
    timelinePrimary: `${formatAmount(guaranteed)} in 7-10 days`,
    timelineSecondary: `${formatAmount(loss)} likely unrecovered`,
    lesson: 'Contractual maturity did not protect against a behavioral run.',
    label: 'THE VICTIM',
  };
}

function formatAmount(value) {
  return `£${Math.round(Number(value || 0)).toLocaleString('en-GB')}`;
}

function getPhase4WholesaleOutcome(player) {
  const grossExposure = roundMoney(Math.max(0, Number(player.principal || 0) * (Number(player.exposurePct || 100) / 100)));
  const defaulted = state.session.bankStatus !== 'RESCUED';

  if (player.meta.refused) {
    return {
      type: 'raider',
      status: defaulted ? 'DEFAULTED / NATIONALIZED' : 'STABILIZED / GUARANTEED',
      action: 'RECALLED FUNDS',
      exposure: 0,
      preservedPrincipal: grossExposure,
      missedYield: roundMoney((grossExposure * (Math.max(0, Number(state.metrics.liborPct || 0)) + 2.0) / 100) / 365),
      recoveryRate: 'N/A',
      timeline: 'Immediate',
      reputation: 'RUTHLESS BUT PRUDENT',
      finalLabel: 'BONUS MAXIMIZED',
    };
  }

  if (defaulted) {
    return {
      type: 'greedy',
      status: 'DEFAULTED / NATIONALIZED',
      action: 'ROLLED OVER',
      exposure: grossExposure,
      preservedPrincipal: 0,
      missedYield: 0,
      recoveryRate: '80-100%',
      timeline: '6-12 months',
      reputation: 'BAG HOLDER',
      finalLabel: 'RISK NEGLIGENCE',
    };
  }

  return {
    type: 'supported_hold',
    status: 'RESCUED / BACKSTOPPED',
    action: 'MAINTAINED EXPOSURE',
    exposure: grossExposure,
    preservedPrincipal: grossExposure,
    missedYield: 0,
    recoveryRate: '100%',
    timeline: 'Normal settlement',
    reputation: 'HIGH RISK TOLERANCE',
    finalLabel: 'SURVIVED WITH SUPPORT',
  };
}

function ensureJoinTokenFresh() {
  if (state.session.join.expiresAt < now()) {
    state.session.join.token = uid(16);
    state.session.join.expiresAt = now() + 10 * 60 * 1000;
  }
}

function rotateJoinToken() {
  state.session.join.token = uid(16);
  state.session.join.expiresAt = now() + 10 * 60 * 1000;
  pushEvent('Join QR refreshed by game master.');
}

function setPhase(phase) {
  if (!PHASES.includes(phase)) {
    return { ok: false, error: 'Invalid phase' };
  }
  const currentIdx = PHASES.indexOf(state.session.phase);
  const targetIdx = PHASES.indexOf(phase);
  if (targetIdx === -1) return { ok: false, error: 'Invalid phase' };
  if (targetIdx !== currentIdx && targetIdx !== currentIdx + 1) {
    return { ok: false, error: `Phase transition blocked. Move sequentially from ${state.session.phase} to the next phase.` };
  }

  state.session.phase = phase;
  state.session.phaseStartedAt = now();
  pushEvent(`Phase changed to ${phase.toUpperCase()}.`, 'phase');

  if (phase === 'phase1') {
    state.session.bankStatus = 'STABLE';
    state.session.eventTriggeredAt = {};
  }
  if (phase === 'phase2') {
    for (const player of playerList()) {
      if (player.role === 'depositor') {
        finalizeDepositorPhase1Choice(player);
      }
      if (player.role === 'wholesale') {
        finalizeWholesalePhase1Deployment(player);
      }
    }
    state.metrics.scenario = 'BASE CASE';
  }
  if (phase === 'phase3') {
    state.metrics.stressTypes.marketWide = true;
    state.metrics.cfpStage.stage2 = 'ACTIVE';
    for (const player of playerList()) {
      if (player.role !== 'depositor') continue;
      ensurePhase3QueueState(player);
      player.meta.phase3SwitchedToCurrent = false;
      player.meta.phase3QueueState = 'none';
      player.meta.phase3QueueMode = 'full';
      player.meta.phase3QueueRef = null;
      player.meta.phase3QueueRequestedAmount = 0;
      player.meta.phase3QueueEtaHours = 0;
      player.meta.phase3QueuePosition = 0;
      player.meta.phase3QueueUpdatedAt = now();
    }
  }
  if (phase === 'phase4') {
    state.metrics.cfpStage.stage3 = 'PENDING';
  }
  if (phase === 'end') {
    state.session.revealNames = true;
  }

  return { ok: true };
}

function triggerEvent(key) {
  const eventMap = {
    LIBOR_RISE: {
      allowedPhases: ['phase2'],
      message: 'LIBOR rising globally. Funding cost assumptions broken.',
      apply: () => {
        state.metrics.liborPct = roundMoney(state.metrics.liborPct + 0.85);
        state.metrics.assumptions.fundingCostStable = false;
        state.metrics.scenario = 'MODERATE STRESS';
      },
    },
    PREPAY_SLOW: {
      allowedPhases: ['phase2'],
      message: 'US mortgage prepayments slowed: expected inflows not arriving.',
      apply: () => {
        state.metrics.assumptions.prepaymentRatePct = 3;
        state.metrics.scenario = 'MODERATE STRESS';
        state.metrics.liquidityBuffer = Math.max(0, state.metrics.liquidityBuffer - 35_000_000);
      },
    },
    COMPETITOR_15: {
      allowedPhases: ['phase2'],
      message: 'Competitor launched 15% bond. Behavioral maturity diverging now.',
      apply: () => {
        state.metrics.assumptions.depositStability = false;
        state.metrics.scenario = 'SEVERE STRESS';
        state.metrics.panicMeter = Math.min(70, state.metrics.panicMeter + 14);
      },
    },
    BBC_LEAK: {
      allowedPhases: ['phase3', 'phase4'],
      message:
        'BREAKING: BoE emergency funding talks leaked. FSCS protection up to 35,000 is highlighted to all participants.',
      apply: () => {
        state.metrics.scenario = 'SEVERE STRESS';
        state.metrics.panicMeter = Math.min(90, state.metrics.panicMeter + 25);
      },
    },
  };

  const found = eventMap[key];
  if (!found) {
    return { ok: false, error: 'Unknown event trigger' };
  }
  if (!found.allowedPhases.includes(state.session.phase)) {
    return { ok: false, error: `Event ${key} is not available in ${state.session.phase}.` };
  }
  if (state.session.activeEvents.includes(key)) {
    return { ok: false, error: `Event ${key} already triggered.` };
  }

  found.apply();
  if (!state.session.activeEvents.includes(key)) {
    state.session.activeEvents.push(key);
  }
  state.session.eventTriggeredAt[key] = now();
  pushEvent(found.message, 'alert');
  return { ok: true };
}

function applyBoeDecision(decision) {
  if (decision !== 'rescue' && decision !== 'collapse') {
    return { ok: false, error: 'Invalid BoE decision' };
  }

  if (decision === 'rescue') {
    state.session.boeStatus = 'APPROVED';
    state.session.bankStatus = 'RESCUED';
    state.metrics.outcomes.boeInjected = true;
    const depositorBuckets = getDepositorBuckets();
    const wholesaleBuckets = getWholesaleBuckets();
    const assetBuckets = computeAssetBuckets(depositorBuckets, wholesaleBuckets);
    const shortTermFundingGap = Math.max(0, depositorBuckets['0-3m'] + wholesaleBuckets['0-3m'] - assetBuckets['0-3m']);
    const withdrawals = playerList().filter((p) => p.role === 'depositor' && p.meta.withdrew).length;
    const refusals = playerList().filter((p) => p.role === 'wholesale' && p.meta.refused).length;
    const emergencyInjection = roundMoney(
      Math.min(1_600_000_000, Math.max(220_000_000, shortTermFundingGap * 0.55 + refusals * 220_000_000 + withdrawals * 7_500_000))
    );
    state.metrics.outcomes.rescueInjectionAmount = emergencyInjection;
    state.metrics.liquidityBuffer = roundMoney(state.metrics.liquidityBuffer + emergencyInjection);
    pushEvent(`BoE rescue approved. Emergency funding injected: ${emergencyInjection.toLocaleString('en-IN')}.`, 'critical');
  }

  if (decision === 'collapse') {
    state.session.boeStatus = 'REJECTED';
    state.session.bankStatus = 'COLLAPSED';
    state.metrics.liquidityBuffer = 0;
    pushEvent('BoE rescue denied/late. Granite Bank collapsed.', 'critical');
  }

  state.session.phase = 'end';
  state.session.phaseStartedAt = now();
  state.session.revealNames = true;

  for (const player of playerList()) {
    if (player.role === 'wholesale' && !player.meta.refused) {
      player.meta.heldThroughPhase4 = true;
    }
    if (
      player.role === 'depositor' &&
      state.session.bankStatus === 'COLLAPSED' &&
      !player.meta.withdrew &&
      player.balance > FSCS_LIMIT
    ) {
      const loss = player.balance - FSCS_LIMIT;
      player.balance = FSCS_LIMIT;
      recordAction(player, 'forced_loss', { amount: roundMoney(loss) });
    }
  }

  return { ok: true };
}

function enforcePhaseAction(player, actionType, payload) {
  const phase = state.session.phase;
  if (phase === 'lobby' || phase === 'end') {
    return { ok: false, error: 'Actions disabled in current phase' };
  }

  if (player.role === 'depositor') {
    if (player.meta.withdrew) {
      if (actionType === 'hold' || actionType === 'noop') {
        recordAction(player, actionType);
        return { ok: true };
      }
      return { ok: false, error: 'You already exited. You are now a spectator.' };
    }

    if (phase === 'phase1') {
      if (actionType === 'select_product') {
        const product = String(payload.product || '');
        if (!depositorProducts[product] || product === 'premier_142') {
          return { ok: false, error: 'Invalid product' };
        }
        if (player.meta.phase1Confirmed) {
          player.meta.phase1PendingProduct = product;
        } else {
          player.meta.phase1DraftProduct = product;
        }
        recordAction(player, actionType, { product });
        pushEvent(`${player.name} shortlisted ${depositorProducts[product].label}.`);
        return { ok: true };
      }
      if (actionType === 'phase1_set_additional') {
        if (player.meta.phase1Confirmed) {
          return { ok: false, error: 'You can only use the setup slider before first confirm.' };
        }
        const additional = clampNumber(Number(payload.additional || 0), 0, 40000);
        player.meta.phase1DraftAdditional = additional;
        recordAction(player, actionType, { additional });
        return { ok: true };
      }
      if (actionType === 'add_money') {
        if (!player.meta.phase1Confirmed) {
          return { ok: false, error: 'Confirm your deposit first.' };
        }
        const amount = Math.max(0, Number(payload.amount || 0));
        const room = Math.max(0, 50000 - player.principal);
        const capped = Math.min(room, amount);
        if (capped <= 0) return { ok: false, error: 'Amount must be positive' };
        player.balance = roundMoney(player.balance + capped);
        player.principal = roundMoney(player.principal + capped);
        player.meta.phase1DraftAdditional = Math.max(0, roundMoney(player.principal - 10000));
        recordAction(player, actionType, { amount: capped });
        pushEvent(`${player.name} added more savings.`);
        return { ok: true };
      }
      if (actionType === 'phase1_confirm' || actionType === 'hold') {
        const chosenProduct = String(
          player.meta.phase1Confirmed
            ? player.meta.phase1PendingProduct || player.product || ''
            : player.meta.phase1DraftProduct || player.product || ''
        );
        if (!chosenProduct) {
          return { ok: false, error: 'Choose a product first.' };
        }
        finalizeDepositorPhase1Choice(player, chosenProduct);
        recordAction(player, actionType);
        pushEvent(`${player.name} confirmed Phase 1 deposit plan.`);
        return { ok: true };
      }
    }

    if (phase === 'phase2') {
      if (actionType === 'upgrade_premier') {
        if (player.product === 'premier_142') {
          return { ok: false, error: 'Already in Premier Bond.' };
        }
        const accruedBeforeUpgrade = Math.max(0, roundMoney(player.balance - player.principal));
        player.meta.phase2BankedInterest = roundMoney((player.meta.phase2BankedInterest || 0) + accruedBeforeUpgrade);
        player.product = 'premier_142';
        player.principal = roundMoney(player.balance);
        player.meta.phase2UpgradedAt = now();
        recordAction(player, actionType);
        pushEvent(`${player.name} upgraded to Premier Bond 14.2%.`, 'alert');
        return { ok: true };
      }
      if (actionType === 'add_money') {
        const amount = Math.max(0, Number(payload.amount || 0));
        const room = Math.max(0, 50000 - player.principal);
        const capped = Math.min(room, amount);
        if (capped <= 0) return { ok: false, error: 'Amount must be positive' };
        player.balance = roundMoney(player.balance + capped);
        player.principal = roundMoney(player.principal + capped);
        recordAction(player, actionType, { amount: capped });
        return { ok: true };
      }
      if (actionType === 'early_exit') {
        if (String(payload.confirmStep || '') !== 'double') {
          return { ok: false, error: 'Early exit needs final confirmation.' };
        }
        const penaltyPct = 40;
        const principal = Math.max(0, Number(player.principal || 0));
        const interestEarned = Math.max(0, roundMoney(player.balance - principal));
        const penaltyAmount = roundMoney(principal * (penaltyPct / 100));
        const payout = Math.max(0, roundMoney(principal - penaltyAmount + interestEarned));
        player.balance = payout;
        player.principal = 0;
        player.product = null;
        player.meta.withdrew = true;
        player.meta.withdrawnAtPhase = 'phase2';
        player.meta.exitPayout = payout;
        player.meta.exitLoss = penaltyAmount;
        player.meta.exitPrincipal = roundMoney(principal);
        player.meta.exitInterest = roundMoney(interestEarned);
        state.metrics.liquidityBuffer = Math.max(0, state.metrics.liquidityBuffer - payout * 0.15);
        state.metrics.panicMeter = Math.min(95, state.metrics.panicMeter + 3);
        recordAction(player, actionType, {
          penaltyPct,
          principal: roundMoney(principal),
          interestEarned: roundMoney(interestEarned),
          penaltyAmount,
          payout,
        });
        pushEvent(`${player.name} exited early with a ${penaltyPct}% penalty.`, 'alert');
        return { ok: true };
      }
      if (actionType === 'buy_hedge') {
        if (player.meta.hedged) return { ok: false, error: 'Hedge already active' };
        const hedgeType = String(payload.level || 'basic') === 'full' ? 'full' : 'basic';
        const premiumRate = hedgeType === 'full' ? 0.012 : 0.005;
        const premium = roundMoney(player.principal * premiumRate);
        const accrued = Math.max(0, roundMoney(player.balance - player.principal));
        if (premium > accrued) {
          return { ok: false, error: `Need ${premium.toFixed(2)} earned interest to buy this hedge.` };
        }
        player.balance = roundMoney(player.balance - premium);
        player.meta.hedged = true;
        player.meta.hedgeType = hedgeType;
        recordAction(player, actionType, { premium: roundMoney(premium), hedgeType });
        return { ok: true };
      }
      if (actionType === 'hold') {
        recordAction(player, actionType);
        return { ok: true };
      }
    }

    if (phase === 'phase3') {
      ensurePhase3QueueState(player);
      if (actionType === 'hold') {
        if (player.meta.phase3QueueState !== 'none') {
          const drift = Math.floor(Math.random() * 60) + 20;
          player.meta.phase3QueuePosition = Math.max(1, Number(player.meta.phase3QueuePosition || 1800) - drift);
          player.meta.phase3QueueEtaHours = roundMoney(Math.max(1.5, Number(player.meta.phase3QueueEtaHours || 4) + 0.2));
          player.meta.phase3QueueUpdatedAt = now();
        }
        recordAction(player, actionType);
        return { ok: true };
      }
      if (actionType === 'early_exit') {
        player.balance = roundMoney(player.balance * 0.6);
        player.meta.withdrew = true;
        player.meta.withdrawnAtPhase = 'phase3';
        recordAction(player, actionType, { penaltyPct: 40 });
        pushEvent(`${player.name} exited under stress with 40% penalty.`, 'alert');
        return { ok: true };
      }
      if (actionType === 'partial_withdraw_unprotected') {
        const unprotected = Math.max(0, player.balance - FSCS_LIMIT);
        if (unprotected <= 0) return { ok: false, error: 'No unprotected amount to withdraw' };
        player.balance = roundMoney(player.balance - unprotected);
        player.meta.withdrew = true;
        player.meta.withdrawnAtPhase = 'phase3';
        recordAction(player, actionType, { amount: roundMoney(unprotected) });
        pushEvent(`${player.name} withdrew only unprotected amount.`);
        return { ok: true };
      }
      if (actionType === 'convert_current') {
        player.product = 'current';
        player.meta.phase3SwitchedToCurrent = true;
        player.balance = roundMoney(player.balance * 0.85);
        player.principal = roundMoney(player.balance);
        player.meta.phase3QueueState = 'processing';
        player.meta.phase3QueueMode = 'full';
        player.meta.phase3QueueRef = `#${Math.floor(100000 + Math.random() * 900000)}`;
        player.meta.phase3QueueRequestedAmount = roundMoney(player.balance);
        player.meta.phase3QueueEtaHours = 4;
        player.meta.phase3QueuePosition = 1800 + Math.floor(Math.random() * 900);
        player.meta.phase3QueueUpdatedAt = now();
        recordAction(player, actionType, { feePct: 15, queueRef: player.meta.phase3QueueRef });
        pushEvent(`${player.name} paid break fee and switched to instant access.`, 'alert');
        return { ok: true };
      }
      if (actionType === 'phase3_cancel_request') {
        if (player.meta.phase3QueueState === 'none') return { ok: false, error: 'No active request.' };
        player.meta.phase3QueueState = 'cancelled';
        player.meta.phase3QueueUpdatedAt = now();
        recordAction(player, actionType);
        return { ok: true };
      }
      if (actionType === 'phase3_prioritize_protected') {
        if (player.meta.phase3QueueState === 'none') return { ok: false, error: 'No active request.' };
        player.meta.phase3QueueMode = 'protected';
        player.meta.phase3QueueState = 'partial';
        player.meta.phase3QueueRequestedAmount = roundMoney(Math.min(player.balance, FSCS_LIMIT));
        player.meta.phase3QueueEtaHours = roundMoney(Math.max(1.2, Number(player.meta.phase3QueueEtaHours || 4) - 1.8));
        player.meta.phase3QueuePosition = Math.max(1, Math.floor(Number(player.meta.phase3QueuePosition || 1600) * 0.55));
        player.meta.phase3QueueUpdatedAt = now();
        recordAction(player, actionType, { amount: player.meta.phase3QueueRequestedAmount });
        return { ok: true };
      }
      if (actionType === 'phase3_keep_full_request') {
        if (player.meta.phase3QueueState === 'none') return { ok: false, error: 'No active request.' };
        player.meta.phase3QueueMode = 'full';
        player.meta.phase3QueueState = 'processing';
        player.meta.phase3QueueRequestedAmount = roundMoney(player.balance);
        player.meta.phase3QueueEtaHours = roundMoney(Math.min(8, Math.max(3.5, Number(player.meta.phase3QueueEtaHours || 4) + 0.8)));
        player.meta.phase3QueuePosition = Math.max(1, Number(player.meta.phase3QueuePosition || 1800) + 120);
        player.meta.phase3QueueUpdatedAt = now();
        recordAction(player, actionType, { amount: player.meta.phase3QueueRequestedAmount });
        return { ok: true };
      }
    }

    if (phase === 'phase4') {
      if (actionType === 'hold') {
        recordAction(player, actionType);
        return { ok: true };
      }
      if (actionType === 'withdraw_now') {
        player.meta.withdrew = true;
        player.meta.withdrawnAtPhase = 'phase4';
        recordAction(player, actionType);
        pushEvent(`${player.name} withdrew immediately after leak.`, 'alert');
        return { ok: true };
      }
      if (actionType === 'withdraw_unprotected') {
        const unprotected = Math.max(0, player.balance - FSCS_LIMIT);
        if (unprotected <= 0) return { ok: false, error: 'No unprotected amount available' };
        player.balance = roundMoney(player.balance - unprotected);
        player.meta.withdrew = true;
        player.meta.withdrawnAtPhase = 'phase4';
        recordAction(player, actionType, { amount: roundMoney(unprotected) });
        return { ok: true };
      }
      if (actionType === 'spread_panic') {
        player.meta.panicSignals += 1;
        state.metrics.panicMeter = Math.min(95, state.metrics.panicMeter + 4);
        recordAction(player, actionType);
        pushEvent(`${player.name} spread panic signals.`, 'alert');
        return { ok: true };
      }
    }

    return { ok: false, error: 'Action not available for depositor in this phase' };
  }

  if (player.role === 'wholesale') {
    if (state.session.phase === 'phase1') {
      if (actionType === 'select_facility') {
        const facility = String(payload.facility || '');
        if (!wholesaleFacilities[facility]) return { ok: false, error: 'Invalid facility' };
        if (player.meta.phase1Deployed) {
          player.meta.phase1PendingFacility = facility;
        } else {
          player.meta.phase1DraftFacility = facility;
        }
        recordAction(player, actionType, { facility });
        pushEvent(`${player.name} shortlisted ${wholesaleFacilities[facility].label}.`);
        return { ok: true };
      }
      if (actionType === 'phase1_deploy' || actionType === 'maintain') {
        const chosenFacility = String(
          player.meta.phase1Deployed
            ? player.meta.phase1PendingFacility || player.facility || ''
            : player.meta.phase1DraftFacility || player.facility || ''
        );
        if (!chosenFacility) {
          return { ok: false, error: 'Choose a facility first.' };
        }
        finalizeWholesalePhase1Deployment(player, chosenFacility);
        recordAction(player, actionType, { facility: chosenFacility });
        pushEvent(`${player.name} deployed via ${wholesaleFacilities[chosenFacility].label}.`);
        return { ok: true };
      }
      if (actionType === 'phase1_change_cancel') {
        player.meta.phase1PendingFacility = null;
        recordAction(player, actionType);
        return { ok: true };
      }
    }

    if (state.session.phase === 'phase2') {
      if (actionType === 'maintain') {
        recordAction(player, actionType);
        return { ok: true };
      }
      if (actionType === 'demand_spread') {
        const level = Number(payload.level || 25);
        const bps = level === 150 ? 150 : level === 75 ? 75 : 25;
        player.spreadBpsOverride = bps;
        recordAction(player, actionType, { bps });
        state.metrics.liborPct = roundMoney(state.metrics.liborPct + bps / 600);
        pushEvent(`${player.name} demanded +${bps}bps spread.`, 'alert');
        return { ok: true };
      }
      if (actionType === 'reduce_exposure') {
        const pct = Number(payload.pct || 25);
        const validPct = pct === 75 ? 75 : pct === 50 ? 50 : 25;
        player.exposurePct = Math.max(10, player.exposurePct - validPct);
        state.metrics.liquidityBuffer = Math.max(0, state.metrics.liquidityBuffer - player.principal * (validPct / 100) * 0.1);
        recordAction(player, actionType, { pct: validPct });
        pushEvent(`${player.name} reduced exposure by ${validPct}%.`, 'alert');
        return { ok: true };
      }
      if (actionType === 'add_more') {
        const amount = Math.min(500_000_000, Math.max(0, Number(payload.amount || 0)));
        if (amount <= 0) return { ok: false, error: 'Amount must be positive' };
        player.balance = roundMoney(player.balance + amount);
        player.principal = roundMoney(player.principal + amount);
        recordAction(player, actionType, { amount });
        pushEvent(`${player.name} added ${roundMoney(amount / 1_000_000)}m capital.`, 'info');
        return { ok: true };
      }
    }

    if (state.session.phase === 'phase3') {
      if (actionType === 'rollover') {
        recordAction(player, actionType);
        return { ok: true };
      }
      if (actionType === 'punitive_spread') {
        player.spreadBpsOverride = 200;
        state.metrics.liborPct = roundMoney(state.metrics.liborPct + 0.25);
        recordAction(player, actionType, { bps: 200 });
        pushEvent(`${player.name} demanded punitive spread +200bps.`, 'alert');
        return { ok: true };
      }
      if (actionType === 'refuse_rollover') {
        if (!player.meta.refused) {
          player.meta.refused = true;
          player.meta.refusedAtPhase = 'phase3';
          recordAction(player, actionType);
          pushEvent(`${player.name} refused rollover.`, 'critical');
        }
        return { ok: true };
      }
      if (actionType === 'partial_rollover') {
        player.exposurePct = Math.max(20, player.exposurePct - 25);
        recordAction(player, actionType, { pct: 25 });
        return { ok: true };
      }
    }

    if (state.session.phase === 'phase4') {
      if (actionType === 'final_hold') {
        player.meta.heldThroughPhase4 = true;
        recordAction(player, actionType);
        return { ok: true };
      }
      if (actionType === 'final_refuse') {
        player.meta.refused = true;
        player.meta.refusedAtPhase = 'phase4';
        recordAction(player, actionType);
        pushEvent(`${player.name} refused in final window.`, 'critical');
        return { ok: true };
      }
    }

    return { ok: false, error: 'Action not available for wholesale in this phase' };
  }

  return { ok: false, error: 'Unknown role' };
}

function publicSnapshot(req, player) {
  const counts = countRoles();
  const feed = state.session.eventFeed.slice(0, 12);
  const leaderboard = getLeaderboard();

  const depositorBuckets = getDepositorBuckets();
  const wholesaleBuckets = getWholesaleBuckets();
  const assetBuckets = computeAssetBuckets(depositorBuckets, wholesaleBuckets);

  const gapTable = [
    {
      bucket: '0-3m',
      assets: assetBuckets['0-3m'],
      liabilities: roundMoney(depositorBuckets['0-3m'] + wholesaleBuckets['0-3m']),
    },
    {
      bucket: '3-12m',
      assets: assetBuckets['3-12m'],
      liabilities: roundMoney(depositorBuckets['3-12m'] + wholesaleBuckets['3-12m']),
    },
    {
      bucket: '12-36m',
      assets: assetBuckets['12-36m'],
      liabilities: roundMoney(depositorBuckets['12-36m'] + wholesaleBuckets['12-36m']),
    },
    {
      bucket: '36m+',
      assets: assetBuckets.other,
      liabilities: roundMoney(depositorBuckets.other + wholesaleBuckets.other),
    },
  ].map((row) => ({
    ...row,
    netGap: roundMoney(row.assets - row.liabilities),
  }));

  const cumulativeGap = gapTable.reduce((acc, row) => {
    const previous = acc.length ? acc[acc.length - 1].value : 0;
    acc.push({ bucket: row.bucket, value: roundMoney(previous + row.netGap) });
    return acc;
  }, []);

  const response = {
    ok: true,
    serverTime: now(),
    session: {
      id: state.session.id,
      code: state.session.code,
      phase: state.session.phase,
      phaseStartedAt: state.session.phaseStartedAt,
      joinTokenExpiresAt: state.session.join.expiresAt,
      boeStatus: state.session.boeStatus,
      bankStatus: state.session.bankStatus,
      activeEvents: state.session.activeEvents,
      eventTriggeredAt: state.session.eventTriggeredAt || {},
      revealNames: state.session.revealNames,
      joinUrl: buildJoinUrl(req),
    },
    counts,
    metrics: {
      ...state.metrics,
      wholesaleRefusals: playerList().filter((p) => p.role === 'wholesale' && p.meta.refused).length,
      depositorWithdrawals: playerList().filter((p) => p.role === 'depositor' && p.meta.withdrew).length,
      gapTable,
      cumulativeGap,
    },
    leaderboard,
    eventFeed: feed,
  };

  const wholesalePlayers = playerList().filter((p) => p.role === 'wholesale');
  const deployedWholesale = wholesalePlayers.filter((p) => p.meta.phase1Deployed);
  const depositorPlayers = playerList().filter((p) => p.role === 'depositor');
  const confirmedDepositors = depositorPlayers.filter((p) => p.meta.phase1Confirmed);
  response.metrics.wholesaleDeployment = {
    deployedCount: deployedWholesale.length,
    totalCount: wholesalePlayers.length,
    byFacility: {
      overnight: deployedWholesale.filter((p) => p.facility === 'overnight').length,
      week_1: deployedWholesale.filter((p) => p.facility === 'week_1').length,
      month_3: deployedWholesale.filter((p) => p.facility === 'month_3').length,
      year_1: deployedWholesale.filter((p) => p.facility === 'year_1').length,
    },
  };
  response.metrics.phase1Retail = {
    confirmedCount: confirmedDepositors.length,
    totalCount: depositorPlayers.length,
    byProduct: {
      current: confirmedDepositors.filter((p) => p.product === 'current').length,
      notice_3m: confirmedDepositors.filter((p) => p.product === 'notice_3m').length,
      fixed_1y: confirmedDepositors.filter((p) => p.product === 'fixed_1y').length,
      bond_3y: confirmedDepositors.filter((p) => p.product === 'bond_3y').length,
    },
  };
  const wholesaleLive = wholesalePlayers.filter((p) => !p.meta.refused);
  const spreadDemanders = wholesaleLive.filter((p) => Number(p.spreadBpsOverride || 0) > 0);
  const reducedExposure = wholesaleLive.filter((p) => Number(p.exposurePct || 100) < 100);
  const addedCapital = wholesaleLive.filter((p) => Number(p.principal || 0) > 500_000_000);
  response.metrics.phase2Wholesale = {
    liveCount: wholesaleLive.length,
    totalCount: wholesalePlayers.length,
    baseCount: Math.max(0, wholesaleLive.length - spreadDemanders.length),
    demandingCount: spreadDemanders.length,
    reducedCount: reducedExposure.length,
    addedCount: addedCapital.length,
    rolloverRatePct: wholesalePlayers.length ? roundMoney((wholesaleLive.length / wholesalePlayers.length) * 100) : 100,
  };
  const depositors = playerList().filter((p) => p.role === 'depositor');
  const phase2Actions = depositors.flatMap((p) => p.actions).filter((a) => a.phase === 'phase2');
  response.metrics.phase2Depositor = {
    upgraded: phase2Actions.filter((a) => a.type === 'upgrade_premier').length,
    addedMore: phase2Actions.filter((a) => a.type === 'add_money').length,
    exited: phase2Actions.filter((a) => a.type === 'early_exit').length,
    hedged: phase2Actions.filter((a) => a.type === 'buy_hedge').length,
    confidencePct: roundMoney(Math.max(0, 100 - Number(state.metrics.panicMeter || 0))),
  };
  const phase4Outcomes = depositors.map((entry) => getPhase4DepositorOutcome(entry));
  response.metrics.phase4RetailReport = {
    totalDepositors: depositors.length,
    fullyProtected: phase4Outcomes.filter((entry) => Number(entry.loss || 0) <= 0).length,
    sufferedHaircut: phase4Outcomes.filter((entry) => Number(entry.loss || 0) > 0).length,
    lostOver10k: phase4Outcomes.filter((entry) => Number(entry.loss || 0) > 10000).length,
    bankStatusText: state.session.bankStatus === 'RESCUED' ? 'NATIONALIZED / STABILIZED' : 'NATIONALIZED / COLLAPSED',
  };
  const refusedWholesale = wholesalePlayers.filter((entry) => entry.meta.refused);
  const liquidityDrained = roundMoney(
    refusedWholesale.reduce((sum, entry) => sum + Number(entry.principal || 0) * (Number(entry.exposurePct || 100) / 100), 0)
  );
  response.metrics.phase4WholesaleReport = {
    totalWholesale: wholesalePlayers.length,
    refusalRatePct: wholesalePlayers.length ? roundMoney((refusedWholesale.length / wholesalePlayers.length) * 100) : 0,
    liquidityDrained,
    statusText: state.session.bankStatus === 'RESCUED' ? 'STABILIZED BY PUBLIC SUPPORT' : 'NATIONALIZED AFTER FUNDING RUN',
  };
  const phase3Classify = (entry) => {
    if (entry.meta.refused) return 'refused';
    const phase3Action = entry.actions.find((act) => act.phase === 'phase3');
    if (phase3Action && (phase3Action.type === 'rollover' || phase3Action.type === 'punitive_spread')) return 'rolling';
    return 'hesitating';
  };
  const phase3WholesaleCounts = wholesalePlayers.reduce(
    (acc, entry) => {
      acc[phase3Classify(entry)] += 1;
      return acc;
    },
    { rolling: 0, hesitating: 0, refused: 0 }
  );
  response.metrics.phase3Wholesale = {
    totalCount: wholesalePlayers.length,
    rolling: phase3WholesaleCounts.rolling,
    hesitating: phase3WholesaleCounts.hesitating,
    refused: phase3WholesaleCounts.refused,
    refusalRatePct: wholesalePlayers.length ? roundMoney((phase3WholesaleCounts.refused / wholesalePlayers.length) * 100) : 0,
    failureThresholdPct: 50,
  };

  if (player) {
    const currentProduct = depositorProducts[player.product] || null;
    const currentFacility = wholesaleFacilities[player.facility] || null;
    const draftProductId =
      player.role === 'depositor'
        ? player.meta.phase1Confirmed
          ? player.meta.phase1PendingProduct || player.product
          : player.meta.phase1DraftProduct || player.product
        : null;
    const draftProduct = draftProductId ? depositorProducts[draftProductId] || null : null;
    const draftAdditional = player.role === 'depositor' ? clampNumber(Number(player.meta.phase1DraftAdditional || 0), 0, 40000) : 0;
    const previewTotal = player.role === 'depositor' && !player.meta.phase1Confirmed ? roundMoney(10000 + draftAdditional) : roundMoney(player.principal);
    const previewRate = player.role === 'depositor' ? (draftProduct ? draftProduct.rate : currentProduct ? currentProduct.rate : 0) : 0;
    const draftFacilityId =
      player.role === 'wholesale'
        ? player.meta.phase1Deployed
          ? player.meta.phase1PendingFacility || player.facility
          : player.meta.phase1DraftFacility || player.facility
        : null;
    const draftFacility = draftFacilityId ? wholesaleFacilities[draftFacilityId] || null : null;
    const wholesalePreviewRate = player.role === 'wholesale' ? state.metrics.liborPct + (draftFacility ? draftFacility.spreadBps : 8) / 100 : 0;
    const wholesaleDailyPreview = player.role === 'wholesale' ? roundMoney((player.principal * wholesalePreviewRate) / 100 / 365) : 0;
    const phase1CycleBase = Number(player.meta.phase1InterestCycleBaseBalance || player.balance);
    const phase1CycleEarned = Math.max(0, roundMoney(player.balance - phase1CycleBase));
    const wholesaleCycleBase = Number(player.meta.phase1SpreadCycleBaseBalance || player.balance);
    const wholesaleCycleEarned = Math.max(0, roundMoney(player.balance - wholesaleCycleBase));
    const totalInterestAccrued =
      player.role === 'depositor' && player.meta.withdrew
        ? roundMoney(player.meta.exitInterest || 0)
        : Math.max(0, roundMoney(player.balance - player.principal));
    const phase2EarlyExitPenaltyPct = 40;
    const phase2EarlyExitLossEstimate = roundMoney(player.principal * (phase2EarlyExitPenaltyPct / 100));
    const phase2EarlyExitPayoutEstimate = roundMoney(player.balance - phase2EarlyExitLossEstimate);
    const phase2PremierPeers = playerList().filter((entry) => entry.role === 'depositor' && !entry.meta.withdrew && entry.product === 'premier_142').length;
    const phaseElapsedSec = Math.max(0, Math.floor((now() - Number(state.session.phaseStartedAt || now())) / 1000));
    const phase3Stage =
      state.session.phase === 'phase3'
        ? phaseElapsedSec < 120
          ? 'denial'
          : phaseElapsedSec < 300
            ? 'realization'
            : phaseElapsedSec < 420
              ? 'panic'
              : 'bridge'
        : null;
    const phase3SwitchFeePct = 15;
    const phase3SwitchFeeAmount = roundMoney(player.balance * (phase3SwitchFeePct / 100));
    const phase3SwitchPayout = roundMoney(player.balance - phase3SwitchFeeAmount);
    const phase3DecisionSecondsLeft = Math.max(0, 300 - phaseElapsedSec);
    const phase3WholesaleLiveExposure = player.role === 'wholesale' ? roundMoney(player.principal * (player.exposurePct / 100)) : 0;
    const phase3WholesaleOfferRate = roundMoney(state.metrics.liborPct + 2.0);
    const phase3WholesaleOneDayOfferProfit =
      player.role === 'wholesale' ? roundMoney((phase3WholesaleLiveExposure * (phase3WholesaleOfferRate / 100)) / 365) : 0;
    const phase4WholesaleOutcome = player.role === 'wholesale' ? getPhase4WholesaleOutcome(player) : null;
    const phase4Outcome = player.role === 'depositor' ? getPhase4DepositorOutcome(player) : null;
    const phase4Rank = leaderboard.findIndex((row) => row.id === player.id) + 1;
    response.player = {
      id: player.id,
      name: player.name,
      role: player.role,
      balance: roundMoney(player.balance),
      principal: roundMoney(player.principal),
      product: player.product,
      productLabel: currentProduct ? currentProduct.label : 'Not selected',
      productRate: currentProduct ? currentProduct.rate : null,
      facility: player.facility,
      facilityLabel: currentFacility ? currentFacility.label : 'Not selected',
      spreadBpsOverride: player.spreadBpsOverride,
      exposurePct: player.exposurePct,
      unprotectedAmount: roundMoney(Math.max(0, player.balance - FSCS_LIMIT)),
      fscsLimit: FSCS_LIMIT,
      hedged: !!player.meta.hedged,
      withdrew: !!player.meta.withdrew,
      refused: !!player.meta.refused,
      phase1Committed: !!player.meta.phase1Committed,
      phase1TopUpUsed: !!player.meta.phase1TopUpUsed,
      phase1Confirmed: !!player.meta.phase1Confirmed,
      phase1DraftProduct: draftProductId,
      phase1DraftProductLabel: draftProduct ? draftProduct.label : null,
      phase1PendingProduct: player.role === 'depositor' ? player.meta.phase1PendingProduct || null : null,
      phase1DraftAdditional: draftAdditional,
      phase1PreviewTotal: previewTotal,
      phase1PreviewRate: previewRate,
      phase1BankedInterest: roundMoney(player.meta.phase1BankedInterest || 0),
      phase1TickerInterest: phase1CycleEarned,
      totalInterestAccrued,
      phase2BankedInterest: roundMoney(player.meta.phase2BankedInterest || 0),
      phase2PremierPeers,
      phase2CanUpgrade: player.role === 'depositor' ? !player.meta.withdrew && player.product !== 'premier_142' : false,
      phase2ExitPenaltyPct: phase2EarlyExitPenaltyPct,
      phase2ExitLossEstimate: phase2EarlyExitLossEstimate,
      phase2ExitPayoutEstimate: phase2EarlyExitPayoutEstimate,
      phase2ExitPayout: roundMoney(player.meta.exitPayout || 0),
      phase2ExitLoss: roundMoney(player.meta.exitLoss || 0),
      phase2ExitPrincipal: roundMoney(player.meta.exitPrincipal || 0),
      phase2ExitInterest: roundMoney(player.meta.exitInterest || 0),
      phase3Stage,
      phase3PhaseElapsedSec: phaseElapsedSec,
      phase3SwitchFeePct,
      phase3SwitchFeeAmount,
      phase3SwitchPayout,
      phase3SwitchedToCurrent: !!player.meta.phase3SwitchedToCurrent,
      phase3QueueState: player.meta.phase3QueueState || 'none',
      phase3QueueMode: player.meta.phase3QueueMode || 'full',
      phase3QueueRef: player.meta.phase3QueueRef || null,
      phase3QueueRequestedAmount: roundMoney(player.meta.phase3QueueRequestedAmount || 0),
      phase3QueueEtaHours: roundMoney(player.meta.phase3QueueEtaHours || 0),
      phase3QueuePosition: Number(player.meta.phase3QueuePosition || 0),
      phase3QueueUpdatedAt: Number(player.meta.phase3QueueUpdatedAt || 0),
      phase3DecisionSecondsLeft,
      phase3WholesaleLiveExposure,
      phase3WholesaleOfferRate,
      phase3WholesaleOneDayOfferProfit,
      phase4WholesaleOutcome,
      phase4Outcome,
      phase4Rank,
      phase1Deployed: !!player.meta.phase1Deployed,
      phase1DraftFacility: draftFacilityId,
      phase1DraftFacilityLabel: draftFacility ? draftFacility.label : null,
      phase1PendingFacility: player.role === 'wholesale' ? player.meta.phase1PendingFacility || null : null,
      phase1WholesalePreviewRate: wholesalePreviewRate,
      phase1WholesaleDailyPreview: wholesaleDailyPreview,
      phase1BankedSpread: roundMoney(player.meta.phase1BankedSpread || 0),
      phase1TickerSpread: wholesaleCycleEarned,
      label: getPlayerLabel(player),
      score: getPlayerScore(player),
      recentActions: player.actions.slice(0, 6),
      canAct:
        state.session.phase !== 'lobby' &&
        state.session.phase !== 'end' &&
        !(player.role === 'depositor' && player.meta.withdrew) &&
        !(player.role === 'wholesale' && player.meta.refused),
    };
  }

  return response;
}

function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true, uptime: process.uptime() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/session') {
    ensureJoinTokenFresh();
    const counts = countRoles();
    sendJson(res, 200, {
      ok: true,
      session: {
        id: state.session.id,
        code: state.session.code,
        phase: state.session.phase,
        joinTokenExpiresAt: state.session.join.expiresAt,
        joinToken: state.session.join.token,
        joinUrl: buildJoinUrl(req),
      },
      counts,
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/session/rotate-join') {
    rotateJoinToken();
    saveState();
    sendJson(res, 200, {
      ok: true,
      joinToken: state.session.join.token,
      joinTokenExpiresAt: state.session.join.expiresAt,
      joinUrl: buildJoinUrl(req),
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/session/reset') {
    resetState();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/ocr-name') {
    parseBody(req)
      .then(async (body) => {
        const imageDataUrl = String(body.imageDataUrl || '');
        if (!imageDataUrl.startsWith('data:image/')) {
          sendJson(res, 400, { ok: false, error: 'Invalid image payload.' });
          return;
        }
        const ocrSpaceKey = process.env.OCR_SPACE_API_KEY || '';
        const openaiKey = process.env.OPENAI_API_KEY || '';

        if (ocrSpaceKey) {
          const form = new FormData();
          form.append('base64Image', imageDataUrl);
          form.append('language', 'eng');
          form.append('isOverlayRequired', 'false');
          form.append('OCREngine', '2');

          const ocrResp = await fetch('https://api.ocr.space/parse/image', {
            method: 'POST',
            headers: {
              apikey: ocrSpaceKey,
            },
            body: form,
          });

          const ocrJson = await ocrResp.json().catch(() => ({}));
          if (!ocrResp.ok || Number(ocrJson?.IsErroredOnProcessing || 0) === 1) {
            const msg = String(ocrJson?.ErrorMessage?.[0] || ocrJson?.ErrorMessage || 'OCR.space provider error');
            sendJson(res, 502, { ok: false, error: msg });
            return;
          }

          const parsedText = String(ocrJson?.ParsedResults?.[0]?.ParsedText || '');
          const fullName = extractNameFromRawText(parsedText);
          const fallbackName = extractFallbackNameFromRawText(parsedText);
          const confidence = fullName ? 0.85 : 0.15;
          sendJson(res, 200, { ok: true, fullName, fallbackName, confidence });
          return;
        }

        if (openaiKey) {
          const schema = {
            type: 'object',
            additionalProperties: false,
            properties: {
              full_name: { type: 'string' },
              confidence: { type: 'number' },
            },
            required: ['full_name', 'confidence'],
          };

          const resp = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${openaiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'gpt-4.1-mini',
              input: [
                {
                  role: 'user',
                  content: [
                    {
                      type: 'input_text',
                      text:
                        'Extract only the person full name from this ID card image. Ignore all other text. Return strict JSON only.',
                    },
                    {
                      type: 'input_image',
                      image_url: imageDataUrl,
                    },
                  ],
                },
              ],
              text: {
                format: {
                  type: 'json_schema',
                  name: 'id_name_extraction',
                  strict: true,
                  schema,
                },
              },
              max_output_tokens: 80,
            }),
          });

          const json = await resp.json().catch(() => ({}));
          if (!resp.ok) {
            const msg = String(json?.error?.message || 'OpenAI OCR provider error');
            sendJson(res, 502, { ok: false, error: msg });
            return;
          }

          const textOut = String(json?.output_text || '').trim();
          let parsed = { full_name: '', confidence: 0 };
          try {
            parsed = JSON.parse(textOut);
          } catch (_) {
            parsed = { full_name: '', confidence: 0 };
          }

          const fullName = String(parsed.full_name || '')
            .replace(/[^A-Za-z\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 40);
          const confidence = Math.max(0, Math.min(1, Number(parsed.confidence || 0)));
          sendJson(res, 200, { ok: true, fullName, fallbackName: '', confidence });
          return;
        }

        sendJson(res, 503, { ok: false, error: 'OCR service not configured on server.' });
      })
      .catch(() => sendJson(res, 400, { ok: false, error: 'Invalid OCR request body' }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/join/quiz') {
    sendJson(res, 200, {
      ok: true,
      threshold: WHOLESALE_QUIZ_THRESHOLD,
      questions: joinQuiz.map((q) => ({ id: q.id, prompt: q.prompt, options: q.options })),
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/join') {
    parseBody(req)
      .then((body) => {
        const idExtractedName = String(body.idExtractedName || '').trim().replace(/\s+/g, ' ');
        const name = idExtractedName.slice(0, 40);
        const joinToken = String(body.token || '');
        const code = String(body.code || '').toUpperCase();
        const answers = body.quizAnswers || {};

        if (name.length < 3) {
          sendJson(res, 400, { ok: false, error: 'ID name extraction failed. Capture a clearer ID photo.' });
          return;
        }

        if (code && code !== state.session.code) {
          sendJson(res, 400, { ok: false, error: 'Invalid session code' });
          return;
        }

        if (joinToken !== state.session.join.token || state.session.join.expiresAt < now()) {
          sendJson(res, 401, {
            ok: false,
            error: 'Join QR is expired. Ask game master to refresh.',
            code: 'QR_EXPIRED',
          });
          return;
        }

        const normalized = normalizeName(name);
        const duplicate = playerList().find((p) => normalizeName(p.name) === normalized);
        if (duplicate) {
          sendJson(res, 409, { ok: false, error: 'This ID name is already joined in the session.' });
          return;
        }

        const quizScore = evaluateQuizScore(answers);
        const role = assignRoleByQuiz(quizScore);
        const player = initialPlayer(role, name);
        player.meta.verifiedName = true;
        player.meta.quizScore = quizScore;
        state.players[player.id] = player;
        pushEvent(`${name} joined as ${role} (quiz ${quizScore}/3).`);
        saveState();

        sendJson(res, 200, {
          ok: true,
          player: {
            id: player.id,
            name: player.name,
            role: player.role,
            resumeToken: player.resumeToken,
            quizScore,
          },
          session: {
            code: state.session.code,
            phase: state.session.phase,
          },
        });
      })
      .catch(() => sendJson(res, 400, { ok: false, error: 'Invalid body' }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/resume') {
    parseBody(req)
      .then((body) => {
        const resumeToken = String(body.resumeToken || '');
        if (!resumeToken) {
          sendJson(res, 400, { ok: false, error: 'Resume token required' });
          return;
        }

        const player = getPlayerByResume(resumeToken);
        if (!player) {
          sendJson(res, 404, { ok: false, error: 'Player session not found' });
          return;
        }

        sendJson(res, 200, {
          ok: true,
          player: {
            id: player.id,
            name: player.name,
            role: player.role,
            resumeToken: player.resumeToken,
          },
          snapshot: publicSnapshot(req, player),
        });
      })
      .catch(() => sendJson(res, 400, { ok: false, error: 'Invalid body' }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/state') {
    const parsed = new URL(req.url, hostUrl(req));
    const playerId = parsed.searchParams.get('playerId');
    const player = playerId ? state.players[playerId] : null;

    sendJson(res, 200, publicSnapshot(req, player));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/action') {
    parseBody(req)
      .then((body) => {
        const playerId = String(body.playerId || '');
        const actionType = String(body.actionType || '');
        const payload = body.payload || {};
        const player = state.players[playerId];

        if (!player) {
          sendJson(res, 404, { ok: false, error: 'Player not found' });
          return;
        }

        const result = enforcePhaseAction(player, actionType, payload);
        if (!result.ok) {
          sendJson(res, 400, result);
          return;
        }

        adjustMacroMetrics();
        saveState();
        sendJson(res, 200, { ok: true, snapshot: publicSnapshot(req, player) });
      })
      .catch(() => sendJson(res, 400, { ok: false, error: 'Invalid body' }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/gm/phase') {
    parseBody(req)
      .then((body) => {
        const phase = String(body.phase || '');
        const result = setPhase(phase);
        if (!result.ok) {
          sendJson(res, 400, result);
          return;
        }
        saveState();
        sendJson(res, 200, { ok: true, snapshot: publicSnapshot(req, null) });
      })
      .catch(() => sendJson(res, 400, { ok: false, error: 'Invalid body' }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/gm/event') {
    parseBody(req)
      .then((body) => {
        const eventKey = String(body.eventKey || '');
        const result = triggerEvent(eventKey);
        if (!result.ok) {
          sendJson(res, 400, result);
          return;
        }
        saveState();
        sendJson(res, 200, { ok: true, snapshot: publicSnapshot(req, null) });
      })
      .catch(() => sendJson(res, 400, { ok: false, error: 'Invalid body' }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/gm/boe') {
    parseBody(req)
      .then((body) => {
        const decision = String(body.decision || '');
        const result = applyBoeDecision(decision);
        if (!result.ok) {
          sendJson(res, 400, result);
          return;
        }
        saveState();
        sendJson(res, 200, { ok: true, snapshot: publicSnapshot(req, null) });
      })
      .catch(() => sendJson(res, 400, { ok: false, error: 'Invalid body' }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/gm/notify') {
    parseBody(req)
      .then((body) => {
        const message = String(body.message || '').trim().slice(0, 200);
        if (!message) {
          sendJson(res, 400, { ok: false, error: 'Message cannot be empty' });
          return;
        }
        pushEvent(message, 'broadcast');
        saveState();
        sendJson(res, 200, { ok: true });
      })
      .catch(() => sendJson(res, 400, { ok: false, error: 'Invalid body' }));
    return;
  }

  sendJson(res, 404, { ok: false, error: 'API route not found' });
}

function serveStatic(req, res, pathname) {
  let resolved = pathname === '/' ? '/index.html' : pathname;
  let filePath = path.normalize(path.join(PUBLIC_DIR, resolved));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden' });
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  sendFile(res, filePath);
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, hostUrl(req));

  if (parsed.pathname.startsWith('/api/')) {
    handleApi(req, res, parsed.pathname);
    return;
  }

  serveStatic(req, res, parsed.pathname);
});

setInterval(() => {
  applyAccrualTick();
  saveState();
}, 2000);

server.listen(PORT, HOST, () => {
  console.log(`Granite Bank Run Simulator server running at http://${HOST}:${PORT}`);
});
