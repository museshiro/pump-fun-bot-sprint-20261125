# Wide Net Sniper + Flat-Coin Pacer

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/museshiro/pump-fun-bot-sprint-20261125/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/museshiro/pump-fun-bot-sprint-20261125/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading bot for pump.fun bonding curves, entered in [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) on [make.fun](https://make.fun/r/xrr5vp10).

## Strategy

Two halves. The **sniper** buys a new coin only in its first 5 slots, when at most 1 distinct non-creator wallet has bought, at least 0.05 SOL of non-creator volume has arrived, the curve already holds 2.25 SOL of real reserve, the creator has bought at most 2.5 SOL and has not sold, and the price has not already run more than +50% from creation. It stakes 0.04 SOL per coin, sells half at +12%, stops out at −12%, trails the rest 15% below the peak once the peak clears +10%, never holds longer than 300 slots, and leaves the moment the creator sells.

The **pacer** exists for the guardrail, not for alpha: the final window is only 6 hours, so the sniper alone may not reach 20 round trips. It buys exactly 0.01 SOL on deep, mature, flat coins (30+ trades, first seen 1200+ slots ago, 5+ SOL of real reserve), spaced at least 1200 slots apart, and sells on a +0.3% uptick, a −5% dip, or after 600 slots.

## Files

- `main.ts` — entrypoint: hands the strategy to the harness shim.
- `strategy.ts` — all trading logic (entry filters, exits, pacer). Deterministic: no clock, no environment, no `Math.random`.
- `vendor/makefun-bot.ts` — the kit's SDK shim, copied byte-for-byte as the kit instructs (excluded from authorship counts).

## Running

The grader runs `node /bot/main.ts` on Node 22 in a sandbox with no network. To grade locally:

```sh
node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process
```
