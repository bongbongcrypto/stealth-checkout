import { WalletActionError } from "./adapter.js";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * In-memory wallet with the exact adapter surface, so the full checkout flow:
 * including the shield-then-pay path and every failure branch: runs with no
 * extension, no network, and no funds. Used by the demo arcade until the
 * Sepolia adapter lands, and by tests forever.
 */
export class MockWallet {
    network;
    latency;
    failAt;
    connected = false;
    pub = new Map();
    shielded = new Map();
    txCounter = 0;
    fee;
    constructor(opts = {}) {
        this.network = opts.network ?? "sepolia";
        this.latency = opts.latency ?? 600;
        this.failAt = opts.failAt;
        this.fee = toUnits(opts.poolFeeStrk ?? "6");
        for (const [token, amount] of Object.entries(opts.funded ?? { STRK: "100" })) {
            this.pub.set(token, toUnits(amount));
        }
        for (const [token, amount] of Object.entries(opts.shielded ?? {})) {
            this.shielded.set(token, toUnits(amount));
        }
    }
    async connect() {
        await wait(this.latency);
        if (this.failAt === "connect")
            throw new WalletActionError("connect", "User rejected the connection.");
        this.connected = true;
        return { address: "0x0mock" + (1000 + Math.floor(Math.random() * 9000)).toString(16) };
    }
    isConnected() {
        return this.connected;
    }
    async publicBalance(token) {
        return fromUnits(this.pub.get(token) ?? 0n);
    }
    async shieldedBalance(token) {
        return fromUnits(this.shielded.get(token) ?? 0n);
    }
    async poolFee() {
        return fromUnits(this.fee);
    }
    async shield(token, amount) {
        this.assertConnected("shield");
        await wait(this.latency * 2); // screening + acceptance
        if (this.failAt === "shield")
            throw new WalletActionError("shield", "Deposit rejected by compliance screening.");
        // The pool takes its fee OUT of the deposit: send X, get X - fee credited.
        // A deposit at or below the fee buys nothing and is refused here rather
        // than silently crediting zero.
        const deposited = toUnits(amount);
        if (deposited <= this.fee) {
            throw new WalletActionError("shield", `A deposit of ${amount} is not more than the pool's ${fromUnits(this.fee)} fee, so it would credit nothing.`);
        }
        this.take(this.pub, token, amount, "shield");
        this.shielded.set(token, (this.shielded.get(token) ?? 0n) + deposited - this.fee);
        return { txHash: this.hash() };
    }
    async privateTransfer(token, amount, _toPoolAddress) {
        this.assertConnected("privateTransfer");
        await wait(this.latency * 2); // proof generation happens in the wallet
        if (this.failAt === "privateTransfer")
            throw new WalletActionError("privateTransfer", "Wallet failed to prove the transfer.");
        this.take(this.shielded, token, fromUnits(toUnits(amount) + this.fee), "privateTransfer");
        return { txHash: this.hash() };
    }
    async unshield(token, amount, _toAddress) {
        this.assertConnected("unshield");
        await wait(this.latency * 2);
        if (this.failAt === "unshield")
            throw new WalletActionError("unshield", "Wallet failed to prove the withdrawal.");
        // The recipient gets the full amount; the fee comes out of the payer's
        // shielded balance on top of it.
        this.take(this.shielded, token, fromUnits(toUnits(amount) + this.fee), "unshield");
        return { txHash: this.hash() };
    }
    /** Simulates the ~10-block note maturation delay. */
    async awaitMaturity(onProgress) {
        for (let left = 3; left > 0; left--) {
            onProgress?.(left);
            await wait(this.latency / 3);
        }
    }
    assertConnected(action) {
        if (!this.connected)
            throw new WalletActionError(action, "Wallet is not connected.");
    }
    take(from, token, amount, action) {
        const bal = from.get(token) ?? 0n;
        const amt = toUnits(amount);
        if (amt <= 0n)
            throw new WalletActionError(action, "Amount must be positive.");
        if (bal < amt)
            throw new WalletActionError(action, `Insufficient ${token} balance.`);
        from.set(token, bal - amt);
    }
    hash() {
        return "0x" + (++this.txCounter).toString(16).padStart(4, "0") + "f".repeat(56);
    }
}
const DECIMALS = 18n;
const ONE = 10n ** DECIMALS;
function toUnits(amount) {
    const [ip = "0", fp = ""] = amount.trim().split(".");
    if (!/^\d*$/.test(ip) || !/^\d*$/.test(fp) || fp.length > Number(DECIMALS)) {
        throw new Error(`Invalid amount: ${amount}`);
    }
    return BigInt(ip || "0") * ONE + BigInt((fp + "0".repeat(Number(DECIMALS))).slice(0, Number(DECIMALS)) || "0");
}
function fromUnits(units) {
    const ip = units / ONE;
    const fp = (units % ONE).toString().padStart(Number(DECIMALS), "0").replace(/0+$/, "");
    return fp ? `${ip}.${fp}` : ip.toString();
}
