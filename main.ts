// Wide Net Sniper + Flat-Coin Pacer.
//
// A Solana paper-trading bot for pump.fun bonding curves. It reads the replay's
// market events as they arrive and decides when to buy, when to sell and how
// much to risk. Ranked on paper net PnL; a prize needs net PnL above 0 SOL
// after every fee, with at least 20 round trips of 0.01 SOL on 20 different
// coins and a maximum drawdown of 50% or less.
//
// The strategy has two halves. The sniper buys a new coin only in its first
// 5 slots, when at most 1 distinct non-creator wallet has bought, at least
// 0.05 SOL of non-creator volume has arrived, the curve already holds 2.25 SOL
// of real reserve, the creator has bought at most 2.5 SOL and has not sold, and
// the price has not already run more than +50% from creation. It stakes
// 0.04 SOL per coin, sells half at +12%, stops out at -12%, trails the rest
// 15% below the peak once the peak clears +10%, never holds longer than
// 300 slots, and leaves the moment the creator sells.
//
// The pacer exists for the guardrail, not for alpha: the final window is only
// 6 hours, so the sniper alone may not reach 20 round trips. It buys exactly
// 0.01 SOL on deep, mature, flat coins (30+ trades, first seen 1200+ slots ago,
// 5+ SOL of real reserve), spaced at least 1200 slots apart, and sells on a
// +0.3% uptick, a -5% dip, or after 600 slots. Each probe costs roughly its
// fees; 30 of them cost far less than one missed guardrail.
//
// Deterministic by construction: no clock, no environment, no Math.random.
// Every decision comes from the harness state and the fixed constants in
// strategy.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { createBot } from './strategy.ts';

const bot = createBot();

await runBot({
  onBatch: bot.onBatch,
  onDone: bot.onDone,
});
