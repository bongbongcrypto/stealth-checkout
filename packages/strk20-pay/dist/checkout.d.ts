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
    private listeners;
    private phase;
    constructor(wallet: WalletAdapter, confirmPayment?: (invoice: Invoice, txHash: string) => Promise<boolean>);
    on(listener: (e: CheckoutEvent) => void): Unsubscribe;
    /** Honesty panel rows for this invoice, given current balances. */
    preview(invoice: Invoice): Promise<RevealItem[]>;
    pay(invoice: Invoice): Promise<Receipt>;
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
