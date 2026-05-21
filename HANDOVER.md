# Project Handover — Solana Confidential Perps

> **Paste this entire document at the top of your next Claude Code session, or open this file from the project root.**

---

## 🎯 TO THE NEW CLAUDE SESSION

You are joining a project that has completed planning and is ready to start Day 1 of implementation. Read this entire document carefully before responding.

After reading, respond with:
1. A 3-bullet summary of what we're building (verify you got it)
2. Confirmation that you understand the user's working style (per the "How to work with me" section)
3. **Ask which specific Day 1 task to start with** — do NOT begin implementation until the user instructs you

Do not regenerate the plan. Do not re-research what's already been decided. The decisions below are locked.

---

## Project name

**Confidential Perps on Solana** (working title — final name TBD)

## One-line pitch

The first confidential perpetual futures DEX on Solana — orders are encrypted client-side, matched in Arcium's MPC network, settled on-chain via Anchor. The dark-pool primitive Solana DeFi is missing.

## Why this exists

Solana's transparency is a feature for verification and a tax on trading. $400M+ extracted by sandwich bots in 16 months. Quant funds and prop firms stay on CEXes because their alpha leaks the moment they trade on transparent DEXes. Arcium just shipped Mainnet Alpha (Feb 2026), making Solana-native encrypted compute possible for the first time. The window to be the first credible confidential perp DEX is open right now.

This is for **Solana India Fellowship (SIF)** — 8 weeks, ~30 hrs/week, Demo Day at the end. Precedent: Encifher and Umbra (both Indian SIF alumni) broke out using Arcium for privacy DeFi.

---

## 🔒 Locked decisions (don't relitigate)

### Architecture
- **Option A** (public liquidations) — not B (encrypted liquidations)
- **Critical exception**: use Arcium threshold encryption for position commitments from day 1, NOT naive AES — this preserves the option to add B later as v2 without rewriting the protocol
- **One market**: SOL-PERP
- **One collateral**: USDC, hardcoded (no whitelist instruction — Drift-hack defensive)
- **Devnet only**

### Tech stack (all locked)
| Layer | Choice |
|---|---|
| Blockchain | Solana 1.18+ |
| Smart contract | Anchor (latest stable, ~0.30+) |
| MPC | Arcium Mainnet Alpha (devnet for build) |
| MPC DSL | Arcis |
| Language | Rust 1.75+ |
| Oracle | Pyth Pull |
| Frontend | Next.js 15 (App Router) |
| FE language | TypeScript 5+ |
| Data fetching | TanStack Query 5 |
| Styling | Tailwind + shadcn/ui |
| Wallet | @solana/wallet-adapter |
| Package manager | **pnpm** (never npm) |
| Node | 20+ |

### Hard rules (defensive design — Drift $285M hack lessons, April 2026)
- **NO `update_oracle_source` instruction** — Pyth feed locked at market init
- **NO `add_collateral_type` instruction** — USDC hardcoded
- **NO `update_admin` instruction** — admin field vestigial
- **Withdrawal rate limit**: per-block USDC out ≤ 5% of vault, enforced in code
- **NO durable nonce support on privileged instructions** — require recent blockhash check
- **No governance / Security Council** for MVP — code is immutable post-deploy

---

## Scope

### IN
- Encrypted batch-auction matching in Arcis (the moat)
- Encrypted position commitments (Arcium threshold encryption)
- Public liquidations via position reveal
- Time-priority keeper bot
- Pyth public oracle via Anchor
- Funding rate: simple cumulative (fixed coefficient)
- Next.js UI: order entry, position view, PnL, liquidation alerts
- Devnet deployment + working demo

### OUT (defer)
- Encrypted liquidations (Option B — v2)
- Multi-market / cross-margin
- Order types beyond limit
- Adaptive funding curves
- Mainnet
- Audits
- Governance / admin
- Multi-collateral

---

## Architecture (text diagram)

```
┌──────────────┐   1. encrypted order      ┌──────────────────┐
│  Next.js UI  │  ───────────────────────► │  Anchor Program  │
│  + SDK       │                            │  (on Solana)     │
│              │                            │                  │
│  - encrypts  │   2. position display      │  - vault         │
│    intent    │  ◄─────────────────────── │  - merkle root   │
│  - decrypts  │                            │  - funding       │
│    own pos   │                            │  - liquidation   │
└──────────────┘                            └────────┬─────────┘
                                                     │
                                                     │ 3. MXE request
                                                     ▼
                                            ┌──────────────────┐
                                            │  Arcium MXE      │
                                            │  (off-chain MPC) │
                                            │                  │
                                            │  - batch match   │
                                            │  - clearing price│
                                            │  - new commits   │
                                            └────────┬─────────┘
                                                     │
                                                     │ 4. result callback
                                                     ▼
                                            ┌──────────────────┐
                                            │  Anchor Program  │
                                            │  applies fills   │
                                            │  updates root    │
                                            └──────────────────┘

Pyth Oracle ─────────► Anchor (public reads)
                       Arcis (public input for matching reference)
```

## Repo structure (target)

```
confidential-perps/
├── programs/confidential-perps/   # Anchor program (Rust)
│   └── src/{instructions,state,errors.rs,constants.rs,lib.rs}
├── arcis/matching/                # Arcium MPC circuit
│   └── src/{lib.rs,types.rs,auction.rs}
├── sdk/                            # TypeScript SDK
├── app/                            # Next.js UI
├── keeper/                         # Liquidation bot
├── tests/{anchor,e2e}
├── scripts/
├── docs/{architecture.md,spec.md,PLAN.md}
└── README.md
```

---

## 🛠 Day 1 startup commands (literal)

```bash
# 1. Install Solana
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"
solana --version  # confirm 1.18+

# 2. Install Anchor via avm
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install latest
avm use latest

# 3. Install pnpm + Node 20
brew install pnpm node@20

# 4. Install Arcium CLI (verify exact name on Arcium docs)
pnpm add -g @arcium-hq/cli

# 5. Solana devnet config + airdrop
solana-keygen new -o ~/.config/solana/devnet.json
solana config set --url devnet --keypair ~/.config/solana/devnet.json
solana airdrop 5

# 6. Scaffold repo (you're already in ~/try/confidential-perps)
git init
anchor init programs --no-git
# Manually add arcis/, sdk/, app/, keeper/ per repo structure above

# 7. pnpm workspace
pnpm init
# create pnpm-workspace.yaml with: packages: ['sdk', 'app', 'keeper']
```

---

## 🔌 Skills + MCP servers to install BEFORE coding

Three skills, one MCP setup. Don't over-install.

| Install | Source | Why |
|---|---|---|
| **Solana Foundation Dev Skill** | https://github.com/solana-foundation/solana-dev-skill | Canonical Anchor + React patterns, Jan 2026 best practices |
| **Helius Claude Code Plugin** | https://www.helius.dev/docs/agents/claude-code-plugin | RPC + MCP + reference files bundled |
| **Safe Solana Builder** | https://github.com/Frankcastleauditor/safe-solana-builder | Drift-hack-defensive security review |
| **Solana Developer MCP** | https://mcp.solana.com | Real-time docs, account queries, CPI generation |

**Arcium gap**: no dedicated Claude skill exists for Arcium/Arcis. Lean on context7 MCP + Arcium official docs directly: https://docs.arcium.com/developers

---

## 📅 Week-by-week roadmap (compressed)

| Week | Focus | Exit criterion |
|---|---|---|
| 1 | Setup, learning, spec lock | Can explain end-to-end flow in one paragraph; programs deploying to devnet |
| 2 | Arcis matching v0 + Anchor scaffolding | 2-order batch matches in Arcis; deposit/withdraw works |
| 3 | End-to-end batch + commitments | Single batch end-to-end on devnet |
| 4 | Close + liquidate + funding | **Full lifecycle works — SAFETY NET ACHIEVED** |
| 5 | Client SDK | SDK drives full lifecycle from TS script |
| 6 | UI | Non-developer can use the UI |
| 7 | Keeper + integration | Devnet runs unattended; liquidations fire |
| 8 | Polish + demo + application | Demo video shipped, SIF submitted |

**Critical milestone: end of Week 4.** If everything fails after that, you still demo the lifecycle. Don't ship anything past Week 4 that breaks Week 4.

---

## ⚠️ Risk register

| Risk | Mitigation |
|---|---|
| Arcium devnet flaky | Local mock MXE for dev; only hit devnet for integration |
| Arcis circuit produces wrong fills | Property-based testing from simple cases up |
| Pyth feed quirks | Wrap reads in `PriceWithSanity` helper |
| Solo blocker for 1+ day | Pair with Claude aggressively; have a Solana Discord backup contact |
| Demo recording fails on demo day | Record 3 takes by end of Week 7, keep best |
| Scope creep | Honor the cut list (below). Hard "no new features" line at end of Week 6 |

---

## ✂️ Cut list (priority — drop top item first if behind by 1+ week at any check-in)

1. Multi-position per user → 1 position max per user
2. Funding rate → display "0%" / not yet implemented
3. Keeper bot automation → manual CLI liquidations in demo
4. Liquidation reveal flow → user-initiated close only, mention liquidation as designed
5. UI polish → terminal-style raw output, no shadcn
6. PnL display → just position size, no PnL calc
7. Funding crank → manual command

---

## 📚 Reading list (Week 1, in this order)

1. [Arcium developer docs](https://docs.arcium.com/developers) — 2-3 hours, read entirely
2. [BLINDBID example](https://github.com/arcium-hq) — Arcis patterns
3. [Crafts example](https://github.com/arcium-hq) — encrypted state management
4. [Drift protocol-v2](https://github.com/drift-labs/protocol-v2) — perp accounting, funding, liquidation math
5. [Phoenix v1](https://github.com/Ellipsis-Labs/phoenix-v1) — matching engine patterns
6. [Jump Crypto DFBA paper](https://jumpcrypto.com/writing/dual-flow-batch-auction/) — batch auction theory
7. [Pyth Pull oracle docs](https://docs.pyth.network/price-feeds/use-real-time-data/solana)
8. [Sealevel attacks](https://github.com/coral-xyz/sealevel-attacks) — defensive coding

---

## 🎬 Demo storyboard (4-minute video, Week 8)

| Time | Beat |
|---|---|
| 0:00-0:20 | Hook: "Solana DeFi loses $400M/year to public orderbooks" |
| 0:20-0:50 | Problem: orders public → strategies copied, MEV, institutional flow on CEXes |
| 0:50-1:30 | Solution: confidential perps. Animated diagram |
| 1:30-3:00 | Live demo: deposit → encrypted order → match → encrypted position → close at profit |
| 3:00-3:30 | Architecture deep-dive: 1 slide |
| 3:30-4:00 | Vision: dark-pool primitive, future B with encrypted liquidations |

Record 3 backup takes. Arcium devnet can flake.

---

## ✅ Definition of done (Week 8 ship gate)

- [ ] Devnet program deployed at stable address (no redeploys in final 48h)
- [ ] Full trade lifecycle demonstrated on devnet, recorded
- [ ] At least one liquidation demonstrated (manual or auto)
- [ ] UI renders on fresh wallet
- [ ] Demo video uploaded
- [ ] README + spec.md complete
- [ ] Pitch deck finalized
- [ ] SIF application submitted

---

## 🗣 How to work with me (user preferences — IMPORTANT)

These come from prior sessions. Internalize them.

- **Use pnpm, never npm**
- **No AI references** in commits or PRs (no "Co-Authored-By: Claude", no "Generated with Claude")
- **Fewer questions** — form opinions from the codebase and propose directly; don't ask 5 questions when 1 will do
- **Skip office-hours mode** — go straight to substance
- **Direct and opinionated** — give recommendations with tradeoffs, not just options
- **Tight responses** — sentences > paragraphs where possible
- **Be honest** about what's hard, what won't work, what's behind schedule
- **No fluff** — substantive only
- **Pair effectively**: Anchor + UI + SDK = Claude does 50-70% of the work. Arcis circuits + crypto design = user writes, Claude spot-checks.

---

## 🧠 Pitch (memorize, for when you talk about the project)

> "Solana captured retail trading. To capture institutional flow, it needs privacy. Every order on Drift or Jupiter is public — strategies leak, sandwich bots extract $400M, sophisticated capital stays on CEXes. We're building the first confidential perpetual futures DEX on Solana: orders encrypted client-side, matched in Arcium's MPC network, settled on-chain. The dark-pool primitive Solana DeFi is missing."

Tagline (for demo / one-pager): **"Trade with size on Solana. Without showing your hand."**

---

## ❓ Open questions / decisions deferred

These are explicitly NOT decided yet — flag them when relevant:

1. **Project name** (working title is "Confidential Perps")
2. **Batch window duration** (current best guess: 5 slots / ~2s) — finalize Week 1 based on Arcium MXE latency
3. **Max orders per batch** (current best guess: 32) — depends on Arcis circuit performance
4. **Minimum collateral** for opening a position — finalize Week 4
5. **Funding rate coefficient** — finalize Week 4
6. **Mainnet launch criteria** — out of scope for SIF, decide post-Demo Day
7. **Whether to publish a research paper alongside** — decide Week 7

---

## 🎤 SIF context (for narrative awareness)

- **Program**: 8 weeks, ~30 hrs/week, $2,500 stipend top 20 fellows, Demo Day at end
- **Bar**: "Technical heavy" = custom on-chain Anchor program + hard crypto/systems + shipped to devnet by Demo Day
- **What wins**: privacy/infra projects outperform consumer apps in Indian cohorts (Encifher, Umbra precedent)
- **What loses**: agent kit wrappers, "chat with chain" RAG apps, generic Yet-Another-DEX
- **Reviewers**: Yash Agarwal (SendAI), Kash Dhanda, ecosystem partners. Skew DeFi + infra. Recognize Arcium-based projects as fully Solana-native.

---

## 🚦 First instruction to new Claude

> "I've read the handover. I'm ready to start Day 1. Before I run any commands, I want you to: (1) confirm my installed skills/MCP servers are correct per the list above, (2) walk me through the Day 1 startup commands one at a time so I can verify each step works, (3) at the end of Day 1, help me write a 1-paragraph entry to a `JOURNAL.md` capturing what was done and any surprises. Let's start with step 1."

---

## 📎 Critical links (bookmark these)

| Resource | URL |
|---|---|
| Arcium docs | https://docs.arcium.com/developers |
| Arcium GitHub | https://github.com/arcium-hq |
| Drift v2 | https://github.com/drift-labs/protocol-v2 |
| Phoenix v1 | https://github.com/Ellipsis-Labs/phoenix-v1 |
| Pyth Pull docs | https://docs.pyth.network/price-feeds/use-real-time-data/solana |
| Solana Dev Skill | https://github.com/solana-foundation/solana-dev-skill |
| Helius plugin | https://www.helius.dev/docs/agents/claude-code-plugin |
| Safe Solana Builder | https://github.com/Frankcastleauditor/safe-solana-builder |
| Solana MCP | https://mcp.solana.com |
| Sealevel attacks | https://github.com/coral-xyz/sealevel-attacks |
| SIF program info | https://fellowship.superteamin.fun/ |
| DFBA paper | https://jumpcrypto.com/writing/dual-flow-batch-auction/ |

---

## 📌 The two most important things to remember

1. **Hit the Week 4 safety net.** Full position lifecycle working on devnet by end of Week 4. Everything after that is upside.
2. **Use Arcium threshold encryption for position commitments from commit #1.** This is the single design decision that preserves your ability to add encrypted liquidations later. Don't use AES.

---

**End of handover. Save this. Start Day 1.**
