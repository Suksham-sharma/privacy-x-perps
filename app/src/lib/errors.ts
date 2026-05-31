// Turn a raw Anchor/web3 error into a short, human message: map known program
// error codes to plain guidance, falling back to a trimmed message.
const FRIENDLY: Record<string, string> = {
  BatchWindowClosed:
    "Round closed before a counterparty arrived. Cancel your order in Open Orders, then retry.",
  BatchFull: "This batch is full — wait for it to settle, then try again.",
  BatchAlreadyProcessing: "A match is settling right now — try again in a moment.",
  BatchNotReady: "The batch isn't ready to match yet.",
  BatchWindowOpen: "The batch window is still open — orders can still join.",
  InsufficientCollateral: "Not enough margin — deposit more, or lower size / leverage.",
  NoPendingOrder: "You have no pending order in this batch to cancel.",
  BatchEmpty: "There are no orders in the batch.",
  ZeroAmount: "Enter an amount greater than zero.",
  WithdrawRateLimitExceeded: "Withdrawal rate limit hit — try a smaller amount or wait a slot.",
};

export function friendlyError(e: unknown): string {
  // Anchor surfaces a structured code on the error object.
  const code =
    (e as { error?: { errorCode?: { code?: string } } })?.error?.errorCode?.code ??
    undefined;
  if (code && FRIENDLY[code]) return FRIENDLY[code];

  const raw = (e as Error)?.message ?? String(e);

  // Parse the code out of the stringified AnchorError when the object form
  // isn't available (e.g. logs-only rejections).
  const codeMatch = raw.match(/Error Code: (\w+)/);
  if (codeMatch && FRIENDLY[codeMatch[1]]) return FRIENDLY[codeMatch[1]];

  // Otherwise show the program's own "Error Message: …" if present.
  const msgMatch = raw.match(/Error Message: ([^\n]+?)\.?$/m);
  if (msgMatch) return msgMatch[1];

  // Last resort: a trimmed raw message (no stack, no file paths).
  const firstLine = raw.split("\n")[0].trim();
  return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
}
