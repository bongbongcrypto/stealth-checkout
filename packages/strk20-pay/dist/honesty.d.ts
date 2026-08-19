import type { Invoice, RevealItem } from "./types.js";
/**
 * The pre-sign honesty panel: exactly what this payment will reveal on-chain
 * and what it will hide. Wording follows the protocol's own public/private
 * boundary — overclaiming privacy is the one thing this widget must never do.
 */
export declare function revealReport(invoice: Invoice, willShieldFirst: boolean): RevealItem[];
