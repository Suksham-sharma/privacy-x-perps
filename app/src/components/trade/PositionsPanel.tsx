"use client";
// Positions tab: the wallet's open position (plaintext in v0) as a ledger row, uPnL marked
// at the on-chain index (localnet Pyth fixture). Close → close_position settles PnL + returns collateral.
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
import { useIndexPrice } from "@/hooks/useIndexPrice";
import { useAutoDismiss } from "@/hooks/useAutoDismiss";
import { PROGRAM_ID, PYTH_PRICE_UPDATE } from "@/lib/config";
import { fmtUsdc } from "@/lib/format";
import { friendlyError } from "@/lib/errors";

const abs = (x: bigint) => (x < 0n ? -x : x);

export function PositionsPanel() {
  const program = useProgram();
  const { publicKey } = useWallet();
  const pos = usePosition();
  const index = useIndexPrice();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "err" | "info"; msg: string } | null>(null);
  useAutoDismiss(status, () => setStatus(null));

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
      setStatus({ tone: "err", msg: friendlyError(e) });
    } finally {
      setBusy(false);
    }
  }

  const p = pos.data;

  if (!p) {
    return <div className="pane-empty">No open position — submit an order to open one.</div>;
  }

  const indexPrice = index.data ?? null;
  const isLong = p.baseAmountLots > 0n;
  const size = abs(p.baseAmountLots);
  const entry = size > 0n ? abs(p.quoteEntry) / size : 0n;
  const upnl = indexPrice !== null ? p.baseAmountLots * indexPrice + p.quoteEntry : 0n;
  // Simple liquidation estimate (no funding/maintenance in v0): the price move
  // that exhausts locked margin against entry notional.
  const notionalAtEntry = Number(abs(p.quoteEntry)) || 1;
  const frac = Number(p.marginLocked) / notionalAtEntry;
  const entryNum = Number(entry);
  const liq = BigInt(Math.round(isLong ? entryNum * (1 - frac) : entryNum * (1 + frac)));
  const fmt = (n: number) => n.toLocaleString("en-US");
  // Signed currency for uPnL so gain/loss reads at a glance (+$ / -$, neutral at 0).
  const upnlStr = upnl === 0n ? `$${fmtUsdc(0n)}` : `${upnl < 0n ? "-" : "+"}$${fmtUsdc(abs(upnl))}`;

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
        <span className="c">{fmt(Number(size))} SOL</span>
        <span className="c">${fmtUsdc(entry)}</span>
        <span className="c">{indexPrice !== null ? `$${fmtUsdc(indexPrice)}` : "—"}</span>
        <span className="c">${fmtUsdc(liq)}</span>
        <span className="c">${fmtUsdc(p.marginLocked)}</span>
        <span className={`c ${upnl > 0n ? "long" : upnl < 0n ? "short" : ""}`}>{upnlStr}</span>
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
