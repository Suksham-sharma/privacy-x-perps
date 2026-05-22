# Project Journal

Daily log of what shipped, what surprised, and what's open. One entry per working day.

---

## Day 1 — 2026-05-24

Audited toolchain (Solana 2.2.21, Rust 1.88, pnpm 10.17, Node 24.4, Docker 27.3, Yarn 1.22 all already present; ~9.5 SOL on devnet), upgraded Anchor 0.31.1 → 1.0.2 via `avm`, installed Arcium CLI 0.10.3 (with `arx-node` + `trusted-dealer` Docker images), scaffolded the project via `arcium init confidential-perps --package-manager pnpm -t multiple` (into a temp dir, then rsynced into the git-init'd project root to preserve HANDOVER.md), and set up the pnpm workspace with stub `sdk/` and `keeper/` packages. The scaffold gave us a canonical `add_together` example covering the full Arcium pattern — `#[encrypted]` Arcis circuit, `#[arcium_program]` macro on the Anchor side, `init_*_comp_def` / `*_handler` / `*_callback_handler` triplet, the full account list (MXE / mempool / execpool / computation / comp_def / cluster / fee pool / clock PDAs), and `queue_computation` + `verify_output` flow — which is exactly the shape `match_batch` will take.

**Surprises:**
- Handover said Arcium installs as `pnpm add -g @arcium-hq/cli` — wrong. It's a Rust binary, official install is `curl -sSfL https://install.arcium.com/ | bash` (which provisions `arcup` + `arcium` + Docker images via `arcup install`).
- Arcium docs require **Anchor 1.0.2 specifically**, not the "~0.30+" the handover suggested. Bumping was forced, not optional.
- Arcium docs *also* list Solana 3.1.10 — but the installer accepted our 2.2.21 with `[OK]`, so no Solana upgrade needed (yet). Will flag if a later build/deploy complains.
- Arcium scaffold uses `encrypted-ixs/` (not `arcis/` as the handover called it) and `programs/confidential_perps/` (underscore — Cargo convention). Naming everywhere in configs uses underscores; documenting this so we don't get confused later.
- The `-t multiple` template flag emitted a misleading "Using single-file template" warning, but actually did produce the multi-file layout (`instructions/`, `state/`, `error.rs`, `constants.rs`). Cosmetic bug in arcium CLI.
- `arcium init` always creates a subdirectory; can't init in-place. Solved by scaffolding to `/tmp` then `rsync --exclude='.git'` into project root.

**Decisions locked:**
- Project dir: `confidential-perps` (hyphen); Rust crate / Anchor program name: `confidential_perps` (underscore). Both are correct, both stay.
- Branch: `main` (renamed from git's default `master`).
- Skipped the 4 "nice-to-have" Solana skills/MCPs (Solana Dev Skill, Helius plugin, Safe Solana Builder, Solana MCP) — context7 + Arcium docs + handover reading list cover real needs. Reconsider only if blocked.

**Open:**
- [x] `arcium build` smoke test — see Smoke test section below.
- [ ] `pnpm install` not run yet — defer until we add Next.js or actually need the lockfile.
- [ ] No initial commit yet — waiting for build smoke test to pass first, so commit reflects working state.
- [ ] `app/` is empty; Next.js scaffold deferred to Week 6 per roadmap.
- [ ] `rust-toolchain.toml` pins channel 1.89.0; we're on 1.88.0. rustup will fetch on demand — non-blocking.

**Smoke test (`arcium build`):** _passed cleanly after a multi-hop toolchain fix_

Took three iterations to reach a clean build with no workarounds:

1. **First run** — failed at `cargo build-sbf`: Solana CLI 2.2.21 ships platform-tools v1.48 (rust 1.84.1), but `solana-address@2.6.0` (transitive dep of `arcium-anchor 0.10.3`) demands rust 1.89.0.
2. **Solana upgrade** — `agave-install update` brought Solana CLI to 3.1.15, which ships platform-tools v1.52 (rust 1.89.0-dev). BPF build + Arcis circuit then compiled, but `anchor idl build` (run inside `arcium build` as a separate Cargo invocation) still failed with the same rust-1.88 error.
3. **Root cause** — `strings ~/.avm/bin/anchor-1.0.2 | grep RUSTUP` revealed Anchor 1.0.2 hardcodes `RUSTUP_TOOLCHAIN=stable` for its IDL build subprocess. Our `stable` channel was rust 1.88.0 (stale). `rustup install stable` brought it to 1.95.0, and `arcium build` now succeeds end-to-end with no env-var workarounds. Also freed ~2.5 GB by removing the now-unused v1.48 platform-tools cache.

Final artifacts (clean):
- `target/deploy/confidential_perps.so` — 396 KB BPF binary
- `target/deploy/confidential_perps-keypair.json` — program keypair
- `build/add_together.arcis` — 265 KB compiled Arcis circuit
- `target/idl/confidential_perps.json` — 25 KB Anchor IDL
- `target/types/confidential_perps.ts` — 25 KB TypeScript types for the SDK

**Net:** entire toolchain wired correctly. Devnet deploy and `arcium test` localnet not yet exercised — Day 2.

---

## Day 2 — 2026-05-24 (same day, continued)

Ran `pnpm install` (had to bump `@arcium-hq/client` 0.10.3 → 0.10.2 in all three package.jsons — the CLI is at 0.10.3 but the npm client lags one patch behind), started OrbStack for Docker, and ran `arcium test`. Full canonical `add_together` e2e passed in 18s: 2 arx-node containers + trusted-dealer spun up, MXE pubkey fetched, comp def initialized, encrypted inputs queued, MPC computed, callback fired, client decrypted result, assertion held. The entire confidential-compute pipeline is verified working before we touch a single line of our own code — Week 4 safety net is dramatically de-risked. Also drafted `docs/circuit-v0.md`: proposed Order/Batch/Fill structs, a uniform-price batch-auction match algorithm sketch in Arcis style, a table of what's encrypted vs public, and 7 open design questions for the human to settle before circuit work begins.

**Surprises:**
- `@arcium-hq/client@0.10.3` not on npm — only 0.10.2 published. CLI/client version skew.

**Open:**
- Resolve the 7 questions in `docs/circuit-v0.md` (clearing-price reveal, position-per-user, partial-fill rule, MAX_ORDERS, oracle band, nonce semantics, no-match outcome).
- Have not yet deployed to devnet (only localnet exercised).


