export class WalletActionError extends Error {
    action;
    cause;
    constructor(action, message, cause) {
        super(message);
        this.action = action;
        this.cause = cause;
        this.name = "WalletActionError";
    }
}
