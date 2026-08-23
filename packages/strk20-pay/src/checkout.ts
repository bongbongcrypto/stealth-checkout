import { revealReport } from "./honesty.js";
import { TOKENS, resolveToken } from "./tokens.js";
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
   * Record of a payment already broadcast, keyed by invoice. Confirmation can
   * fail while the money is genuinely gone (slow chain, flaky RPC), and the
   * payer then retries, or reloads the page. Either way the payment must not
   * be sent again, so this is persisted through `store` and survives a reload.
   */
  private sentPayment: SentPayment | null = null;

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
    /**
     * Where broadcast payments are remembered. Defaults to sessionStorage in a
     * browser so a reload cannot re-send; pass your own for other hosts, or
     * `null` to opt out (a reload then risks paying twice).
     */
    private readonly store: PaymentStore | null = defaultStore(),
  ) {}

  on(listener: (e: CheckoutEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Honesty panel rows for this invoice, given current balances. The threshold
   * is amount + pool fee, the same one `pay` uses: judging by the amount alone
   * told a payer holding exactly the invoice amount that no public deposit was
   * coming, and then one was.
   */
  async preview(invoice: Invoice): Promise<RevealItem[]> {
    if (!this.wallet.isConnected()) return revealReport(invoice, true);
    const shielded = await this.wallet.shieldedBalance(invoice.token);
    const fee = (await this.wallet.poolFee?.(invoice.token)) ?? "0";
    const dp = decimalsOf(invoice.token);
    const willShieldFirst =
      shielded === null || compareAmounts(shielded, addAmounts(invoice.amount, fee, dp), dp) < 0;
    return revealReport(invoice, willShieldFirst);
  }

  async pay(invoice: Invoice): Promise<Receipt> {
    if (this.phase === "paid") this.phase = "idle"; // a settled instance is reusable
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
      // The record is matched on the terms of the payment, not just its id, so
      // a mutated invoice reusing an id cannot claim someone else's payment.
      // Check the in-memory record only if it is for THIS invoice: a stale one
      // for another invoice used to shadow the persisted lookup entirely, and
      // the payer paid an already-settled invoice a second time.
      const cached = this.sentPayment && matchesInvoice(this.sentPayment, invoice) ? this.sentPayment : null;
      const prior = cached ?? this.loadSent(invoice);
      if (prior) {
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
          const fee = (await this.wallet.poolFee?.(invoice.token)) ?? "0";
          shieldTxHash = await this.shieldOrExplain(invoice, undefined, fee);
          ({ txHash } = await this.payStep(invoice));
        }
      } else {
        // Paying costs amount + fee out of the shielded balance. Gating on the
        // amount alone waved payers through who then hit an opaque wallet
        // error with the money still in the pool.
        const fee = (await this.wallet.poolFee?.(invoice.token)) ?? "0";
        const dp = decimalsOf(invoice.token);
        const needed = addAmounts(invoice.amount, fee, dp);
        if (compareAmounts(shielded, needed, dp) < 0) {
          shieldTxHash = await this.shieldOrExplain(invoice, shielded, fee);
        }
        ({ txHash } = await this.payStep(invoice));
      }

      // Recorded the instant it is broadcast, before anything that can throw:
      // the money is already gone, and losing the record means paying twice.
      this.sentPayment = {
        invoiceId: invoice.id,
        amount: invoice.amount,
        token: invoice.token,
        recipient: invoice.receiveAddress ?? invoice.merchantPoolAddress ?? "",
        txHash,
        shieldTxHash,
      };
      this.saveSent(this.sentPayment);

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

  private storeKey(invoiceId: string): string {
    return `strk20-pay.sent.${this.wallet.network}.${invoiceId}`;
  }

  /**
   * A stored record only counts if it settles THIS invoice. The key is scoped
   * by id, which is not enough on its own: an id can be reused with a
   * different amount or recipient, and returning it unchecked would treat the
   * new, larger invoice as already paid.
   */
  private loadSent(invoice: Invoice): SentPayment | null {
    try {
      const raw = this.store?.getItem(this.storeKey(invoice.id));
      if (!raw) return null;
      const record = JSON.parse(raw) as SentPayment;
      return matchesInvoice(record, invoice) ? record : null;
    } catch {
      return null;
    }
  }

  private saveSent(record: SentPayment): void {
    if (!this.store) return this.warnUnprotected("no storage is available");
    try {
      this.store.setItem(this.storeKey(record.invoiceId), JSON.stringify(record));
    } catch (err) {
      // Never fail a payment that already landed. Do say so, though: without a
      // record, a reload can pay again.
      this.warnUnprotected(err instanceof Error ? err.message : "storage rejected the write");
    }
  }

  private warnUnprotected(reason: string): void {
    this.emit(
      "confirming",
      `Payment sent. Do not reload this page: it could not be remembered (${reason}), and reloading may pay again.`,
      false,
      this.sentPayment?.txHash,
    );
  }

  /**
   * Either shield inline (opt-in) or stop and say why not. Refusing is the
   * privacy-preserving answer, so the message has to be genuinely useful.
   */
  private async shieldOrExplain(invoice: Invoice, shielded?: Amount, fee = "0"): Promise<string> {
    if (this.allowInlineShield) return this.shieldStep(invoice, fee);
    const needed = addAmounts(invoice.amount, fee, decimalsOf(invoice.token));
    const have = shielded !== undefined ? ` You have ${shielded} ${invoice.token} shielded right now.` : "";
    const feeNote =
      compareAmounts(fee, "0") > 0
        ? ` The pool charges a flat ${fee} ${invoice.token} for the payment itself, on top of the ${invoice.amount} the merchant receives.`
        : "";
    throw new Error(
      `You need ${needed} ${invoice.token} shielded to pay this invoice.${have}${feeNote} ` +
        "Shield it in your wallet first, in one go and ahead of time: each deposit costs the same flat fee again, " +
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
  private async shieldStep(invoice: Invoice, fee = "0"): Promise<string> {
    // Shield the amount PLUS the fee the payment will cost, or the deposit
    // lands and the payment that follows can never be afforded.
    const deposit = addAmounts(invoice.amount, fee, decimalsOf(invoice.token));
    this.emit(
      "shielding",
      `Your wallet will pop up to shield ${deposit} ${invoice.token}. This deposit is public and screened.`,
      true,
    );
    const { txHash } = await this.wallet.shield(invoice.token, deposit);
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
/**
 * The one definition of a valid amount, shared by every helper here.
 *
 * It has to be shared. When `compareAmounts` accepted ".5" and `addAmounts`
 * rejected it, the same string passed the sufficiency check and then threw
 * partway through a payment. And when `addAmounts` silently truncated below
 * the token's precision while `compareAmounts` counted it, the two disagreed
 * about whether a dust amount was greater than zero.
 *
 * Rejected on purpose: "" (parses as 0 in most naive versions), ".5" and "5."
 * (ambiguous), "1e3" (exponent notation is not a decimal string), "-1", and
 * anything with more decimal places than the token can represent, because
 * truncating a payment amount without saying so is how a payer is short-changed.
 */
function parseAmount(x: string, decimals: number): [string, string] {
  const s = String(x).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Not a valid amount: ${JSON.stringify(x)}`);
  const [ip = "0", fp = ""] = s.split(".");
  if (fp.length > decimals) {
    throw new Error(`Amount ${JSON.stringify(x)} has more than ${decimals} decimal places`);
  }
  return [(ip || "0").replace(/^0+(?=\d)/, ""), fp.replace(/0+$/, "")];
}

/**
 * The token's precision, or 18 for one not in the registry. An unregistered
 * token is already refused at the wallet boundary, so this only decides how
 * strictly an amount string is validated before we get there.
 */
function decimalsOf(token: string): number {
  try {
    return resolveToken(token, TOKENS).decimals;
  } catch {
    return 18;
  }
}

export function compareAmounts(a: string, b: string, decimals = 18): -1 | 0 | 1 {
  const [ai, af] = parseAmount(a, decimals);
  const [bi, bf] = parseAmount(b, decimals);
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

/** A payment already broadcast. Persisted so a reload cannot re-send it. */
export interface SentPayment {
  invoiceId: string;
  amount: string;
  token: string;
  recipient: string;
  txHash: string;
  shieldTxHash?: string;
}

/** The slice of Storage this needs. sessionStorage and localStorage both fit. */
export interface PaymentStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStore(): PaymentStore | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null; // blocked by the browser
  }
}

/**
 * Does a remembered payment settle THIS invoice? Same id is not enough: an id
 * can be reused with a different amount or recipient, and treating that as
 * already-paid would hand over goods for a payment that never covered them.
 */
export function matchesInvoice(sent: SentPayment, invoice: Invoice): boolean {
  try {
    const recipient = invoice.receiveAddress ?? invoice.merchantPoolAddress ?? "";
    return (
      sent.invoiceId === invoice.id &&
      sent.token === invoice.token &&
      sameFelt(sent.recipient, recipient) &&
      compareAmounts(sent.amount, invoice.amount) === 0
    );
  } catch {
    // A malformed record must not throw out of pay(): that used to leave the
    // payer unable to pay the invoice at all from this browser.
    return false;
  }
}

/**
 * Compare Starknet addresses by value. Text form is not canonical, and
 * comparing the strings made the SAME address re-rendered with different
 * padding or case look like a different one, so the payment went out twice.
 */
export function sameFelt(a: string, b: string): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return a === b;
  }
}

/** Add two decimal-string amounts exactly, with no float. */
export function addAmounts(a: string, b: string, decimals = 18): string {
  const units = (x: string): bigint => {
    const [ip, fp] = parseAmount(x, decimals);
    return BigInt(ip || "0") * 10n ** BigInt(decimals) + BigInt(fp.padEnd(decimals, "0") || "0");
  };
  const total = units(a) + units(b);
  const one = 10n ** BigInt(decimals);
  const ip = total / one;
  const fp = (total % one).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fp ? `${ip}.${fp}` : ip.toString();
}
