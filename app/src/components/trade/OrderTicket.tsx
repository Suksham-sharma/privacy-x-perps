"use client";
// Order ticket: pick side / size / leverage, encrypt the order CLIENT-SIDE
// (x25519 + RescueCipher via the SDK), and submit_order. Price stays encrypted;
// only max_margin is public. v0a matches against peers + a pool backstop and
// clears at the live oracle; a market order just needs to CROSS the oracle
// (long: price >= oracle, short: price <= oracle), so we encrypt the price with
// a small cross buffer (see CROSS_BUFFER_BPS) to stay crossing as the oracle
// ticks during the batch window.
import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { BN } from "@anchor-lang/core";
import { SystemProgram } from "@solana/web3.js";
import {
  deriveMarketPda,
  deriveBatchBufferPda,
  deriveUserCollateralPda,
  derivePositionPda,
  encryptOrder,
  toSubmitOrderArgs,
  type OrderPlaintext,
} from "@confidential-perps/sdk";
import { useProgram } from "@/lib/anchor";
import { useMxePublicKey } from "@/hooks/useMxePublicKey";
import { useUserCollateral } from "@/hooks/useUserCollateral";
import { useIndexPrice } from "@/hooks/useIndexPrice";
import { useAutoDismiss } from "@/hooks/useAutoDismiss";
import { PROGRAM_ID } from "@/lib/config";
import { fmtUsdc } from "@/lib/format";
import { friendlyError } from "@/lib/errors";

function randomU64(): bigint {
  const b = crypto.getRandomValues(new Uint8Array(8));
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

type Tone = "ok" | "err" | "info";

export function OrderTicket() {
  const program = useProgram();
  const { publicKey, connected } = useWallet();
  const mxe = useMxePublicKey();
  const collateral = useUserCollateral();
  const index = useIndexPrice();
  const qc = useQueryClient();

  const [side, setSide] = useState<0 | 1>(0); // 0 long, 1 short
  const [sizeInput, setSizeInput] = useState("1");
  const [leverage, setLeverage] = useState(2);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: Tone; msg: string } | null>(null);
  useAutoDismiss(status, () => setStatus(null));

  // Live SOL/USD index (USD * 1e6 == USDC base units per SOL). 1 lot = 1 SOL,
  // so notional = price * size is already in USDC base units.
  const indexPrice = index.data ?? null;
  const size = (() => {
    const v = Number(sizeInput);
    return Number.isFinite(v) && v > 0 ? BigInt(Math.floor(v)) : 0n;
  })();
  const notional = (indexPrice ?? 0n) * size; // base units
  const maxMargin = size > 0n ? (notional + BigInt(leverage) - 1n) / BigInt(leverage) : 0n;
  const balance = collateral.data ?? 0n;
  const insufficient = maxMargin > balance;

  const ready =
    connected && !!publicKey && !!program && !!mxe.data && indexPrice !== null && size > 0n && !insufficient;
  const levPct = ((leverage - 1) / 9) * 100;

  async function submit() {
    if (!program || !publicKey || !mxe.data || indexPrice === null) return;
    setBusy(true);
    setStatus({ tone: "info", msg: "Encrypting order in your browser…" });
    try {
      const clientNonce = randomU64();
      // Cross buffer: price a market long ABOVE / short BELOW the live index so
      // the order still crosses if the keeper pushes a fresh oracle during the
      // ~window. v0a always clears at the oracle, so this changes only the cross
      // gate, not the execution price (never a worse fill). max_margin below
      // stays based on the index notional, not this buffered price.
      const CROSS_BUFFER_BPS = 200n; // 2%
      const orderPrice =
        side === 0
          ? indexPrice + (indexPrice * CROSS_BUFFER_BPS) / 10_000n
          : indexPrice - (indexPrice * CROSS_BUFFER_BPS) / 10_000n;
      const pt: OrderPlaintext = {
        side: BigInt(side),
        price: orderPrice,
        size,
        clientNonce,
      };
      const enc = encryptOrder(pt, mxe.data);
      // Stash the ephemeral key for a future decryptFill path (position is
      // plaintext in v0, so display doesn't need it).
      try {
        sessionStorage.setItem(
          "iceberg.lastOrder",
          JSON.stringify({
            clientNonce: clientNonce.toString(),
            privateKey: Array.from(enc.privateKey),
            side,
            size: size.toString(),
            leverage,
          }),
        );
      } catch {}

      const args = toSubmitOrderArgs(enc);
      const [market] = deriveMarketPda(PROGRAM_ID);
      const [batchBuffer] = deriveBatchBufferPda(market, PROGRAM_ID);
      const [userCollateral] = deriveUserCollateralPda(market, publicKey, PROGRAM_ID);
      const [position] = derivePositionPda(market, publicKey, PROGRAM_ID);

      setStatus({ tone: "info", msg: "Submitting sealed order…" });
      const sig = await program.methods
        .submitOrder(
          args.x25519Pubkey,
          args.nonce,
          new BN(maxMargin.toString()),
          args.ctSide,
          args.ctPrice,
          args.ctSize,
          args.ctClientNonce,
        )
        .accountsPartial({
          user: publicKey,
          market,
          batchBuffer,
          userCollateral,
          position,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      setStatus({
        tone: "ok",
        msg: `Sealed ${side === 0 ? "long" : "short"} ${size} submitted. ${sig.slice(0, 8)}…`,
      });
      qc.invalidateQueries({ queryKey: ["batchBuffer"] });
      qc.invalidateQueries({ queryKey: ["userCollateral"] });
      qc.invalidateQueries({ queryKey: ["position"] });
    } catch (e) {
      setStatus({ tone: "err", msg: friendlyError(e) });
    } finally {
      setBusy(false);
    }
  }

  const submitLabel = busy
    ? "Sealing…"
    : mxe.isLoading
      ? "Connecting to MXE…"
      : "Encrypt & Submit";

  return (
    <div className="ticket">
      <div className="ls">
        <button
          className={side === 0 ? "on-long" : ""}
          onClick={() => setSide(0)}
        >
          Long
        </button>
        <button
          className={side === 1 ? "on-short" : ""}
          onClick={() => setSide(1)}
        >
          Short
        </button>
      </div>

      <div className="fld">
        <div className="flab">
          <span>Size</span>
          <span>Margin {fmtUsdc(balance)}</span>
        </div>
        <div className="fin">
          <input
            className="cinput"
            inputMode="numeric"
            placeholder="0"
            value={sizeInput}
            onChange={(e) => setSizeInput(e.target.value)}
          />
          <span className="u">SOL</span>
        </div>
      </div>

      <div className="fld">
        <div className="flab">
          <span>Leverage</span>
          <span style={{ color: "var(--accent)" }}>{leverage.toFixed(1)}×</span>
        </div>
        <div className="lev-track">
          <div className="lev-fill" style={{ inset: `0 ${100 - levPct}% 0 0` }} />
          <div className="lev-knob" style={{ left: `${levPct}%` }} />
          <input
            className="lev-range"
            type="range"
            min={1}
            max={10}
            step={1}
            value={leverage}
            onChange={(e) => setLeverage(Number(e.target.value))}
          />
        </div>
        <div className="lev-marks">
          <span style={{ left: "0%" }}>1×</span>
          <span style={{ left: `${((5 - 1) / 9) * 100}%`, transform: "translateX(-50%)" }}>5×</span>
          <span style={{ left: "100%", transform: "translateX(-100%)" }}>10×</span>
        </div>
      </div>

      <div className="ticket-sum">
        <div className="l">
          <span className="k">Index · SOL/USD</span>
          <span>{indexPrice !== null ? `$${fmtUsdc(indexPrice)}` : "—"}</span>
        </div>
        <div className="l">
          <span className="k">Notional</span>
          <span>{fmtUsdc(notional)} USDC</span>
        </div>
        <div className="l">
          <span className="k">Margin required</span>
          <span style={{ color: insufficient ? "var(--short)" : undefined }}>
            {fmtUsdc(maxMargin)} USDC
          </span>
        </div>
      </div>

      <div className="seal">
        <svg
          width={13}
          height={13}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          aria-hidden
        >
          <rect x="5" y="11" width="14" height="9" rx="1" />
          <path d="M8 11 V7 a4 4 0 0 1 8 0 v4" />
        </svg>
        Encrypted before it leaves your browser
      </div>

      <button className="submit" onClick={submit} disabled={!ready || busy}>
        {submitLabel}
      </button>

      {!connected ? (
        <div className="cstatus info">Connect a wallet to submit an order.</div>
      ) : insufficient && size > 0n ? (
        <div className="cstatus err">
          Need {fmtUsdc(maxMargin)} margin — deposit more or lower size/leverage.
        </div>
      ) : status ? (
        <div className={`cstatus ${status.tone}`}>{status.msg}</div>
      ) : null}
    </div>
  );
}
