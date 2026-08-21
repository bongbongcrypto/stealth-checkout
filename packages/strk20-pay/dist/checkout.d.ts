import type { CheckoutEvent, Invoice, Receipt, RevealItem, Unsubscribe } from "./types.js";
import type { WalletAdapter } from "./wallet/adapter.js";
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
export declare class StealthCheckout {
    private readonly wallet;
    private readonly confirmPayment;
    /**
     * Shield inline when the payer has no shielded funds. OFF by default, and
     * that default is the protocol's own advice: a deposit is a public leg
     * naming the depositor, so shielding moments before paying lets an
     * observer correlate the two ends by amount and timing. Shielding ahead of
     * time, separately, is what makes the payment unlinkable. It is also
     * cheaper, since the pool charges a fee per deposit.
     */
    private readonly allowInlineShield;
    private listeners;
    private phase;
    constructor(wallet: WalletAdapter, confirmPayment?: (invoice: Invoice, txHash: string) => Promise<boolean>, 
    /**
     * Shield inline when the payer has no shielded funds. OFF by default, and
     * that default is the protocol's own advice: a deposit is a public leg
     * naming the depositor, so shielding moments before paying lets an
     * observer correlate the two ends by amount and timing. Shielding ahead of
     * time, separately, is what makes the payment unlinkable. It is also
     * cheaper, since the pool charges a fee per deposit.
     */
    allowInlineShield?: boolean);
    on(listener: (e: CheckoutEvent) => void): Unsubscribe;
    /** Honesty panel rows for this invoice, given current balances. */
    preview(invoice: Invoice): Promise<RevealItem[]>;
    pay(invoice: Invoice): Promise<Receipt>;
    /**
     * Either shield inline (opt-in) or stop and say why not. Refusing is the
     * privacy-preserving answer, so the message has to be genuinely useful.
     */
    private shieldOrExplain;
    /** Shield, then block until the new notes are actually spendable. */
    private shieldStep;
    private payStep;
    private executePayment;
    private emit;
}
/** Compare two decimal-string amounts without floats. */
export declare function compareAmounts(a: string, b: string): -1 | 0 | 1;
/** Does this wallet error mean "you do not have enough shielded funds"? */
export declare function isInsufficientFunds(err: unknown): boolean;
