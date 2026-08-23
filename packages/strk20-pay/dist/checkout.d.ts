import type { Amount, CheckoutEvent, Invoice, Receipt, RevealItem, Unsubscribe } from "./types.js";
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
    pay(invoice: Invoice, opts?: PayOptions): Promise<Receipt>;
    private storeKey;
    /**
     * A stored record only counts if it settles THIS invoice. The key is scoped
     * by id, which is not enough on its own: an id can be reused with a
     * different amount or recipient, and returning it unchecked would treat the
     * new, larger invoice as already paid.
     */
    private loadSent;
    /** Remember that a payment was requested, before it can possibly land. */
    private markPending;
    /**
     * Forget the marker, once the wallet has made clear nothing was submitted.
     *
     * ONLY the marker. This used to blank the stored key unconditionally while
     * the in-memory guard beside it was careful, so a `confirm` that threw with
     * the word "invalid" anywhere in its text erased the durable record of a
     * payment that had genuinely been broadcast. The next tab found nothing and
     * paid again: the whole cross-tab guard, undone by one word of error text.
     */
    private clearPending;
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
/**
 * What a payer must DEPOSIT to end up able to pay this invoice.
 *
 * The pool charges its flat fee on every operation, and on a deposit it takes
 * that fee OUT of the deposit rather than on top of it: send X, get X - fee
 * credited. So paying an invoice of A out of a fresh deposit needs
 *
 *     deposit - fee >= A + fee   =>   deposit >= A + 2 x fee
 *
 * Shielding A + fee, which is what this used to do, credits exactly A and then
 * the payment needs A + fee. Short by one fee at every invoice size, every
 * time, with the money already public and in the pool. The ledger of this
 * project's own seven mainnet transactions is what settles the direction:
 * 20-6, -5-6, +5-6, +5-6, +20-6, -5-6, +5-6 = 3 STRK.
 */
export declare function depositNeededFor(amount: Amount, fee: Amount, decimals?: number): Amount;
/** What a payer must already hold shielded to pay this invoice outright. */
export declare function shieldedNeededFor(amount: Amount, fee: Amount, decimals?: number): Amount;
export declare function compareAmounts(a: string, b: string, decimals?: number): -1 | 0 | 1;
/**
 * Is this an error a wallet raises BEFORE submitting anything?
 *
 * Only these may clear the pending marker. Everything else - a timeout, a lost
 * response, a wallet that vanished - has to be treated as "it may have gone
 * through", because the alternative is telling a payer it is safe to pay again
 * when it is not.
 */
export declare function didNotReachTheChain(err: unknown): boolean;
/** Does this wallet error mean "you do not have enough shielded funds"? */
export declare function isInsufficientFunds(err: unknown): boolean;
export interface PayOptions {
    /**
     * The payer has looked in their wallet and confirmed nothing was sent.
     *
     * Only meaningful after a `PendingPaymentError`. It exists because only a
     * human can answer the question that error asks, and because guessing on
     * their behalf means either paying twice or bricking the invoice.
     */
    paidNothingLastTime?: boolean;
}
/**
 * An earlier attempt may or may not have spent money, and nothing here can
 * tell. Distinct from a plain failure so a UI can offer the one action that
 * resolves it, instead of a Retry button that might pay twice.
 */
export declare class PendingPaymentError extends Error {
    readonly needsPayerCheck = true;
    constructor(message: string);
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
