"use client";
// Open Orders = the live encrypted batch register. Every slot's {owner, margin}
// is public on-chain; the order itself (side/price/size) is sealed. YOUR row
// renders in plaintext — recovered from the client-side stash written at submit
// time, since only you hold it — while every other trader's order stays a
// redaction bar until the MPC match. Cancel pulls your order + refunds margin.
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
import { PROGRAM_ID } from "@/lib/config";
import { fmtUsdc } from "@/lib/format";

const MAX_ORDERS = 8;

interface Stash {
  side?: 0 | 1;
  size?: string;
  leverage?: number;
}

function readStash(): Stash | null {
  try {
    const raw = sessionStorage.getItem("iceberg.lastOrder");
    return raw ? (JSON.parse(raw) as Stash) : null;
  } catch {
    return null;
  }
}

function short(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-2)}`;
}

export function OpenOrders() {
  const program = useProgram();
  const { publicKey } = useWallet();
  const batch = useBatchBuffer();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "err" | "info"; msg: string } | null>(null);

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
      setStatus({ tone: "err", msg: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!data || data.nOrders === 0) {
    return (
      <>
        <div className="ebk-h">
          <span>Slot</span>
          <span>Trader</span>
          <span>Sealed order</span>
          <span>Margin</span>
        </div>
        <div className="pane-empty">No sealed orders in the batch — submit one to open the round.</div>
        {status && (
          <div className="pane-status">
            <div className={`cstatus ${status.tone}`}>{status.msg}</div>
          </div>
        )}
      </>
    );
  }

  const stash = readStash();

  return (
    <>
      <div className="ebk-h">
        <span>Slot</span>
        <span>Trader</span>
        <span>Sealed order</span>
        <span>Margin</span>
      </div>

      {data.orders.map((o, i) => {
        const mine = !!me && o.owner === me;
        return (
          <div key={`${o.owner}-${i}`} className={`ebk-row ${mine ? "you" : ""}`}>
            <span className="slot">{String(i + 1).padStart(2, "0")}</span>
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
                <button className="ebk-cancel" onClick={cancel} disabled={busy || data.isProcessing}>
                  {busy ? "…" : "Cancel"}
                </button>
              )}
            </span>
          </div>
        );
      })}

      {data.nOrders < MAX_ORDERS && (
        <div className="ebk-empty">
          <span className="slot">{String(data.nOrders + 1).padStart(2, "0")}</span>
          <span>{data.isProcessing ? "— matching… —" : "— awaiting counterparty —"}</span>
          <span className="redact">███████</span>
          <span>—</span>
        </div>
      )}

      <div className="pane-note">
        <span className="microprint">
          YOUR ORDER IS LEGIBLE TO YOU ALONE · EVERY OTHER SLOT STAYS SEALED UNTIL THE MPC MATCH · CANCEL REFUNDS MARGIN
        </span>
      </div>

      {status && (
        <div className="pane-status">
          <div className={`cstatus ${status.tone}`}>{status.msg}</div>
        </div>
      )}
    </>
  );
}
