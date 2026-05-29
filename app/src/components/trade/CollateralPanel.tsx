"use client";
// Collateral panel: wallet USDC + deposited margin, a localnet "Get USDC" faucet
// button, and deposit/withdraw forms wired to the program. All amounts are USDC
// (6 decimals). Reuses the Declassified field/button classes from globals.css.
import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { BN } from "@anchor-lang/core";
import { SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  deriveMarketPda,
  deriveUserCollateralPda,
} from "@confidential-perps/sdk";
import { useProgram } from "@/lib/anchor";
import { useUsdcBalance } from "@/hooks/useUsdcBalance";
import { useUserCollateral } from "@/hooks/useUserCollateral";
import { PROGRAM_ID, USDC_MINT } from "@/lib/config";

const USDC = 1_000_000n;

function fmtUsdc(base: bigint | undefined): string {
  if (base === undefined) return "—";
  const whole = base / USDC;
  const cents = (base % USDC) / 10_000n;
  return `${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}

function toBaseUnits(input: string): bigint | null {
  const v = Number(input);
  if (!Number.isFinite(v) || v <= 0) return null;
  return BigInt(Math.round(v * 1_000_000));
}

type Tone = "ok" | "err" | "info";

export function CollateralPanel() {
  const program = useProgram();
  const { publicKey, connected } = useWallet();
  const qc = useQueryClient();

  const usdc = useUsdcBalance();
  const collateral = useUserCollateral();

  const [depositAmt, setDepositAmt] = useState("");
  const [withdrawAmt, setWithdrawAmt] = useState("");
  const [busy, setBusy] = useState<null | "faucet" | "deposit" | "withdraw">(null);
  const [status, setStatus] = useState<{ tone: Tone; msg: string } | null>(null);

  const ready = connected && !!publicKey && !!program && !!USDC_MINT;

  function refresh() {
    qc.invalidateQueries({ queryKey: ["usdcBalance"] });
    qc.invalidateQueries({ queryKey: ["userCollateral"] });
  }

  async function getUsdc() {
    if (!publicKey) return;
    setBusy("faucet");
    setStatus({ tone: "info", msg: "Requesting test USDC + gas…" });
    try {
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: publicKey.toBase58() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "faucet failed");
      setStatus({ tone: "ok", msg: `Funded ${data.usdc} USDC + 2 SOL gas.` });
      setTimeout(refresh, 1200);
    } catch (e) {
      setStatus({ tone: "err", msg: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function deposit() {
    if (!program || !publicKey || !USDC_MINT) return;
    const amount = toBaseUnits(depositAmt);
    if (amount === null) {
      setStatus({ tone: "err", msg: "Enter a positive amount." });
      return;
    }
    setBusy("deposit");
    setStatus({ tone: "info", msg: `Depositing ${depositAmt} USDC…` });
    try {
      const [market] = deriveMarketPda(PROGRAM_ID);
      const [userCollateral] = deriveUserCollateralPda(market, publicKey, PROGRAM_ID);
      const usdcVault = await getAssociatedTokenAddress(USDC_MINT, market, true);
      const userTokenAccount = await getAssociatedTokenAddress(USDC_MINT, publicKey);
      const sig = await program.methods
        .deposit(new BN(amount.toString()))
        .accounts({
          user: publicKey,
          market,
          userCollateral,
          usdcVault,
          userTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      setStatus({ tone: "ok", msg: `Deposited. ${sig.slice(0, 8)}…` });
      setDepositAmt("");
      setTimeout(refresh, 800);
    } catch (e) {
      setStatus({ tone: "err", msg: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function withdraw() {
    if (!program || !publicKey || !USDC_MINT) return;
    const amount = toBaseUnits(withdrawAmt);
    if (amount === null) {
      setStatus({ tone: "err", msg: "Enter a positive amount." });
      return;
    }
    setBusy("withdraw");
    setStatus({ tone: "info", msg: `Withdrawing ${withdrawAmt} USDC…` });
    try {
      const [market] = deriveMarketPda(PROGRAM_ID);
      const [userCollateral] = deriveUserCollateralPda(market, publicKey, PROGRAM_ID);
      const usdcVault = await getAssociatedTokenAddress(USDC_MINT, market, true);
      const userTokenAccount = await getAssociatedTokenAddress(USDC_MINT, publicKey);
      const sig = await program.methods
        .withdraw(new BN(amount.toString()))
        .accounts({
          user: publicKey,
          market,
          userCollateral,
          usdcVault,
          userTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      setStatus({ tone: "ok", msg: `Withdrew. ${sig.slice(0, 8)}…` });
      setWithdrawAmt("");
      setTimeout(refresh, 800);
    } catch (e) {
      setStatus({ tone: "err", msg: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="cpanel">
      <div className="cpanel-h">
        <span className="cpanel-title">Collateral</span>
        <span className="cpanel-sub">USDC · localnet</span>
      </div>

      <div className="cpanel-body">
        <div className="cstats">
          <div className="cstat">
            <span className="ck">In wallet</span>
            <span className="cv">{fmtUsdc(usdc.data)}</span>
          </div>
          <div className="cstat">
            <span className="ck">Deposited margin</span>
            <span className="cv accent">{fmtUsdc(collateral.data)}</span>
          </div>
        </div>

        {!USDC_MINT ? (
          <div className="cnote">
            No localnet config. Run{" "}
            <code>pnpm exec tsx scripts/localnet-bootstrap.ts</code> then restart
            the dev server.
          </div>
        ) : !connected ? (
          <div className="cnote">Connect a wallet to fund and deposit.</div>
        ) : (
          <>
            <button
              className="btn btn-sm cfaucet"
              onClick={getUsdc}
              disabled={busy !== null}
            >
              {busy === "faucet" ? "Funding…" : "Get 1,000 USDC"}
            </button>

            <div className="crow">
              <div className="fld">
                <div className="flab">
                  <span>Deposit</span>
                  <span>USDC</span>
                </div>
                <div className="fin">
                  <input
                    className="cinput"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={depositAmt}
                    onChange={(e) => setDepositAmt(e.target.value)}
                  />
                  <span className="u">USDC</span>
                </div>
              </div>
              <button
                className="submit csubmit"
                onClick={deposit}
                disabled={!ready || busy !== null}
              >
                {busy === "deposit" ? "…" : "Deposit"}
              </button>
            </div>

            <div className="crow">
              <div className="fld">
                <div className="flab">
                  <span>Withdraw</span>
                  <span>USDC</span>
                </div>
                <div className="fin">
                  <input
                    className="cinput"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={withdrawAmt}
                    onChange={(e) => setWithdrawAmt(e.target.value)}
                  />
                  <span className="u">USDC</span>
                </div>
              </div>
              <button
                className="btn cwithdraw"
                onClick={withdraw}
                disabled={!ready || busy !== null}
              >
                {busy === "withdraw" ? "…" : "Withdraw"}
              </button>
            </div>
          </>
        )}

        {status && (
          <div className={`cstatus ${status.tone}`}>{status.msg}</div>
        )}
      </div>
    </section>
  );
}
