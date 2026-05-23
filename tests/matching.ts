import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { randomBytes } from "crypto";
import { expect } from "chai";
import { ConfidentialPerps } from "../target/types/confidential_perps";

const MARKET_SEED = Buffer.from("market");
const BATCH_BUFFER_SEED = Buffer.from("batch");

describe("matching: init_market + submit_order", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.ConfidentialPerps as Program<ConfidentialPerps>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const admin = (provider.wallet as anchor.Wallet).payer;

  // Placeholder accounts for init — Market only stores keys, doesn't read them.
  const pythFeed = Keypair.generate().publicKey;
  const usdcMint = Keypair.generate().publicKey;
  const usdcVault = Keypair.generate().publicKey;

  const [marketPda] = PublicKey.findProgramAddressSync(
    [MARKET_SEED],
    program.programId,
  );
  const [batchBufferPda] = PublicKey.findProgramAddressSync(
    [BATCH_BUFFER_SEED, marketPda.toBuffer()],
    program.programId,
  );

  it("initializes the market and batch buffer", async () => {
    const sig = await program.methods
      .initMarket()
      .accounts({
        admin: admin.publicKey,
        market: marketPda,
        batchBuffer: batchBufferPda,
        pythFeed,
        usdcMint,
        usdcVault,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc({ commitment: "confirmed" });

    console.log("init_market sig:", sig);

    const market = await program.account.market.fetch(marketPda);
    expect(market.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(market.pythFeed.toBase58()).to.equal(pythFeed.toBase58());
    expect(market.batchWindowSlots.toNumber()).to.equal(5);
    expect(market.currentBatchId.toNumber()).to.equal(0);

    const buffer = await program.account.batchBuffer.fetch(batchBufferPda);
    expect(buffer.market.toBase58()).to.equal(marketPda.toBase58());
    expect(buffer.batchId.toNumber()).to.equal(0);
    expect(buffer.nOrders).to.equal(0);
  });

  it("accepts 3 submit_order calls and stores ciphertexts in order", async () => {
    // Three distinct users, each posting a different "encrypted" order.
    // We use random bytes — the Anchor side just buffers them; correctness
    // of the real encryption is exercised by add_together.
    const users = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    for (const u of users) {
      const airdrop = await provider.connection.requestAirdrop(
        u.publicKey,
        1e9,
      );
      await provider.connection.confirmTransaction(airdrop, "confirmed");
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
      const u = users[i];
      const o = orders[i];
      await program.methods
        .submitOrder(
          o.x25519Pubkey,
          o.nonce,
          o.ctSide,
          o.ctPrice,
          o.ctSize,
          o.ctClientNonce,
        )
        .accounts({
          user: u.publicKey,
          market: marketPda,
          batchBuffer: batchBufferPda,
        })
        .signers([u])
        .rpc({ commitment: "confirmed" });
    }

    const buffer = await program.account.batchBuffer.fetch(batchBufferPda);
    expect(buffer.nOrders).to.equal(3);
    expect(buffer.openedAtSlot.toNumber()).to.be.greaterThan(0);

    for (let i = 0; i < 3; i++) {
      const slot = buffer.orders[i];
      expect(slot.owner.toBase58()).to.equal(users[i].publicKey.toBase58());
      expect(Buffer.from(slot.ctSide)).to.deep.equal(
        Buffer.from(orders[i].ctSide),
      );
      expect(Buffer.from(slot.ctPrice)).to.deep.equal(
        Buffer.from(orders[i].ctPrice),
      );
    }

    // Empty slots remain zeroed.
    for (let i = 3; i < 8; i++) {
      const slot = buffer.orders[i];
      expect(slot.owner.toBase58()).to.equal(PublicKey.default.toBase58());
    }
  });
});
