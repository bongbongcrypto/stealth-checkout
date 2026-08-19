import { StealthCheckout } from "./checkout.js";
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
