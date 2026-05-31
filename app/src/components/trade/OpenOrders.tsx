"use client";
// Open Orders = the live encrypted batch register: {owner, margin} public, order sealed.
// YOUR row renders plaintext from the client-side stash; others stay redacted until the MPC match.
import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  deriveMarketPda,
  deriveBatchBufferPda,
  deriveUserCollateralPda,
} from "@confidential-perps/sdk";
import { useProgram } from "@/lib/anchor";
import { useBatchBuffer } from "@/hooks/useBatchBuffer";
import { useAutoDismiss } from "@/hooks/useAutoDismiss";
import { PROGRAM_ID } from "@/lib/config";
import { fmtUsdc } from "@/lib/format";
import { getStashedOrder } from "@/lib/orderStash";
import { friendlyError } from "@/lib/errors";

const MAX_ORDERS = 4;

function short(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-2)}`;
}

// mineOnly → "Open Orders" tab: just the connected wallet's pending orders.
// default → "Batch" tab: the full encrypted register (every slot, others sealed).
export function OpenOrders({ mineOnly = false }: { mineOnly?: boolean } = {}) {
  const program = useProgram();
  const { publicKey } = useWallet();
  const batch = useBatchBuffer();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "err" | "info"; msg: string } | null>(null);
  useAutoDismiss(status, () => setStatus(null));

  const me = publicKey?.toBase58();
  const data = batch.data;

  async function cancel() {
    if (!program || !publicKey) return;
    setBusy(true);
    setStatus({ tone: "info", msg: "Cancelling order…" });
    try {
      const [market] = deriveMarketPda(PROGRAM_ID);
      const [batchBuffer] = deriveBatchBufferPda(market, PROGRAM_ID);
      const [userCollateral] = deriveUserCollateralPda(market, publicKey, PROGRAM_ID);
      const sig = await program.methods
        .cancelOrder()
        .accountsPartial({ user: publicKey, market, batchBuffer, userCollateral })
        .rpc();
      setStatus({ tone: "ok", msg: `Cancelled, margin refunded. ${sig.slice(0, 8)}…` });
      qc.invalidateQueries({ queryKey: ["batchBuffer"] });
      qc.invalidateQueries({ queryKey: ["userCollateral"] });
    } catch (e) {
      setStatus({ tone: "err", msg: friendlyError(e) });
    } finally {
      setBusy(false);
    }
  }

  const rows = (data?.orders ?? [])
    .map((o, slot) => ({ o, slot }))
    .filter(({ o }) => !mineOnly || (!!me && o.owner === me));
  const empty = !data || data.nOrders === 0 || (mineOnly && rows.length === 0);

  return (
    <>
      <div className="ebk-h">
        <span>Slot</span>
        <span>Trader</span>
        <span>{mineOnly ? "Order" : "Sealed order"}</span>
        <span>Margin</span>
      </div>

      {empty ? (
        <div className="pane-empty">
          {mineOnly
            ? "No open orders — submit one from the ticket."
            : "No sealed orders in the batch — submit one to open the round."}
        </div>
      ) : (
        rows.map(({ o, slot }) => {
          const mine = !!me && o.owner === me;
          // Per-row lookup keyed by this slot's maxMargin, so each of your
          // orders renders its own side/size/leverage (not the last one's).
          const stash = mine ? getStashedOrder(o.maxMargin) : null;
          return (
            <div key={`${o.owner}-${slot}`} className={`ebk-row ${mine ? "you" : ""}`}>
              <span className="slot">{String(slot + 1).padStart(2, "0")}</span>
              <span className="tr">{mine ? `you · ${short(o.owner)}` : short(o.owner)}</span>
              <span className="ord">
                {mine && stash?.side !== undefined ? (
                  <>
                    <span className={stash.side === 0 ? "side-long" : "side-short"}>
                      {stash.side === 0 ? "LONG" : "SHORT"}
                    </span>{" "}
                    {stash.size ? Number(stash.size).toLocaleString("en-US") : "—"}
                    {stash.leverage ? ` · ${stash.leverage}×` : ""}
                  </>
                ) : mine ? (
                  <span className="cipher">Sealed (yours)</span>
                ) : (
                  <span className="redact">█████████</span>
                )}
              </span>
              <span className="mg">
                {fmtUsdc(o.maxMargin)}
                {mine && (
                  <button className="ebk-cancel" onClick={cancel} disabled={busy || data?.isProcessing}>
                    {busy ? "…" : "Cancel"}
                  </button>
                )}
              </span>
            </div>
          );
        })
      )}

      {!mineOnly && data && data.nOrders > 0 && data.nOrders < MAX_ORDERS && (
        <div className="ebk-empty">
          <span className="slot">{String(data.nOrders + 1).padStart(2, "0")}</span>
          <span>{data.isProcessing ? "— matching… —" : "— awaiting counterparty —"}</span>
          <span className="redact">███████</span>
          <span>—</span>
        </div>
      )}

      {!empty && (
        <div className="pane-note">
          <span className="microprint">
            {mineOnly
              ? "YOUR PENDING ORDERS · LEGIBLE TO YOU ALONE · CANCEL REFUNDS MARGIN"
              : "EVERY OTHER SLOT STAYS SEALED UNTIL THE MPC MATCH · YOUR ORDER IS LEGIBLE TO YOU ALONE · CANCEL REFUNDS MARGIN"}
          </span>
        </div>
      )}

      {status && (
        <div className="pane-status">
          <div className={`cstatus ${status.tone}`}>{status.msg}</div>
        </div>
      )}
    </>
  );
}
