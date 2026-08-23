export class WalletActionError extends Error {
    action;
    cause;
    submitted;
    constructor(action, message, cause, 
    /**
     * Might this error have followed a transaction reaching the network?
     *
     * Defaults to TRUE, which is the safe answer: an adapter that does not
     * think about it gets "assume the money may be gone", and the checkout
     * refuses to pay again rather than risking a double spend.
     *
     * Only set false where the code path provably precedes submission - a
     * missing connection, an amount that fails validation, a token that is not
     * registered. Never on a catch around the submit call itself.
     *
     * This replaced substring-matching the message. `didNotReachTheChain` used
     * to look for "invalid" / "expired" / "is not connected" anywhere in free
     * text, so a wallet that broadcast and then reported "Invalid response
     * from the node" had its pending marker erased and the payer paid twice.
     * The wallet vendor chose the wording; we chose to trust it.
     */
    submitted = true) {
        super(message);
        this.action = action;
        this.cause = cause;
        this.submitted = submitted;
        this.name = "WalletActionError";
    }
}
