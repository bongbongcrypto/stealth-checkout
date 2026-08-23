import { WalletActionError } from "./adapter.js";
import { TOKENS, amountToFelt, resolveToken, unitsToAmount } from "../tokens.js";
/** Wallet-API version that introduced the STRK20 methods (Ready, Xverse). */
export const MIN_STRK20_WALLET_API = "0.10.3";
/** Pool notes become spendable this many blocks after the deposit lands. */
export const MATURITY_BLOCKS = 10;
/** The STRK20 privacy pool, which charges the flat per-operation fee. */
/** Voyager has a separate host per network; one URL for both 404s on one. */
export const EXPLORER_BASE = {
    mainnet: "https://voyager.online",
    sepolia: "https://sepolia.voyager.online",
};
export const POOL_ADDRESS = {
    mainnet: "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a",
    sepolia: "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a",
};
export class WalletApiAdapter {
    network;
    /** Voyager, on the network this adapter is actually connected to. */
    explorerUrl(kind, value) {
        if (!/^0x[0-9a-fA-F]{1,64}$/.test(value))
            return null;
        const path = kind === "tx" ? "tx" : "contract";
        return `${EXPLORER_BASE[this.network]}/${path}/${value}`;
    }
    rpcUrl;
    registry;
    preferWallet;
    discoveryTimeoutMs;
    account = null;
    shieldedAtBlock = null;
    feeCache = undefined;
    accountV6 = null;
    provider = null;
    constructor(opts) {
        this.network = opts.network;
        const fallback = opts.network === "mainnet" ? "https://rpc.starknet.lava.build" : undefined;
        const rpcUrl = opts.rpcUrl ?? fallback;
        if (!rpcUrl)
            throw new Error("rpcUrl is required on Sepolia.");
        this.rpcUrl = rpcUrl;
        this.registry = { ...TOKENS, ...opts.tokens };
        this.preferWallet = (opts.preferWallet ?? "ready").toLowerCase();
        this.discoveryTimeoutMs = opts.discoveryTimeoutMs ?? 2500;
    }
    isConnected() {
        return this.account !== null;
    }
    /** Discover wallets and report their STRK20 capability (for custom pickers). */
    async listWallets() {
        const [{ createStore }, { walletV6 }, { compareVersions }] = await Promise.all([
            import("@starknet-io/get-starknet-discovery"),
            import("starknet"),
            import("starknet"),
        ]).then(([d, s]) => [d, s, s]);
        const store = createStore();
        const found = new Map();
        const started = Date.now();
        // Legacy injected globals are a one-shot scan; late injections need rescans
        // (the Ready extension can register a beat after page load).
        while (Date.now() - started < this.discoveryTimeoutMs) {
            store._refreshInjectedWallets?.();
            for (const w of store.getWallets())
                found.set(w.name ?? String(found.size), w);
            if (found.size > 0 && Date.now() - started > 400)
                break;
            await new Promise((r) => setTimeout(r, 200));
        }
        const out = [];
        for (const [name, wallet] of found) {
            let strk20 = false;
            try {
                const versions = await walletV6.supportedWalletApi(wallet);
                strk20 = versions.some((v) => compareVersions(v, MIN_STRK20_WALLET_API) >= 0);
            }
            catch {
                strk20 = false; // wallets predating supportedWalletApi are not capable
            }
            out.push({ name, wallet, strk20 });
        }
        return out;
    }
    async connect() {
        try {
            const { RpcProvider, WalletAccountV6 } = (await import("starknet"));
            this.provider ??= new RpcProvider({ nodeUrl: this.rpcUrl });
            const wallets = await this.listWallets();
            const capable = wallets.filter((w) => w.strk20);
            if (capable.length === 0) {
                // Two different problems, and telling someone to update software they
                // have not installed is a dead end they cannot act on.
                throw new Error(wallets.length === 0
                    ? "No Starknet wallet was found in this browser. Install Ready X (Chrome Web Store or Edge Add-ons), " +
                        "enable Smart Wallet and Private in its settings, then reload this page."
                    : `None of the wallets here can make private payments (found: ${wallets.map((w) => w.name).join(", ")}). ` +
                        "If yours still shows the old name \"Ready Wallet (Formerly Argent)\", it is the same extension out of date: " +
                        "update it, enable Smart Wallet + Private, then reload.");
            }
            const pick = capable.find((w) => w.name.toLowerCase().includes(this.preferWallet)) ?? capable[0];
            this.accountV6 = await WalletAccountV6.connect(this.provider, pick.wallet);
            this.account = { address: this.accountV6.address };
            return this.account;
        }
        catch (err) {
            throw new WalletActionError("connect", err instanceof Error ? err.message : "Wallet connection failed.", err);
        }
    }
    async publicBalance(token) {
        const info = resolveToken(token, this.registry);
        const { RpcProvider } = (await import("starknet"));
        this.provider ??= new RpcProvider({ nodeUrl: this.rpcUrl });
        const result = await this.provider.callContract({
            contractAddress: info.address,
            entrypoint: "balanceOf",
            calldata: [this.requireAddress()],
        });
        const low = BigInt(result[0] ?? "0x0");
        const high = BigInt(result[1] ?? "0x0");
        return unitsToAmount(low + (high << 128n), info.decimals);
    }
    async shieldedBalance(token) {
        const info = resolveToken(token, this.registry);
        this.requireAddress();
        try {
            // wallet_strk20Balances via WalletAccountV6. The wallet may ask the user
            // for consent: only call this once a payment flow has actually started.
            const entries = await this.accountV6.strk20Balances([info.address]);
            const entry = entries.find((e) => BigInt(e.token) === BigInt(info.address));
            return unitsToAmount(BigInt(entry?.balance ?? "0x0"), info.decimals);
        }
        catch {
            // The wallet declined to report. Say UNKNOWN: answering zero here would
            // make the caller shield funds the user has already shielded.
            return null;
        }
    }
    /**
     * Read the pool's flat fee. It is a real charge that no STRK20 documentation
     * mentions: we found it by calling the contract. Cached because it does not
     * move, and returned as null rather than zero when unreadable, so a caller
     * can say "unknown" instead of quietly promising the payer too low a total.
     */
    async poolFee(token) {
        const info = resolveToken(token, this.registry);
        if (this.feeCache !== undefined)
            return this.feeCache;
        try {
            const { RpcProvider } = (await import("starknet"));
            this.provider ??= new RpcProvider({ nodeUrl: this.rpcUrl });
            const res = await this.provider.callContract({
                contractAddress: POOL_ADDRESS[this.network],
                entrypoint: "get_fee_amount",
                calldata: [],
            });
            const low = BigInt(res[0] ?? "0x0");
            const high = BigInt(res[1] ?? "0x0");
            this.feeCache = unitsToAmount(low + (high << 128n), info.decimals);
        }
        catch {
            this.feeCache = null;
        }
        return this.feeCache;
    }
    async shield(token, amount) {
        const result = await this.invoke("shield", this.actionsShield(token, amount));
        this.shieldedAtBlock = await this.blockOfTx(result.txHash).catch(() => null);
        return result;
    }
    /**
     * Wait until the notes created by our last shield are spendable. Without this
     * a payment fires one block after the deposit and cannot succeed, because a
     * pool note only matures after MATURITY_BLOCKS.
     */
    async awaitMaturity(onProgress) {
        const start = this.shieldedAtBlock;
        if (start === null)
            return;
        const target = start + MATURITY_BLOCKS;
        const deadline = Date.now() + 15 * 60_000;
        while (Date.now() < deadline) {
            const head = await this.currentBlock().catch(() => null);
            if (head !== null) {
                const left = target - head;
                if (left <= 0)
                    return;
                onProgress?.(left);
            }
            await new Promise((r) => setTimeout(r, 5_000));
        }
        // Falling through is deliberate: let the payment attempt produce the real
        // error rather than inventing one from a timer.
    }
    async blockOfTx(txHash) {
        const { RpcProvider } = (await import("starknet"));
        this.provider ??= new RpcProvider({ nodeUrl: this.rpcUrl });
        for (let i = 0; i < 30; i++) {
            const receipt = await this.provider.getTransactionReceipt(txHash).catch(() => null);
            const block = receipt?.block_number;
            if (typeof block === "number")
                return block;
            await new Promise((r) => setTimeout(r, 4_000));
        }
        return null;
    }
    async currentBlock() {
        const { RpcProvider } = (await import("starknet"));
        this.provider ??= new RpcProvider({ nodeUrl: this.rpcUrl });
        return this.provider.getBlockNumber();
    }
    async privateTransfer(token, amount, toPoolAddress) {
        return this.invoke("privateTransfer", this.actionsTransfer(token, amount, toPoolAddress));
    }
    async unshield(token, amount, toAddress) {
        return this.invoke("unshield", this.actionsWithdraw(token, amount, toAddress));
    }
    /** Action builders are pure and exported for tests. */
    actionsShield(token, amount) {
        const info = resolveToken(token, this.registry);
        return [{ type: "deposit", token: info.address, amount: amountToFelt(amount, info.decimals) }];
    }
    actionsTransfer(token, amount, recipient) {
        const info = resolveToken(token, this.registry);
        return [
            { type: "transfer", token: info.address, amount: amountToFelt(amount, info.decimals), recipient },
        ];
    }
    actionsWithdraw(token, amount, recipient) {
        const info = resolveToken(token, this.registry);
        return [
            { type: "withdraw", token: info.address, amount: amountToFelt(amount, info.decimals), recipient },
        ];
    }
    async invoke(action, actions) {
        this.requireAddress();
        try {
            const { transaction_hash } = await this.accountV6.strk20InvokeTransaction(actions);
            return { txHash: transaction_hash };
        }
        catch (err) {
            throw new WalletActionError(action, explainWalletError(err, action), err);
        }
    }
    requireAddress() {
        if (!this.account)
            throw new WalletActionError("connect", "Wallet is not connected.");
        return this.account.address;
    }
}
/**
 * Turn a raw wallet error into something a payer can act on.
 *
 * The one everybody hits first is NOT_REGISTERED: every pool user publishes a
 * viewing key on-chain once, and until that lands the pool will not accept a
 * deposit. Wallets do it as part of their own first shield, so the fix is a
 * one-time action in the wallet rather than anything this app can sign for.
 */
export function explainWalletError(err, action) {
    const raw = err instanceof Error ? err.message : String(err ?? "");
    if (/NOT_REGISTERED/i.test(raw)) {
        return ("Your wallet is not registered with the privacy pool yet. This is a one-time step: " +
            "open your wallet, shield any amount there once (that publishes your viewing key on-chain), " +
            "wait about ten blocks, then come back and pay.");
    }
    if (/SCREENING|COMPLIANCE|BLOCKED/i.test(raw)) {
        return "The privacy pool's compliance screening rejected this deposit. Deposits are screened on every route.";
    }
    if (/INSUFFICIENT|BALANCE/i.test(raw)) {
        return `Not enough balance to ${action === "shield" ? "shield" : "pay"}, including fees.`;
    }
    if (/reject|denied|USER_REFUSED|cancel/i.test(raw)) {
        return "You dismissed the wallet prompt.";
    }
    return raw || `${action} failed in the wallet.`;
}
