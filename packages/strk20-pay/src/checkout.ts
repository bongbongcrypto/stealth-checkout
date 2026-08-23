import { revealReport } from "./honesty.js";
import type { Amount, CheckoutEvent, Invoice, PaymentPhase, PaymentProgress, Receipt, RevealItem, Unsubscribe } from "./types.js";
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
  /**
   * Hash of a payment already broadcast for this invoice. Confirmation can
   * fail while the money is genuinely gone (slow chain, flaky RPC), and the
   * widget then offers a Retry button. Without this the retry pays twice.
   */
  private sentPayment: { invoiceId: string; txHash: string; shieldTxHash?: string } | null = null;

  constructor(
    private readonly wallet: WalletAdapter,
    private readonly confirmPayment: (invoice: Invoice, txHash: string) => Promise<boolean> = async () => true,
    /**
     * Shield inline when the payer has no shielded funds. OFF by default, and
     * that default is the protocol's own advice: a deposit is a public leg
     * naming the depositor, so shielding moments before paying lets an
     * observer correlate the two ends by amount and timing. Shielding ahead of
     * time, separately, is what makes the payment unlinkable. It is also
     * cheaper, since the pool charges a fee per deposit.
     */
    private readonly allowInlineShield = false,
  ) {}

  on(listener: (e: CheckoutEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Honesty panel rows for this invoice, given current balances. */
  async preview(invoice: Invoice): Promise<RevealItem[]> {
    const shielded = this.wallet.isConnected() ? await this.wallet.shieldedBalance(invoice.token) : null;
    const willShieldFirst = shielded === null || compareAmounts(shielded, invoice.amount) < 0;
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

    if (this.wallet.network !== invoice.network) {
      const msg = `This invoice is for ${invoice.network}, but the wallet is on ${this.wallet.network}.`;
      this.emit("failed", msg, false, undefined, msg);
      throw new Error(msg);
    }

    try {
      if (!this.wallet.isConnected()) {
        this.emit("connecting", "Your wallet will pop up to connect.", true);
        await this.wallet.connect();
      }

      // Already broadcast for this invoice? Never send again: only wait.
      if (this.sentPayment && this.sentPayment.invoiceId === invoice.id) {
        const prior = this.sentPayment;
        this.emit("confirming", "Payment already sent. Waiting for on-chain confirmation…", false, prior.txHash);
        const ok = await this.confirmPayment(invoice, prior.txHash);
        if (!ok) throw new Error("Still not confirmed on-chain. Your payment was sent once and has not been repeated.");
        return this.finish(invoice, prior.txHash, prior.shieldTxHash);
      }

      this.emit("preparing", "Checking your shielded balance…", false);
      const shielded = await this.wallet.shieldedBalance(invoice.token);
      let shieldTxHash: string | undefined;
      let txHash: string;

      if (shielded === null) {
        // The wallet would not report a balance. Try paying with what may
        // already be shielded rather than shielding blind: a needless deposit
        // costs a pool fee and publishes another public leg.
        try {
          ({ txHash } = await this.payStep(invoice));
        } catch (err) {
          if (!isInsufficientFunds(err)) throw err;
          shieldTxHash = await this.shieldOrExplain(invoice);
          ({ txHash } = await this.payStep(invoice));
        }
      } else {
        if (compareAmounts(shielded, invoice.amount) < 0) {
          shieldTxHash = await this.shieldOrExplain(invoice, shielded);
        }
        ({ txHash } = await this.payStep(invoice));
      }

      this.sentPayment = { invoiceId: invoice.id, txHash, shieldTxHash };

      this.emit("confirming", "Payment sent. Waiting for on-chain confirmation…", false, txHash);
      const confirmed = await this.confirmPayment(invoice, txHash);
      if (!confirmed) throw new Error("The payment was not confirmed on-chain. It was sent once and will not be sent again.");

      return this.finish(invoice, txHash, shieldTxHash);
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

  /**
   * Either shield inline (opt-in) or stop and say why not. Refusing is the
   * privacy-preserving answer, so the message has to be genuinely useful.
   */
  private async shieldOrExplain(invoice: Invoice, shielded?: Amount): Promise<string> {
    if (this.allowInlineShield) return this.shieldStep(invoice);
    const have = shielded !== undefined ? ` You currently have ${shielded} ${invoice.token} shielded.` : "";
    throw new Error(
      `You need at least ${invoice.amount} ${invoice.token} shielded before paying.${have} ` +
        "Shield it in your wallet first, in one go and ahead of time: the pool charges a fee per deposit, " +
        "and a deposit made moments before a payment can be linked to it by amount and timing. " +
        "Wait about ten blocks after shielding, then come back to this invoice.",
    );
  }

  private finish(invoice: Invoice, txHash: string, shieldTxHash?: string): Receipt {
    const receipt: Receipt = {
      invoiceId: invoice.id,
      token: invoice.token,
      amount: invoice.amount,
      // The wallet decides which network the money moved on, not the invoice.
      network: this.wallet.network,
      mode: invoice.mode,
      txHash,
      shieldTxHash,
      confirmedAt: Date.now(),
      disclosure:
        invoice.mode === "address"
          ? "Proves this invoice was paid. Does not link the payment to the payer's wallet."
          : "Proves a private note was sent. Amount and parties are not on-chain.",
    };
    this.emit("paid", "Paid. Receipt ready.", false, txHash);
    this.listeners.forEach((l) => l({ type: "paid", receipt }));
    return receipt;
  }

  /** Shield, then block until the new notes are actually spendable. */
  private async shieldStep(invoice: Invoice): Promise<string> {
    this.emit(
      "shielding",
      `Your wallet will pop up to shield ${invoice.amount} ${invoice.token}. This deposit is public and screened.`,
      true,
    );
    const { txHash } = await this.wallet.shield(invoice.token, invoice.amount);
    this.emit("maturing", "Waiting for your shielded funds to mature (about ten blocks). Leave this page open.", false, txHash);
    await this.wallet.awaitMaturity?.((blocksLeft) => {
      this.emit("maturing", `Waiting for your shielded funds to mature: ${blocksLeft} block(s) to go. Leave this page open.`, false, txHash);
    });
    return txHash;
  }

  private async payStep(invoice: Invoice): Promise<{ txHash: string }> {
    this.emit(
      "paying",
      invoice.mode === "address"
        ? "Your wallet will pop up to pay the invoice address privately."
        : "Your wallet will pop up to send a private note to the merchant.",
      true,
    );
    return this.executePayment(invoice);
  }

  private async executePayment(invoice: Invoice): Promise<{ txHash: string }> {
    if (invoice.mode === "address") {
      if (!invoice.receiveAddress) throw new Error("Invoice is missing its receive address.");
      return this.wallet.unshield(invoice.token, invoice.amount, invoice.receiveAddress);
    }
    if (!invoice.merchantPoolAddress) throw new Error("Invoice is missing the merchant pool address.");
    return this.wallet.privateTransfer(invoice.token, invoice.amount, invoice.merchantPoolAddress);
  }

  private emit(phase: PaymentPhase, message: string, walletPopupImminent: boolean, txHash?: string, error?: string): void {
    this.phase = phase;
    const progress: PaymentProgress = { phase, message, walletPopupImminent, txHash, error };
    this.listeners.forEach((l) => l({ type: "progress", progress }));
  }
}

/**
 * Compare two decimal-string amounts without floats.
 * Throws on anything that is not a plain non-negative decimal: this gates the
 * shield-or-not decision, and silently ranking junk sends real money.
 */
export function compareAmounts(a: string, b: string): -1 | 0 | 1 {
  const norm = (x: string): [string, string] => {
    const s = String(x).trim();
    if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) throw new Error(`Not a valid amount: ${JSON.stringify(x)}`);
    const [ip = "0", fp = ""] = s.split(".");
    return [(ip || "0").replace(/^0+(?=\d)/, ""), fp.replace(/0+$/, "")];
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

/** Does this wallet error mean "you do not have enough shielded funds"? */
export function isInsufficientFunds(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  return /insufficient|not enough|no (unspent )?notes|balance too low|NOT_ENOUGH/i.test(raw);
}
