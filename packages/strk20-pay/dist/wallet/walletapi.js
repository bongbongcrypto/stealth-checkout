import { WalletActionError } from "./adapter.js";
import { TOKENS, amountToFelt, resolveToken, unitsToAmount } from "../tokens.js";
/** Wallet-API version that introduced the STRK20 methods (Ready, Xverse). */
export const MIN_STRK20_WALLET_API = "0.10.3";
export class WalletApiAdapter {
    network;
    rpcUrl;
    registry;
    preferWallet;
    discoveryTimeoutMs;
    account = null;
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
                const seen = wallets.map((w) => w.name).join(", ") || "none";
                throw new Error(`No STRK20-capable wallet found (detected: ${seen}). Install Ready X and enable Smart Wallet + Private.`);
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
        catch (err) {
            // A wallet that cannot report shielded balances still may pay; treat as
            // zero so the flow shields first rather than failing outright.
            return "0";
        }
    }
    async shield(token, amount) {
        return this.invoke("shield", this.actionsShield(token, amount));
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
            throw new WalletActionError(action, err instanceof Error ? err.message : `${action} failed in the wallet.`, err);
        }
    }
    requireAddress() {
        if (!this.account)
            throw new WalletActionError("connect", "Wallet is not connected.");
        return this.account.address;
    }
}
