// Green-bar reversal bot for cbBTC/USDC on 1-minute bars (agent-fun/bars-replay/v1).
//
// Idea: on this thin on-chain pool the price grinds in slow multi-hour waves
// and then snaps back. Chasing every 1-minute wiggle loses money to the
// ~26 bps round-trip cost, so this bot waits for a washout and only buys the
// first sign that sellers are exhausted:
//
//   - Entry (flat only): the close is at least DIP_BPS below the highest
//     HIGH of the last WINDOW_BARS bars, and the bar that just closed is
//     green (close above its own open) — the dip is deep, and this very
//     minute buyers stepped back in. Buys with all available cash.
//   - Exit (whole position): take profit at TAKE_PROFIT_BPS over the entry
//     cost, stop loss at STOP_LOSS_BPS under it, a trailing stop of
//     TRAIL_BPS below the best value seen since entry, or a time stop after
//     MAX_HOLD_BARS bars held, so a position that never bounces is not
//     carried into the next wave.
//   - One position at a time, long only, full size.
//
// This is a reversal bot, not a trend bot: it never buys a breakout and never
// chases a rising market. It also never trades on a red bar, however deep the
// dip — a falling knife has to show one green minute first.
//
// Everything is a pure function of the bars the harness sends: no clock, no
// network, no randomness, no files. The same bars always give the same orders.

import {
  runBars,
  type BarsState,
  type Batch,
  type BuyInput,
  type SellInput,
} from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const WINDOW_BARS = 120;
const DIP_BPS = 100;
const TAKE_PROFIT_BPS = 150;
const STOP_LOSS_BPS = 80;
const TRAIL_BPS = 150;
const MAX_HOLD_BARS = 360;
const MAX_SLIPPAGE_BPS = 100;
const BPS = 10000n;

// Bars seen so far, oldest first (one entry per CBBTC bar received).
const closes: number[] = [];
const opens: number[] = [];
const highs: number[] = [];

// Position bookkeeping, filled in from the fills each batch reports.
// NOTE: a fill's decided_bar is the bar's timestamp in ms, not its seq, so
// the entry seq is recorded when the buy order is sent (see below), never
// from a fill.
let entryCost = 0n; // quote units spent on the open buy (fee included)
let entrySeq = -1; // seq of the batch that sent the open buy
let peakValue = 0n; // best position value (quote units) since entry

function rollingHigh(): number {
  let high = 0;
  const start = closes.length - WINDOW_BARS - 1;
  for (let i = start; i < closes.length - 1; i++) {
    if (highs[i]! > high) high = highs[i]!;
  }
  return high;
}

function entrySignal(): boolean {
  if (closes.length <= WINDOW_BARS) return false;
  const close = closes[closes.length - 1]!;
  const open = opens[opens.length - 1]!;
  // The bar must be green: buyers stepped back in on this very minute.
  if (close <= open) return false;
  const high = rollingHigh();
  const dipBps = ((high - close) / high) * 10000;
  return dipBps >= DIP_BPS;
}

function exitSignal(state: BarsState): boolean {
  const held = state.positions.get(SYMBOL);
  if (held === undefined || entryCost === 0n) return false;
  const value = state.value(SYMBOL, held.qty);
  if (value > peakValue) peakValue = value;
  const gainBps = ((value - entryCost) * BPS) / entryCost;
  if (gainBps >= BigInt(TAKE_PROFIT_BPS)) return true;
  if (gainBps <= -BigInt(STOP_LOSS_BPS)) return true;
  if (peakValue > 0n) {
    const trailBps = ((peakValue - value) * BPS) / peakValue;
    if (trailBps >= BigInt(TRAIL_BPS)) return true;
  }
  if (entrySeq >= 0 && state.seq - entrySeq >= MAX_HOLD_BARS) return true;
  return false;
}

await runBars({
  onBatch(state, batch: Batch) {
    // Fold in this batch's fills before deciding: a buy fill opens the
    // position (record its cost), a sell fill closes it.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled' || fill.symbol !== SYMBOL) continue;
      if (fill.side === 'buy') {
        entryCost = BigInt(fill.notional_quote_units);
        peakValue = 0n;
      } else {
        entryCost = 0n;
        entrySeq = -1;
        peakValue = 0n;
      }
    }

    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) {
        closes.push(Number(bar.c));
        opens.push(Number(bar.o));
        highs.push(Number(bar.h));
      }
    }
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      if (exitSignal(state)) {
        return [
          {
            side: 'sell',
            symbol: SYMBOL,
            qty: held.qty,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          } satisfies SellInput,
        ];
      }
      return [];
    }

    if (entrySignal() && state.cash >= BigInt(state.hello.fees.min_notional_quote_units)) {
      // Record the entry seq here: the fill that comes back reports
      // decided_bar as a millisecond timestamp, not this seq.
      entrySeq = state.seq;
      return [
        {
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: state.cash,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        } satisfies BuyInput,
      ];
    }
    return [];
  },
});
