import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import {
  awaitComputationFinalization,
  getArciumAccountBaseSeed,
  getArciumEnv,
  getArciumProgram,
  getArciumProgramId,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getComputationAccAddress,
  getExecutingPoolAccAddress,
  getLookupTableAddress,
  getMempoolAccAddress,
  getMXEAccAddress,
  getMXEPublicKey,
  uploadCircuit,
} from "@arcium-hq/client";
import {
  deriveMarketPda,
  deriveBatchBufferPda,
  deriveUserCollateralPda,
  derivePositionPda,
  encryptOrder,
  toSubmitOrderArgs,
  decryptFill,
  type OrderPlaintext,
} from "@confidential-perps/sdk";
import { expect } from "chai";
import * as fs from "fs";
import { randomBytes } from "crypto";
import { ConfidentialPerps } from "../target/types/confidential_perps";

const USDC_DECIMALS = 6;
const ONE_USDC = 10n ** BigInt(USDC_DECIMALS);

async function getMxePubkeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  attempts = 60,
  delayMs = 500,
): Promise<Uint8Array> {
  for (let i = 0; i < attempts; i++) {
    try {
      const k = await getMXEPublicKey(provider, programId);
      if (k) return k;
    } catch {}
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("MXE pubkey unavailable after retries");
}

describe("perp engine e2e", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.ConfidentialPerps as Program<ConfidentialPerps>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const admin = (provider.wallet as anchor.Wallet).payer;

  // Arcium localnet handles for the e2e flow.
  const arciumProgram = getArciumProgram(provider);
  const arciumEnv = getArciumEnv();
  const clusterAccount = getClusterAccAddress(arciumEnv.arciumClusterOffset);

  // Event-listener helper. Mirrors the pattern in tests/confidential_perps.ts.
  type Event = anchor.IdlEvents<(typeof program)["idl"]>;
  const awaitEvent = async <E extends keyof Event>(
    eventName: E,
  ): Promise<Event[E]> => {
    let listenerId: number;
    const event = await new Promise<Event[E]>((res) => {
      listenerId = program.addEventListener(eventName, (e) => res(e));
    });
    await program.removeEventListener(listenerId);
    return event;
  };

  // SOL/USD Pyth feed id (32 bytes). Stable per asset across all Pyth
  // deployments. Must match SOL_USD_FEED_ID in programs/.../constants.rs.
  const SOL_USD_FEED_ID_HEX =
    "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
  const solUsdFeedId = Array.from(Buffer.from(SOL_USD_FEED_ID_HEX, "hex"));

  // Sponsored SOL/USD PriceUpdateV2 account, cloned from devnet by
  // Anchor.toml's [[test.validator.clone]] at validator startup. Same
  // address on devnet + mainnet.
  const pythPriceUpdate = new PublicKey(
    "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
  );

  const [marketPda] = deriveMarketPda(program.programId);
  const [batchBufferPda] = deriveBatchBufferPda(marketPda, program.programId);

  let usdcMint: PublicKey;
  let vaultAta: PublicKey;
  let mxePublicKey: Uint8Array;

  before(async () => {
    usdcMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      USDC_DECIMALS,
    );
    vaultAta = await getAssociatedTokenAddress(usdcMint, marketPda, true);
    mxePublicKey = await getMxePubkeyWithRetry(provider, program.programId);
  });

  describe("init", () => {
    it("initializes the market and batch buffer", async () => {
      await program.methods
        .initMarket(solUsdFeedId)
        .accounts({
          admin: admin.publicKey,
          market: marketPda,
          batchBuffer: batchBufferPda,
          usdcMint,
          usdcVault: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc({ skipPreflight: true, commitment: "confirmed" });

      const market = await program.account.market.fetch(marketPda);
      expect(Buffer.from(market.pythFeedId)).to.deep.equal(
        Buffer.from(SOL_USD_FEED_ID_HEX, "hex"),
      );
      expect(market.usdcMint.toBase58()).to.equal(usdcMint.toBase58());
      expect(market.usdcVault.toBase58()).to.equal(vaultAta.toBase58());
      expect(market.batchWindowSlots.toNumber()).to.equal(5);

      const buffer = await program.account.batchBuffer.fetch(batchBufferPda);
      expect(buffer.nOrders).to.equal(0);
      expect(buffer.isProcessing).to.equal(false);
    });

    it("initializes the match_batch comp def and uploads the compiled circuit", async () => {
      // Same pattern as initAddTogetherCompDef in tests/confidential_perps.ts.
      const baseSeed = getArciumAccountBaseSeed("ComputationDefinitionAccount");
      const offset = getCompDefAccOffset("match_batch");
      const compDefPda = PublicKey.findProgramAddressSync(
        [baseSeed, program.programId.toBuffer(), offset],
        getArciumProgramId(),
      )[0];

      const mxeAccount = getMXEAccAddress(program.programId);
      const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
      const lutAddress = getLookupTableAddress(
        program.programId,
        mxeAcc.lutOffsetSlot,
      );

      await program.methods
        .initMatchBatchCompDef()
        .accounts({
          payer: admin.publicKey,
          mxeAccount,
          compDefAccount: compDefPda,
          addressLookupTable: lutAddress,
        })
        .signers([admin])
        .rpc({ skipPreflight: true, commitment: "confirmed" });

      const rawCircuit = fs.readFileSync("build/match_batch.arcis");
      await uploadCircuit(
        provider,
        "match_batch",
        program.programId,
        rawCircuit,
        true,
        500,
        {
          skipPreflight: true,
          preflightCommitment: "confirmed",
          commitment: "confirmed",
        },
      );
    });
  });

  describe("submit_order edge cases", () => {
    // Per-order margin lock. The full happy-path SDK-encrypted submit flow
    // is exercised inside the e2e block below (which also drives the
    // callback). This block keeps the negative + SDK round-trip cases.
    const PER_ORDER_MARGIN = new anchor.BN(Number(50n * ONE_USDC));

    it("rejects an order whose max_margin exceeds the user's collateral", async () => {
      const poor = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(poor.publicKey, 1e9);
      await provider.connection.confirmTransaction(sig, "confirmed");

      // Fund + deposit a tiny balance (10 USDC), then try to submit with
      // max_margin = 50 USDC. Must fail BEFORE the buffer is touched.
      const ata = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        usdcMint,
        poor.publicKey,
      );
      await mintTo(
        provider.connection,
        admin,
        usdcMint,
        ata.address,
        admin,
        Number(10n * ONE_USDC),
      );
      const [poorCollateralPda] = deriveUserCollateralPda(
        marketPda,
        poor.publicKey,
        program.programId,
      );
      await program.methods
        .deposit(new anchor.BN(Number(10n * ONE_USDC)))
        .accounts({
          user: poor.publicKey,
          market: marketPda,
          userCollateral: poorCollateralPda,
          usdcVault: vaultAta,
          userTokenAccount: ata.address,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([poor])
        .rpc({ skipPreflight: true, commitment: "confirmed" });

      const nOrdersBefore = (
        await program.account.batchBuffer.fetch(batchBufferPda)
      ).nOrders;
      const balanceBefore = (
        await program.account.userCollateral.fetch(poorCollateralPda)
      ).balance.toString();

      const plaintext: OrderPlaintext = { side: 0n, price: 100_000n, size: 1n, clientNonce: 99n };
      const e = encryptOrder(plaintext, mxePublicKey);
      const a = toSubmitOrderArgs(e);
      const [positionPda] = derivePositionPda(
        marketPda,
        poor.publicKey,
        program.programId,
      );

      let failed = false;
      try {
        await program.methods
          .submitOrder(
            a.x25519Pubkey,
            a.nonce,
            PER_ORDER_MARGIN, // 50 USDC > deposited 10 USDC
            a.ctSide,
            a.ctPrice,
            a.ctSize,
            a.ctClientNonce,
          )
          .accounts({
            user: poor.publicKey,
            market: marketPda,
            batchBuffer: batchBufferPda,
            userCollateral: poorCollateralPda,
            position: positionPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([poor])
          .rpc({ commitment: "confirmed" });
      } catch (err: any) {
        failed = true;
        const msg = String(err?.message ?? err);
        expect(msg).to.match(/InsufficientCollateral|0x[0-9a-f]+/i);
      }
      expect(failed).to.equal(true);

      // Buffer untouched, balance untouched — full atomic rollback.
      const nOrdersAfter = (
        await program.account.batchBuffer.fetch(batchBufferPda)
      ).nOrders;
      const balanceAfter = (
        await program.account.userCollateral.fetch(poorCollateralPda)
      ).balance.toString();
      expect(nOrdersAfter).to.equal(nOrdersBefore);
      expect(balanceAfter).to.equal(balanceBefore);
    });

    it("round-trips the first field through encrypt then decryptFill", async () => {
      // decryptFill is the one-ciphertext path (what match_batch_callback will
      // hand each owner: a re-encrypted fill at cipher offset 0). Encrypt
      // -> decrypt only the first field, which lives at offset 0.
      const plaintext: OrderPlaintext = {
        side: 1n,
        price: 12_345n,
        size: 678n,
        clientNonce: 42n,
      };
      const e = encryptOrder(plaintext, mxePublicKey);

      const decryptedSide = decryptFill(
        e.ctSide,
        e.nonce,
        e.privateKey,
        mxePublicKey,
      );
      expect(decryptedSide).to.equal(plaintext.side);
    });
  });

  describe("process_batch + callback (full lifecycle)", () => {
    // The e2e test. Two users deposit, submit crossing orders, the batch
    // window closes, anyone calls process_batch, MPC runs, callback applies
    // fills to both Positions and resets the buffer.
    const PER_ORDER_MARGIN = new anchor.BN(Number(50n * ONE_USDC));
    const DEPOSIT_AMOUNT = new anchor.BN(Number(200n * ONE_USDC));

    it("crosses 2 orders -> callback applies fills to both Positions", async () => {
      const alice = Keypair.generate();
      const bob = Keypair.generate();

      // Fund SOL + USDC + deposit collateral for both.
      const setups: Array<{
        kp: Keypair;
        collateral: PublicKey;
        position: PublicKey;
      }> = [];
      for (const u of [alice, bob]) {
        const sig = await provider.connection.requestAirdrop(u.publicKey, 2e9);
        await provider.connection.confirmTransaction(sig, "confirmed");

        const ata = await getOrCreateAssociatedTokenAccount(
          provider.connection,
          admin,
          usdcMint,
          u.publicKey,
        );
        await mintTo(
          provider.connection,
          admin,
          usdcMint,
          ata.address,
          admin,
          Number(200n * ONE_USDC),
        );
        const [collateral] = deriveUserCollateralPda(
          marketPda,
          u.publicKey,
          program.programId,
        );
        const [position] = derivePositionPda(
          marketPda,
          u.publicKey,
          program.programId,
        );
        await program.methods
          .deposit(DEPOSIT_AMOUNT)
          .accounts({
            user: u.publicKey,
            market: marketPda,
            userCollateral: collateral,
            usdcVault: vaultAta,
            userTokenAccount: ata.address,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([u])
          .rpc({ skipPreflight: true, commitment: "confirmed" });
        setups.push({ kp: u, collateral, position });
      }

      // Crossing orders at the same price -> match at the midpoint (also
      // 100_000) -> fill_size = min(1000, 1000) = 1000. Oracle band ±5%
      // is satisfied for oracle = 100_000.
      const orderA: OrderPlaintext = {
        side: 0n,
        price: 100_000n,
        size: 1_000n,
        clientNonce: 11n,
      };
      const orderB: OrderPlaintext = {
        side: 1n,
        price: 100_000n,
        size: 1_000n,
        clientNonce: 22n,
      };
      const encA = encryptOrder(orderA, mxePublicKey);
      const encB = encryptOrder(orderB, mxePublicKey);
      const argsA = toSubmitOrderArgs(encA);
      const argsB = toSubmitOrderArgs(encB);

      for (const [args, s] of [
        [argsA, setups[0]],
        [argsB, setups[1]],
      ] as const) {
        await program.methods
          .submitOrder(
            args.x25519Pubkey,
            args.nonce,
            PER_ORDER_MARGIN,
            args.ctSide,
            args.ctPrice,
            args.ctSize,
            args.ctClientNonce,
          )
          .accounts({
            user: s.kp.publicKey,
            market: marketPda,
            batchBuffer: batchBufferPda,
            userCollateral: s.collateral,
            position: s.position,
            systemProgram: SystemProgram.programId,
          })
          .signers([s.kp])
          .rpc({ skipPreflight: true, commitment: "confirmed" });
      }

      // Wait for the batch window (5 slots @ 400ms ≈ 2s) to close.
      await new Promise((r) => setTimeout(r, 3_000));

      // Queue match_batch via process_batch. accountsPartial so we only
      // pin the Arcium-side accounts; Anchor infers the rest.
      const computationOffset = new anchor.BN(randomBytes(8), "hex");
      const compDefOffset = Buffer.from(
        getCompDefAccOffset("match_batch"),
      ).readUInt32LE();

      const settledPromise = awaitEvent("batchSettledEvent");

      await program.methods
        .processBatch(computationOffset)
        .accountsPartial({
          payer: admin.publicKey,
          mxeAccount: getMXEAccAddress(program.programId),
          mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
          executingPool: getExecutingPoolAccAddress(
            arciumEnv.arciumClusterOffset,
          ),
          computationAccount: getComputationAccAddress(
            arciumEnv.arciumClusterOffset,
            computationOffset,
          ),
          compDefAccount: getCompDefAccAddress(
            program.programId,
            compDefOffset,
          ),
          clusterAccount,
          market: marketPda,
          batchBuffer: batchBufferPda,
          priceUpdate: pythPriceUpdate,
        })
        .signers([admin])
        .rpc({ skipPreflight: true, commitment: "confirmed" });

      // Wait for MPC + callback to finalize.
      await awaitComputationFinalization(
        provider,
        computationOffset,
        program.programId,
        "confirmed",
      );

      const settled = await settledPromise;
      // Clearing price comes from the synthetic Pyth fixture (price=100_000).
      // Orders cross at midpoint 100_000; oracle band ±5% of 100_000 passes.
      expect(settled.clearingPrice.toString()).to.equal("100000");
      expect(settled.totalVolume.toString()).to.equal("1000");
      expect(settled.ownerA.toBase58()).to.equal(alice.publicKey.toBase58());
      expect(settled.ownerB.toBase58()).to.equal(bob.publicKey.toBase58());

      // Positions: alice long 1000 lots @ 100k -> base +1000, quote -1000*100k.
      //            bob short 1000 lots @ 100k  -> base -1000, quote +1000*100k.
      const alicePos = await program.account.position.fetch(setups[0].position);
      expect(alicePos.owner.toBase58()).to.equal(alice.publicKey.toBase58());
      expect(alicePos.baseAmountLots.toString()).to.equal("1000");
      expect(alicePos.quoteEntry.toString()).to.equal("-100000000");

      const bobPos = await program.account.position.fetch(setups[1].position);
      expect(bobPos.owner.toBase58()).to.equal(bob.publicKey.toBase58());
      expect(bobPos.baseAmountLots.toString()).to.equal("-1000");
      expect(bobPos.quoteEntry.toString()).to.equal("100000000");

      // Buffer reset; batch_id bumped; is_processing cleared.
      const buffer = await program.account.batchBuffer.fetch(batchBufferPda);
      expect(buffer.nOrders).to.equal(0);
      expect(buffer.isProcessing).to.equal(false);
      expect(buffer.batchId.toString()).to.equal("1");

      // Margin stays locked on match (no partial-fill refund in v0) and
      // is mirrored onto the Position so close_position knows what to
      // release.
      expect(alicePos.marginLocked.toString()).to.equal(
        (50n * ONE_USDC).toString(),
      );
      expect(bobPos.marginLocked.toString()).to.equal(
        (50n * ONE_USDC).toString(),
      );

      const aliceUcAfterMatch = await program.account.userCollateral.fetch(
        setups[0].collateral,
      );
      expect(aliceUcAfterMatch.balance.toString()).to.equal(
        (200n * ONE_USDC - 50n * ONE_USDC).toString(),
      );
      const bobUcAfterMatch = await program.account.userCollateral.fetch(
        setups[1].collateral,
      );
      expect(bobUcAfterMatch.balance.toString()).to.equal(
        (200n * ONE_USDC - 50n * ONE_USDC).toString(),
      );

      // ----- Pyth gate negative path: garbage price_update is rejected -----
      // alice's position is open; closePosition with a random pubkey as
      // priceUpdate must fail at the owner check in read_pyth_price. This
      // is the only test in the suite that exercises a Pyth rejection
      // path (the happy paths cover the other 6 sub-checks implicitly).
      const garbagePriceUpdate = Keypair.generate().publicKey;
      let pythRejected = false;
      try {
        await program.methods
          .closePosition()
          .accounts({
            user: alice.publicKey,
            market: marketPda,
            position: setups[0].position,
            userCollateral: setups[0].collateral,
            priceUpdate: garbagePriceUpdate,
          })
          .signers([alice])
          .rpc({ commitment: "confirmed" });
      } catch (err: any) {
        pythRejected = true;
        const msg = String(err?.message ?? err);
        // InvalidPythAccount when owner check fails OR account-not-found
        // (a random pubkey points to a non-existent account); both are
        // valid Pyth-gate rejections.
        expect(msg).to.match(/InvalidPythAccount|AccountNotFound|AccountOwnedByWrongProgram|0x[0-9a-f]+/i);
      }
      expect(pythRejected).to.equal(true);

      // Position untouched after the rejection.
      const alicePosStillOpen = await program.account.position.fetch(setups[0].position);
      expect(alicePosStillOpen.baseAmountLots.toString()).to.equal("1000");

      // ----- close both positions at the fixture price (flat, PnL=0) -----
      // With a single synthetic Pyth fixture we can't test +10% close PnL
      // on localnet — the price is fixed at 100_000 = entry. So this just
      // exercises the close path: position zeroed, margin returned in
      // full, no PnL. The +10% case is verified manually on devnet and is
      // covered by the math in close_position_handler regardless.
      // alice (long 1000 @ 100k) exit 100k:
      //   pnl = 1000 * 100_000 + (-100_000_000) = 0
      //   credit = 50_000_000 + 0 = 50_000_000
      //   balance: 150 -> 200 USDC (back to pre-match)

      const aliceClosedPromise = awaitEvent("positionClosedEvent");
      await program.methods
        .closePosition()
        .accounts({
          user: alice.publicKey,
          market: marketPda,
          position: setups[0].position,
          userCollateral: setups[0].collateral,
          priceUpdate: pythPriceUpdate,
        })
        .signers([alice])
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      const aliceClosed = await aliceClosedPromise;
      expect(aliceClosed.owner.toBase58()).to.equal(alice.publicKey.toBase58());
      expect(aliceClosed.realizedPnl.toString()).to.equal("0");
      expect(aliceClosed.credit.toString()).to.equal("50000000");

      const bobClosedPromise = awaitEvent("positionClosedEvent");
      await program.methods
        .closePosition()
        .accounts({
          user: bob.publicKey,
          market: marketPda,
          position: setups[1].position,
          userCollateral: setups[1].collateral,
          priceUpdate: pythPriceUpdate,
        })
        .signers([bob])
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      const bobClosed = await bobClosedPromise;
      expect(bobClosed.realizedPnl.toString()).to.equal("0");
      expect(bobClosed.credit.toString()).to.equal("50000000");

      const aliceFinalUc = await program.account.userCollateral.fetch(
        setups[0].collateral,
      );
      expect(aliceFinalUc.balance.toString()).to.equal(
        (200n * ONE_USDC).toString(),
      );
      const bobFinalUc = await program.account.userCollateral.fetch(
        setups[1].collateral,
      );
      expect(bobFinalUc.balance.toString()).to.equal(
        (200n * ONE_USDC).toString(),
      );

      // Positions zeroed (account stays, fields cleared).
      const alicePosClosed = await program.account.position.fetch(setups[0].position);
      expect(alicePosClosed.baseAmountLots.toString()).to.equal("0");
      expect(alicePosClosed.quoteEntry.toString()).to.equal("0");
      expect(alicePosClosed.marginLocked.toString()).to.equal("0");
      const bobPosClosed = await program.account.position.fetch(setups[1].position);
      expect(bobPosClosed.baseAmountLots.toString()).to.equal("0");
      expect(bobPosClosed.quoteEntry.toString()).to.equal("0");
      expect(bobPosClosed.marginLocked.toString()).to.equal("0");
    });

    it("liquidate gates: rejects healthy position + self-liquidation", async () => {
      // v0 localnet limitation: with a single synthetic Pyth fixture at
      // price 100_000 we can't drive a position underwater (entry = exit
      // = 100_000 -> credit = margin -> healthy). So we exercise the
      // gating logic only: healthy-position rejection + self-liq rejection.
      // The positive-liquidation case (credit < maintenance) is covered by
      // the math in liquidate_position_handler and verified on devnet.
      const carol = Keypair.generate();
      const dave = Keypair.generate();

      const setups: Array<{
        kp: Keypair;
        collateral: PublicKey;
        position: PublicKey;
      }> = [];
      for (const u of [carol, dave]) {
        const sig = await provider.connection.requestAirdrop(u.publicKey, 2e9);
        await provider.connection.confirmTransaction(sig, "confirmed");
        const ata = await getOrCreateAssociatedTokenAccount(
          provider.connection,
          admin,
          usdcMint,
          u.publicKey,
        );
        await mintTo(
          provider.connection,
          admin,
          usdcMint,
          ata.address,
          admin,
          Number(200n * ONE_USDC),
        );
        const [collateral] = deriveUserCollateralPda(
          marketPda,
          u.publicKey,
          program.programId,
        );
        const [position] = derivePositionPda(
          marketPda,
          u.publicKey,
          program.programId,
        );
        await program.methods
          .deposit(DEPOSIT_AMOUNT)
          .accounts({
            user: u.publicKey,
            market: marketPda,
            userCollateral: collateral,
            usdcVault: vaultAta,
            userTokenAccount: ata.address,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([u])
          .rpc({ skipPreflight: true, commitment: "confirmed" });
        setups.push({ kp: u, collateral, position });
      }

      const carolOrder: OrderPlaintext = {
        side: 0n,
        price: 100_000n,
        size: 1_000n,
        clientNonce: 33n,
      };
      const daveOrder: OrderPlaintext = {
        side: 1n,
        price: 100_000n,
        size: 1_000n,
        clientNonce: 44n,
      };
      const argsC = toSubmitOrderArgs(encryptOrder(carolOrder, mxePublicKey));
      const argsD = toSubmitOrderArgs(encryptOrder(daveOrder, mxePublicKey));

      for (const [args, s] of [
        [argsC, setups[0]],
        [argsD, setups[1]],
      ] as const) {
        await program.methods
          .submitOrder(
            args.x25519Pubkey,
            args.nonce,
            PER_ORDER_MARGIN,
            args.ctSide,
            args.ctPrice,
            args.ctSize,
            args.ctClientNonce,
          )
          .accounts({
            user: s.kp.publicKey,
            market: marketPda,
            batchBuffer: batchBufferPda,
            userCollateral: s.collateral,
            position: s.position,
            systemProgram: SystemProgram.programId,
          })
          .signers([s.kp])
          .rpc({ skipPreflight: true, commitment: "confirmed" });
      }

      await new Promise((r) => setTimeout(r, 3_000));

      const computationOffset = new anchor.BN(randomBytes(8), "hex");
      const compDefOffset = Buffer.from(
        getCompDefAccOffset("match_batch"),
      ).readUInt32LE();
      await program.methods
        .processBatch(computationOffset)
        .accountsPartial({
          payer: admin.publicKey,
          mxeAccount: getMXEAccAddress(program.programId),
          mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
          executingPool: getExecutingPoolAccAddress(
            arciumEnv.arciumClusterOffset,
          ),
          computationAccount: getComputationAccAddress(
            arciumEnv.arciumClusterOffset,
            computationOffset,
          ),
          compDefAccount: getCompDefAccAddress(
            program.programId,
            compDefOffset,
          ),
          clusterAccount,
          market: marketPda,
          batchBuffer: batchBufferPda,
          priceUpdate: pythPriceUpdate,
        })
        .signers([admin])
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      await awaitComputationFinalization(
        provider,
        computationOffset,
        program.programId,
        "confirmed",
      );

      // Carol's position is now set; verify before any liquidation attempts.
      const carolPosBefore = await program.account.position.fetch(setups[0].position);
      expect(carolPosBefore.baseAmountLots.toString()).to.equal("1000");
      expect(carolPosBefore.marginLocked.toString()).to.equal(
        (50n * ONE_USDC).toString(),
      );

      // ----- 1. healthy gate: position is flat (entry=exit=fixture price) -----
      // credit = margin + 0 PnL = 50m; maintenance = 25m; 50m !< 25m -> reject.
      let healthyRejected = false;
      try {
        await program.methods
          .liquidatePosition()
          .accounts({
            liquidator: admin.publicKey,
            market: marketPda,
            position: setups[0].position,
            userCollateral: setups[0].collateral,
            priceUpdate: pythPriceUpdate,
          })
          .signers([admin])
          .rpc({ commitment: "confirmed" });
      } catch (err: any) {
        healthyRejected = true;
        const msg = String(err?.message ?? err);
        expect(msg).to.match(/PositionNotLiquidatable|0x[0-9a-f]+/i);
      }
      expect(healthyRejected).to.equal(true);

      // ----- 2. self-liq gate: carol tries to liquidate herself -----
      let selfRejected = false;
      try {
        await program.methods
          .liquidatePosition()
          .accounts({
            liquidator: carol.publicKey,
            market: marketPda,
            position: setups[0].position,
            userCollateral: setups[0].collateral,
            priceUpdate: pythPriceUpdate,
          })
          .signers([carol])
          .rpc({ commitment: "confirmed" });
      } catch (err: any) {
        selfRejected = true;
        const msg = String(err?.message ?? err);
        expect(msg).to.match(/SelfLiquidationNotAllowed|0x[0-9a-f]+/i);
      }
      expect(selfRejected).to.equal(true);

      // Position untouched after both failures.
      const carolPosAfter = await program.account.position.fetch(setups[0].position);
      expect(carolPosAfter.baseAmountLots.toString()).to.equal("1000");
      expect(carolPosAfter.marginLocked.toString()).to.equal(
        (50n * ONE_USDC).toString(),
      );
    });

    it("rejects close_position when there is no open position", async () => {
      // Fresh user with collateral but no position — close should fail
      // with NoOpenPosition.
      const stranger = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(stranger.publicKey, 1e9);
      await provider.connection.confirmTransaction(sig, "confirmed");

      const ata = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        usdcMint,
        stranger.publicKey,
      );
      await mintTo(
        provider.connection,
        admin,
        usdcMint,
        ata.address,
        admin,
        Number(50n * ONE_USDC),
      );
      const [collateral] = deriveUserCollateralPda(
        marketPda,
        stranger.publicKey,
        program.programId,
      );
      await program.methods
        .deposit(new anchor.BN(Number(50n * ONE_USDC)))
        .accounts({
          user: stranger.publicKey,
          market: marketPda,
          userCollateral: collateral,
          usdcVault: vaultAta,
          userTokenAccount: ata.address,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([stranger])
        .rpc({ skipPreflight: true, commitment: "confirmed" });

      // No Position PDA exists for stranger. The seeds constraint will fail
      // at account validation; surfaces as a generic account error, not
      // NoOpenPosition. That's fine — point is the close is rejected.
      const [position] = derivePositionPda(
        marketPda,
        stranger.publicKey,
        program.programId,
      );

      let failed = false;
      try {
        await program.methods
          .closePosition()
          .accounts({
            user: stranger.publicKey,
            market: marketPda,
            position,
            userCollateral: collateral,
            priceUpdate: pythPriceUpdate,
          })
          .signers([stranger])
          .rpc({ commitment: "confirmed" });
      } catch (err: any) {
        failed = true;
      }
      expect(failed).to.equal(true);
    });
  });

  describe("collateral", () => {
    const alice = Keypair.generate();
    let aliceAta: PublicKey;
    let aliceCollateralPda: PublicKey;

    before(async () => {
      const sig = await provider.connection.requestAirdrop(alice.publicKey, 2e9);
      await provider.connection.confirmTransaction(sig, "confirmed");

      const ata = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        usdcMint,
        alice.publicKey,
      );
      aliceAta = ata.address;

      await mintTo(
        provider.connection,
        admin,
        usdcMint,
        aliceAta,
        admin,
        Number(1000n * ONE_USDC),
      );

      [aliceCollateralPda] = deriveUserCollateralPda(
        marketPda,
        alice.publicKey,
        program.programId,
      );
    });

    it("deposits 500 USDC and credits UserCollateral", async () => {
      const amount = new anchor.BN(Number(500n * ONE_USDC));

      // Vault may already hold prior deposits from earlier tests
      // (submit_order users had to fund themselves). Assert the delta, not
      // the absolute vault balance.
      const vaultBefore = (await getAccount(provider.connection, vaultAta)).amount;

      await program.methods
        .deposit(amount)
        .accounts({
          user: alice.publicKey,
          market: marketPda,
          userCollateral: aliceCollateralPda,
          usdcVault: vaultAta,
          userTokenAccount: aliceAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc({ skipPreflight: true, commitment: "confirmed" });

      const uc = await program.account.userCollateral.fetch(aliceCollateralPda);
      expect(uc.owner.toBase58()).to.equal(alice.publicKey.toBase58());
      expect(uc.balance.toString()).to.equal((500n * ONE_USDC).toString());

      const vaultAfter = (await getAccount(provider.connection, vaultAta)).amount;
      expect((vaultAfter - vaultBefore).toString()).to.equal(
        (500n * ONE_USDC).toString(),
      );
    });

    it("withdraws an amount within the per-slot rate limit", async () => {
      const amount = new anchor.BN(Number(10n * ONE_USDC));

      await program.methods
        .withdraw(amount)
        .accounts({
          user: alice.publicKey,
          market: marketPda,
          userCollateral: aliceCollateralPda,
          usdcVault: vaultAta,
          userTokenAccount: aliceAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([alice])
        .rpc({ skipPreflight: true, commitment: "confirmed" });

      const uc = await program.account.userCollateral.fetch(aliceCollateralPda);
      expect(uc.balance.toString()).to.equal((490n * ONE_USDC).toString());
    });

    it("rejects a withdraw that breaches the 5% per-slot cap", async () => {
      const amount = new anchor.BN(Number(100n * ONE_USDC));

      const balanceBefore = (
        await program.account.userCollateral.fetch(aliceCollateralPda)
      ).balance.toString();

      let failed = false;
      try {
        await program.methods
          .withdraw(amount)
          .accounts({
            user: alice.publicKey,
            market: marketPda,
            userCollateral: aliceCollateralPda,
            usdcVault: vaultAta,
            userTokenAccount: aliceAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([alice])
          .rpc({ commitment: "confirmed" });
      } catch (e: any) {
        failed = true;
        const msg = String(e?.message ?? e);
        expect(msg).to.match(/WithdrawRateLimitExceeded|rate limit|0x[0-9a-f]+/i);
      }
      expect(failed).to.equal(true);

      const balanceAfter = (
        await program.account.userCollateral.fetch(aliceCollateralPda)
      ).balance.toString();
      expect(balanceAfter).to.equal(balanceBefore);
    });
  });
});
