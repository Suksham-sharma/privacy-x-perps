"use client";
// Positions ledger (the Positions tab): the connected wallet's open position
// (plaintext in v0) as a ledger row — direction, size, entry, mark, est. liq,
// margin, and unrealized PnL marked at the on-chain index (localnet Pyth
// fixture). Your row is accent-tinted ("your row legible"). Close →
// close_position settles realized PnL and returns collateral.
import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  deriveMarketPda,
  derivePositionPda,
  deriveUserCollateralPda,
} from "@confidential-perps/sdk";
import { useProgram } from "@/lib/anchor";
import { usePosition } from "@/hooks/usePosition";
import { PROGRAM_ID, PYTH_PRICE_UPDATE } from "@/lib/config";
import { fmtUsdc, INDEX_PRICE_TICKS } from "@/lib/format";

const abs = (x: bigint) => (x < 0n ? -x : x);

export function PositionsPanel() {
  const program = useProgram();
  const { publicKey } = useWallet();
  const pos = usePosition();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "err" | "info"; msg: string } | null>(null);

  async function close() {
    if (!program || !publicKey) return;
    setBusy(true);
    setStatus({ tone: "info", msg: "Closing position…" });
    try {
      const [market] = deriveMarketPda(PROGRAM_ID);
      const [position] = derivePositionPda(market, publicKey, PROGRAM_ID);
      const [userCollateral] = deriveUserCollateralPda(market, publicKey, PROGRAM_ID);
      const sig = await program.methods
        .closePosition()
        .accountsPartial({
          user: publicKey,
          market,
          position,
          userCollateral,
          priceUpdate: PYTH_PRICE_UPDATE,
        })
        .rpc();
      setStatus({ tone: "ok", msg: `Closed. ${sig.slice(0, 8)}…` });
      qc.invalidateQueries({ queryKey: ["position"] });
      qc.invalidateQueries({ queryKey: ["userCollateral"] });
    } catch (e) {
      setStatus({ tone: "err", msg: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const p = pos.data;

  if (!p) {
    return <div className="pane-empty">No open position — submit an order to open one.</div>;
  }

  const isLong = p.baseAmountLots > 0n;
  const size = abs(p.baseAmountLots);
  const entry = size > 0n ? abs(p.quoteEntry) / size : 0n;
  const upnl = p.baseAmountLots * INDEX_PRICE_TICKS + p.quoteEntry;
  // Simple liquidation estimate (no funding/maintenance in v0): the price move
  // that exhausts locked margin against entry notional.
  const notionalAtEntry = Number(abs(p.quoteEntry)) || 1;
  const frac = Number(p.marginLocked) / notionalAtEntry;
  const entryNum = Number(entry);
  const liq = Math.round(isLong ? entryNum * (1 - frac) : entryNum * (1 + frac));
  const fmt = (n: number) => n.toLocaleString("en-US");

  return (
    <>
      <div className="tled-h">
        <span>Position</span>
        <span>Size</span>
        <span>Entry</span>
        <span>Mark</span>
        <span>Est. liq.</span>
        <span>Margin</span>
        <span>uPnL</span>
        <span />
      </div>
      <div className="tled-row you">
        <span className="side">
          <span className={`tag ${isLong ? "long" : "short"}`}>{isLong ? "Long" : "Short"}</span> SOL-PERP
        </span>
        <span className="c">{fmt(Number(size))}</span>
        <span className="c">{fmt(Number(entry))}</span>
        <span className="c">{fmt(Number(INDEX_PRICE_TICKS))}</span>
        <span className="c">{fmt(liq)}</span>
        <span className="c">{fmtUsdc(p.marginLocked)}</span>
        <span className={`c ${upnl > 0n ? "long" : upnl < 0n ? "short" : ""}`}>{fmtUsdc(upnl)}</span>
        <span style={{ textAlign: "right" }}>
          <button className="close" onClick={close} disabled={busy}>
            {busy ? "Closing…" : "Close"}
          </button>
        </span>
      </div>
      {status && (
        <div className="pane-status" style={{ paddingTop: 12 }}>
          <div className={`cstatus ${status.tone}`}>{status.msg}</div>
        </div>
      )}
    </>
  );
}
