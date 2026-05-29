"use client";
// Positions panel: the connected wallet's open position (plaintext in v0) with
// direction, size, entry, margin, and unrealized PnL marked at the index price.
// Close → close_position (settles realized PnL at the Pyth fixture, returns
// collateral). Empty state when flat.
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
        .accounts({
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

  return (
    <section className="cpanel">
      <div className="cpanel-h">
        <span className="cpanel-title">Position</span>
        <span className="cpanel-sub">Plaintext · yours</span>
      </div>
      <div className="cpanel-body">
        {!p ? (
          <div className="cnote">No open position — submit an order.</div>
        ) : (
          (() => {
            const isLong = p.baseAmountLots > 0n;
            const size = abs(p.baseAmountLots);
            const entry = size > 0n ? abs(p.quoteEntry) / size : 0n;
            const upnl = p.baseAmountLots * INDEX_PRICE_TICKS + p.quoteEntry;
            return (
              <>
                <div className="prow">
                  <span className={`pside ${isLong ? "long" : "short"}`}>
                    {isLong ? "LONG" : "SHORT"}
                  </span>
                  <span className="psize">{size.toLocaleString("en-US")} lots</span>
                </div>
                <div className="ticket-sum">
                  <div className="l">
                    <span className="k">Entry</span>
                    <span>{entry.toLocaleString("en-US")}</span>
                  </div>
                  <div className="l">
                    <span className="k">Mark</span>
                    <span>{INDEX_PRICE_TICKS.toLocaleString("en-US")}</span>
                  </div>
                  <div className="l">
                    <span className="k">Margin</span>
                    <span>{fmtUsdc(p.marginLocked)} USDC</span>
                  </div>
                  <div className="l">
                    <span className="k">Unrealized PnL</span>
                    <span
                      style={{
                        color:
                          upnl > 0n
                            ? "var(--long)"
                            : upnl < 0n
                              ? "var(--short)"
                              : undefined,
                      }}
                    >
                      {fmtUsdc(upnl)} USDC
                    </span>
                  </div>
                </div>
                <button
                  className="btn cwithdraw"
                  style={{ width: "100%" }}
                  onClick={close}
                  disabled={busy}
                >
                  {busy ? "Closing…" : "Close position"}
                </button>
              </>
            );
          })()
        )}
        {status && <div className={`cstatus ${status.tone}`}>{status.msg}</div>}
      </div>
    </section>
  );
}
