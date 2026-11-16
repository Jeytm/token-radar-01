// Token Radar's model: one sealed snapshot in, one ranked board out.
//
// The board ranks the protocols that record no token and are not a wrapped, staked or bridged
// product of a token that already trades — the watchlist's own rule, applied to every row, not just
// the watchlist. Protocols whose token already trades are set aside with their market caps: the
// market's own numbers, never a model's, and the calibration set the model is checked against.
//
// Implied value is one stated formula of the snapshot's own figures, the same function for every row:
//
//   ratio        = the category's shrunken median market-cap-to-TVL ratio among live-token
//                  protocols (see categoryRatio), or the global median when the category has
//                  fewer than three live comparables
//   growthMult   = 1 + clamp(change_7d, -60, 120) / 100 x 0.5
//   maturityMult = 0.6 + min(age_days, 1095) / 1095 x 0.4   (age unknown: 365 days)
//   implied      = max(1, round(tvl_usd x ratio x growthMult x maturityMult))
//
// No protocol name is ever special-cased. The dashboard recomputes every row from the same formula,
// so the page and board.json agree by construction, and the leave-one-out check in calibrateModel
// measures the formula against the live-token protocols it was never fitted on.

/** One protocol entry: exactly the ten fields the sealed snapshot carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, stated in the dashboard and used by both the builder and the page. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  shrink_k: number;
  min_comparables: number;
  ratio_min: number;
  ratio_max: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  shrink_k: 3,
  min_comparables: 3,
  ratio_min: 0.02,
  ratio_max: 2.0,
};

/** The model's version label, shown in the dashboard header. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the dashboard's live view carries, by market cap. */
export const LIVE_ROWS = 150;

/** A farm step before it is flattened to one string: the action, its cost, its time. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_ratio: number;
    comparables: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** One row as the dashboard carries it, farm plan included so the page never re-derives it alone. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  category_ratio: number;
  comparables: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  farm_steps: string[];
}

/** A protocol whose token already trades: shown with the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  age_days: number | null;
  ratio: number | null;
}

/** One category's calibration: how many live comparables, their median ratio, the ratio used. */
export interface CategoryCalibration {
  category: string;
  comparables: number;
  median_ratio: number | null;
  ratio: number;
}

/** The leave-one-out check of the model against the live-token protocols. */
export interface Calibration {
  comparables: number;
  median_abs_log_error: number;
  mean_abs_log_error: number;
  factor: number;
  baseline_median_abs_log_error: number;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist: string[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  global_ratio: number;
  calibration: Calibration;
  categories: CategoryCalibration[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** The median of a non-empty list; null when empty. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when the date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether the record carries no token at all: no market cap, no CoinGecko id, no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** The watchlist's exclusion rule, from the snapshot's field guide, applied to any protocol. */
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * Whether a protocol is a subject of the board: it records no token, and it is not a wrapped,
 * staked or bridged product of a token that already trades. The watchlist rows pass this rule by
 * construction; the early rows below the floor are held to the same rule.
 */
export function isSubject(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED_NAME.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((prefix) => p.name.startsWith(prefix))) return false;
  return true;
}

/**
 * The live comparables: protocols whose token trades, with a positive market cap and TVL, outside
 * the exchange category. They calibrate the category ratios and the leave-one-out check.
 */
export function comparables(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) => !isPreToken(p) && p.category !== 'CEX' && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
}

/** A comparable's market-cap-to-TVL ratio. */
function ratioOf(p: SnapshotProtocol): number {
  return (p.mcap_usd as number) / p.tvl_usd;
}

/**
 * The value multiple for one category: the median market-cap-to-TVL ratio of its live comparables,
 * shrunk toward the global median with weight `shrink_k`, so a category with few comparables cannot
 * swing the board on one outlier. Categories with fewer than `min_comparables` comparables use the
 * global median outright. The result is clamped to the model's ratio band.
 */
export function categoryRatio(category: string | null, pool: SnapshotProtocol[], model: ModelConstants): { ratio: number; comparables: number; median: number | null } {
  const global = median(pool.map(ratioOf));
  const globalRatio = global === null ? 0.25 : global;
  const key = category ?? '(uncategorised)';
  const mine = pool.filter((p) => (p.category ?? '(uncategorised)') === key).map(ratioOf);
  const med = median(mine);
  if (med === null || mine.length < model.min_comparables) {
    return { ratio: clamp(globalRatio, model.ratio_min, model.ratio_max), comparables: mine.length, median: med };
  }
  const shrunk = (mine.length * med + model.shrink_k * globalRatio) / (mine.length + model.shrink_k);
  return { ratio: clamp(shrunk, model.ratio_min, model.ratio_max), comparables: mine.length, median: med };
}

/** The implied value of one protocol under the stated formula, with its multipliers exposed. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  ratio: number,
  model: ModelConstants,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const growthPct = clamp(finite(protocol.change_7d, 0), model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (clamp(ageForModel, 0, model.maturity_days) / model.maturity_days) * model.maturity_range;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * ratio * growthMult * maturityMult));
  return { implied, growthPct, growthMult, maturityMult, age };
}

/**
 * The leave-one-out check: every live comparable is scored by a model fitted on all the others
 * (its own record excluded from the category medians), and the prediction is compared with its
 * real market cap. The median absolute log error is the model's honest miss; `factor` is that miss
 * as a multiple. The baseline is the same check with one global ratio for every protocol.
 */
export function calibrateModel(snapshot: Snapshot, model: ModelConstants): Calibration {
  const pool = comparables(snapshot);
  const errors: number[] = [];
  const baselineErrors: number[] = [];
  for (const p of pool) {
    const rest = pool.filter((q) => q.slug !== p.slug);
    const { ratio } = categoryRatio(p.category, rest, model);
    const { implied } = impliedValue(p, snapshot.as_of, ratio, model);
    errors.push(Math.abs(Math.log(implied) - Math.log(p.mcap_usd as number)));
    const global = median(rest.map(ratioOf)) ?? 0.25;
    const { implied: base } = impliedValue(p, snapshot.as_of, clamp(global, model.ratio_min, model.ratio_max), model);
    baselineErrors.push(Math.abs(Math.log(base) - Math.log(p.mcap_usd as number)));
  }
  const med = median(errors) ?? 0;
  const baseMed = median(baselineErrors) ?? 0;
  return {
    comparables: pool.length,
    median_abs_log_error: Math.round(med * 1e4) / 1e4,
    mean_abs_log_error: Math.round((errors.reduce((a, b) => a + b, 0) / Math.max(1, errors.length)) * 1e4) / 1e4,
    factor: Math.round(Math.exp(med) * 100) / 100,
    baseline_median_abs_log_error: Math.round(baseMed * 1e4) / 1e4,
  };
}

/** The calibration table: one row per category that has at least one live comparable. */
export function categoryTable(snapshot: Snapshot, model: ModelConstants): CategoryCalibration[] {
  const pool = comparables(snapshot);
  const keys = [...new Set(pool.map((p) => p.category ?? '(uncategorised)'))].sort();
  return keys
    .map((key) => {
      const { ratio, comparables: n, median: med } = categoryRatio(key === '(uncategorised)' ? null : key, pool, model);
      return { category: key, comparables: n, median_ratio: med === null ? null : Math.round(med * 1e4) / 1e4, ratio: Math.round(ratio * 1e4) / 1e4 };
    })
    .sort((a, b) => b.comparables - a.comparables || (a.category < b.category ? -1 : 1));
}

// ---------------------------------------------------------------- farm plans

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Approximate gas for one transaction on a chain, in whole dollars: an estimate, labelled as one. */
export function gasFor(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 6;
  if (c === 'solana') return 0.05;
  if (c === 'tron') return 2;
  if (c === 'bitcoin') return 3;
  if (c === 'binance' || c === 'bsc' || c === 'polygon' || c === 'polygon zkevm') return 0.3;
  if (c === 'hyperliquid l1' || c === 'hyperliquid') return 0.1;
  if (['arbitrum', 'optimism', 'base', 'blast', 'linea', 'scroll', 'zksync', 'mantle', 'mode', 'fraxtal', 'ink', 'unichain', 'soneium', 'abstract', 'berachain', 'avalanche', 'gnosis', 'celo', 'fantom', 'moonbeam', 'aurora'].includes(c)) return 0.5;
  return 2;
}

/** Gas as a short dollar figure: $0.05, $0.30, $0.50, $2, $3, $6. */
function gasText(chain: string): string {
  const g = gasFor(chain);
  return g < 1 ? `$${g.toFixed(2)}` : `$${g}`;
}

/** The capital one farm position needs, tiered by the protocol's own TVL. */
export function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 25_000_000) return 100;
  return 50;
}

/** How long to hold: younger protocols get a longer window, so the activity spans more snapshots. */
export function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's main action: what the farmer actually does with the capital. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name}'s lending market on ${chain} and leave the position open.`;
  if (c.includes('dex')) return `Add $${capital} of liquidity to ${name}'s busiest pool on ${chain} and leave the position open.`;
  if (c.includes('yield') || c.includes('farm') || c.includes('leveraged')) return `Deposit $${capital} of USDC into ${name}'s highest-TVL vault on ${chain} and hold the vault shares.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC through ${name} to ${chain} and use the bridged funds in a second app on the destination chain.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and hold the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${capital} and take one small position in an active market on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and hold the vault shares.`;
  if (c.includes('stable') || c.includes('algo-stable')) return `Mint or hold $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('launchpad')) return `Commit $${capital} through ${name}'s launchpad on ${chain} and join one sale allocation.`;
  if (c.includes('nft')) return `Buy or list one item through ${name} on ${chain} with $${capital} of funds.`;
  if (c.includes('index')) return `Buy $${capital} of the ${name} index token on ${chain} and hold it.`;
  if (c.includes('payment') || c.includes('card')) return `Route $${capital} of spending through ${name} on ${chain} over the month.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and use its main feature once.`;
}

/** The category's weekly action: the repeatable step that shows continued use. */
function weeklyFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'open a small borrow against the supply and repay it';
  if (c.includes('dex')) return 'add or remove a small amount of liquidity';
  if (c.includes('bridge')) return 'bridge a small amount back or to a second chain';
  if (c.includes('staking') || c.includes('restak')) return 'top up the stake by a small amount';
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return 'open and close one small position';
  if (c.includes('prediction')) return 'take one small position in a new market';
  return 'repeat the main action with a small amount, or vote if a proposal is live';
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time, derived from the
 * protocol's own record (category, chains, TVL, age). Nothing here claims a live points program,
 * an airdrop date or a reward: the plan is how to use the protocol genuinely, with honest costs.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasText(chain);
  const weekly = weeklyFor(p);
  return [
    {
      text: `Set up a fresh wallet that holds only this farm's funds, and write its recovery phrase on paper kept offline. Fund the wallet with the gas token of ${chain} before you touch the app.`,
      cost: `about ${gas} of gas to fund the wallet and approve the first token`,
      time: '10 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital plus about ${gas} of gas`,
      time: '20 minutes to open the position',
    },
    {
      text: `Once a week, ${weekly}, so the wallet shows repeated use rather than a single deposit.`,
      cost: `about ${gas} of gas a week`,
      time: '15 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days, through more than one weekly snapshot, before you judge the farm. Do not move the funds to another wallet mid-way.`,
      cost: `the $${capital} stays deployed; no extra fees while holding`,
      time: `${hold} days`,
    },
    {
      text: `Each week, check the protocol's own rewards or points page from the link inside its app, and record every transaction hash, date and amount in a farm log.`,
      cost: 'nothing to check',
      time: '10 minutes a week',
    },
    {
      text: `When you exit, claim only through the link the protocol itself publishes, never pay anyone to claim for you, and unwind in two tranches a day apart so a failed transaction cannot strand the whole position.`,
      cost: `about ${gas} of exit gas`,
      time: '20 minutes',
    },
  ];
}

/** One step as a single string: action, then cost and time, inside the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position open and re-check the protocol's own page.`;
  return s;
}

// ---------------------------------------------------------------- board

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The ranked board: every subject protocol, strongest implied value first, ranks 1..N. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const pool = comparables(snapshot);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names, even one the snapshot no longer carries.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other subject protocol, below the floor or left off the list.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isSubject(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const { ratio, comparables: n } = categoryRatio(p.category, pool, model);
    const { implied, growthPct, growthMult, maturityMult, age } = impliedValue(p, snapshot.as_of, ratio, model);
    return { p, ratio, n, implied, growthPct, growthMult, maturityMult, age };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      category_ratio: round4(s.ratio),
      comparables: s.n,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's live view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      age_days: ageDays(snapshot.as_of, p.listed_at),
      ratio: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const pool = comparables(snapshot);
  const global = median(pool.map(ratioOf)) ?? 0.25;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist: [...snapshot.watchlist].sort(),
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !snapshot.watchlist.includes(r.slug)).length,
    live_size: live.length,
    global_ratio: round4(global),
    calibration: calibrateModel(snapshot, model),
    categories: categoryTable(snapshot, model),
    rows: board.map((row) => ({
      rank: row.rank,
      slug: row.slug,
      name: row.name,
      category: row.category,
      chains: row.chains,
      tvl_usd: row.tvl_usd,
      change_7d: row.change_7d,
      mcap_usd: row.mcap_usd,
      listed_at: row.listed_at,
      age_days: row.age_days,
      implied_value_usd: row.implied_value_usd,
      category_ratio: row.model.category_ratio,
      comparables: row.model.comparables,
      growth_multiplier: row.model.growth_multiplier,
      maturity_multiplier: row.model.maturity_multiplier,
      farm_steps: row.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, steps, values. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board repeats a slug';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const invented = board.filter((r) => !known.has(r.slug));
  if (invented.length > 0) return `the board names a slug the snapshot does not list: ${invented.slice(0, 3).map((r) => r.slug).join(', ')}`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) {
    if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `rank ${byRank[i]!.rank} outranks rank ${byRank[i - 1]!.rank} on implied value`;
  }
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) {
    return 'every row shares the same implied value: a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    if (typeof r.name !== 'string' || r.name.length === 0) return `${r.slug} has an empty name`;
    if (/\s/.test(r.slug) || r.slug.length < 1 || r.slug.length > 128) return `${r.slug} is not a valid slug`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** The dashboard's whole dataset as one script: window.RADAR, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
