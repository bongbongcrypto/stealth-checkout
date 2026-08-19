import { revealReport } from "./honesty.js";
import type { CheckoutEvent, Invoice, PaymentPhase, PaymentProgress, Receipt, RevealItem, Unsubscribe } from "./types.js";
import type { WalletAdapter } from "./wallet/adapter.js";
import { WalletActionError } from "./wallet/adapter.js";

/**
 * Orchestrates one payment end to end:
 *
 *   connect → prepare (balance check, shield-if-needed) → [shield → mature]
 *   → pay (unshield to invoice address | private note transfer) → confirm
 *
 * UI-framework-agnostic: consumers subscribe to progress events and render
 * them however they like. Every wait emits a message meant to be shown next
 * to the button that caused it, and wallet popups are announced beforehand.
 */
export class StealthCheckout {
  private listeners = new Set<(e: CheckoutEvent) => void>();
  private phase: PaymentPhase = "idle";

  constructor(
    private readonly wallet: WalletAdapter,
    private readonly confirmPayment: (invoice: Invoice, txHash: string) => Promise<boolean> = async () => true,
  ) {}

  on(listener: (e: CheckoutEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Honesty panel rows for this invoice, given current balances. */
  async preview(invoice: Invoice): Promise<RevealItem[]> {
    const willShieldFirst = this.wallet.isConnected() ? await this.needsShield(invoice) : true;
    return revealReport(invoice, willShieldFirst);
  }

  async pay(invoice: Invoice): Promise<Receipt> {
    if (this.phase !== "idle" && this.phase !== "failed" && this.phase !== "expired") {
      throw new Error(`A payment is already in progress (${this.phase}).`);
    }
    if (invoice.expiresAt && Date.now() > invoice.expiresAt) {
      this.emit("expired", "This invoice has expired. Ask the merchant for a fresh one.", false);
      throw new Error("Invoice expired.");
    }

    try {
      if (!this.wallet.isConnected()) {
        this.emit("connecting", "Your wallet will pop up to connect.", true);
        await this.wallet.connect();
      }

      this.emit("preparing", "Checking your shielded balance…", false);
      if (await this.needsShield(invoice)) {
        this.emit("shielding", `Your wallet will pop up to shield ${invoice.amount} ${invoice.token}. This deposit is public and screened.`, true);
        await this.wallet.shield(invoice.token, invoice.amount);
        this.emit("maturing", "Waiting for your shielded funds to mature (~10 blocks). Leave this page open.", false);
        await this.matureIfSupported();
      }

      const paying =
        invoice.mode === "address"
          ? "Your wallet will pop up to pay the invoice address privately."
          : "Your wallet will pop up to send a private note to the merchant.";
      this.emit("paying", paying, true);
      const { txHash } = await this.executePayment(invoice);

      this.emit("confirming", "Payment sent. Waiting for on-chain confirmation…", false, txHash);
      const confirmed = await this.confirmPayment(invoice, txHash);
      if (!confirmed) throw new Error("The payment was not confirmed on-chain.");

      const receipt: Receipt = {
        invoiceId: invoice.id,
        token: invoice.token,
        amount: invoice.amount,
        network: invoice.network,
        mode: invoice.mode,
        txHash,
        confirmedAt: Date.now(),
        disclosure:
          invoice.mode === "address"
            ? "Proves this invoice was paid. Does not link the payment to the payer's wallet."
            : "Proves a private note was sent. Amount and parties are not on-chain.",
      };
      this.emit("paid", "Paid. Receipt ready.", false, txHash);
      this.listeners.forEach((l) => l({ type: "paid", receipt }));
      return receipt;
    } catch (err) {
      const message =
        err instanceof WalletActionError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Payment failed for an unknown reason.";
      this.emit("failed", message, false, undefined, message);
      this.listeners.forEach((l) => l({ type: "failed", error: message, phase: this.phase }));
      throw err;
    }
  }

  private async needsShield(invoice: Invoice): Promise<boolean> {
    const shielded = await this.wallet.shieldedBalance(invoice.token);
    return compareAmounts(shielded, invoice.amount) < 0;
  }

  private async executePayment(invoice: Invoice): Promise<{ txHash: string }> {
    if (invoice.mode === "address") {
      if (!invoice.receiveAddress) throw new Error("Invoice is missing its receive address.");
      return this.wallet.unshield(invoice.token, invoice.amount, invoice.receiveAddress);
    }
    if (!invoice.merchantPoolAddress) throw new Error("Invoice is missing the merchant pool address.");
    return this.wallet.privateTransfer(invoice.token, invoice.amount, invoice.merchantPoolAddress);
  }

  private async matureIfSupported(): Promise<void> {
    const maybe = this.wallet as WalletAdapter & { matureNotes?: () => Promise<void> };
    if (maybe.matureNotes) await maybe.matureNotes();
  }

  private emit(phase: PaymentPhase, message: string, walletPopupImminent: boolean, txHash?: string, error?: string): void {
    this.phase = phase;
    const progress: PaymentProgress = { phase, message, walletPopupImminent, txHash, error };
    this.listeners.forEach((l) => l({ type: "progress", progress }));
  }
}

/** Compare two decimal-string amounts without floats. */
export function compareAmounts(a: string, b: string): -1 | 0 | 1 {
  const norm = (x: string): [string, string] => {
    const [ip = "0", fp = ""] = x.trim().split(".");
    return [ip.replace(/^0+(?=\d)/, ""), fp.replace(/0+$/, "")];
  };
  const [ai, af] = norm(a);
  const [bi, bf] = norm(b);
  if (ai.length !== bi.length) return ai.length < bi.length ? -1 : 1;
  if (ai !== bi) return ai < bi ? -1 : 1;
  if (af === bf) return 0;
  const len = Math.max(af.length, bf.length);
  const ap = af.padEnd(len, "0");
  const bp = bf.padEnd(len, "0");
  return ap === bp ? 0 : ap < bp ? -1 : 1;
}
