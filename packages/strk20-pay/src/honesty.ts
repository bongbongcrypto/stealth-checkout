import type { Invoice, RevealItem } from "./types.js";

/**
 * The pre-sign honesty panel: exactly what this payment will reveal on-chain
 * and what it will hide. Wording follows the protocol's own public/private
 * boundary: overclaiming privacy is the one thing this widget must never do.
 */
export function revealReport(invoice: Invoice, willShieldFirst: boolean): RevealItem[] {
  const items: RevealItem[] = [];

  if (willShieldFirst) {
    items.push({
      fact: "Your deposit into the pool",
      visibility: "public",
      detail:
        "Shielding is a public, compliance-screened transaction: your address, the token, and the deposited amount are visible on-chain.",
    });
  }

  if (invoice.mode === "address") {
    items.push(
      {
        fact: "Invoice address and amount",
        visibility: "public",
        detail: `The payment lands on a fresh address created only for this invoice, so the amount (${invoice.amount} ${invoice.token}) and that address are visible.`,
      },
      {
        fact: "The link between your wallet and this payment",
        visibility: "hidden",
        detail:
          "The withdrawal is submitted by the pool's relayers. Your wallet address appears nowhere in the paying transaction.",
      },
      {
        fact: "The merchant's other income",
        visibility: "hidden",
        detail:
          "Each invoice uses its own address, so observers cannot total a merchant's revenue by watching one address.",
      },
    );
  } else {
    items.push(
      {
        fact: "Amount and both parties",
        visibility: "hidden",
        detail:
          "A note-to-note transfer publishes only an encrypted note and a nullifier: no amount, no sender, no recipient.",
      },
      {
        fact: "That the pool was used at this time",
        visibility: "public",
        detail: "The transfer's existence and timing are visible, without amounts or identities.",
      },
    );
  }

  items.push({
    fact: "Timing correlation",
    visibility: "public",
    detail:
      "A distinctive amount paid shortly after a distinctive deposit can be correlated. Shield ahead of time, or shield more than you spend.",
  });

  return items;
}
