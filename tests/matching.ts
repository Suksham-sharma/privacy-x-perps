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
import { getMXEPublicKey } from "@arcium-hq/client";
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

  const pythFeed = Keypair.generate().publicKey;

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
        .initMarket()
        .accounts({
          admin: admin.publicKey,
          market: marketPda,
          batchBuffer: batchBufferPda,
          pythFeed,
          usdcMint,
          usdcVault: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc({ skipPreflight: true, commitment: "confirmed" });

      const market = await program.account.market.fetch(marketPda);
      expect(market.pythFeed.toBase58()).to.equal(pythFeed.toBase58());
      expect(market.usdcMint.toBase58()).to.equal(usdcMint.toBase58());
      expect(market.usdcVault.toBase58()).to.equal(vaultAta.toBase58());
      expect(market.batchWindowSlots.toNumber()).to.equal(5);

      const buffer = await program.account.batchBuffer.fetch(batchBufferPda);
      expect(buffer.nOrders).to.equal(0);
    });
  });

  describe("submit_order with real SDK encryption", () => {
    // Per-order margin lock. With ONE_USDC = 10^6 USDC base units, 50 USDC
    // is well under what any user deposits below — every order is funded.
    const PER_ORDER_MARGIN = new anchor.BN(Number(50n * ONE_USDC));

    it("encrypts 3 orders via the SDK and stores their ciphertexts on-chain", async () => {
      const users = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
      for (const u of users) {
        const sig = await provider.connection.requestAirdrop(u.publicKey, 1e9);
        await provider.connection.confirmTransaction(sig, "confirmed");
      }

      // Fund each user's UserCollateral so submit_order's margin lock has
      // something to debit. Mint USDC -> ATA -> deposit -> PDA.
      const collateralPdas: PublicKey[] = [];
      for (const u of users) {
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
        const [collateralPda] = deriveUserCollateralPda(
          marketPda,
          u.publicKey,
          program.programId,
        );
        collateralPdas.push(collateralPda);
        await program.methods
          .deposit(new anchor.BN(Number(200n * ONE_USDC)))
          .accounts({
            user: u.publicKey,
            market: marketPda,
            userCollateral: collateralPda,
            usdcVault: vaultAta,
            userTokenAccount: ata.address,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([u])
          .rpc({ skipPreflight: true, commitment: "confirmed" });
      }

      // Three distinct plaintext orders. SDK does the encryption.
      const plaintexts: OrderPlaintext[] = [
        { side: 0n, price: 100_000n, size: 1_000n, clientNonce: 1n },  // long
        { side: 1n, price: 101_000n, size: 2_000n, clientNonce: 2n },  // short
        { side: 0n, price: 99_500n,  size: 500n,   clientNonce: 3n },  // long
      ];
      const encrypted = plaintexts.map((p) => encryptOrder(p, mxePublicKey));
      const argsList = encrypted.map(toSubmitOrderArgs);

      for (let i = 0; i < users.length; i++) {
        const a = argsList[i];
        const [positionPda] = derivePositionPda(
          marketPda,
          users[i].publicKey,
          program.programId,
        );
        await program.methods
          .submitOrder(
            a.x25519Pubkey,
            a.nonce,
            PER_ORDER_MARGIN,
            a.ctSide,
            a.ctPrice,
            a.ctSize,
            a.ctClientNonce,
          )
          .accounts({
            user: users[i].publicKey,
            market: marketPda,
            batchBuffer: batchBufferPda,
            userCollateral: collateralPdas[i],
            position: positionPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([users[i]])
          .rpc({ skipPreflight: true, commitment: "confirmed" });
      }

      const buffer = await program.account.batchBuffer.fetch(batchBufferPda);
      expect(buffer.nOrders).to.equal(3);

      // The on-chain ciphertexts must match what the SDK produced.
      // Each slot also records the public max_margin that was locked.
      for (let i = 0; i < 3; i++) {
        expect(buffer.orders[i].owner.toBase58()).to.equal(
          users[i].publicKey.toBase58(),
        );
        expect(Buffer.from(buffer.orders[i].ctPrice)).to.deep.equal(
          Buffer.from(encrypted[i].ctPrice),
        );
        expect(buffer.orders[i].maxMargin.toString()).to.equal(
          PER_ORDER_MARGIN.toString(),
        );
      }

      // UserCollateral balance was debited by exactly the margin per order.
      for (let i = 0; i < users.length; i++) {
        const uc = await program.account.userCollateral.fetch(collateralPdas[i]);
        expect(uc.balance.toString()).to.equal(
          (200n * ONE_USDC - 50n * ONE_USDC).toString(),
        );
      }
    });

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
