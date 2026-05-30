// Client-side encryption for orders + fill decryption.
// Mirrors the canonical add_together test pattern: x25519 ECDH with the MXE,
// then RescueCipher with the shared secret.
//
// Runs in both Node (scripts/keeper) and the browser (the /trade UI), so the
// nonce uses the Web Crypto global (present in Node >=19 and every browser)
// rather than Node's `crypto.randomBytes`, which would break the browser bundle.
import { x25519, RescueCipher, deserializeLE } from "@arcium-hq/client";
import { BN } from "@anchor-lang/core";
import type { OrderPlaintext, EncryptedOrder } from "./types";

export function encryptOrder(
  plaintext: OrderPlaintext,
  mxePublicKey: Uint8Array,
): EncryptedOrder {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);

  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const plain = [plaintext.side, plaintext.price, plaintext.size, plaintext.clientNonce];
  const cts = cipher.encrypt(plain, nonce);

  return {
    x25519Pubkey: publicKey,
    nonce,
    ctSide: cts[0],
    ctPrice: cts[1],
    ctSize: cts[2],
    ctClientNonce: cts[3],
    privateKey,
  };
}

// Adapt an EncryptedOrder to the exact arg shape submit_order expects.
// (number[] for byte arrays, BN for the u128 nonce.)
export interface SubmitOrderArgs {
  x25519Pubkey: number[];
  nonce: BN;
  ctSide: number[];
  ctPrice: number[];
  ctSize: number[];
  ctClientNonce: number[];
}

export function toSubmitOrderArgs(e: EncryptedOrder): SubmitOrderArgs {
  return {
    x25519Pubkey: Array.from(e.x25519Pubkey),
    nonce: new BN(deserializeLE(e.nonce).toString()),
    ctSide: Array.from(e.ctSide),
    ctPrice: Array.from(e.ctPrice),
    ctSize: Array.from(e.ctSize),
    ctClientNonce: Array.from(e.ctClientNonce),
  };
}

// Decrypt an encrypted fill returned by match_batch_callback.
// Caller must persist the privateKey from the original encryptOrder() call.
export function decryptFill(
  ciphertext: number[],
  nonce: Uint8Array,
  privateKey: Uint8Array,
  mxePublicKey: Uint8Array,
): bigint {
  const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);
  return cipher.decrypt([ciphertext], nonce)[0];
}
