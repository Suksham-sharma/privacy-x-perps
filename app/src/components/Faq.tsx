"use client";

import { useState } from "react";

const ITEMS: { q: string; a: string }[] = [
  {
    q: "If size is encrypted, how does matching work?",
    a: "Matching runs inside Arcium's multi-party computation network. The circuit operates directly on ciphertext — orders are compared and matched without any node decrypting them. The cluster produces a result, not a plaintext.",
  },
  {
    q: "Can the team see my positions?",
    a: "No. Encryption happens in your browser against a threshold key held collectively by the MPC cluster. There is no server-side plaintext and no operator backdoor. Even we cannot reconstruct your size.",
  },
  {
    q: "How do liquidations work if size is private?",
    a: "Liquidations stay permissionless. The protocol exposes only what a liquidator needs to act on an underwater position while keeping full size sealed. Solvency remains publicly verifiable.",
  },
  {
    q: "What chain and assets are supported?",
    a: "Confidential Perps runs on Solana. The launch market is SOL-PERP with USDC collateral. More markets follow once the core is proven on devnet and mainnet-beta.",
  },
  {
    q: "Is it live today?",
    a: "The full lifecycle — deposit, encrypted order, MPC match, on-chain settlement, close, and liquidate — runs now on Solana devnet. Launch the terminal to try it with devnet funds.",
  },
];

export function Faq() {
  const [open, setOpen] = useState(0);
  return (
    <div className="faq">
      {ITEMS.map((it, i) => (
        <div key={i} className={`faq-i${open === i ? " open" : ""}`}>
          <div className="faq-q" onClick={() => setOpen(open === i ? -1 : i)}>
            <span className="qn">Q{i + 1}</span>
            <span className="qt">{it.q}</span>
            <span className="pm">+</span>
          </div>
          <div className="faq-a">
            <div>{it.a}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
