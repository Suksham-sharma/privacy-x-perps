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
import { randomBytes } from "crypto";
import { expect } from "chai";
import { ConfidentialPerps } from "../target/types/confidential_perps";

const MARKET_SEED = Buffer.from("market");
const BATCH_BUFFER_SEED = Buffer.from("batch");
const USER_COLLATERAL_SEED = Buffer.from("collateral");

const USDC_DECIMALS = 6;
const ONE_USDC = 10n ** BigInt(USDC_DECIMALS);

describe("perp engine e2e", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.ConfidentialPerps as Program<ConfidentialPerps>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const pythFeed = Keypair.generate().publicKey; // placeholder; Market only stores the key

  const [marketPda] = PublicKey.findProgramAddressSync(
    [MARKET_SEED],
    program.programId,
  );
  const [batchBufferPda] = PublicKey.findProgramAddressSync(
    [BATCH_BUFFER_SEED, marketPda.toBuffer()],
    program.programId,
  );

  let usdcMint: PublicKey;
  let vaultAta: PublicKey;

  before(async () => {
    // Real USDC-style mint, admin = mint authority.
    usdcMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      USDC_DECIMALS,
    );
    vaultAta = await getAssociatedTokenAddress(usdcMint, marketPda, true);
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
      expect(market.admin.toBase58()).to.equal(admin.publicKey.toBase58());
      expect(market.pythFeed.toBase58()).to.equal(pythFeed.toBase58());
      expect(market.usdcMint.toBase58()).to.equal(usdcMint.toBase58());
      expect(market.usdcVault.toBase58()).to.equal(vaultAta.toBase58());
      expect(market.batchWindowSlots.toNumber()).to.equal(5);

      const buffer = await program.account.batchBuffer.fetch(batchBufferPda);
      expect(buffer.nOrders).to.equal(0);
    });
  });

  describe("submit_order", () => {
    it("accepts 3 submit_order calls and stores ciphertexts in order", async () => {
      const users = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
      for (const u of users) {
        const sig = await provider.connection.requestAirdrop(u.publicKey, 1e9);
        await provider.connection.confirmTransaction(sig, "confirmed");
      }

      const orders = users.map(() => ({
        x25519Pubkey: Array.from(randomBytes(32)),
        nonce: new anchor.BN(randomBytes(8), "hex"),
        ctSide: Array.from(randomBytes(32)),
        ctPrice: Array.from(randomBytes(32)),
        ctSize: Array.from(randomBytes(32)),
        ctClientNonce: Array.from(randomBytes(32)),
      }));

      for (let i = 0; i < users.length; i++) {
        await program.methods
          .submitOrder(
            orders[i].x25519Pubkey,
            orders[i].nonce,
            orders[i].ctSide,
            orders[i].ctPrice,
            orders[i].ctSize,
            orders[i].ctClientNonce,
          )
          .accounts({
            user: users[i].publicKey,
            market: marketPda,
            batchBuffer: batchBufferPda,
          })
          .signers([users[i]])
          .rpc({ skipPreflight: true, commitment: "confirmed" });
      }

      const buffer = await program.account.batchBuffer.fetch(batchBufferPda);
      expect(buffer.nOrders).to.equal(3);
      for (let i = 0; i < 3; i++) {
        expect(buffer.orders[i].owner.toBase58()).to.equal(
          users[i].publicKey.toBase58(),
        );
        expect(Buffer.from(buffer.orders[i].ctPrice)).to.deep.equal(
          Buffer.from(orders[i].ctPrice),
        );
      }
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

      // Mint 1000 USDC to alice.
      await mintTo(
        provider.connection,
        admin,
        usdcMint,
        aliceAta,
        admin,
        Number(1000n * ONE_USDC),
      );

      [aliceCollateralPda] = PublicKey.findProgramAddressSync(
        [USER_COLLATERAL_SEED, marketPda.toBuffer(), alice.publicKey.toBuffer()],
        program.programId,
      );
    });

    it("deposits 500 USDC and credits UserCollateral", async () => {
      const amount = new anchor.BN(Number(500n * ONE_USDC));

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

      const vault = await getAccount(provider.connection, vaultAta);
      expect(vault.amount.toString()).to.equal((500n * ONE_USDC).toString());
    });

    it("withdraws an amount within the per-slot rate limit", async () => {
      // 5% of 500 USDC = 25 USDC. Withdraw 10 USDC.
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
      // Vault snapshot ~490 USDC. 5% cap = ~24.5. Try to withdraw 100 — exceeds.
      const amount = new anchor.BN(Number(100n * ONE_USDC));

      const balanceBefore = (
        await program.account.userCollateral.fetch(aliceCollateralPda)
      ).balance.toString();

      let failed = false;
      try {
        // Preflight on, so we get the program error back instead of a generic
        // SendTransactionError that drops the logs.
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

      // Balance unchanged — the failed withdraw didn't leak.
      const balanceAfter = (
        await program.account.userCollateral.fetch(aliceCollateralPda)
      ).balance.toString();
      expect(balanceAfter).to.equal(balanceBefore);
    });
  });
});
