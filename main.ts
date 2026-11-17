// BTC Race Bot — "bank the first swing": buy once at the open, take profit at
// +1.2% over cost or stop out at -2.5%, then sit in cash.
//
// Why this shape (tested offline on the published dev window, 1,440 one-minute
// cbBTC/USDC bars, with the harness's own fill model: 4 bps fee + 2 bps modelled
// slippage + constant-product impact against the bar's open depth):
//   - A full-size round trip costs ~37 bps at this pool's depth (~790k USDC),
//     while 1-minute returns have a std of only ~6.4 bps. Any strategy that
//     trades often (EMA crosses, tight mean reversion) loses 5-15% of equity to
//     fees on the dev window. Fewer, wider trades win.
//   - The dev window rose +0.49% with an intraday high of +1.6% and a max
//     drawdown of 2.1%. Buy-and-hold nets +1.07 USDC; this rule nets +10.21 USDC
//     on the same window by selling into the first +1.2% move.
//   - Robustness: on 40 block-shuffled copies of the dev window (same 24h
//     return, different path) this rule has median +10.63 USDC, mean +5.99,
//     positive in 90% of copies. The 2.5% stop almost never triggers on a
//     normal day (dev max drawdown 2.1%) but caps the loss if the race window
//     crashes; the +1.2% take-profit banks the move before a rally fades.
//   - No re-entry after the exit: rebuying tested worse (it buys into falling
//     prices). One position, one exit, done.
//
// Deterministic: decisions use only the bars the harness sent and integer
// arithmetic on the account the harness reports. No clock, no network, no
// randomness.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Take profit: position value at least 1.2% over its cost (fees included). */
const TP_NUM = 1012n;
const TP_DEN = 1000n;
/** Stop loss: position value at most 2.5% under its cost. */
const SL_NUM = 975n;
const SL_DEN = 1000n;
/** Slippage cap per order, vs the latest close: 200 bps. 1-minute moves on
 * this pool have a ~6.4 bps std, so this essentially never binds, but it
 * refuses a fill into a genuine gap instead of chasing it. */
const MAX_SLIPPAGE_BPS = 200;

/** 0 = not bought yet, 1 = holding, 2 = sell sent, awaiting its fill,
 *  3 = exited (never trade again). */
let phase = 0;

await runBars({
  onBatch(state: BarsState) {
    if (state.warmingUp) return [];
    const held = state.positions.get(SYMBOL);
    if (phase === 0) {
      if (held !== undefined) {
        // Our buy filled: we are holding now.
        phase = 1;
      } else {
        // First tradable batch (or a retry after a rejected buy): spend all cash.
        if (state.cash <= 0n) return [];
        const buy: BuyInput = {
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: state.cash,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        };
        return [buy];
      }
    }
    if (phase === 1) {
      if (held === undefined) {
        // Position gone without our sell (should not happen): stop trading.
        phase = 3;
        return [];
      }
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      if (cost > 0n && (value * TP_DEN >= cost * TP_NUM || value * SL_DEN <= cost * SL_NUM)) {
        const sell: SellInput = {
          side: 'sell',
          symbol: SYMBOL,
          qty: held.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        };
        // Do not mark exited yet: if the harness rejects this sell (a gap
        // past the slippage cap, a missing bar), the next batch sees the
        // position still held and retries the exit instead of stranding it.
        phase = 2;
        return [sell];
      }
      return [];
    }
    if (phase === 2) {
      if (held === undefined) {
        // The sell filled: we are out for good.
        phase = 3;
        return [];
      }
      // Sell was rejected: fall back to holding and re-check the exit rule.
      phase = 1;
      return [];
    }
    return [];
  },
});
