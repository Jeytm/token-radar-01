// Token Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board, filters, a per-protocol detail view, and the model's own evidence.
// No network: every byte shown is in data.js.
//
// The page does not trust the numbers it is handed: impliedOf recomputes every row from the
// snapshot figures and the live comparables, farmSteps re-derives every farm plan, and the
// self-check badges compare both against what board.json carries. The model lives here in full,
// so the dossier's source text and the screenshots show the same arithmetic.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var MODEL = DATA.model;
  var state = { q: '', category: 'all', chain: 'all', tab: 'pre-token', sort: 'implied', dir: -1, detail: null, alloc: 0.05 };

  // ------------------------------------------------------------ formatting

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtUsdFull(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return usd.format(Math.round(n));
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) { return (Math.round(n * 1e4) / 1e4).toFixed(4); }
  function fmtCount(n) { return n.toLocaleString('en-US'); }

  function h(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // ------------------------------------------------------------ the model, recomputed in the page

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function median(values) {
    if (values.length === 0) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    return sorted[Math.floor(sorted.length / 2)];
  }

  /** The live comparables: token trades, positive market cap and TVL. The calibration set. */
  function comparables() {
    return DATA.live.filter(function (p) { return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0; });
  }
  function ratioOf(p) { return p.mcap_usd / p.tvl_usd; }

  /**
   * The value multiple for one category: the median market-cap-to-TVL ratio of its live
   * comparables, shrunk toward the global median, or the global median when the category has
   * fewer than three comparables. The same rule the builder runs; the page re-derives it from
   * the live set it carries, so the dossier shows the derivation, not just its result.
   */
  function categoryRatio(category, pool) {
    var global = median(pool.map(ratioOf));
    var globalRatio = global === null ? 0.25 : global;
    var key = category === null ? '(uncategorised)' : category;
    var mine = pool.filter(function (p) { return (p.category === null ? '(uncategorised)' : p.category) === key; }).map(ratioOf);
    var med = median(mine);
    if (med === null || mine.length < MODEL.min_comparables) {
      return { ratio: clamp(globalRatio, MODEL.ratio_min, MODEL.ratio_max), comparables: mine.length, median: med };
    }
    var shrunk = (mine.length * med + MODEL.shrink_k * globalRatio) / (mine.length + MODEL.shrink_k);
    return { ratio: clamp(shrunk, MODEL.ratio_min, MODEL.ratio_max), comparables: mine.length, median: med };
  }

  /** One protocol's implied value under the stated formula, from its own snapshot figures. */
  function impliedOf(row) {
    var pool = comparables();
    var ratio = categoryRatio(row.category, pool).ratio;
    var growthPct = clamp(row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d, MODEL.growth_floor, MODEL.growth_cap);
    var growthMult = 1 + (growthPct / 100) * MODEL.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? MODEL.unknown_age_days : row.age_days;
    var maturityMult = MODEL.maturity_floor + (clamp(age, 0, MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range;
    return Math.max(1, Math.round(row.tvl_usd * ratio * growthMult * maturityMult));
  }

  /**
   * The leave-one-out check, recomputed in the page: every live comparable is scored by a model
   * fitted on all the others, and the prediction is compared with its real market cap.
   */
  function looCalibration() {
    var pool = comparables();
    var errors = [];
    var baseline = [];
    pool.forEach(function (p) {
      var rest = pool.filter(function (q) { return q.slug !== p.slug; });
      var ratio = categoryRatio(p.category, rest).ratio;
      var growthPct = clamp(p.change_7d === null ? 0 : p.change_7d, MODEL.growth_floor, MODEL.growth_cap);
      var growthMult = 1 + (growthPct / 100) * MODEL.growth_weight;
      var age = p.age_days === null || p.age_days === undefined ? MODEL.unknown_age_days : p.age_days;
      var maturityMult = MODEL.maturity_floor + (clamp(age, 0, MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range;
      var pred = Math.max(1, Math.round(p.tvl_usd * ratio * growthMult * maturityMult));
      errors.push(Math.abs(Math.log(pred) - Math.log(p.mcap_usd)));
      var g = median(rest.map(ratioOf));
      var base = Math.max(1, Math.round(p.tvl_usd * clamp(g === null ? 0.25 : g, MODEL.ratio_min, MODEL.ratio_max) * growthMult * maturityMult));
      baseline.push(Math.abs(Math.log(base) - Math.log(p.mcap_usd)));
    });
    var med = median(errors) || 0;
    return {
      comparables: pool.length,
      median_abs_log_error: Math.round(med * 1e4) / 1e4,
      factor: Math.round(Math.exp(med) * 100) / 100,
      baseline_median_abs_log_error: Math.round((median(baseline) || 0) * 1e4) / 1e4
    };
  }

  // ------------------------------------------------------------ farm plans, re-derived in the page

  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function gasFor(chain) {
    var c = String(chain).toLowerCase();
    if (c === 'ethereum') return 6;
    if (c === 'solana') return 0.05;
    if (c === 'tron') return 2;
    if (c === 'bitcoin') return 3;
    if (c === 'binance' || c === 'bsc' || c === 'polygon' || c === 'polygon zkevm') return 0.3;
    if (c === 'hyperliquid l1' || c === 'hyperliquid') return 0.1;
    if (['arbitrum', 'optimism', 'base', 'blast', 'linea', 'scroll', 'zksync', 'mantle', 'mode', 'fraxtal', 'ink', 'unichain', 'soneium', 'abstract', 'berachain', 'avalanche', 'gnosis', 'celo', 'fantom', 'moonbeam', 'aurora'].indexOf(c) >= 0) return 0.5;
    return 2;
  }
  function gasText(chain) {
    var g = gasFor(chain);
    return g < 1 ? '$' + g.toFixed(2) : '$' + g;
  }
  function capitalFor(p) {
    if (p.tvl_usd >= 1e9) return 250;
    if (p.tvl_usd >= 1e8) return 150;
    if (p.tvl_usd >= 25e6) return 100;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + "'s lending market on " + chain + ' and leave the position open.';
    if (c.indexOf('dex') >= 0) return 'Add $' + capital + ' of liquidity to ' + name + "'s busiest pool on " + chain + ' and leave the position open.';
    if (c.indexOf('yield') >= 0 || c.indexOf('farm') >= 0 || c.indexOf('leveraged') >= 0) return 'Deposit $' + capital + ' of USDC into ' + name + "'s highest-TVL vault on " + chain + ' and hold the vault shares.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + capital + ' of USDC through ' + name + ' to ' + chain + ' and use the bridged funds in a second app on the destination chain.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return 'Stake $' + capital + " of the chain's staking asset through " + name + ' and hold the receipt token.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('options') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedged position.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' and take one small position in an active market on ' + name + '.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and hold the vault shares.';
    if (c.indexOf('stable') >= 0 || c.indexOf('algo-stable') >= 0) return 'Mint or hold $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('rwa') >= 0) return 'Mint $' + capital + " of " + name + "'s yield-bearing asset on " + chain + ' and hold it.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy active.';
    if (c.indexOf('launchpad') >= 0) return 'Commit $' + capital + ' through ' + name + "'s launchpad on " + chain + ' and join one sale allocation.';
    if (c.indexOf('nft') >= 0) return 'Buy or list one item through ' + name + ' on ' + chain + ' with $' + capital + ' of funds.';
    if (c.indexOf('index') >= 0) return 'Buy $' + capital + ' of the ' + name + ' index token on ' + chain + ' and hold it.';
    if (c.indexOf('payment') >= 0 || c.indexOf('card') >= 0) return 'Route $' + capital + ' of spending through ' + name + ' on ' + chain + ' over the month.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and use its main feature once.';
  }
  function weeklyFor(p) {
    var c = (p.category || '').toLowerCase();
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'open a small borrow against the supply and repay it';
    if (c.indexOf('dex') >= 0) return 'add or remove a small amount of liquidity';
    if (c.indexOf('bridge') >= 0) return 'bridge a small amount back or to a second chain';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return 'top up the stake by a small amount';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('options') >= 0) return 'open and close one small position';
    if (c.indexOf('prediction') >= 0) return 'take one small position in a new market';
    return 'repeat the main action with a small amount, or vote if a proposal is live';
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Keep the position open and re-check the protocol's own page.";
    return s;
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var gas = gasText(chain);
    var weekly = weeklyFor(p);
    return [
      { text: 'Set up a fresh wallet that holds only this farm\'s funds, and write its recovery phrase on paper kept offline. Fund the wallet with the gas token of ' + chain + ' before you touch the app.', cost: 'about ' + gas + ' of gas to fund the wallet and approve the first token', time: '10 minutes' },
      { text: actionFor(p, capital, chain), cost: '$' + capital + ' of capital plus about ' + gas + ' of gas', time: '20 minutes to open the position' },
      { text: 'Once a week, ' + weekly + ', so the wallet shows repeated use rather than a single deposit.', cost: 'about ' + gas + ' of gas a week', time: '15 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days, through more than one weekly snapshot, before you judge the farm. Do not move the funds to another wallet mid-way.', cost: 'the $' + capital + ' stays deployed; no extra fees while holding', time: hold + ' days' },
      { text: 'Each week, check the protocol\'s own rewards or points page from the link inside its app, and record every transaction hash, date and amount in a farm log.', cost: 'nothing to check', time: '10 minutes a week' },
      { text: 'When you exit, claim only through the link the protocol itself publishes, never pay anyone to claim for you, and unwind in two tranches a day apart so a failed transaction cannot strand the whole position.', cost: 'about ' + gas + ' of exit gas', time: '20 minutes' }
    ].map(stepText);
  }

  // ------------------------------------------------------------ farm economics (stated assumptions)

  /**
   * Net farming economics under stated assumptions, never a promise: a share of the implied
   * value is assumed to reach farmers one day, split evenly among N farmers. The screen rule:
   * FARM when the break-even farmer count reaches 10,000, THIN at 1,000, else SKIP.
   */
  function econFor(row, allocPct) {
    var capital = capitalFor(row);
    var gas = gasFor(chainOf(row));
    var hold = holdDaysFor(row.age_days);
    var weeks = Math.ceil(hold / 7);
    var gasTotal = gas * (2 + weeks + 2);
    var allocation = allocPct * row.implied_value_usd;
    var breakEven = gasTotal > 0 ? allocation / gasTotal : Infinity;
    var activeMin = 30 + 25 * weeks + 20;
    var verdict = breakEven >= 10000 ? 'FARM' : breakEven >= 1000 ? 'THIN' : 'SKIP';
    var scenarios = [100, 1000, 10000].map(function (n) {
      return { farmers: n, net: allocation / n - gasTotal };
    });
    return { capital: capital, gas: gas, hold: hold, weeks: weeks, gasTotal: gasTotal, allocation: allocation, breakEven: breakEven, activeMin: activeMin, verdict: verdict, scenarios: scenarios };
  }

  // ------------------------------------------------------------ state and deep links

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q') !== null) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('tab')) state.tab = params.get('tab');
    if (params.get('sort')) state.sort = params.get('sort');
    if (params.get('dir')) state.dir = params.get('dir') === 'asc' ? 1 : -1;
    if (params.get('detail')) state.detail = params.get('detail');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    if (state.sort !== 'implied') params.set('sort', state.sort);
    if (state.dir !== -1) params.set('dir', 'asc');
    if (state.detail) params.set('detail', state.detail);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  // ------------------------------------------------------------ self-checks

  function selfChecks() {
    var rows = DATA.rows;
    var slugs = {};
    rows.forEach(function (r) { slugs[r.slug] = true; });
    var covered = DATA.watchlist.filter(function (s) { return slugs[s]; }).length;
    var ranksOk = rows.map(function (r) { return r.rank; }).sort(function (a, b) { return a - b; })
      .every(function (rank, i) { return rank === i + 1; });
    var byRank = rows.slice().sort(function (a, b) { return a.rank - b.rank; });
    var orderOk = true;
    for (var i = 1; i < byRank.length; i++) {
      if (byRank[i].implied_value_usd > byRank[i - 1].implied_value_usd) { orderOk = false; break; }
    }
    var modelOk = 0;
    rows.forEach(function (r) { if (Math.abs(impliedOf(r) - r.implied_value_usd) <= 1) modelOk++; });
    var farmOk = 0;
    rows.forEach(function (r) {
      var mine = farmSteps(r);
      var stored = r.farm_steps || [];
      if (mine.length === stored.length && mine.every(function (s, j) { return s === stored[j]; })) farmOk++;
    });
    var loo = looCalibration();
    var calOk = Math.abs(loo.median_abs_log_error - DATA.calibration.median_abs_log_error) <= 0.01;
    return [
      { label: 'Watchlist', value: covered + ' / ' + DATA.watchlist_size, ok: covered === DATA.watchlist_size },
      { label: 'Rows', value: fmtCount(rows.length), ok: rows.length >= 100 },
      { label: 'Ranks', value: ranksOk ? '1–' + rows.length : 'broken', ok: ranksOk },
      { label: 'Values sorted', value: orderOk ? 'yes' : 'no', ok: orderOk },
      { label: 'Values recomputed', value: modelOk + ' / ' + rows.length, ok: modelOk === rows.length },
      { label: 'Farm plans match', value: farmOk + ' / ' + rows.length, ok: farmOk === rows.length },
      { label: 'Calibration recomputed', value: calOk ? 'match' : 'differs', ok: calOk }
    ];
  }

  // ------------------------------------------------------------ filtering and sorting

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  // ------------------------------------------------------------ rendering

  var boardEl = document.getElementById('board');
  var dialog = document.getElementById('detail');
  var dialogSlug = null;

  function renderTopMeta() {
    var el = document.getElementById('top-meta');
    el.textContent = '';
    el.appendChild(h('span', null, 'Snapshot ', h('b', { text: DATA.as_of })));
    el.appendChild(h('span', null, 'Source ', h('b', { text: 'DefiLlama protocol index' })));
    el.appendChild(h('span', null, 'Model ', h('b', { text: DATA.model_version })));
    el.appendChild(h('span', null, 'Floor ', h('b', { text: fmtUsd(DATA.floor_usd) })));
  }

  function renderLede() {
    document.getElementById('lede-text').textContent =
      'The watchlist is the floor: every protocol with at least ' + fmtUsd(DATA.floor_usd) +
      ' of TVL that records no token and is not a wrapped, staked or bridged product. The early radar adds ' +
      DATA.early_size + ' more pre-token protocols below that floor, held to the same rule. Each row carries an implied value from one stated formula and a farm plan with costs and times.';
    var cal = DATA.calibration;
    var strip = document.getElementById('calibration-strip');
    strip.textContent = '';
    strip.appendChild(document.createTextNode('Model check: scored against '));
    strip.appendChild(h('b', { text: cal.comparables + ' live-token protocols' }));
    strip.appendChild(document.createTextNode(', leaving each one out in turn, the model lands within a factor of '));
    strip.appendChild(h('b', { text: '×' + cal.factor }));
    strip.appendChild(document.createTextNode(' of the real market cap at the median (a single global ratio manages ×' + (Math.round(Math.exp(cal.baseline_median_abs_log_error) * 100) / 100) + '). Implied values are order-of-magnitude estimates, not prices.'));
    var facts = document.getElementById('facts');
    facts.textContent = '';
    [
      ['Watchlist covered', DATA.watchlist_size + ' / ' + DATA.watchlist_size],
      ['Pre-token rows', fmtCount(DATA.board_size)],
      ['Early rows below the floor', fmtCount(DATA.early_size)],
      ['Live-token protocols set aside', fmtCount(DATA.live_size)],
      ['Global median mcap / TVL', fmtMult(DATA.global_ratio)]
    ].forEach(function (f) {
      facts.appendChild(h('div', null, h('dt', { text: f[0] }), h('dd', { text: f[1] })));
    });
  }

  function renderChecks() {
    var box = document.getElementById('checks');
    box.textContent = '';
    selfChecks().forEach(function (c) {
      box.appendChild(h('span', { class: 'badge' + (c.ok ? '' : ' fail') }, c.label + ' ', h('b', { text: c.value })));
    });
  }

  function sortHeader(key, label) {
    return h('th', { scope: 'col' },
      h('button', {
        type: 'button',
        onclick: function () {
          if (state.sort === key) state.dir = -state.dir;
          else { state.sort = key; state.dir = -1; }
          writeHash(); renderBoard();
        }
      }, label, state.sort === key ? h('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' ↓' : ' ↑' }) : null)
    );
  }

  function verdictBadge(row) {
    var v = econFor(row, state.alloc).verdict;
    return h('span', { class: 'screen ' + v.toLowerCase(), text: v });
  }

  function boardTable() {
    var list = sortedRows(filteredRows());
    if (list.length === 0) {
      return h('div', { class: 'panel' }, h('div', { class: 'empty' },
        h('h2', { text: 'No protocol matches that filter' }),
        h('p', { text: 'Clear the search or pick another category or chain to see the board again.' }),
        h('button', {
          class: 'button primary', type: 'button', text: 'Clear filters',
          onclick: function () {
            state.q = ''; state.category = 'all'; state.chain = 'all';
            document.getElementById('q').value = '';
            document.getElementById('category').value = 'all';
            document.getElementById('chain').value = 'all';
            writeHash(); renderBoard();
          }
        })
      ));
    }
    var max = 1;
    DATA.rows.forEach(function (r) { if (r.implied_value_usd > max) max = r.implied_value_usd; });
    var tbody = h('tbody');
    list.forEach(function (r) {
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = h('tr', {
        'data-selected': state.detail === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        h('td', { class: 'num', text: String(r.rank) }),
        h('td', null, h('div', { class: 'name' },
          h('b', { text: r.name }),
          h('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') : 'an unnamed chain') })
        )),
        h('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        h('td', { class: 'num ' + growthClass, text: fmtPct(r.change_7d) }),
        h('td', { class: 'num', text: fmtAge(r.age_days) }),
        h('td', null, h('div', { class: 'implied' },
          h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: 'width:' + Math.max(2, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          h('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        h('td', null, verdictBadge(r)),
        h('td', null, h('span', { class: 'status', text: 'no token recorded' }))
      );
      tbody.appendChild(tr);
    });
    return h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { text: 'Pre-token protocols, strongest implied value first. Select a row for its model breakdown, farm screen and farm plan. The screen is an assumption-labelled estimate, not a recommendation.' }),
          h('thead', null, h('tr', null,
            h('th', { scope: 'col', text: 'Rank' }),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('implied', 'Implied value'),
            h('th', { scope: 'col', text: 'Screen' }),
            h('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = h('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(h('tr', { tabindex: '-1', onclick: function () {} },
        h('td', null, h('div', { class: 'name' },
          h('b', { text: r.name }),
          h('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') : 'an unnamed chain') })
        )),
        h('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        h('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        h('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        h('td', { class: 'num', text: r.ratio === null ? 'n/a' : fmtMult(r.ratio) }),
        h('td', null, h('span', { class: 'status live', text: 'already trades' }))
      ));
    });
    return h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking, and their market-cap-to-TVL ratios calibrate it.' }),
          h('thead', null, h('tr', null,
            h('th', { scope: 'col', text: 'Protocol' }),
            h('th', { scope: 'col', text: 'TVL' }),
            h('th', { scope: 'col', text: '7d' }),
            h('th', { scope: 'col', text: 'Market cap' }),
            h('th', { scope: 'col', text: 'Mcap / TVL' }),
            h('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function renderModel() {
    var m = MODEL;
    var cal = DATA.calibration;
    var box = document.getElementById('model');
    box.textContent = '';
    box.appendChild(h('div', null,
      h('h2', { text: 'How implied value is computed' }),
      h('p', { class: 'sub', text: 'One function scores every row, from the snapshot figures alone. No protocol name is special-cased and no row is hand-picked. The page recomputes each row with impliedOf and checks it against the board.' })
    ));
    var formula = h('div', { class: 'formula' });
    formula.appendChild(document.createTextNode('implied = round( tvl_usd × '));
    formula.appendChild(h('b', { text: 'category_ratio' }));
    formula.appendChild(document.createTextNode(' × (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 × ' + m.growth_weight + ') × (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' × ' + m.maturity_range + ') )'));
    box.appendChild(formula);
    box.appendChild(h('p', { class: 'sub', text: 'category_ratio is the category\u2019s median market-cap-to-TVL ratio among its live-token comparables, shrunk toward the global median (' + fmtMult(DATA.global_ratio) + ') with weight ' + m.shrink_k + '; a category with fewer than ' + m.min_comparables + ' comparables uses the global median outright. The ratio is clamped to [' + m.ratio_min + ', ' + m.ratio_max + ']. Age is the time since the protocol was first listed — the best record of how long it has run with no token; an unlisted age uses ' + m.unknown_age_days + ' days.' }));
    var grid = h('div', { class: 'model-grid' });
    grid.appendChild(h('div', { class: 'stat' }, h('span', { text: 'Leave-one-out comparables' }), h('b', { text: fmtCount(cal.comparables) })));
    grid.appendChild(h('div', { class: 'stat' }, h('span', { text: 'Median miss (factor)' }), h('b', { text: '×' + cal.factor })));
    grid.appendChild(h('div', { class: 'stat' }, h('span', { text: 'Median absolute log error' }), h('b', { text: String(cal.median_abs_log_error) })));
    box.appendChild(grid);
    box.appendChild(h('p', { class: 'sub', text: 'The check leaves each live-token protocol out in turn, fits the category ratios on the rest, and compares the prediction with the real market cap. The same check with one global ratio for every protocol misses by a median log error of ' + cal.baseline_median_abs_log_error + '. The category step helps a little; the honest reading is that implied values are order-of-magnitude estimates.' }));
    var cats = DATA.categories.slice(0, 12);
    var tbody = h('tbody');
    cats.forEach(function (c) {
      tbody.appendChild(h('tr', null,
        h('td', { text: c.category }),
        h('td', { class: 'num', text: String(c.comparables) }),
        h('td', { class: 'num', text: c.median_ratio === null ? 'n/a' : fmtMult(c.median_ratio) }),
        h('td', { class: 'num', text: fmtMult(c.ratio) })
      ));
    });
    box.appendChild(h('div', null,
      h('h3', { text: 'Category calibration (largest comparable sets)' }),
      h('div', { class: 'table-wrap' },
        h('table', { class: 'cats' },
          h('thead', null, h('tr', null,
            h('th', { scope: 'col', text: 'Category' }),
            h('th', { scope: 'col', text: 'Comparables' }),
            h('th', { scope: 'col', text: 'Median mcap / TVL' }),
            h('th', { scope: 'col', text: 'Ratio used' })
          )),
          tbody
        )
      )
    ));
  }

  function renderBoard() {
    boardEl.textContent = '';
    boardEl.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    boardEl.setAttribute('aria-busy', 'false');
    var count = document.getElementById('count');
    count.textContent = state.tab === 'pre-token'
      ? filteredRows().length + ' of ' + DATA.board_size + ' rows shown'
      : DATA.live.length + ' live-token protocols';
    document.getElementById('tab-pre').setAttribute('aria-pressed', state.tab === 'pre-token' ? 'true' : 'false');
    document.getElementById('tab-live').setAttribute('aria-pressed', state.tab === 'live' ? 'true' : 'false');
  }

  // ------------------------------------------------------------ detail view

  dialog.addEventListener('close', function () {
    state.detail = null;
    dialogSlug = null;
    writeHash();
    renderBoard();
  });

  function openDetail(slug) {
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === slug) row = r; });
    if (!row) return;
    state.detail = slug;
    writeHash();
    dialog.textContent = '';
    dialogSlug = slug;

    dialog.appendChild(h('div', { class: 'detail-head' },
      h('div', null,
        h('span', { class: 'sub', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + ' · records no token' }),
        h('h2', { id: 'detail-title', text: row.name }),
        h('p', { class: 'sub', text: (row.category || 'Other') + ' · ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + ' · listed ' + (row.listed_at || 'date unknown') })
      ),
      h('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));

    var recomputed = impliedOf(row);
    dialog.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Implied value' }),
      h('div', { class: 'equation' },
        h('div', null, h('span', { text: 'TVL' }), h('b', { class: 'num', text: fmtUsdFull(row.tvl_usd) })),
        h('div', null, h('span', { text: 'Seven-day growth' }), h('b', { class: 'num', text: fmtPct(row.change_7d) })),
        h('div', null, h('span', { text: 'Age with no token' }), h('b', { class: 'num', text: fmtAge(row.age_days) })),
        h('div', null, h('span', { text: 'Category ratio (' + row.comparables + ' comparable' + (row.comparables === 1 ? '' : 's') + ')' }), h('b', { class: 'num', text: fmtMult(row.category_ratio) })),
        h('div', null, h('span', { text: 'Growth multiplier' }), h('b', { class: 'num', text: fmtMult(row.growth_multiplier) })),
        h('div', null, h('span', { text: 'Maturity multiplier' }), h('b', { class: 'num', text: fmtMult(row.maturity_multiplier) })),
        h('div', null, h('span', { text: 'Implied value' }), h('b', { class: 'num', text: fmtUsdFull(row.implied_value_usd) }))
      ),
      h('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the page recomputes this row as ' + fmtUsdFull(recomputed) + (Math.abs(recomputed - row.implied_value_usd) <= 1 ? ', the same number board.json carries.' : ' — it differs from the board, so the data would be stale.') + ' An estimate, not a price.' })
    ));

    var econSection = h('section', { class: 'detail-section' });
    dialog.appendChild(econSection);
    renderEcon(econSection, row);

    var steps = farmSteps(row);
    dialog.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Farm plan' }),
      h('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return h('li', null, h('b', { text: action }), h('span', { class: 'cost', text: tail }));
      }))
    ));

    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    renderBoard();
  }

  function renderEcon(section, row) {
    section.textContent = '';
    var econ = econFor(row, state.alloc);
    var head = h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:12px;' },
      h('h3', { text: 'Farm screen' }),
      h('span', { class: 'screen ' + econ.verdict.toLowerCase(), text: econ.verdict })
    );
    section.appendChild(head);
    section.appendChild(h('div', { class: 'econ' },
      h('div', null, h('span', { text: 'Capital deployed' }), h('b', { text: fmtUsdFull(econ.capital) })),
      h('div', null, h('span', { text: 'Gas, whole farm (estimate)' }), h('b', { text: fmtUsdFull(econ.gasTotal) })),
      h('div', null, h('span', { text: 'Active time' }), h('b', { text: Math.floor(econ.activeMin / 60) + 'h ' + (econ.activeMin % 60) + 'm + ' + econ.hold + 'd holding' })),
      h('div', null, h('span', { text: 'Assumed farmer allocation' }), h('b', { text: (state.alloc * 100) + '% of implied value = ' + fmtUsd(econ.allocation) })),
      h('div', null, h('span', { text: 'Break-even farmers' }), h('b', { text: isFinite(econ.breakEven) ? fmtCount(Math.floor(econ.breakEven)) : 'n/a' }))
    ));
    var tbody = h('tbody');
    econ.scenarios.forEach(function (sc) {
      tbody.appendChild(h('tr', null,
        h('td', { class: 'num', text: fmtCount(sc.farmers) + ' farmers' }),
        h('td', { class: 'num ' + (sc.net >= 0 ? 'pos' : 'neg'), text: (sc.net >= 0 ? '+' : '−') + fmtUsdFull(Math.abs(sc.net)) + ' net each' })
      ));
    });
    section.appendChild(h('div', { class: 'table-wrap' },
      h('table', { class: 'scenarios' },
        h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'If farmers split it evenly' }), h('th', { scope: 'col', text: 'Net after gas' }))),
        tbody
      )
    ));
    var select = h('select', { id: 'alloc', 'aria-label': 'Assumed farmer allocation' });
    [[0.02, '2%'], [0.05, '5%'], [0.1, '10%']].forEach(function (opt) {
      var o = h('option', { value: String(opt[0]), text: opt[1] + ' of implied value to farmers' });
      if (opt[0] === state.alloc) o.setAttribute('selected', 'selected');
      select.appendChild(o);
    });
    select.addEventListener('change', function () {
      state.alloc = parseFloat(select.value);
      renderEcon(section, row);
      renderBoard();
    });
    section.appendChild(h('div', { class: 'assume' },
      h('label', { for: 'alloc', class: 'sub', text: 'Assumption: ' }), select
    ));
    section.appendChild(h('p', { class: 'sub', text: 'Assumptions, not a promise: no token may ever be issued, no allocation may ever reach farmers, and the split is never even. The screen rule is FARM at 10,000 break-even farmers, THIN at 1,000, else SKIP. Capital stays at risk throughout.' }));
  }

  // ------------------------------------------------------------ wiring

  function initControls() {
    var categories = [];
    DATA.rows.forEach(function (r) {
      var c = r.category || 'Other';
      if (categories.indexOf(c) < 0) categories.push(c);
    });
    categories.sort();
    var catSel = document.getElementById('category');
    catSel.appendChild(h('option', { value: 'all', text: 'All categories' }));
    categories.forEach(function (c) { catSel.appendChild(h('option', { value: c, text: c })); });
    catSel.value = state.category;
    catSel.addEventListener('change', function () { state.category = catSel.value; writeHash(); renderBoard(); });

    var chains = [];
    DATA.rows.forEach(function (r) { (r.chains || []).forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); }); });
    chains.sort();
    var chainSel = document.getElementById('chain');
    chainSel.appendChild(h('option', { value: 'all', text: 'All chains' }));
    chains.forEach(function (c) { chainSel.appendChild(h('option', { value: c, text: c })); });
    chainSel.value = state.chain;
    chainSel.addEventListener('change', function () { state.chain = chainSel.value; writeHash(); renderBoard(); });

    var search = document.getElementById('q');
    search.value = state.q;
    search.addEventListener('input', function () { state.q = search.value; writeHash(); renderBoard(); });

    document.getElementById('tab-pre').addEventListener('click', function () { state.tab = 'pre-token'; writeHash(); renderBoard(); });
    document.getElementById('tab-live').addEventListener('click', function () { state.tab = 'live'; writeHash(); renderBoard(); });
  }

  function renderAll() {
    renderTopMeta();
    renderLede();
    renderChecks();
    renderBoard();
    renderModel();
    if (state.detail && dialogSlug !== state.detail) openDetail(state.detail);
  }

  readHash();
  initControls();
  renderAll();
  window.addEventListener('hashchange', function () {
    var prev = state.detail;
    readHash();
    document.getElementById('q').value = state.q;
    document.getElementById('category').value = state.category;
    document.getElementById('chain').value = state.chain;
    renderBoard();
    if (state.detail && state.detail !== prev) openDetail(state.detail);
    if (!state.detail && dialog.open) dialog.close();
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
