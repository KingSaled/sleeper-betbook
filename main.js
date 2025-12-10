import './style.css';
import { init, i, id } from '@instantdb/core';

// ----------------- CONFIG (EDIT THESE) -----------------
const APP_ID = '35f3bfd9-6d1d-450a-978f-8cf9b3fecf5e';
const SLEEPER_LEAGUE_ID = '1180549903520518144'; // <-- put your league_id here
const DEFAULT_BANKROLL = 1000;
const ADMIN_SECRET = 'nicetry'; // simple client-side secret for reset
// ------------------------------------------------------

// InstantDB schema (for nice structure; you don't need CLI for this in dev)
const schema = i.schema({
  entities: {
    wallets: i.entity({
      leagueId: i.string().indexed(),
      sleeperUserId: i.string().indexed(),
      displayName: i.string(),
      balance: i.number(),
      startingBankroll: i.number(),
      pnl: i.number(),
      createdAt: i.date(),
      password: i.string().optional(), // 🔐 simple stored password
    }),
    bets: i.entity({
      leagueId: i.string().indexed(),
      sleeperUserId: i.string().indexed(),
      week: i.number(),
      stake: i.number(),
      combinedOdds: i.number(),
      type: i.string(),
      status: i.string(),
      legs: i.any(),
      createdAt: i.date(),
      payout: i.number().optional(),
      settledAt: i.date().optional(),
    }),
  },
});

const db = init({ appId: APP_ID, schema });

// ----------------- GLOBAL STATE -----------------
let currentUser = null; // { id, username, displayName }
let currentWallet = null; // Instant wallet entity
let currentBets = []; // bets for current user
let leaderboardWallets = [];
let leagueState = {
  week: null,
  season: null,
  matchups: [],
  rostersById: {},
  usersById: {},
  projectionsByPlayer: {}, // player_id -> projected points
  projectionsByRoster: {}, // roster_id -> projected team total
  playersById: {}, // player_id -> player metadata
};

let walletAndBetsUnsub = null;
let leaderboardUnsub = null;
let autoSettleTimer = null;

let betSlipLegs = []; // array of { type, description, data, odds }
let playerPropsCandidates = []; // all starter QBs/RBs/WRs/TE with projections
let currentPropPosFilter = 'ALL';
let playerTopOddsById = {}; // playerId -> decimal odds for top-scorer market

let projectionsRefreshTimer = null;
let isPlacingBet = false;
let isRefreshingLeague = false;

let recentLeagueBets = []; // league-wide bets (for recent results)
let recentBetsUnsub = null;

// ----------------- HELPERS -----------------
function computeTeamTopScoreOdds(teamList) {
  if (!teamList.length) return {};

  const scores = teamList.map((t) => ({
    rosterId: t.rosterId,
    score: Math.max(t.projPts || 0, 0),
  }));

  const totalScore = scores.reduce((sum, s) => sum + s.score, 0) || 1;

  let probs = scores.map((s) => ({
    rosterId: s.rosterId,
    p: s.score / totalScore,
  }));

  // small house margin
  const margin = 0.08;
  probs.forEach((e) => {
    e.p *= 1 - margin;
  });

  // renormalize
  const norm = probs.reduce((s, e) => s + e.p, 0) || 1;
  probs.forEach((e) => {
    e.p /= norm;
  });

  const MAX_P = 0.5; // min odds 2.0
  const map = {};
  probs.forEach(({ rosterId, p }) => {
    const clamped = Math.min(p, MAX_P);
    map[rosterId] = +(1 / clamped).toFixed(2);
  });

  return map;
}

const $ = (id) => document.getElementById(id);

function formatMoney(value) {
  return '$' + value.toFixed(2);
}

function statusText(el, text, kind) {
  if (!el) return;
  el.textContent = text || '';
  el.classList.remove('error', 'success');
  if (kind) el.classList.add(kind);
}

// Toast helper (uses Phosphor web icons)
function showToast(message, type = 'info') {
  const container = $('toast-container');
  if (!container || !message) return;

  const toast = document.createElement('div');
  toast.className = 'toast';

  if (type === 'success') toast.classList.add('toast-success');
  else if (type === 'error') toast.classList.add('toast-error');
  else toast.classList.add('toast-info');

  const icon = document.createElement('i');
  icon.className =
    'toast-icon ph ' +
    (type === 'success'
      ? 'ph-check-circle'
      : type === 'error'
      ? 'ph-warning-circle'
      : 'ph-info');

  const msg = document.createElement('span');
  msg.className = 'toast-message';
  msg.textContent = message;

  toast.appendChild(icon);
  toast.appendChild(msg);
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-hide');
    setTimeout(() => {
      toast.remove();
    }, 200);
  }, 3000);
}

// Password modal helper
function openPasswordModal(mode, username) {
  // mode: 'create' | 'enter'
  const backdrop = $('password-modal');
  const titleEl = $('password-modal-title');
  const descEl = $('password-modal-desc');
  const inputEl = $('password-modal-input');
  const confirmBtn = $('password-modal-confirm');
  const cancelBtn = $('password-modal-cancel');

  if (
    !backdrop ||
    !titleEl ||
    !descEl ||
    !inputEl ||
    !confirmBtn ||
    !cancelBtn
  ) {
    // Fallback: don’t break login if modal markup is missing
    const msg =
      mode === 'create'
        ? 'Create a password for your Betbook account (min 4 characters):'
        : 'Enter your Betbook password:';
    const val = window.prompt(msg);
    return Promise.resolve(val === null ? null : val);
  }

  return new Promise((resolve) => {
    inputEl.value = '';

    if (mode === 'create') {
      titleEl.textContent = 'Create Betbook password';
      descEl.textContent = `Set a password to protect your bankroll for ${username}.`;
    } else {
      titleEl.textContent = 'Enter Betbook password';
      descEl.textContent = `Enter the password for ${username}.`;
    }

    backdrop.classList.add('open');

    // focus after open
    setTimeout(() => inputEl.focus(), 0);

    const cleanup = () => {
      backdrop.classList.remove('open');
      inputEl.value = '';
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onBackdrop);
      inputEl.removeEventListener('keydown', onKeyDown);
    };

    const onConfirm = () => {
      const val = (inputEl.value || '').trim();
      resolve(val);
      cleanup();
    };

    const onCancel = () => {
      resolve(null);
      cleanup();
    };

    const onBackdrop = (e) => {
      if (e.target === backdrop) {
        onCancel();
      }
    };

    const onKeyDown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    backdrop.addEventListener('click', onBackdrop);
    inputEl.addEventListener('keydown', onKeyDown);
  });
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

// ----------------- PLAYER METADATA (Sleeper) -----------------

// Big players file; cache in memory + localStorage so we don't refetch often
let playersCache = null;

async function loadAllNflPlayers() {
  if (playersCache) return playersCache;

  const cached = localStorage.getItem('sleeper_players_nfl_v1');
  if (cached) {
    try {
      playersCache = JSON.parse(cached);
      return playersCache;
    } catch (_) {
      // fall through to fetch
    }
  }

  const data = await fetchJson('https://api.sleeper.app/v1/players/nfl');
  playersCache = data;
  try {
    localStorage.setItem('sleeper_players_nfl_v1', JSON.stringify(data));
  } catch (_) {
    // storage might be full, that's ok
  }
  return playersCache;
}

// ----------------- PLAYER STATS (Sleeper, past averages) -----------------

const PLAYER_STATS_BASE = 'https://api.sleeper.com/stats/nfl/player';

// cache: key = `${season}-${playerId}` -> avg PPR
const playerStatsCache = {};

async function fetchPlayerAveragePoints(playerId, season, currentWeek) {
  if (!season || !currentWeek || currentWeek <= 1) {
    // no real "history" yet
    return null;
  }

  const key = `${season}-${playerId}`;
  if (playerStatsCache[key] !== undefined) {
    return playerStatsCache[key];
  }

  try {
    const url = `${PLAYER_STATS_BASE}/${playerId}?season_type=regular&season=${season}&grouping=week`;
    const data = await fetchJson(url);
    let total = 0;
    let count = 0;

    for (const [weekStr, entry] of Object.entries(data || {})) {
      const w = Number(weekStr);
      if (!Number.isFinite(w)) continue;
      if (w >= currentWeek) continue; // only completed weeks
      const pts = entry?.stats?.pts_ppr;
      if (pts != null) {
        total += Number(pts);
        count++;
      }
    }

    const avg = count ? total / count : null;
    playerStatsCache[key] = avg;
    return avg;
  } catch (err) {
    console.error('fetchPlayerAveragePoints error', playerId, err);
    playerStatsCache[key] = null;
    return null;
  }
}

// Fill each candidate with avgPts if we can
async function enrichPlayerCandidatesWithHistory(candidates) {
  const season = leagueState.season;
  const week = leagueState.week;
  if (!season || !week || week <= 1) return; // nothing meaningful yet

  await Promise.all(
    candidates.map(async (c) => {
      const avg = await fetchPlayerAveragePoints(c.playerId, season, week);
      if (avg != null) {
        c.avgPts = avg;
      }
    })
  );
}

// ----------------- PROJECTIONS (Sleeper) -----------------

// Fetch weekly NFL projections from Sleeper.
// Undocumented endpoint used by community tools:
//   /projections/nfl/<season>/<week>?season_type=regular&position[]=...&order_by=ppr
async function fetchNflProjections(season, week) {
  const base = `https://api.sleeper.app/projections/nfl/${season}/${week}`;
  const params =
    '?season_type=regular' +
    '&position[]=QB&position[]=RB&position[]=WR&position[]=TE' +
    '&position[]=K&position[]=DEF&position[]=FLEX&position[]=REC_FLEX' +
    '&order_by=ppr';

  const url = base + params;
  const data = await fetchJson(url); // returns array of projection objects
  return data;
}

// Turn raw projection array into a simple map: player_id -> projected fantasy pts
function buildPlayerProjectionMap(projectionArray) {
  const map = {};
  for (const proj of projectionArray || []) {
    const pid = proj.player_id;
    if (!pid) continue;
    const stats = proj.stats || {};
    // Try common fantasy scoring keys; fall back to 0 if missing
    const pts = Number(
      stats.pts_ppr ?? stats.pts_half_ppr ?? stats.pts_std ?? 0
    );
    map[pid] = pts;
  }
  return map;
}

// Compute roster-level projection totals based on starters in matchups
function buildRosterProjectionMap(matchups, playerProjMap) {
  const rosterTotals = {};
  for (const m of matchups || []) {
    const rid = m.roster_id;
    if (!rid) continue;
    const starters = m.starters || [];
    let total = rosterTotals[rid] || 0;
    for (const pid of starters) {
      const pts = playerProjMap[pid] ?? 0;
      total += pts;
    }
    rosterTotals[rid] = total;
  }
  return rosterTotals;
}

// Compute odds for "top scorer this week" across a list of players
function computePlayerTopScorerOdds(playerList) {
  if (!playerList.length) return {};

  const PROJ_WEIGHT = 0.6;
  const HIST_WEIGHT = 0.4;

  // Step 1: build a combined rating from projection + historical average
  const scores = playerList.map((p) => {
    const proj = p.projPts || 0;
    const hist = p.avgPts != null ? p.avgPts : proj; // fall back to proj
    const rating = PROJ_WEIGHT * proj + HIST_WEIGHT * (hist || 0);
    return {
      playerId: p.playerId,
      score: Math.max(rating, 0),
    };
  });

  const totalScore = scores.reduce((sum, s) => sum + s.score, 0) || 1;

  let probs = scores.map((s) => ({
    playerId: s.playerId,
    p: s.score / totalScore,
  }));

  // Step 2: apply a small house margin
  const margin = 0.08; // 8%
  probs.forEach((e) => {
    e.p *= 1 - margin;
  });

  // Renormalize
  const norm = probs.reduce((s, e) => s + e.p, 0) || 1;
  probs.forEach((e) => {
    e.p /= norm;
  });

  // Step 3: only clamp big favorites, let longshots float naturally
  const MAX_P = 0.35; // min odds ~2.86
  const map = {};
  probs.forEach(({ playerId, p }) => {
    const clamped = Math.min(p, MAX_P);
    map[playerId] = +(1 / clamped).toFixed(2);
  });

  return map;
}

// ----------------- SLEEPER INTEGRATION -----------------

async function lookupSleeperUser(username) {
  const user = await fetchJson(`https://api.sleeper.app/v1/user/${username}`);
  return {
    id: user.user_id,
    username: user.username,
    displayName: user.display_name || user.username,
  };
}

async function loadLeagueData() {
  try {
    // Get current NFL state for week/season
    const state = await fetchJson('https://api.sleeper.app/v1/state/nfl');
    const week = state.week;
    const season = state.season;

    // Fetch league info + weekly matchups + projections in parallel
    const [users, rosters, matchups, projectionsRaw] = await Promise.all([
      fetchJson(`https://api.sleeper.app/v1/league/${SLEEPER_LEAGUE_ID}/users`),
      fetchJson(
        `https://api.sleeper.app/v1/league/${SLEEPER_LEAGUE_ID}/rosters`
      ),
      fetchJson(
        `https://api.sleeper.app/v1/league/${SLEEPER_LEAGUE_ID}/matchups/${week}`
      ),
      fetchNflProjections(season, week),
    ]);

    const usersById = {};
    users.forEach((u) => {
      usersById[u.user_id] = u;
    });

    const rostersById = {};
    rosters.forEach((r) => {
      rostersById[r.roster_id] = r;
    });

    const projectionsByPlayer = buildPlayerProjectionMap(projectionsRaw);
    const projectionsByRoster = buildRosterProjectionMap(
      matchups,
      projectionsByPlayer
    );

    leagueState = {
      ...leagueState,
      week,
      season,
      matchups,
      usersById,
      rostersById,
      projectionsByPlayer,
      projectionsByRoster,
    };

    renderMatchups();
    $('week-number').textContent = String(week);
    $('bet-props-section').hidden = false;

    await setupPlayerProps();
    renderTeamProps(); // prepare team props, too
    renderRecentBets();

    autoSettleForCurrentWeek();
  } catch (err) {
    console.error('loadLeagueData failed', err);
    const note = $('matchups-note');
    if (note) {
      note.textContent =
        'Failed to load league/matchups from Sleeper. Check that SLEEPER_LEAGUE_ID is correct and projections endpoint is reachable. (' +
        (err.message || 'unknown error') +
        ')';
    }
    $('bet-props-section').hidden = false;
    throw err;
  }
}

async function periodicLeagueRefresh() {
  // Don’t spam Sleeper or fight with bet placement
  if (isRefreshingLeague || isPlacingBet) return;
  if (!currentUser) return; // nothing to refresh if nobody is connected

  isRefreshingLeague = true;
  try {
    // Re-use the normal loader
    await loadLeagueData();
  } catch (err) {
    console.error('Periodic league refresh failed', err);
    const note = $('matchups-note');
    if (note && !note.textContent) {
      note.textContent =
        'Could not refresh projections from Sleeper (will retry later).';
    }
  } finally {
    isRefreshingLeague = false;
  }
}

function computeMatchupOdds(rosterAId, rosterBId) {
  const projMap = leagueState.projectionsByRoster || {};
  const projA = projMap[rosterAId] ?? 0;
  const projB = projMap[rosterBId] ?? 0;

  // If we don't have projections, return even odds
  if (!projA && !projB) {
    return { oddsA: 2.0, oddsB: 2.0 };
  }

  const diff = projA - projB;

  // Softer logistic: treat ~20–25 pts diff as "strong but not certain"
  const scale = 18; // bigger = flatter curve
  let pA = 1 / (1 + Math.exp(-diff / scale)); // base e logistic
  let pB = 1 - pA;

  // Add a small house margin
  const margin = 0.05; // 5% overround
  pA *= 1 - margin / 2;
  pB *= 1 - margin / 2;
  const norm = pA + pB;
  pA /= norm;
  pB /= norm;

  // Clamp so we never get absurd odds
  const MIN_P = 0.1; // max odds 10.0
  const MAX_P = 0.9; // min odds ~1.11
  pA = Math.min(Math.max(pA, MIN_P), MAX_P);
  pB = Math.min(Math.max(pB, MIN_P), MAX_P);

  const oddsA = +(1 / pA).toFixed(2);
  const oddsB = +(1 / pB).toFixed(2);

  return { oddsA, oddsB };
}

// ----------------- INSTANTDB: WALLETS & BETS -----------------

async function ensureWalletForUser(sleeperUserId, displayName) {
  const resp = await db.queryOnce({
    wallets: {
      $: {
        where: { leagueId: SLEEPER_LEAGUE_ID, sleeperUserId },
      },
    },
  });

  if (resp.error) {
    console.error(resp.error);
    throw new Error('Error querying wallets');
  }

  const existing = resp.data.wallets?.[0];
  if (existing) return existing;

  // Create new wallet
  const walletId = id();
  await db.transact(
    db.tx.wallets[walletId].update({
      leagueId: SLEEPER_LEAGUE_ID,
      sleeperUserId,
      displayName,
      balance: DEFAULT_BANKROLL,
      startingBankroll: DEFAULT_BANKROLL,
      pnl: 0,
      createdAt: Date.now(),
    })
  );

  const resp2 = await db.queryOnce({
    wallets: {
      $: {
        where: { leagueId: SLEEPER_LEAGUE_ID, sleeperUserId },
      },
    },
  });

  return resp2.data.wallets[0];
}

function subscribeRecentBets() {
  if (recentBetsUnsub) recentBetsUnsub();

  recentBetsUnsub = db.subscribeQuery(
    {
      bets: {
        $: {
          where: { leagueId: SLEEPER_LEAGUE_ID },
          order: {
            serverCreatedAt: 'desc',
          },
        },
      },
    },
    (resp) => {
      if (resp.error) {
        console.error('recent bets subscription error', resp.error);
        return;
      }
      recentLeagueBets = resp.data.bets || [];
      renderRecentBets();
    }
  );
}

function subscribeWalletAndBets(sleeperUserId) {
  if (walletAndBetsUnsub) walletAndBetsUnsub();

  walletAndBetsUnsub = db.subscribeQuery(
    {
      wallets: {
        $: {
          where: { leagueId: SLEEPER_LEAGUE_ID, sleeperUserId },
        },
      },
      bets: {
        $: {
          where: { leagueId: SLEEPER_LEAGUE_ID, sleeperUserId },
          order: {
            serverCreatedAt: 'desc', // newest bets first
          },
        },
      },
    },
    (resp) => {
      if (resp.error) {
        console.error(resp.error);
        return;
      }
      const data = resp.data || {};
      currentWallet = (data.wallets && data.wallets[0]) || null;
      currentBets = data.bets || [];
      renderWallet();
      renderUserBets();
    }
  );
}

function subscribeLeaderboard() {
  if (leaderboardUnsub) leaderboardUnsub();

  leaderboardUnsub = db.subscribeQuery(
    {
      wallets: {
        $: {
          where: { leagueId: SLEEPER_LEAGUE_ID },
        },
      },
    },
    (resp) => {
      if (resp.error) {
        console.error(resp.error);
        return;
      }
      leaderboardWallets = resp.data.wallets || [];
      renderLeaderboard();
    }
  );
}

// ----------------- AUTO SETTLEMENT -----------------

function groupMatchupsById(matchups) {
  const map = new Map();
  for (const m of matchups) {
    const id = m.matchup_id ?? m.roster_id;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(m);
  }
  return map;
}

function getTopScoringPlayerId(matchups) {
  const totals = new Map(); // playerId -> points
  for (const m of matchups || []) {
    const pp = m.players_points || {};
    for (const [pid, pts] of Object.entries(pp)) {
      const prev = totals.get(pid) || 0;
      totals.set(pid, prev + (pts ?? 0));
    }
  }
  let bestId = null;
  let bestPts = -Infinity;
  for (const [pid, pts] of totals.entries()) {
    if (pts > bestPts) {
      bestPts = pts;
      bestId = pid;
    }
  }
  return bestId;
}

function getTopScoringRosterId(matchups) {
  const totals = new Map(); // rosterId -> points
  for (const m of matchups || []) {
    const rid = m.roster_id;
    if (!rid) continue;
    const pts = m.points ?? 0;
    totals.set(rid, (totals.get(rid) || 0) + pts);
  }
  let bestId = null;
  let bestPts = -Infinity;
  for (const [rid, pts] of totals.entries()) {
    if (pts > bestPts) {
      bestPts = pts;
      bestId = rid;
    }
  }
  return bestId;
}

async function autoSettleForCurrentWeek() {
  // 1) Get current NFL week from Sleeper
  let state;
  try {
    state = await fetchJson('https://api.sleeper.app/v1/state/nfl');
  } catch (err) {
    console.error('Error fetching Sleeper state for settlement', err);
    return;
  }

  const currentWeek = Number(state.week);
  if (!Number.isFinite(currentWeek) || currentWeek <= 0) {
    // Offseason / unknown week – nothing to settle
    return;
  }

  // 2) Load all open bets + wallets for this league
  const resp = await db.queryOnce({
    bets: {
      $: {
        where: { leagueId: SLEEPER_LEAGUE_ID, status: 'open' },
      },
    },
    wallets: {
      $: {
        where: { leagueId: SLEEPER_LEAGUE_ID },
      },
    },
  });

  if (resp.error) {
    console.error('Error querying for settlement', resp.error);
    return;
  }

  const openBets = resp.data.bets || [];
  if (!openBets.length) return;

  // 3) Group open bets by week, but only for weeks that are COMPLETE
  const betsByWeek = new Map(); // week -> bet[]
  for (const bet of openBets) {
    const wk = Number(bet.week);
    if (!Number.isFinite(wk)) continue;
    // Only settle bets for weeks strictly before the current NFL week
    if (wk >= currentWeek) continue;

    if (!betsByWeek.has(wk)) betsByWeek.set(wk, []);
    betsByWeek.get(wk).push(bet);
  }

  if (!betsByWeek.size) {
    // Nothing eligible to settle yet (we're still in that week)
    return;
  }

  const walletsByUser = {};
  (resp.data.wallets || []).forEach((w) => {
    walletsByUser[w.sleeperUserId] = w;
  });

  const allTxs = [];

  // 4) For each completed week, fetch final matchups and settle bets
  for (const [week, betsForWeek] of betsByWeek.entries()) {
    let matchups;
    try {
      matchups = await fetchJson(
        `https://api.sleeper.app/v1/league/${SLEEPER_LEAGUE_ID}/matchups/${week}`
      );
    } catch (err) {
      console.error('Error fetching matchups for settlement week', week, err);
      continue;
    }

    const byMatchup = groupMatchupsById(matchups);
    const topPlayerId = getTopScoringPlayerId(matchups);
    const topRosterId = getTopScoringRosterId(matchups);

    for (const bet of betsForWeek) {
      const legs = bet.legs || [];
      let allWin = true;

      for (const leg of legs) {
        if (leg.type === 'match_winner') {
          const matchupTeams = byMatchup.get(leg.data.matchupId) || [];
          if (matchupTeams.length < 2) {
            // Incomplete / missing matchup – don't settle this bet yet
            allWin = null;
            break;
          }
          const [t1, t2] = matchupTeams;
          const winnerRosterId =
            (t1.points ?? 0) >= (t2.points ?? 0) ? t1.roster_id : t2.roster_id;
          if (winnerRosterId !== leg.data.winnerRosterId) {
            allWin = false;
            break;
          }
        } else if (leg.type === 'player_top_points') {
          if (!topPlayerId) {
            // We can't fairly determine a top scorer yet
            allWin = null;
            break;
          }
          if (topPlayerId !== leg.data.playerId) {
            allWin = false;
            break;
          }
        } else if (leg.type === 'team_top_points') {
          if (!topRosterId) {
            // Can't determine top team yet
            allWin = null;
            break;
          }
          if (topRosterId !== leg.data.rosterId) {
            allWin = false;
            break;
          }
        } else {
          // Unknown bet type: don't attempt to settle this bet
          allWin = null;
          break;
        }
      }

      if (allWin === null) {
        // Skip this bet for now; will be retried on a future settlement run
        continue;
      }

      const now = Date.now();
      const wallet = walletsByUser[bet.sleeperUserId];
      if (!wallet) continue;

      if (allWin) {
        const payout = bet.stake * bet.combinedOdds;
        allTxs.push(
          db.tx.bets[bet.id].update({
            status: 'won',
            payout,
            settledAt: now,
          })
        );
        allTxs.push(
          db.tx.wallets[wallet.id].update({
            balance: wallet.balance + payout,
            pnl: (wallet.pnl || 0) + (payout - bet.stake),
          })
        );
        wallet.balance += payout;
        wallet.pnl = (wallet.pnl || 0) + (payout - bet.stake);
      } else {
        allTxs.push(
          db.tx.bets[bet.id].update({
            status: 'lost',
            payout: 0,
            settledAt: now,
          })
        );
        allTxs.push(
          db.tx.wallets[wallet.id].update({
            pnl: (wallet.pnl || 0) - bet.stake,
          })
        );
        wallet.pnl = (wallet.pnl || 0) - bet.stake;
      }
    }
  }

  if (allTxs.length) {
    await db.transact(allTxs);
  }
}

// ----------------- BET SLIP -----------------

function recalcBetSlipSummary() {
  const summaryEl = $('betslip-summary');
  if (!betSlipLegs.length) {
    summaryEl.textContent = 'No legs selected';
    return;
  }
  const combinedOdds = betSlipLegs.reduce(
    (acc, leg) => acc * (leg.odds ?? 1),
    1
  );
  const stake = Number($('betslip-stake').value || '0');
  const potential = stake * combinedOdds;
  summaryEl.textContent = `Parlay with ${
    betSlipLegs.length
  } leg(s) · combined odds ${combinedOdds.toFixed(
    2
  )} · potential return ${formatMoney(potential || 0)}`;
}

function renderBetSlip() {
  const container = $('betslip-legs');
  container.innerHTML = '';
  container.classList.toggle('empty', betSlipLegs.length === 0);

  if (!betSlipLegs.length) {
    container.innerHTML =
      '<p>No selections yet. Tap odds below to add legs to your slip.</p>';
    recalcBetSlipSummary();
    return;
  }

  betSlipLegs.forEach((leg, idx) => {
    const row = document.createElement('div');
    row.className = 'betslip-leg';

    let label = '';
    let kind = '';

    if (leg.type === 'match_winner') {
      label = leg.data.ownerName || 'Team';
      kind = 'Win';
    } else if (leg.type === 'team_top_points') {
      label = leg.data.ownerName || 'Team';
      kind = 'Top Scoring Team';
    } else if (leg.type === 'player_top_points') {
      label = leg.data.playerName || 'Player';
      kind = 'Top Scorer';
    } else {
      label = 'Selection';
      kind = '';
    }

    const leftText = document.createElement('span');
    leftText.textContent = kind ? `${label} | ${kind}` : `${label}`; // fallback if kind missing

    const meta = document.createElement('span');
    meta.textContent = `@ ${leg.odds.toFixed(2)}`;

    const left = document.createElement('span');
    left.appendChild(leftText);
    left.append(' ');
    left.appendChild(meta);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'betslip-leg-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      betSlipLegs.splice(idx, 1);
      renderBetSlip();
    });

    row.appendChild(left);
    row.appendChild(removeBtn);

    container.appendChild(row);
  });

  recalcBetSlipSummary();
}

function addMatchWinnerLeg(matchupId, rosterId, teamLabel, ownerName, odds) {
  // 1) If this exact side is already on the slip, do nothing
  const alreadySelected = betSlipLegs.some(
    (leg) =>
      leg.type === 'match_winner' &&
      leg.data.matchupId === matchupId &&
      leg.data.winnerRosterId === rosterId
  );
  if (alreadySelected) {
    return;
  }

  // 2) If the *other* side of this matchup is already on the slip, remove it
  const otherSideIndex = betSlipLegs.findIndex(
    (leg) =>
      leg.type === 'match_winner' &&
      leg.data.matchupId === matchupId &&
      leg.data.winnerRosterId !== rosterId
  );
  if (otherSideIndex !== -1) {
    betSlipLegs.splice(otherSideIndex, 1);
  }

  // 3) Add the new selection
  betSlipLegs.push({
    type: 'match_winner',
    // short description style for history list
    description: `${ownerName} | Win`,
    data: {
      matchupId,
      winnerRosterId: rosterId,
      ownerName,
      teamLabel,
    },
    odds,
  });

  renderBetSlip();
}

function addTeamTopLeg(rosterId, ownerName, odds) {
  const exists = betSlipLegs.some(
    (leg) => leg.type === 'team_top_points' && leg.data.rosterId === rosterId
  );
  if (exists) return;

  betSlipLegs.push({
    type: 'team_top_points',
    description: `${ownerName} | Top Scoring Team`,
    data: {
      rosterId,
      ownerName,
    },
    odds,
  });

  renderBetSlip();
}

function addPlayerTopLeg(playerId, playerName, odds) {
  const exists = betSlipLegs.some(
    (leg) => leg.type === 'player_top_points' && leg.data.playerId === playerId
  );
  if (exists) return;

  betSlipLegs.push({
    type: 'player_top_points',
    description: `${playerName} | Top Scorer`,
    data: {
      playerId,
      playerName,
    },
    odds,
  });

  renderBetSlip();
}

// ----------------- RENDERING: WALLET / BETS / LEADERBOARD -----------------

function renderWallet() {
  if (!currentUser || !currentWallet) return;

  $('wallet-and-slip').hidden = false;
  $('wallet-balance').textContent = formatMoney(currentWallet.balance || 0);

  const pnlEl = $('wallet-pnl');
  const pnl = currentWallet.pnl || 0;
  pnlEl.textContent = (pnl >= 0 ? '+' : '') + pnl.toFixed(2);
  pnlEl.classList.toggle('pnl-positive', pnl > 0);
  pnlEl.classList.toggle('pnl-negative', pnl < 0);
}

function renderUserBets() {
  const list = $('user-bets-list');
  if (!currentUser) {
    $('bets-section').hidden = true;
    return;
  }

  $('bets-section').hidden = false;
  list.innerHTML = '';

  if (!currentBets.length) {
    const li = document.createElement('li');
    li.textContent = 'No bets yet. Build a slip and place your first bet!';
    li.className = 'small-muted';
    list.appendChild(li);
    return;
  }

  currentBets.forEach((bet) => {
    const li = document.createElement('li');
    li.className = 'bet-item';

    const header = document.createElement('div');
    header.className = 'bet-header';
    const left = document.createElement('span');
    left.textContent = `Week ${bet.week} · ${bet.type}`;
    const status = document.createElement('span');
    status.className = 'bet-status ' + bet.status;
    status.textContent = bet.status.toUpperCase();
    header.appendChild(left);
    header.appendChild(status);

    const body = document.createElement('div');
    body.textContent = `${formatMoney(bet.stake)} @ ${bet.combinedOdds.toFixed(
      2
    )}`;
    const legsUl = document.createElement('ul');
    legsUl.className = 'bet-legs';
    (bet.legs || []).forEach((leg) => {
      const liLeg = document.createElement('li');
      liLeg.textContent = leg.description;
      legsUl.appendChild(liLeg);
    });

    const payoutLine = document.createElement('div');
    payoutLine.className = 'small-muted';
    if (bet.status === 'won') {
      payoutLine.textContent = `Payout: ${formatMoney(bet.payout || 0)}`;
    } else if (bet.status === 'lost') {
      payoutLine.textContent = `Lost stake: ${formatMoney(bet.stake)}`;
    } else {
      payoutLine.textContent = 'Open – will auto-settle after the week ends.';
    }

    li.appendChild(header);
    li.appendChild(body);
    li.appendChild(legsUl);
    li.appendChild(payoutLine);

    list.appendChild(li);
  });
}

function renderRecentBets() {
  const section = $('recent-bets-section');
  const list = $('recent-bets-list');
  if (!section || !list) return;

  // Always show the card; we'll handle "empty" via message
  section.hidden = false;
  list.innerHTML = '';

  const bets = recentLeagueBets || [];

  if (!bets.length) {
    const li = document.createElement('li');
    li.className = 'recent-bet-empty';
    li.textContent = 'No bets placed in the league yet.';
    list.appendChild(li);
    return;
  }

  // Bets are already sorted newest-first by serverCreatedAt in subscribeRecentBets
  const settled = bets
    .filter((b) => b.status === 'won' || b.status === 'lost')
    .slice(0, 10);

  const placed = bets.filter((b) => b.status === 'open').slice(0, 10);

  const addItem = (bet, kind) => {
    const li = document.createElement('li');
    li.className = 'recent-bet-item';

    const mainRow = document.createElement('div');
    mainRow.className = 'recent-bet-main';

    const resultSpan = document.createElement('span');
    resultSpan.className = 'recent-bet-result ' + kind;

    const stake = bet.stake || 0;
    const odds = bet.combinedOdds || 1;

    // Try to get display name from wallets used in leaderboard
    const wallet = (leaderboardWallets || []).find(
      (w) => w.sleeperUserId === bet.sleeperUserId
    );
    const name = wallet?.displayName || 'Unknown';

    if (kind === 'placed') {
      // Recently placed (open) bet
      resultSpan.textContent = `${name} placed ${formatMoney(
        stake
      )} @ ${odds.toFixed(2)} (Wk ${bet.week})`;
    } else if (kind === 'won') {
      const payout = stake * odds;
      const profit = payout - stake;
      resultSpan.textContent = `${name} won ${formatMoney(
        profit
      )} (stake ${formatMoney(stake)} @ ${odds.toFixed(2)} · Wk ${bet.week})`;
    } else if (kind === 'lost') {
      resultSpan.textContent = `${name} lost ${formatMoney(
        stake
      )} (stake ${formatMoney(stake)} @ ${odds.toFixed(2)} · Wk ${bet.week})`;
    } else {
      resultSpan.textContent = `${name} bet ${formatMoney(
        stake
      )} @ ${odds.toFixed(2)} (Wk ${bet.week})`;
    }

    mainRow.appendChild(resultSpan);
    li.appendChild(mainRow);
    list.appendChild(li);
  };

  let hasAny = false;

  if (placed.length) {
    const sep = document.createElement('li');
    sep.className = 'recent-bet-separator';
    sep.textContent = 'Recently placed';
    list.appendChild(sep);

    placed.forEach((bet) => {
      addItem(bet, 'placed');
    });
    hasAny = true;
  }

  if (settled.length) {
    const sep = document.createElement('li');
    sep.className = 'recent-bet-separator';
    sep.textContent = 'Recently settled';
    list.appendChild(sep);

    settled.forEach((bet) => {
      addItem(bet, bet.status); // 'won' or 'lost'
    });
    hasAny = true;
  }

  if (!hasAny) {
    const li = document.createElement('li');
    li.className = 'recent-bet-empty';
    li.textContent = 'No bets placed in the league yet.';
    list.appendChild(li);
  }
}

function renderLeaderboard() {
  const tbody = $('leaderboard-body');
  tbody.innerHTML = '';
  $('leaderboard-section').hidden = false;

  // Sort wallets by balance descending on the client
  const sorted = [...leaderboardWallets].sort(
    (a, b) => (b.balance || 0) - (a.balance || 0)
  );

  sorted.forEach((w, idx) => {
    const tr = document.createElement('tr');
    const rank = document.createElement('td');
    rank.textContent = String(idx + 1);
    const name = document.createElement('td');
    name.textContent = w.displayName || 'Unknown';
    const bal = document.createElement('td');
    bal.textContent = formatMoney(w.balance || 0);
    const pnl = document.createElement('td');
    const v = w.pnl || 0;
    pnl.textContent = (v >= 0 ? '+' : '') + v.toFixed(2);
    tr.appendChild(rank);
    tr.appendChild(name);
    tr.appendChild(bal);
    tr.appendChild(pnl);
    tbody.appendChild(tr);
  });
}

// ----------------- RENDERING: MATCHUPS -----------------

function renderMatchups() {
  const container = $('matchups-list');
  container.innerHTML = '';

  const { matchups, rostersById, usersById, projectionsByRoster } = leagueState;
  if (!matchups?.length) {
    container.innerHTML = '<p>No matchups found for this week.</p>';
    return;
  }

  // Group matchups by matchup_id (two rosters per).
  const byMatchup = groupMatchupsById(matchups);

  for (const [matchupId, teams] of byMatchup.entries()) {
    if (teams.length < 2) continue;
    const [a, b] = teams;

    const rosterA = rostersById[a.roster_id];
    const rosterB = rostersById[b.roster_id];
    if (!rosterA || !rosterB) continue;

    const userA = usersById[rosterA.owner_id];
    const userB = usersById[rosterB.owner_id];

    const ownerNameA = userA?.display_name || userA?.username || 'Unknown';
    const ownerNameB = userB?.display_name || userB?.username || 'Unknown';

    const { oddsA, oddsB } = computeMatchupOdds(a.roster_id, b.roster_id);

    const projA = projectionsByRoster?.[a.roster_id] ?? 0;
    const projB = projectionsByRoster?.[b.roster_id] ?? 0;

    const card = document.createElement('div');
    card.className = 'matchup-card';

    // Header: username vs username in its own box
    const header = document.createElement('div');
    header.className = 'matchup-title';
    header.textContent = `${ownerNameA} vs ${ownerNameB}`;
    card.appendChild(header);

    const row = document.createElement('div');
    row.className = 'matchup-row';

    // --- Side A ---
    const sideA = document.createElement('button');
    sideA.type = 'button';
    sideA.className = 'matchup-side';

    const userPillA = document.createElement('span');
    userPillA.className = 'matchup-user-pill';
    userPillA.textContent = ownerNameA;

    const oddsPillA = document.createElement('span');
    oddsPillA.className = 'matchup-odds-pill';
    oddsPillA.textContent = `Odds: ${oddsA.toFixed(2)}`;

    const projPillA = document.createElement('span');
    projPillA.className = 'matchup-proj-pill';
    projPillA.textContent = `Proj: ${projA.toFixed(1)} pts`;

    sideA.appendChild(userPillA);
    sideA.appendChild(oddsPillA);
    sideA.appendChild(projPillA);

    sideA.addEventListener('click', () => {
      addMatchWinnerLeg(matchupId, a.roster_id, ownerNameA, ownerNameA, oddsA);
    });

    // --- Side B ---
    const sideB = document.createElement('button');
    sideB.type = 'button';
    sideB.className = 'matchup-side';

    const userPillB = document.createElement('span');
    userPillB.className = 'matchup-user-pill';
    userPillB.textContent = ownerNameB;

    const oddsPillB = document.createElement('span');
    oddsPillB.className = 'matchup-odds-pill';
    oddsPillB.textContent = `Odds: ${oddsB.toFixed(2)}`;

    const projPillB = document.createElement('span');
    projPillB.className = 'matchup-proj-pill';
    projPillB.textContent = `Proj: ${projB.toFixed(1)} pts`;

    sideB.appendChild(userPillB);
    sideB.appendChild(oddsPillB);
    sideB.appendChild(projPillB);

    sideB.addEventListener('click', () => {
      addMatchWinnerLeg(matchupId, b.roster_id, ownerNameB, ownerNameB, oddsB);
    });

    row.appendChild(sideA);
    row.appendChild(sideB);
    card.appendChild(row);

    container.appendChild(card);
  }
}

async function setupPlayerProps() {
  const section = $('bet-props-section');
  const list = $('player-props-list');
  list.innerHTML = '';
  // 🔹 Do NOT force-hide the whole section here; mode + visibility are handled elsewhere
  // section.hidden = true;

  if (!leagueState.matchups?.length) {
    return;
  }

  // Load players metadata (cached)
  let players;
  try {
    players = await loadAllNflPlayers();
  } catch (err) {
    console.error('Failed to load players', err);
    list.innerHTML =
      "<p class='small-muted'>Could not load player list for props.</p>";
    section.hidden = false;
    return;
  }

  const projByPlayer = leagueState.projectionsByPlayer || {};
  const startersSet = new Set();

  // Collect starters from all matchups
  for (const m of leagueState.matchups) {
    (m.starters || []).forEach((pid) => startersSet.add(pid));
  }

  const allowedPositions = new Set(['QB', 'RB', 'WR', 'TE']);
  const candidates = [];

  startersSet.forEach((playerId) => {
    const p = players[playerId];
    if (!p) return;
    const position = p.position || '';
    if (!allowedPositions.has(position)) return;

    const projPts = projByPlayer[playerId] ?? 0;
    if (!projPts) return;

    const name =
      `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() ||
      p.full_name ||
      'Unknown';
    const team = p.team || '';

    const photoUrl = `https://sleepercdn.com/content/nfl/players/${playerId}.jpg`;

    candidates.push({
      playerId,
      name,
      position,
      team,
      projPts,
      photoUrl,
    });
  });

  playerPropsCandidates = candidates;

  if (!playerPropsCandidates.length) {
    list.innerHTML =
      "<p class='small-muted'>No starter projections available for player props.</p>";
    section.hidden = false;
    return;
  }

  // 🔹 Enrich with historical averages
  await enrichPlayerCandidatesWithHistory(playerPropsCandidates);

  // 🔹 Compute odds ONCE for the whole universe of players
  playerTopOddsById = computePlayerTopScorerOdds(playerPropsCandidates);

  // 🔹 Preserve the user’s existing filter if they had one
  if (!currentPropPosFilter) {
    currentPropPosFilter = 'ALL';
  }

  // 🔹 Re-highlight the active position pill based on currentPropPosFilter
  document.querySelectorAll('.prop-pos-pill').forEach((btn) => {
    const pos = btn.dataset.pos || 'ALL';
    btn.classList.toggle('active', pos === currentPropPosFilter);
  });

  // 🔹 Re-render list using the preserved filter
  renderPlayerProps();
  section.hidden = false;
}

function renderPlayerProps() {
  const list = $('player-props-list');
  list.innerHTML = '';

  if (!playerPropsCandidates.length) {
    list.innerHTML =
      "<p class='small-muted'>No starter projections available for player props.</p>";
    return;
  }

  // Filter by position
  let filtered = playerPropsCandidates;
  if (currentPropPosFilter !== 'ALL') {
    filtered = playerPropsCandidates.filter(
      (p) => p.position === currentPropPosFilter
    );
  }

  if (!filtered.length) {
    list.innerHTML =
      "<p class='small-muted'>No starters for this position.</p>";
    return;
  }

  // Sort by projection desc; odds are already computed for full list
  filtered.sort((a, b) => b.projPts - a.projPts);

  filtered.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'prop-card';

    // --- Left side: avatar + text ---
    const left = document.createElement('div');
    left.className = 'prop-left';

    const main = document.createElement('div');
    main.className = 'prop-main';

    const nameEl = document.createElement('span');
    nameEl.className = 'prop-name';
    nameEl.textContent = p.name;

    const metaEl = document.createElement('span');
    metaEl.className = 'prop-meta';

    const avgText =
      p.avgPts != null ? ` • Avg: ${p.avgPts.toFixed(1)} pts` : '';
    metaEl.textContent = `Proj: ${p.projPts.toFixed(1)} pts${avgText}`;

    main.appendChild(nameEl);
    main.appendChild(metaEl);

    // Player headshot (optional)
    const avatar = document.createElement('img');
    avatar.className = 'prop-avatar';
    avatar.alt = p.name;
    avatar.src = p.photoUrl || '';
    avatar.loading = 'lazy';
    avatar.onerror = () => {
      // Hide if the image 404s
      avatar.style.display = 'none';
    };

    left.appendChild(avatar);
    left.appendChild(main);

    // --- Right side: odds + Add button ---
    const right = document.createElement('div');
    right.className = 'prop-right';

    const odds = playerTopOddsById[p.playerId] ?? 5.0;

    const oddsEl = document.createElement('span');
    oddsEl.className = 'prop-odds-pill';
    oddsEl.textContent = `Odds: ${odds.toFixed(2)}`;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'prop-add-btn';
    btn.textContent = 'Add';
    btn.addEventListener('click', () => {
      addPlayerTopLeg(p.playerId, p.name, odds);
    });

    right.appendChild(oddsEl);
    right.appendChild(btn);

    card.appendChild(left);
    card.appendChild(right);

    list.appendChild(card);
  });
}

function renderTeamProps() {
  const list = $('team-props-list');
  if (!list) return;
  list.innerHTML = '';

  const { matchups, rostersById, usersById, projectionsByRoster } = leagueState;
  if (!matchups?.length) {
    list.innerHTML =
      "<p class='small-muted'>No matchups loaded for this week.</p>";
    return;
  }

  const byMatchup = groupMatchupsById(matchups);
  const teams = [];

  for (const [matchupId, entries] of byMatchup.entries()) {
    // Only consider "real" matchups: must have id AND at least 2 teams
    if (!matchupId || entries.length < 2) continue;

    for (const m of entries) {
      const rid = m.roster_id;
      if (!rid) continue;

      const roster = rostersById[rid];
      if (!roster) continue;

      const projPts = projectionsByRoster?.[rid] ?? 0;
      if (!projPts) continue;

      const user = usersById[roster.owner_id];
      const ownerName = user?.display_name || user?.username || 'Unknown';

      teams.push({
        rosterId: rid,
        ownerName,
        projPts,
      });
    }
  }

  // Dedupe
  const seen = new Set();
  const uniqueTeams = [];
  for (const t of teams) {
    if (seen.has(t.rosterId)) continue;
    seen.add(t.rosterId);
    uniqueTeams.push(t);
  }

  if (!uniqueTeams.length) {
    list.innerHTML =
      "<p class='small-muted'>No teams with active matchups for this week.</p>";
    return;
  }

  uniqueTeams.sort((a, b) => b.projPts - a.projPts);
  const oddsMap = computeTeamTopScoreOdds(uniqueTeams);

  uniqueTeams.forEach((t) => {
    const card = document.createElement('div');
    card.className = 'prop-card';

    const main = document.createElement('div');
    main.className = 'prop-main';

    // Username as the main label
    const nameEl = document.createElement('span');
    nameEl.className = 'prop-name';
    nameEl.textContent = t.ownerName;

    const metaEl = document.createElement('span');
    metaEl.className = 'prop-meta';
    metaEl.textContent = `Proj: ${t.projPts.toFixed(1)} pts`;

    main.appendChild(nameEl);
    main.appendChild(metaEl);

    const right = document.createElement('div');
    right.className = 'prop-right';

    const oddsEl = document.createElement('span');
    oddsEl.className = 'prop-odds-pill';
    const odds = oddsMap[t.rosterId] ?? 5.0;
    oddsEl.textContent = `Odds: ${odds.toFixed(2)}`;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'prop-add-btn';
    btn.textContent = 'Add';
    btn.addEventListener('click', () => {
      addTeamTopLeg(t.rosterId, t.ownerName, odds);
    });

    right.appendChild(oddsEl);
    right.appendChild(btn);

    card.appendChild(main);
    card.appendChild(right);

    list.appendChild(card);
  });
}

// ----------------- PLACE BET -----------------

async function placeBet() {
  const errorEl = $('betslip-error');
  statusText(errorEl, '');

  // prevent double-click or overlapping with refresh
  if (isPlacingBet) return;
  isPlacingBet = true;

  try {
    if (!currentUser || !currentWallet) {
      const msg = 'You must be logged in and have a wallet.';
      statusText(errorEl, msg, 'error');
      showToast(msg, 'error');
      return;
    }

    if (!betSlipLegs.length) {
      const msg = 'Your bet slip is empty.';
      statusText(errorEl, msg, 'error');
      showToast(msg, 'error');
      return;
    }

    const stake = Number($('betslip-stake').value || '0');
    if (!stake || stake <= 0) {
      const msg = 'Stake must be > 0.';
      statusText(errorEl, msg, 'error');
      showToast(msg, 'error');
      return;
    }

    if (stake > currentWallet.balance) {
      const msg = 'Insufficient balance.';
      statusText(errorEl);
      showToast(msg, 'error');
      return;
    }

    const combinedOdds = betSlipLegs.reduce(
      (acc, leg) => acc * (leg.odds ?? 1),
      1
    );
    const type = betSlipLegs.length === 1 ? betSlipLegs[0].type : 'parlay';

    const week = leagueState.week;
    if (!week) {
      const msg = 'Week not loaded yet.';
      statusText(errorEl, msg, 'error');
      showToast(msg, 'error');
      return;
    }

    const betId = id();
    const walletId = currentWallet.id;
    const newBalance = currentWallet.balance - stake;

    await db.transact([
      db.tx.wallets[walletId].update({
        balance: newBalance,
      }),
      db.tx.bets[betId].update({
        leagueId: SLEEPER_LEAGUE_ID,
        sleeperUserId: currentUser.id,
        week,
        stake,
        combinedOdds,
        type,
        status: 'open',
        legs: betSlipLegs,
        createdAt: Date.now(),
      }),
    ]);

    betSlipLegs = [];
    renderBetSlip();
    statusText(errorEl, '');
    showToast('Bet placed!', 'success');
  } finally {
    isPlacingBet = false;
  }
}

// ----------------- ADMIN RESET -----------------

// ----------------- ADMIN RESET -----------------

async function adminReset() {
  const secret = $('admin-secret').value;
  const statusEl = $('admin-reset-status');
  statusText(statusEl, '');

  if (secret !== ADMIN_SECRET) {
    statusText(statusEl, 'Wrong secret.', 'error');
    return;
  }

  // Grab all wallets & bets for this league
  const resp = await db.queryOnce({
    wallets: {
      $: { where: { leagueId: SLEEPER_LEAGUE_ID } },
    },
    bets: {
      $: { where: { leagueId: SLEEPER_LEAGUE_ID } },
    },
  });

  if (resp.error) {
    console.error('adminReset query error', resp.error);
    statusText(statusEl, 'Error querying DB.', 'error');
    return;
  }

  const wallets = resp.data.wallets || [];
  const bets = resp.data.bets || [];

  const txs = [];

  // ❌ Completely delete all wallets so the leaderboard is cleared
  wallets.forEach((w) => {
    txs.push(db.tx.wallets[w.id].delete());
  });

  // ❌ Delete all bets
  bets.forEach((b) => {
    txs.push(db.tx.bets[b.id].delete());
  });

  if (txs.length) {
    await db.transact(txs);
  }

  // After this:
  // - Leaderboard subscription sees 0 wallets => empty leaderboard
  // - User bets list is empty
  // - Next time someone logs in, ensureWalletForUser() will recreate their wallet at DEFAULT_BANKROLL

  statusText(statusEl, 'League reset!', 'success');
}

async function adminClearUserPassword() {
  const usernameInput = $('admin-reset-user');
  const statusEl = $('admin-reset-user-status');
  statusText(statusEl, '');

  const username = (usernameInput.value || '').trim();
  if (!username) {
    statusText(statusEl, 'Enter a Sleeper username.', 'error');
    return;
  }

  try {
    // Look up that Sleeper user
    const user = await lookupSleeperUser(username);

    // Find their wallet in this league
    const resp = await db.queryOnce({
      wallets: {
        $: {
          where: {
            leagueId: SLEEPER_LEAGUE_ID,
            sleeperUserId: user.id,
          },
        },
      },
    });

    if (resp.error) {
      console.error('adminClearUserPassword query error', resp.error);
      statusText(statusEl, 'Error querying DB.', 'error');
      return;
    }

    const wallet = resp.data.wallets?.[0];
    if (!wallet) {
      statusText(statusEl, 'No wallet found for that user.', 'error');
      return;
    }

    await db.transact(
      db.tx.wallets[wallet.id].update({
        password: null,
      })
    );

    statusText(
      statusEl,
      'Password cleared. User will be asked to create a new one on next login.',
      'success'
    );
  } catch (err) {
    console.error('adminClearUserPassword error', err);
    statusText(
      statusEl,
      'Error clearing password (check the Sleeper username).',
      'error'
    );
  }
}

// ----------------- LOGIN FLOW -----------------

async function handleLogin() {
  const usernameInput = $('sleeper-username');
  const btn = $('login-btn');
  const statusEl = $('login-status');
  const loginPill = $('login-user-pill');

  // reset UI bits
  statusText(statusEl, '');
  $('wallet-and-slip').hidden = true;
  $('bets-section').hidden = true;
  $('admin-section').hidden = true;
  if (loginPill) loginPill.hidden = true;

  const username = (usernameInput.value || '').trim();
  if (!username) {
    statusText(statusEl, 'Please enter your Sleeper username.', 'error');
    return;
  }

  btn.disabled = true;
  statusText(statusEl, 'Looking up Sleeper user…');

  try {
    // 1) Look up Sleeper user
    const user = await lookupSleeperUser(username);

    // 2) Ensure they are actually in this league
    let leagueUsers;
    try {
      leagueUsers = await fetchJson(
        `https://api.sleeper.app/v1/league/${SLEEPER_LEAGUE_ID}/users`
      );
    } catch (err) {
      console.error('Failed loading league users for membership check', err);
      statusText(
        statusEl,
        'Could not verify league membership. Please try again.',
        'error'
      );
      btn.disabled = false;
      return;
    }

    const isMember = leagueUsers.some((u) => u.user_id === user.id);
    if (!isMember) {
      statusText(
        statusEl,
        'That Sleeper account is not a member of this league.',
        'error'
      );
      btn.disabled = false;
      return;
    }

    // Cache league users for later labels
    const usersById = {};
    leagueUsers.forEach((u) => {
      usersById[u.user_id] = u;
    });
    leagueState.usersById = usersById;

    currentUser = user;

    // 3) Ensure wallet exists
    let wallet = await ensureWalletForUser(user.id, user.displayName);

    // 4) 🔐 Password flow (using custom modal)
    if (!wallet.password) {
      // First time (or no password set): ask to CREATE one
      const newPw = await openPasswordModal('create', user.username);

      if (newPw === null || newPw === '') {
        statusText(
          statusEl,
          'Login cancelled before setting a password.',
          'error'
        );
        btn.disabled = false;
        return;
      }

      if (newPw.length < 4) {
        statusText(
          statusEl,
          'Password must be at least 4 characters.',
          'error'
        );
        btn.disabled = false;
        return;
      }

      await db.transact(
        db.tx.wallets[wallet.id].update({
          password: newPw,
        })
      );
      wallet.password = newPw;
      showToast('Password created for your Betbook account.', 'success');
    } else {
      // Existing wallet: ask to ENTER password
      const attempt = await openPasswordModal('enter', user.username);
      if (attempt === null) {
        statusText(statusEl, 'Login cancelled.', 'error');
        btn.disabled = false;
        return;
      }
      if (attempt !== wallet.password) {
        statusText(statusEl, 'Incorrect password for this account.', 'error');
        btn.disabled = false;
        return;
      }
    }

    currentWallet = wallet;

    statusText(
      statusEl,
      `Connected as ${user.displayName} (${user.username}).`,
      'success'
    );

    // Persist basic user info
    localStorage.setItem(
      'betbook-user',
      JSON.stringify({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
      })
    );

    // Start live subscriptions
    subscribeWalletAndBets(user.id);
    subscribeLeaderboard();
    subscribeRecentBets();

    $('wallet-and-slip').hidden = false;
    $('bets-section').hidden = false;

    // 🔐 Admin tools only for your account
    if (user.username === 'kingsaled') {
      $('admin-section').hidden = false;
    } else {
      $('admin-section').hidden = true;
    }

    // 💚 Update "logged in as" pill on the connect card
    if (loginPill) {
      const nameSpan = $('login-user-pill-name');
      if (nameSpan) nameSpan.textContent = user.username;
      loginPill.hidden = false;
    }

    // 5) Load league + matchups, start timers
    try {
      statusText(statusEl, 'Connected. Loading league & matchups…');
      await loadLeagueData();

      // periodic projection refresh (every 5 minutes)
      if (projectionsRefreshTimer) clearInterval(projectionsRefreshTimer);
      projectionsRefreshTimer = setInterval(periodicLeagueRefresh, 60_000);

      // periodic auto-settle check
      if (autoSettleTimer) clearInterval(autoSettleTimer);
      autoSettleTimer = setInterval(autoSettleForCurrentWeek, 60_000);

      statusText(statusEl, '');
      showToast('All set! League data loaded.', 'success');
    } catch (err) {
      console.error('loadLeagueData error:', err);
      statusText(
        statusEl,
        'Connected to Sleeper, but failed to load league/matchups: ' +
          (err.message || 'unknown error'),
        'error'
      );
      // wallet & bets still work; just no matchups/props if this fails
    }
  } catch (err) {
    console.error('Sleeper username lookup / wallet error:', err);
    statusText(
      statusEl,
      'Error connecting to Sleeper user. Double-check your username.',
      'error'
    );
    $('admin-section').hidden = true;
  } finally {
    btn.disabled = false;
  }
}

// ----------------- INIT -----------------

function setPropMode(mode) {
  const modes = ['matchups', 'top-player', 'top-team'];

  modes.forEach((m) => {
    const tab = $(
      m === 'matchups'
        ? 'prop-tab-matchups'
        : m === 'top-player'
        ? 'prop-tab-top-player'
        : 'prop-tab-top-team'
    );
    const container = $(
      m === 'matchups'
        ? 'prop-mode-matchups'
        : m === 'top-player'
        ? 'prop-mode-top-player'
        : 'prop-mode-top-team'
    );
    if (tab) tab.classList.toggle('active', m === mode);
    if (container) container.classList.toggle('active', m === mode);
  });
}

function attachEventListeners() {
  $('login-btn').addEventListener('click', handleLogin);
  $('sleeper-username').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleLogin();
    }
  });

  $('betslip-stake').addEventListener('input', () => {
    recalcBetSlipSummary();
  });

  $('place-bet-btn').addEventListener('click', placeBet);
  $('admin-reset-btn').addEventListener('click', adminReset);
  $('admin-reset-user-btn')?.addEventListener('click', adminClearUserPassword);

  // Player prop position pills
  document.querySelectorAll('.prop-pos-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pos = btn.dataset.pos || 'ALL';
      currentPropPosFilter = pos;

      document
        .querySelectorAll('.prop-pos-pill')
        .forEach((b) => b.classList.toggle('active', b === btn));

      renderPlayerProps();
    });
  });

  // Bet props main tabs
  const tabMatchups = $('prop-tab-matchups');
  const tabTopPlayer = $('prop-tab-top-player');
  const tabTopTeam = $('prop-tab-top-team');

  tabMatchups?.addEventListener('click', () => setPropMode('matchups'));
  tabTopPlayer?.addEventListener('click', () => setPropMode('top-player'));
  tabTopTeam?.addEventListener('click', () => {
    setPropMode('top-team');
    renderTeamProps();
  });
}

function maybeAutoLogin() {
  const raw = localStorage.getItem('betbook-user');
  if (!raw) return;
  try {
    const user = JSON.parse(raw);
    if (user && user.id) {
      currentUser = user;
      $('sleeper-username').value = user.username || '';
      showToast(
        `Restored session as ${user.displayName} (${user.username}). Click "Connect" to sync.`,
        'info'
      );
    }
  } catch (_) {
    // ignore
  }
}

function main() {
  attachEventListeners();
  renderBetSlip();
  maybeAutoLogin();
}

main();


main();

