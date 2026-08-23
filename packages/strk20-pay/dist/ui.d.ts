import { StealthCheckout } from "./checkout.js";
import type { PaymentStore } from "./checkout.js";
import type { Invoice, Receipt } from "./types.js";
import type { WalletAdapter } from "./wallet/adapter.js";
export interface MountOptions {
    invoice: Invoice;
    wallet: WalletAdapter;
    /** Merchant-side confirmation (RPC watcher in production, stub in demos). */
    confirm?: (invoice: Invoice, txHash: string) => Promise<boolean>;
    onPaid?: (receipt: Receipt) => void;
    onFailed?: (error: string) => void;
    /** Button label; defaults to "Pay {amount} {token} privately". */
    label?: string;
    /**
     * Let the widget shield for the payer when they have no shielded funds.
     * Off by default: shielding ahead of time, separately, is what keeps the
     * payment unlinkable, and it avoids paying the pool's per-deposit fee twice.
     */
    allowInlineShield?: boolean;
    /**
     * Where a broadcast payment is remembered, so a reload or a second tab
     * cannot pay twice. Defaults to localStorage. Pass your own to share the
     * record with a backend, or `null` to opt out and accept that risk.
     *
     * This was unreachable from here, which meant every widget consumer was
     * locked to whatever the core happened to choose.
     */
    store?: PaymentStore | null;
}
export interface MountedCheckout {
    unmount(): void;
    /** The orchestrator, for advanced consumers. */
    checkout: StealthCheckout;
}
/**
 * The drop-in widget. One call renders a complete checkout into `container`:
 * pay button, live progress line (always next to the button), the pre-sign
 * honesty panel, and the receipt. No framework, no external CSS.
 */
export declare function mountCheckout(container: HTMLElement, opts: MountOptions): MountedCheckout;
