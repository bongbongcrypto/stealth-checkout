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
    /**
     * Where broadcast payments are remembered. Defaults to sessionStorage in a
     * browser so a reload cannot re-send; pass your own for other hosts, or
     * `null` to opt out (a reload then risks paying twice).
     */
    private readonly store;
    private listeners;
    private phase;
    /**
     * Record of a payment already broadcast, keyed by invoice. Confirmation can
     * fail while the money is genuinely gone (slow chain, flaky RPC), and the
     * payer then retries, or reloads the page. Either way the payment must not
     * be sent again, so this is persisted through `store` and survives a reload.
     */
    private sentPayment;
    constructor(wallet: WalletAdapter, confirmPayment?: (invoice: Invoice, txHash: string) => Promise<boolean>, 
    /**
     * Shield inline when the payer has no shielded funds. OFF by default, and
     * that default is the protocol's own advice: a deposit is a public leg
     * naming the depositor, so shielding moments before paying lets an
     * observer correlate the two ends by amount and timing. Shielding ahead of
     * time, separately, is what makes the payment unlinkable. It is also
     * cheaper, since the pool charges a fee per deposit.
     */
    allowInlineShield?: boolean, 
    /**
     * Where broadcast payments are remembered. Defaults to sessionStorage in a
     * browser so a reload cannot re-send; pass your own for other hosts, or
     * `null` to opt out (a reload then risks paying twice).
     */
    store?: PaymentStore | null);
    on(listener: (e: CheckoutEvent) => void): Unsubscribe;
    /**
     * Honesty panel rows for this invoice, given current balances. The threshold
     * is amount + pool fee, the same one `pay` uses: judging by the amount alone
     * told a payer holding exactly the invoice amount that no public deposit was
     * coming, and then one was.
     */
    preview(invoice: Invoice): Promise<RevealItem[]>;
    pay(invoice: Invoice): Promise<Receipt>;
    private storeKey;
    /**
     * A stored record only counts if it settles THIS invoice. The key is scoped
     * by id, which is not enough on its own: an id can be reused with a
     * different amount or recipient, and returning it unchecked would treat the
     * new, larger invoice as already paid.
     */
    private loadSent;
    private saveSent;
    private warnUnprotected;
    /**
     * Either shield inline (opt-in) or stop and say why not. Refusing is the
     * privacy-preserving answer, so the message has to be genuinely useful.
     */
    private shieldOrExplain;
    private finish;
    /** Shield, then block until the new notes are actually spendable. */
    private shieldStep;
    private payStep;
    private executePayment;
    private emit;
}
export declare function compareAmounts(a: string, b: string, decimals?: number): -1 | 0 | 1;
/** Does this wallet error mean "you do not have enough shielded funds"? */
export declare function isInsufficientFunds(err: unknown): boolean;
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
/**
 * Does a remembered payment settle THIS invoice? Same id is not enough: an id
 * can be reused with a different amount or recipient, and treating that as
 * already-paid would hand over goods for a payment that never covered them.
 */
export declare function matchesInvoice(sent: SentPayment, invoice: Invoice): boolean;
/**
 * Compare Starknet addresses by value. Text form is not canonical, and
 * comparing the strings made the SAME address re-rendered with different
 * padding or case look like a different one, so the payment went out twice.
 */
export declare function sameFelt(a: string, b: string): boolean;
/** Add two decimal-string amounts exactly, with no float. */
export declare function addAmounts(a: string, b: string, decimals?: number): string;
