// Plaintext order — what the user actually wants to do.
// Encryption happens in encryption.ts; on-chain submission takes ciphertexts.
export interface OrderPlaintext {
  side: bigint;        // 0 = long, 1 = short
  price: bigint;       // ticks (see circuit-v0.md for TICK_SIZE)
  size: bigint;        // lots
  clientNonce: bigint; // u64 chosen by client so it can correlate fills
}

// Encryption output. Each ct_* is a 32-byte ciphertext aligned with
// EncryptedOrderSlot in programs/.../state/mod.rs.
export interface EncryptedOrder {
  x25519Pubkey: Uint8Array; // 32 bytes
  nonce: Uint8Array;        // 16 bytes
  ctSide: Uint8Array;
  ctPrice: Uint8Array;
  ctSize: Uint8Array;
  ctClientNonce: Uint8Array;
  privateKey: Uint8Array;   // keep this; required to decrypt the fill
}
