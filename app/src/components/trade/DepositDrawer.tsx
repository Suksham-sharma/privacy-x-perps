"use client";
// Collateral drawer (on-demand): wallet USDC + deposited margin, a localnet
// faucet, and deposit/withdraw — all wired to the program. Opens from the term
// bar's Deposit button. Logic is unchanged from the old always-on panel; only
// the surface moved into a slide-in drawer so trading holds the main canvas.
import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { BN } from "@anchor-lang/core";
import { SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { deriveMarketPda, deriveUserCollateralPda } from "@confidential-perps/sdk";
import { useProgram } from "@/lib/anchor";
import { useUsdcBalance } from "@/hooks/useUsdcBalance";
import { useUserCollateral } from "@/hooks/useUserCollateral";
import { useAutoDismiss } from "@/hooks/useAutoDismiss";
import { PROGRAM_ID, USDC_MINT } from "@/lib/config";
import { fmtUsdc } from "@/lib/format";
import { friendlyError } from "@/lib/errors";

function toBaseUnits(input: string): bigint | null {
  const v = Number(input);
  if (!Number.isFinite(v) || v <= 0) return null;
  return BigInt(Math.round(v * 1_000_000));
}

type Tone = "ok" | "err" | "info";
type Mode = "deposit" | "withdraw";

export function DepositDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const program = useProgram();
  const { publicKey, connected } = useWallet();
  const qc = useQueryClient();

  const usdc = useUsdcBalance();
  const collateral = useUserCollateral();

  const [mode, setMode] = useState<Mode>("deposit");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<null | "faucet" | "deposit" | "withdraw">(null);
  const [status, setStatus] = useState<{ tone: Tone; msg: string } | null>(null);
  useAutoDismiss(status, () => setStatus(null));

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
      setStatus({ tone: "err", msg: friendlyError(e) });
    } finally {
      setBusy(null);
    }
  }

  async function submit() {
    if (!program || !publicKey || !USDC_MINT) return;
    const base = toBaseUnits(amount);
    if (base === null) {
      setStatus({ tone: "err", msg: "Enter a positive amount." });
      return;
    }
    setBusy(mode);
    setStatus({ tone: "info", msg: `${mode === "deposit" ? "Depositing" : "Withdrawing"} ${amount} USDC…` });
    try {
      const [market] = deriveMarketPda(PROGRAM_ID);
      const [userCollateral] = deriveUserCollateralPda(market, publicKey, PROGRAM_ID);
      const usdcVault = await getAssociatedTokenAddress(USDC_MINT, market, true);
      const userTokenAccount = await getAssociatedTokenAddress(USDC_MINT, publicKey);

      const sig =
        mode === "deposit"
          ? await program.methods
              .deposit(new BN(base.toString()))
              .accountsPartial({
                user: publicKey,
                market,
                userCollateral,
                usdcVault,
                userTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
              })
              .rpc()
          : await program.methods
              .withdraw(new BN(base.toString()))
              .accountsPartial({
                user: publicKey,
                market,
                userCollateral,
                usdcVault,
                userTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
              })
              .rpc();

      setStatus({ tone: "ok", msg: `${mode === "deposit" ? "Deposited" : "Withdrew"}. ${sig.slice(0, 8)}…` });
      setAmount("");
      setTimeout(refresh, 800);
    } catch (e) {
      setStatus({ tone: "err", msg: friendlyError(e) });
    } finally {
      setBusy(null);
    }
  }

  const max = mode === "deposit" ? usdc.data : collateral.data;
  const actionLabel = busy === mode ? "…" : mode === "deposit" ? "Deposit" : "Withdraw";

  return (
    <>
      <div className={`tscrim ${open ? "show" : ""}`} onClick={onClose} />
      <aside className={`tdrawer ${open ? "open" : ""}`} aria-hidden={!open}>
        <div className="tdrawer-h">
          <span>Collateral</span>
          <button className="x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="tdrawer-body">
          <div className="cstats">
            <div className="cstat">
              <span className="ck">Deposited margin</span>
              <span className="cv accent">{fmtUsdc(collateral.data)}</span>
            </div>
            <div className="cstat">
              <span className="ck">In wallet</span>
              <span className="cv">{fmtUsdc(usdc.data)}</span>
            </div>
          </div>

          {!USDC_MINT ? (
            <div className="cnote">
              No localnet config. Run{" "}
              <code>pnpm exec tsx scripts/localnet-bootstrap.ts</code> then restart the dev server.
            </div>
          ) : !connected ? (
            <div className="cnote">Connect a wallet to fund and deposit.</div>
          ) : (
            <>
              <button className="btn btn-sm cfaucet" onClick={getUsdc} disabled={busy !== null}>
                {busy === "faucet" ? "Funding…" : "Get 1,000 test USDC"}
              </button>

              <div className="seg">
                <button className={mode === "deposit" ? "on" : ""} onClick={() => setMode("deposit")}>
                  Deposit
                </button>
                <button className={mode === "withdraw" ? "on" : ""} onClick={() => setMode("withdraw")}>
                  Withdraw
                </button>
              </div>

              <div className="fld">
                <div className="flab">
                  <span>Amount</span>
                  <span
                    style={{ color: "var(--accent)", cursor: "pointer" }}
                    onClick={() => max !== undefined && setAmount((Number(max) / 1_000_000).toString())}
                  >
                    MAX {fmtUsdc(max)}
                  </span>
                </div>
                <div className="fin">
                  <input
                    className="cinput"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                  <span className="u">USDC</span>
                </div>
              </div>

              <button className="submit" onClick={submit} disabled={!ready || busy !== null}>
                {actionLabel} {amount && `${amount} USDC`}
              </button>
            </>
          )}

          {status && <div className={`cstatus ${status.tone}`}>{status.msg}</div>}
        </div>
      </aside>
    </>
  );
}
