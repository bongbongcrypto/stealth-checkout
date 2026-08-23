/** Token amounts are decimal strings ("5" = 5 STRK) to avoid float drift; conversion to felt/u256 happens at the wallet boundary. */
export type Amount = string;

export type Network = "mainnet" | "sepolia";

export interface Invoice {
  /** Merchant-scoped unique id, also the hosted page slug. */
  id: string;
  /**
   * ERC-20 the merchant prices in, resolved via the token registry. Only
   * symbols present in that registry work: anything else must be registered
   * with its decimals first. STRK and ETH ship by default.
   */
  token: "STRK" | "ETH" | (string & {});
  amount: Amount;
  /** Shown to the payer and kept on the receipt. Never written on-chain. */
  memo?: string;
  /** Fresh receive address, unique per invoice. Mode "address" only. */
  receiveAddress?: string;
  /** Merchant pool account for mode "note". */
  merchantPoolAddress?: string;
  mode: PaymentMode;
  network: Network;
  createdAt: number;
  expiresAt?: number;
}

/**
 * "address": payer unshields to the invoice's fresh address: merchant confirms
 *            headlessly over public RPC. Payer identity severed by the pool;
 *            amount + invoice address visible.
 * "note":    payer sends a private note to the merchant pool account: fully
 *            private on-chain; confirmation is wallet-side.
 */
export type PaymentMode = "address" | "note";

export type PaymentPhase =
  | "idle"
  | "connecting" // wallet discovery + connect popup
  | "preparing" // balance check, shield-if-needed decision
  | "shielding" // deposit into the pool (public, screened)
  | "maturing" // pool notes take ~10 blocks to become spendable
  | "paying" // the private transfer / unshield popup
  | "confirming" // watching for on-chain confirmation
  | "paid"
  | "failed"
  | "expired";

export interface PaymentProgress {
  phase: PaymentPhase;
  /** Human line rendered NEXT TO the button that caused the wait. */
  message: string;
  /** True right before a wallet popup, so the UI can announce it. */
  walletPopupImminent: boolean;
  /** Terminal error, present only in "failed". */
  error?: string;
  txHash?: string;
}

export interface Receipt {
  invoiceId: string;
  token: string;
  amount: Amount;
  network: Network;
  mode: PaymentMode;
  /** Tx hash of the confirming transaction (mode "address"). */
  txHash?: string;
  /** Tx hash of the shield step, when the flow had to shield first. */
  shieldTxHash?: string;
  confirmedAt: number;
  /** What this receipt proves and what it deliberately does not. */
  disclosure: string;
}

/** One row of the pre-sign honesty panel. */
export interface RevealItem {
  fact: string;
  visibility: "public" | "hidden";
  detail: string;
}

export type CheckoutEvent =
  | { type: "progress"; progress: PaymentProgress }
  | { type: "paid"; receipt: Receipt }
  | { type: "failed"; error: string; phase: PaymentPhase };

export type Unsubscribe = () => void;
