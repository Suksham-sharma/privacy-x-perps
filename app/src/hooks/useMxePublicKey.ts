"use client";
// Fetches the MXE x25519 public key (needed to encrypt orders client-side).
// Mirrors lifecycle-driver's retry: the key is stable once the MXE is up, so we
// cache it forever and retry while localnet is still coming online.
import { useQuery } from "@tanstack/react-query";
import { AnchorProvider } from "@anchor-lang/core";
import { getMXEPublicKey } from "@arcium-hq/client";
import { useProgram } from "@/lib/anchor";
import { PROGRAM_ID } from "@/lib/config";

export function useMxePublicKey() {
  const program = useProgram();

  return useQuery({
    queryKey: ["mxePublicKey", PROGRAM_ID.toBase58()],
    enabled: !!program,
    staleTime: Infinity,
    retry: 20,
    retryDelay: 500,
    queryFn: async (): Promise<Uint8Array> => {
      const provider = program!.provider as AnchorProvider;
      const key = await getMXEPublicKey(provider, PROGRAM_ID);
      if (!key) throw new Error("MXE public key not available yet");
      return key;
    },
  });
}
