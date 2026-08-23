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
        detail:
          `The amount (${invoice.amount} ${invoice.token}) and the address it lands on are visible. ` +
          "That address is meant to be fresh, used for this invoice only, which is what stops an observer totalling " +
          "the merchant's revenue. Only the merchant can guarantee it: this page is given the address, and cannot check it.",
      },
      {
        fact: "The link between your wallet and this payment",
        visibility: "hidden",
        detail:
          "Privacy wallets submit this through the pool's relayers, so your address is not the sender of the paying transaction. " +
          "The strength of that depends on your wallet, and on the deposit that funded it not standing out.",
      },
      {
        fact: "The merchant's other income",
        visibility: "hidden",
        detail:
          "Each invoice uses its own address, so observers cannot total a merchant's revenue by watching one address. " +
          "Two limits on that: sweeping several invoice addresses into one treasury links them back together, and the " +
          "merchant's own records know everything either way.",
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
    fact: "Your network address, to whoever runs the RPC",
    visibility: "public",
    detail:
      "Confirming a payment means asking a public Starknet node about this invoice's address, repeatedly, from your " +
      "browser. Whoever operates that node sees one IP watching one invoice. Nothing about the pool hides that.",
  });

  if (invoice.mode === "note") {
    items.push({
      fact: "Whether the merchant can see this payment at all",
      visibility: "public",
      detail:
        "Note transfers are not discoverable on Starknet mainnet today, so a merchant cannot confirm one headlessly. " +
        "Only send this way if the merchant has told you how they will credit it.",
    });
  }

  items.push({
    fact: "Timing correlation",
    visibility: "public",
    detail:
      "A distinctive amount paid shortly after a distinctive deposit can be correlated. Shield ahead of time, and shield more than you spend.",
  });

  if (willShieldFirst) {
    items.push({
      fact: "Shielding right now, for this payment",
      visibility: "public",
      detail:
        "Depositing the exact invoice amount moments before paying it is the strongest link an observer can get. " +
        "This is why the checkout asks you to shield in your wallet ahead of time instead.",
    });
  }

  return items;
}
