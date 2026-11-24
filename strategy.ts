// Wide Net Sniper + Flat-Coin Pacer.
//
// Idea, in plain words. Most new pump.fun coins go to zero; a few run hard in
// their first minutes. The sniper half buys a new coin only when its first few
// slots look like one real buyer (not a crowd, not the creator pumping it), the
// curve already holds real SOL, and the creator has not sold. It then exits on
// fixed, round rules: take half off at +12%, stop out at -12%, trail the rest,
// never hold longer than 300 slots, and leave the moment the creator sells.
//
// The pacer half exists for the guardrail, not for alpha: the final window is
// only 6 hours, so the sniper alone may not reach 20 round trips. The pacer
// buys exactly 0.01 SOL on deep, mature, flat coins and sells on a small uptick,
// a small dip, or a time cap. Each probe costs roughly its fees; 25 of them cost
// far less than one missed guardrail.
//
// Everything here is deterministic: no clock, no environment, no Math.random.
// All decisions come from the harness state and the fixed constants below.

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;

// ---- sniper entry (round numbers, kept in the neighbourhood that worked) ----
const STAKE_LAMPORTS = (SOL * 4n) / 100n; // 0.04 SOL per sniper coin
const MIN_BUY_LAMPORTS = (SOL * 15n) / 1000n; // skip when the size cap is below 0.015 SOL
const ENTRY_WINDOW_SLOTS = 5; // coin age (slots since CreateEvent) at decision
const MAX_EARLY_BUYERS = 1; // distinct non-creator buyers seen so far
const MIN_EARLY_VOLUME_LAMPORTS = (SOL * 5n) / 100n; // 0.05 SOL of non-creator buys
const MIN_REAL_RESERVE_LAMPORTS = (SOL * 225n) / 100n; // 2.25 SOL real reserve
const MAX_CREATOR_BUY_LAMPORTS = (SOL * 25n) / 10n; // 2.5 SOL of creator buys
const MAX_ENTRY_PUMP_BPS = 5000; // skip when the price already ran +50% from creation

// ---- sniper exits ----
const TAKE_PROFIT_BPS = 1200; // +12%: sell half
const STOP_LOSS_BPS = -1200; // -12%: sell all
const TRAIL_ARM_BPS = 1000; // trailing arms once the peak is +10%
const TRAIL_DROP_BPS = 1500; // sell all when 15% below the peak
const MAX_HOLD_SLOTS = 300;

// ---- pacer (guardrail) ----
const PROBE_BUY_LAMPORTS = (SOL * 1n) / 100n; // exactly 0.01 SOL
const PROBE_MAX_TOTAL = 22;
const PROBE_SPACING_SLOTS = 1200;
const PROBE_MIN_TRADES = 30;
const PROBE_MIN_AGE_SLOTS = 1200;
const PROBE_MIN_REAL_RESERVE_LAMPORTS = SOL * 5n;
const PROBE_TAKE_BPS = 30; // +0.3%: sell
const PROBE_STOP_BPS = -500; // -5%: sell
const PROBE_MAX_HOLD_SLOTS = 600;

const BUY_SLIPPAGE_BPS = 1000;
const SELL_SLIPPAGE_BPS = 10_000;

interface CoinInfo {
  creator: string | null;
  createdSlot: number | null;
  firstSeenSlot: number;
  creationQuote: bigint; // virtual quote reserves at creation (0n when unseen)
  creationToken: bigint; // virtual token reserves at creation
  creatorBuyLamports: bigint;
  creatorSold: boolean;
  buyers: Set<string>;
  buyVolumeLamports: bigint;
  trades: number;
  decided: boolean; // sniper decision already made (buy or permanent skip)
}

interface PositionMeta {
  entrySlot: number;
  entryCostLamports: bigint;
  peakValueLamports: bigint;
  halfSold: boolean;
  probe: boolean;
}

export interface BotStats {
  sniperBuys: number;
  sniperSells: number;
  probeBuys: number;
  probeSells: number;
}

/** Current gross value of `tokens` on the coin's curve, in lamports (bigint-exact). */
function positionValueLamports(state: BotState, mint: string, tokens: bigint): bigint {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.virtual_token_reserves === 0n) return 0n;
  return (tokens * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
}

export function createBot() {
  const coins = new Map<string, CoinInfo>();
  const meta = new Map<string, PositionMeta>();
  const probeMints = new Set<string>();
  const sniperBought = new Set<string>();
  /** Coins created and awaiting their one sniper decision, by mint. */
  const pendingDecision = new Map<string, number>();
  let lastProbeSlot = -1_000_000;
  let probeBuys = 0;
  let probeSells = 0;
  let sniperBuys = 0;
  let sniperSells = 0;

  function infoFor(mint: string, slot: number): CoinInfo {
    let info = coins.get(mint);
    if (info === undefined) {
      info = {
        creator: null,
        createdSlot: null,
        firstSeenSlot: slot,
        creationQuote: 0n,
        creationToken: 0n,
        creatorBuyLamports: 0n,
        creatorSold: false,
        buyers: new Set<string>(),
        buyVolumeLamports: 0n,
        trades: 0,
        decided: false,
      };
      coins.set(mint, info);
    }
    return info;
  }

  /** Price now vs price at creation, in bps. Null when the creation price is unknown. */
  function pumpSinceCreation(state: BotState, mint: string): number | null {
    const info = coins.get(mint);
    const curve = state.curves.get(mint);
    if (info === undefined || curve === undefined) return null;
    if (info.creationQuote === 0n || info.creationToken === 0n) return null;
    if (curve.virtual_token_reserves === 0n) return null;
    // (vq_now / vt_now) / (vq_0 / vt_0) - 1, in bps, bigint-exact.
    const num = curve.virtual_quote_reserves * info.creationToken * 10_000n;
    const den = curve.virtual_token_reserves * info.creationQuote;
    return Number(num / den) - 10_000;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let openSlots = state.hello.caps.max_open_positions - state.committedPositionCount();

    // ---- 1. Fold this batch's events into per-coin facts. ----
    for (const e of batch.events) {
      const info = infoFor(e.mint, batch.slot);
      if (e.event === 'CreateEvent') {
        info.creator = e.creator;
        info.createdSlot = e.slot;
        info.creationQuote = BigInt(e.virtual_quote_reserves);
        info.creationToken = BigInt(e.virtual_token_reserves);
        pendingDecision.set(e.mint, e.slot);
      } else if (e.event === 'TradeEvent') {
        info.trades += 1;
        const amount = BigInt(e.sol_amount);
        if (e.user === info.creator) {
          if (e.is_buy) info.creatorBuyLamports += amount;
          else info.creatorSold = true;
        } else if (e.is_buy) {
          info.buyers.add(e.user);
          info.buyVolumeLamports += amount;
        }
      } else {
        // CompleteEvent: the curve is done; never enter it again.
        info.decided = true;
        pendingDecision.delete(e.mint);
      }
    }

    // ---- 2. Refresh position metadata; drop metadata for closed positions. ----
    for (const mint of [...meta.keys()]) {
      if (!state.positions.has(mint)) meta.delete(mint);
    }
    for (const [mint, holding] of state.positions) {
      const value = positionValueLamports(state, mint, holding.token_amount);
      let m = meta.get(mint);
      if (m === undefined) {
        m = {
          entrySlot: batch.slot,
          entryCostLamports: holding.cost_lamports,
          peakValueLamports: value,
          halfSold: false,
          probe: probeMints.has(mint),
        };
        meta.set(mint, m);
      } else if (value > m.peakValueLamports) {
        m.peakValueLamports = value;
      }
    }

    // ---- 3. Exits for every open position. ----
    for (const [mint, holding] of state.positions) {
      const m = meta.get(mint);
      if (m === undefined) continue;
      const info = coins.get(mint);
      const value = positionValueLamports(state, mint, holding.token_amount);
      const cost = holding.cost_lamports > 0n ? holding.cost_lamports : m.entryCostLamports;
      if (cost === 0n) continue;
      const pnlBps = Number(((value - cost) * 10_000n) / cost);
      const heldSlots = batch.slot - m.entrySlot;

      const sellAll = (): void => {
        if (orders.length >= state.hello.caps.max_orders_per_batch) return;
        const order: SellInput = {
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        };
        orders.push(order);
        if (m.probe) probeSells += 1;
        else sniperSells += 1;
        meta.delete(mint);
      };
      const sellHalf = (): void => {
        if (orders.length >= state.hello.caps.max_orders_per_batch) return;
        const half = holding.token_amount / 2n;
        if (half === 0n) return;
        const order: SellInput = {
          side: 'sell',
          mint,
          token_amount: half,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        };
        orders.push(order);
        sniperSells += 1;
        // The remaining half starts a fresh peak at its current value.
        m.halfSold = true;
        m.peakValueLamports = value / 2n;
      };

      if (m.probe) {
        if (pnlBps >= PROBE_TAKE_BPS || pnlBps <= PROBE_STOP_BPS || heldSlots >= PROBE_MAX_HOLD_SLOTS) {
          sellAll();
        }
        continue;
      }

      // Creator sold: leave immediately, whatever the price.
      if (info !== undefined && info.creatorSold) {
        sellAll();
        continue;
      }
      if (pnlBps <= STOP_LOSS_BPS) {
        sellAll();
        continue;
      }
      if (!m.halfSold && pnlBps >= TAKE_PROFIT_BPS) {
        sellHalf();
        continue;
      }
      // Trailing stop, armed once the peak cleared +10%.
      const peakPnlBps = Number(((m.peakValueLamports - cost) * 10_000n) / cost);
      if (peakPnlBps >= TRAIL_ARM_BPS && value * 10_000n <= m.peakValueLamports * BigInt(10_000 - TRAIL_DROP_BPS)) {
        sellAll();
        continue;
      }
      if (heldSlots >= MAX_HOLD_SLOTS) {
        sellAll();
      }
    }

    // ---- 4. Sniper entries: each coin is decided once, at the first batch at
    // age 5 slots or later, with the whole early picture in hand (buyers,
    // volume, reserve, creator). Deciding early buys into a coin before its
    // first minutes have spoken. ----
    for (const [mint, createdSlot] of [...pendingDecision.entries()]) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (openSlots <= 0) break;
      const age = batch.slot - createdSlot;
      if (age < ENTRY_WINDOW_SLOTS) continue;
      const info = coins.get(mint);
      pendingDecision.delete(mint);
      if (info === undefined) continue;
      info.decided = true;
      if (age > 100) continue; // stale: no batch arrived for a long stretch
      if (probeMints.has(mint)) continue; // already a pacer probe: never double up
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      // One real buyer at most: a crowd means the move is already consensus.
      if (info.buyers.size > MAX_EARLY_BUYERS) continue;
      if (info.buyVolumeLamports < MIN_EARLY_VOLUME_LAMPORTS) continue;
      if (curve.real_quote_reserves < MIN_REAL_RESERVE_LAMPORTS) continue;
      if (info.creator === null) continue;
      if (info.creatorBuyLamports > MAX_CREATOR_BUY_LAMPORTS) continue;
      if (info.creatorSold) continue;
      const pump = pumpSinceCreation(state, mint);
      if (pump !== null && pump > MAX_ENTRY_PUMP_BPS) continue; // already ran
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + tx) continue;
      sniperBought.add(mint);
      const order: BuyInput = {
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      };
      orders.push(order);
      free -= amount + tx;
      openSlots -= 1;
      sniperBuys += 1;
    }

    // ---- 5. Pacer probe: one flat, deep, mature coin at a time, spaced out. ----
    if (
      probeBuys < PROBE_MAX_TOTAL &&
      batch.slot - lastProbeSlot >= PROBE_SPACING_SLOTS &&
      openSlots > 1 && // always leave a slot free for a sniper
      orders.length < state.hello.caps.max_orders_per_batch &&
      free >= PROBE_BUY_LAMPORTS + tx
    ) {
      let best: string | null = null;
      let bestReserve = 0n;
      for (const [mint, curve] of state.curves) {
        if (state.positions.has(mint) || curve.complete) continue;
        if (probeMints.has(mint) || sniperBought.has(mint)) continue;
        const info = coins.get(mint);
        if (info === undefined) continue;
        if (info.trades < PROBE_MIN_TRADES) continue;
        if (batch.slot - info.firstSeenSlot < PROBE_MIN_AGE_SLOTS) continue;
        if (curve.real_quote_reserves < PROBE_MIN_REAL_RESERVE_LAMPORTS) continue;
        if (state.maxBuyLamports(mint) < PROBE_BUY_LAMPORTS) continue;
        if (curve.real_quote_reserves > bestReserve) {
          bestReserve = curve.real_quote_reserves;
          best = mint;
        }
      }
      if (best !== null) {
        probeMints.add(best);
        const order: BuyInput = {
          side: 'buy',
          mint: best,
          quote_lamports: PROBE_BUY_LAMPORTS,
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        };
        orders.push(order);
        free -= PROBE_BUY_LAMPORTS + tx;
        lastProbeSlot = batch.slot;
        probeBuys += 1;
      }
    }

    return orders;
  }

  function onDone(_state: BotState): void {
    // Diagnostics belong on stderr only, so the action log stays deterministic.
    console.error(
      `[wide-net-sniper] sniper buys=${sniperBuys} sells=${sniperSells} probe buys=${probeBuys} sells=${probeSells}`,
    );
  }

  return { onBatch, onDone };
}
