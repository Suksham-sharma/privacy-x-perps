"use client";
// Order ticket: pick side / size / leverage, encrypt the order CLIENT-SIDE
// (x25519 + RescueCipher via the SDK), and submit_order. Price stays encrypted;
// only max_margin is public. On localnet the index price is the Pyth fixture
// (100,000 ticks); orders sit within the circuit's ±5% band so they can match.
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
import { PROGRAM_ID } from "@/lib/config";
import { fmtUsdc, INDEX_PRICE_TICKS } from "@/lib/format";

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
  const qc = useQueryClient();

  const [side, setSide] = useState<0 | 1>(0); // 0 long, 1 short
  const [sizeInput, setSizeInput] = useState("1000");
  const [leverage, setLeverage] = useState(2);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: Tone; msg: string } | null>(null);

  const size = (() => {
    const v = Number(sizeInput);
    return Number.isFinite(v) && v > 0 ? BigInt(Math.floor(v)) : 0n;
  })();
  const notional = INDEX_PRICE_TICKS * size; // base units
  const maxMargin = size > 0n ? (notional + BigInt(leverage) - 1n) / BigInt(leverage) : 0n;
  const balance = collateral.data ?? 0n;
  const insufficient = maxMargin > balance;

  const ready =
    connected && !!publicKey && !!program && !!mxe.data && size > 0n && !insufficient;
  const levPct = ((leverage - 1) / 9) * 100;

  async function submit() {
    if (!program || !publicKey || !mxe.data) return;
    setBusy(true);
    setStatus({ tone: "info", msg: "Encrypting order in your browser…" });
    try {
      const clientNonce = randomU64();
      const pt: OrderPlaintext = {
        side: BigInt(side),
        price: INDEX_PRICE_TICKS,
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
      setStatus({ tone: "err", msg: (e as Error).message });
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
          <span className="u">lots</span>
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
          <span>1×</span>
          <span>5×</span>
          <span>10×</span>
        </div>
      </div>

      <div className="ticket-sum">
        <div className="l">
          <span className="k">Index</span>
          <span>{INDEX_PRICE_TICKS.toLocaleString("en-US")}</span>
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
