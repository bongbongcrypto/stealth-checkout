import { revealReport } from "./honesty.js";
import { TOKENS, resolveToken } from "./tokens.js";
import { WalletActionError } from "./wallet/adapter.js";
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
export class StealthCheckout {
    wallet;
    confirmPayment;
    allowInlineShield;
    store;
    listeners = new Set();
    phase = "idle";
    /**
     * Record of a payment already broadcast, keyed by invoice. Confirmation can
     * fail while the money is genuinely gone (slow chain, flaky RPC), and the
     * payer then retries, or reloads the page. Either way the payment must not
     * be sent again, so this is persisted through `store` and survives a reload.
     */
    sentPayment = null;
    constructor(wallet, confirmPayment = alwaysConfirm, 
    /**
     * Shield inline when the payer has no shielded funds. OFF by default, and
     * that default is the protocol's own advice: a deposit is a public leg
     * naming the depositor, so shielding moments before paying lets an
     * observer correlate the two ends by amount and timing. Shielding ahead of
     * time, separately, is what makes the payment unlinkable. It is also
     * cheaper, since the pool charges a fee per deposit.
     */
    allowInlineShield = false, 
    /**
     * Where broadcast payments are remembered. Defaults to localStorage, so a
     * second tab cannot re-send either; pass your own for other hosts, or
     * `null` to opt out (a reload then risks paying twice).
     *
     * Note what that persists: invoice id, amount, recipient and tx hash, on
     * the page's origin, until cleared. On a shared origin such as
     * `<user>.github.io` that is readable by every other page the same account
     * publishes. A merchant hosting the checkout on their own domain has no
     * such neighbours; one embedding it on a shared host should pass a store
     * scoped the way they want it.
     */
    store = defaultStore()) {
        this.wallet = wallet;
        this.confirmPayment = confirmPayment;
        this.allowInlineShield = allowInlineShield;
        this.store = store;
    }
    on(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    /**
     * Honesty panel rows for this invoice, given current balances. The threshold
     * is amount + pool fee, the same one `pay` uses: judging by the amount alone
     * told a payer holding exactly the invoice amount that no public deposit was
     * coming, and then one was.
     */
    async preview(invoice) {
        if (!this.wallet.isConnected())
            return revealReport(invoice, true);
        const shielded = await this.wallet.shieldedBalance(invoice.token);
        const fee = (await this.wallet.poolFee?.(invoice.token)) ?? "0";
        const dp = decimalsOf(invoice.token);
        const willShieldFirst = shielded === null || compareAmounts(shielded, shieldedNeededFor(invoice.amount, fee, dp), dp) < 0;
        return revealReport(invoice, willShieldFirst);
    }
    async pay(invoice, opts = {}) {
        if (this.phase === "paid")
            this.phase = "idle"; // a settled instance is reusable
        if (this.phase !== "idle" && this.phase !== "failed" && this.phase !== "expired") {
            throw new Error(`A payment is already in progress (${this.phase}).`);
        }
        if (invoice.expiresAt && Date.now() > invoice.expiresAt) {
            this.emit("expired", "This invoice has expired. Ask the merchant for a fresh one.", false);
            throw new Error("Invoice expired.");
        }
        if (this.wallet.network !== invoice.network) {
            const msg = `This invoice is for ${invoice.network}, but the wallet is on ${this.wallet.network}.`;
            this.emit("failed", msg, false, undefined, msg);
            throw new Error(msg);
        }
        try {
            if (!this.wallet.isConnected()) {
                this.emit("connecting", "Your wallet will pop up to connect.", true);
                await this.wallet.connect();
            }
            // Already broadcast for this invoice? Never send again: only wait.
            // The record is matched on the terms of the payment, not just its id, so
            // a mutated invoice reusing an id cannot claim someone else's payment.
            // Check the in-memory record only if it is for THIS invoice: a stale one
            // for another invoice used to shadow the persisted lookup entirely, and
            // the payer paid an already-settled invoice a second time.
            const cached = this.sentPayment && matchesInvoice(this.sentPayment, invoice) ? this.sentPayment : null;
            const prior = cached ?? this.loadSent(invoice);
            if (prior && !prior.txHash) {
                // We asked a wallet to pay this invoice and never learned the outcome.
                // Ask the merchant first: they can see the chain, and if the money
                // arrived there is nothing left to do.
                this.emit("confirming", "Checking whether that earlier attempt went through…", false);
                const settled = await this.confirmPayment(invoice, "").catch(() => false);
                if (settled)
                    return this.finish(invoice, "", undefined);
                if (!opts.paidNothingLastTime) {
                    // Not settled is not proof that nothing was sent: a payment can be
                    // in flight. The payer is the only one who can look in their wallet,
                    // so this stops and hands them that decision instead of guessing.
                    // Without the escape they were locked out of the invoice forever.
                    throw new PendingPaymentError("This page asked your wallet to pay this invoice earlier and never learned the outcome, and the " +
                        "merchant does not see the money. Open your wallet and check its recent activity. If a payment " +
                        "went out, wait for it rather than paying again. If nothing did, choose to pay again below.");
                }
                this.clearPending(invoice);
            }
            if (prior) {
                this.emit("confirming", "Payment already sent. Waiting for on-chain confirmation…", false, prior.txHash);
                const ok = await this.confirmPayment(invoice, prior.txHash);
                if (!ok)
                    throw new Error("Still not confirmed on-chain. Your payment was sent once and has not been repeated.");
                return this.finish(invoice, prior.txHash, prior.shieldTxHash);
            }
            this.emit("preparing", "Checking your shielded balance…", false);
            const shielded = await this.wallet.shieldedBalance(invoice.token);
            let shieldTxHash;
            let txHash;
            if (shielded === null) {
                // The wallet would not report a balance. Try paying with what may
                // already be shielded rather than shielding blind: a needless deposit
                // costs a pool fee and publishes another public leg.
                try {
                    ({ txHash } = await this.payStep(invoice));
                }
                catch (err) {
                    // Only an error that cannot have followed a broadcast may lead to a
                    // second attempt. "Not enough balance" is raised before anything is
                    // submitted, so it qualifies; anything else does not, and the
                    // pending marker written in payStep stays behind to say so.
                    if (!isInsufficientFunds(err))
                        throw err;
                    this.clearPending(invoice);
                    const fee = (await this.wallet.poolFee?.(invoice.token)) ?? "0";
                    shieldTxHash = await this.shieldOrExplain(invoice, undefined, fee);
                    ({ txHash } = await this.payStep(invoice));
                }
            }
            else {
                // Paying costs amount + fee out of the shielded balance. Gating on the
                // amount alone waved payers through who then hit an opaque wallet
                // error with the money still in the pool.
                const fee = (await this.wallet.poolFee?.(invoice.token)) ?? "0";
                const dp = decimalsOf(invoice.token);
                const needed = shieldedNeededFor(invoice.amount, fee, dp);
                if (compareAmounts(shielded, needed, dp) < 0) {
                    shieldTxHash = await this.shieldOrExplain(invoice, shielded, fee);
                }
                ({ txHash } = await this.payStep(invoice));
            }
            // Recorded the instant it is broadcast, before anything that can throw:
            // the money is already gone, and losing the record means paying twice.
            this.sentPayment = {
                invoiceId: invoice.id,
                amount: invoice.amount,
                token: invoice.token,
                recipient: invoice.receiveAddress ?? invoice.merchantPoolAddress ?? "",
                txHash,
                shieldTxHash,
            };
            this.saveSent(this.sentPayment);
            this.emit("confirming", "Payment sent. Waiting for on-chain confirmation…", false, txHash);
            const confirmed = await this.confirmPayment(invoice, txHash);
            if (!confirmed)
                throw new Error("The payment was not confirmed on-chain. It was sent once and will not be sent again.");
            return this.finish(invoice, txHash, shieldTxHash);
        }
        catch (err) {
            // A dismissed prompt or a refused amount means nothing was submitted, so
            // the marker must go: leaving it would tell the payer on their next
            // visit that money may already be gone when it plainly is not.
            if (didNotReachTheChain(err))
                this.clearPending(invoice);
            const message = err instanceof WalletActionError
                ? err.message
                : err instanceof Error
                    ? err.message
                    : "Payment failed for an unknown reason.";
            this.emit("failed", message, false, undefined, message);
            this.listeners.forEach((l) => l({ type: "failed", error: message, phase: this.phase }));
            throw err;
        }
    }
    storeKey(invoiceId) {
        return `strk20-pay.sent.${this.wallet.network}.${invoiceId}`;
    }
    /**
     * A stored record only counts if it settles THIS invoice. The key is scoped
     * by id, which is not enough on its own: an id can be reused with a
     * different amount or recipient, and returning it unchecked would treat the
     * new, larger invoice as already paid.
     */
    loadSent(invoice) {
        try {
            const raw = this.store?.getItem(this.storeKey(invoice.id));
            if (!raw)
                return null; // "" is a cleared marker, and falsy on purpose
            const record = JSON.parse(raw);
            return matchesInvoice(record, invoice) ? record : null;
        }
        catch {
            return null;
        }
    }
    /** Remember that a payment was requested, before it can possibly land. */
    markPending(invoice) {
        const record = {
            invoiceId: invoice.id,
            amount: invoice.amount,
            token: invoice.token,
            recipient: invoice.receiveAddress ?? invoice.merchantPoolAddress ?? "",
            txHash: "",
        };
        this.sentPayment = record;
        this.saveSent(record, { quiet: true });
    }
    /**
     * Forget the marker, once the wallet has made clear nothing was submitted.
     *
     * ONLY the marker. This used to blank the stored key unconditionally while
     * the in-memory guard beside it was careful, so a `confirm` that threw with
     * the word "invalid" anywhere in its text erased the durable record of a
     * payment that had genuinely been broadcast. The next tab found nothing and
     * paid again: the whole cross-tab guard, undone by one word of error text.
     */
    clearPending(invoice) {
        const stored = this.loadSent(invoice);
        if (stored?.txHash)
            return; // a real payment: this is not ours to forget
        if (this.sentPayment && !this.sentPayment.txHash)
            this.sentPayment = null;
        try {
            this.store?.setItem(this.storeKey(invoice.id), "");
        }
        catch {
            /* nothing to undo */
        }
    }
    saveSent(record, opts = {}) {
        if (!this.store)
            return opts.quiet ? undefined : this.warnUnprotected("no storage is available");
        if (isEphemeral(this.store) && !opts.quiet)
            this.warnUnprotected("this browser is not storing anything");
        try {
            this.store.setItem(this.storeKey(record.invoiceId), JSON.stringify(record));
        }
        catch (err) {
            // Never fail a payment that already landed. Do say so, though: without a
            // record, a reload can pay again.
            if (!opts.quiet)
                this.warnUnprotected(err instanceof Error ? err.message : "storage rejected the write");
        }
    }
    warnUnprotected(reason) {
        // Deliberately the failure styling, not the muted progress line. This is
        // the payer's only warning that a reload can spend their money twice, and
        // it used to render as one grey sentence under a green "confirming".
        this.emit("confirming", `DO NOT RELOAD THIS PAGE. Your payment was sent, but it could not be remembered (${reason}), ` +
            "so reloading would pay again. Wait here until the receipt appears.", false, this.sentPayment?.txHash, undefined, "warning");
    }
    /**
     * Either shield inline (opt-in) or stop and say why not. Refusing is the
     * privacy-preserving answer, so the message has to be genuinely useful.
     */
    async shieldOrExplain(invoice, shielded, fee = "0") {
        if (this.allowInlineShield)
            return this.shieldStep(invoice, fee, shielded);
        const dp = decimalsOf(invoice.token);
        const needed = shieldedNeededFor(invoice.amount, fee, dp);
        const deposit = depositNeededFor(invoice.amount, fee, dp, shielded ?? "0");
        const have = shielded !== undefined ? ` You have ${shielded} ${invoice.token} shielded right now.` : "";
        // Telling a payer the shielded figure alone sent them to deposit exactly
        // that, which credits one fee less and lands them back here with the same
        // message: an instruction that loops forever. Say what to send.
        const feeNote = compareAmounts(fee, "0") > 0
            ? ` The pool charges a flat ${fee} ${invoice.token} per operation and takes it out of a deposit, so send ${deposit} ${invoice.token} to end up with ${needed} spendable.`
            : "";
        throw new Error(`You need ${needed} ${invoice.token} shielded to pay this invoice.${have}${feeNote} ` +
            "Do it in your wallet, in one go and ahead of time: every deposit costs that fee again, " +
            "and a deposit made moments before a payment can be linked to it by amount and timing. " +
            "Wait about ten blocks after shielding, then come back to this invoice.");
    }
    finish(invoice, txHash, shieldTxHash) {
        // Whether anyone actually checked. The default confirm returns true
        // without looking, so a receipt that reads the same either way is telling
        // an integrator who forgot to wire a backend exactly what they want to
        // hear.
        const checked = this.confirmPayment !== alwaysConfirm;
        const receipt = {
            invoiceId: invoice.id,
            token: invoice.token,
            amount: invoice.amount,
            // The wallet decides which network the money moved on, not the invoice.
            network: this.wallet.network,
            mode: invoice.mode,
            txHash,
            shieldTxHash,
            confirmedAt: Date.now(),
            // Three things this string used to get wrong, all in eleven words.
            //
            // "Proves" was false: `confirmPayment` defaults to a function that
            // returns true, so an integrator who never wired a backend got a receipt
            // asserting proof of nothing. It now says who checked.
            //
            // "Does not link the payment to the payer's wallet" was contradicted on
            // the line above it, which prints the public deposit that names the
            // payer, and by the honesty panel that had just called a deposit made
            // moments before a payment the strongest link an observer can get.
            disclosure: [
                invoice.mode === "address"
                    ? checked
                        ? `Records that ${invoice.amount} ${invoice.token} reached this invoice's address.`
                        : `Records that this page asked your wallet to send ${invoice.amount} ${invoice.token} to this invoice's address. Nothing checked that it arrived.`
                    : `Records that a private note for ${invoice.amount} ${invoice.token} was sent.`,
                txHash ? "" : "The paying transaction's hash is not known to this page, so this receipt cannot point at it.",
                invoice.mode === "address"
                    ? "The paying transaction is submitted through the pool's relayers, so it does not name your wallet."
                    : "The transfer publishes no amount, sender or recipient.",
                shieldTxHash
                    ? "The deposit above is public and names you. Made this close to the payment, the two can be linked by amount and timing."
                    : "",
                "This is your record, not the merchant's: they confirm independently from the chain.",
            ]
                .filter(Boolean)
                .join(" "),
        };
        this.emit("paid", "Paid. Receipt ready.", false, txHash);
        this.listeners.forEach((l) => l({ type: "paid", receipt }));
        return receipt;
    }
    /** Shield, then block until the new notes are actually spendable. */
    async shieldStep(invoice, fee = "0", alreadyShielded) {
        // Two fees, not one: the pool takes its fee out of the deposit AND charges
        // it again on the payment. Depositing amount + fee credited exactly the
        // amount and then could not afford the payment, at any invoice size.
        const dp = decimalsOf(invoice.token);
        const deposit = depositNeededFor(invoice.amount, fee, dp, alreadyShielded ?? "0");
        const held = alreadyShielded && compareAmounts(alreadyShielded, "0", dp) > 0 ? alreadyShielded : null;
        const feeNote = compareAmounts(fee, "0") > 0
            ? held
                ? ` You already hold ${held} ${invoice.token} shielded, so this only tops up the difference, plus the pool's ${fee} fee on the deposit itself.`
                : ` That covers the ${invoice.amount} the merchant receives plus the pool's ${fee} fee twice: once on this deposit, once on the payment.`
            : "";
        this.emit("shielding", `Your wallet will pop up to shield ${deposit} ${invoice.token}. This deposit is public and screened.${feeNote}`, true);
        const { txHash } = await this.wallet.shield(invoice.token, deposit);
        this.emit("maturing", "Waiting for your shielded funds to mature (about ten blocks). Leave this page open.", false, txHash);
        await this.wallet.awaitMaturity?.((blocksLeft) => {
            this.emit("maturing", `Waiting for your shielded funds to mature: ${blocksLeft} block(s) to go. Leave this page open.`, false, txHash);
        });
        return txHash;
    }
    async payStep(invoice) {
        // Written BEFORE the wallet is asked to move anything. The record used to
        // be written after payStep resolved, so a wallet that submitted and never
        // returned - tab closed, extension killed, response lost - left the money
        // gone and no evidence, and the next page load paid again. A marker with
        // no hash means "we asked; we do not know what happened".
        this.markPending(invoice);
        this.emit("paying", invoice.mode === "address"
            ? "Your wallet will pop up to pay the invoice address privately."
            : "Your wallet will pop up to send a private note to the merchant.", true);
        return this.executePayment(invoice);
    }
    async executePayment(invoice) {
        if (invoice.mode === "address") {
            if (!invoice.receiveAddress)
                throw new Error("Invoice is missing its receive address.");
            return this.wallet.unshield(invoice.token, invoice.amount, invoice.receiveAddress);
        }
        if (!invoice.merchantPoolAddress)
            throw new Error("Invoice is missing the merchant pool address.");
        return this.wallet.privateTransfer(invoice.token, invoice.amount, invoice.merchantPoolAddress);
    }
    emit(phase, message, walletPopupImminent, txHash, error, severity) {
        this.phase = phase;
        const progress = { phase, message, walletPopupImminent, txHash, error, severity };
        this.listeners.forEach((l) => l({ type: "progress", progress }));
    }
}
/**
 * The one definition of a valid amount, shared by every helper here.
 *
 * It has to be shared. When `compareAmounts` accepted ".5" and `addAmounts`
 * rejected it, the same string passed the sufficiency check and then threw
 * partway through a payment. And when `addAmounts` silently truncated below
 * the token's precision while `compareAmounts` counted it, the two disagreed
 * about whether a dust amount was greater than zero.
 *
 * Rejected on purpose: "" (parses as 0 in most naive versions), ".5" and "5."
 * (ambiguous), "1e3" (exponent notation is not a decimal string), "-1", and
 * anything with more decimal places than the token can represent, because
 * truncating a payment amount without saying so is how a payer is short-changed.
 */
function parseAmount(x, decimals) {
    const s = String(x).trim();
    if (!/^\d+(\.\d+)?$/.test(s))
        throw new Error(`Not a valid amount: ${JSON.stringify(x)}`);
    const [ip = "0", fp = ""] = s.split(".");
    if (fp.length > decimals) {
        throw new Error(`Amount ${JSON.stringify(x)} has more than ${decimals} decimal places`);
    }
    return [(ip || "0").replace(/^0+(?=\d)/, ""), fp.replace(/0+$/, "")];
}
/**
 * The token's precision, or 18 for one not in the registry. An unregistered
 * token is already refused at the wallet boundary, so this only decides how
 * strictly an amount string is validated before we get there.
 */
function decimalsOf(token) {
    try {
        return resolveToken(token, TOKENS).decimals;
    }
    catch {
        return 18;
    }
}
/**
 * What a payer must DEPOSIT to end up able to pay this invoice.
 *
 * The pool charges its flat fee on every operation, and on a deposit it takes
 * that fee OUT of the deposit rather than on top of it: send X, get X - fee
 * credited. So paying an invoice of A out of a fresh deposit needs
 *
 *     deposit - fee >= A + fee   =>   deposit >= A + 2 x fee
 *
 * Shielding A + fee, which is what this used to do, credits exactly A and then
 * the payment needs A + fee. Short by one fee at every invoice size, every
 * time, with the money already public and in the pool. The ledger of this
 * project's own seven mainnet transactions is what settles the direction:
 * 20-6, -5-6, +5-6, +5-6, +20-6, -5-6, +5-6 = 3 STRK.
 */
export function depositNeededFor(amount, fee, decimals = 18, alreadyShielded = "0") {
    const needed = shieldedNeededFor(amount, fee, decimals);
    const shortfall = subAmounts(needed, alreadyShielded, decimals);
    if (compareAmounts(shortfall, "0", decimals) <= 0)
        return "0";
    // The shortfall, plus one fee for the deposit that delivers it. Ignoring
    // what the payer already holds quoted the full amount every time, and with
    // inline shielding on it deposited that much: a payer holding 5 of an 11
    // needed was asked for 17 instead of 12, and the extra 5 was stranded in the
    // pool behind another fee to get out.
    return addAmounts(shortfall, fee, decimals);
}
/** a - b, floored at zero. Same parser, same rules, no floats. */
export function subAmounts(a, b, decimals = 18) {
    const units = (x) => {
        const [ip, fp] = parseAmount(x, decimals);
        return BigInt(ip || "0") * 10n ** BigInt(decimals) + BigInt(fp.padEnd(decimals, "0") || "0");
    };
    const diff = units(a) - units(b);
    if (diff <= 0n)
        return "0";
    const one = 10n ** BigInt(decimals);
    const fp = (diff % one).toString().padStart(decimals, "0").replace(/0+$/, "");
    return fp ? `${diff / one}.${fp}` : (diff / one).toString();
}
/** What a payer must already hold shielded to pay this invoice outright. */
export function shieldedNeededFor(amount, fee, decimals = 18) {
    return addAmounts(amount, fee, decimals);
}
export function compareAmounts(a, b, decimals = 18) {
    const [ai, af] = parseAmount(a, decimals);
    const [bi, bf] = parseAmount(b, decimals);
    if (ai.length !== bi.length)
        return ai.length < bi.length ? -1 : 1;
    if (ai !== bi)
        return ai < bi ? -1 : 1;
    if (af === bf)
        return 0;
    const len = Math.max(af.length, bf.length);
    const ap = af.padEnd(len, "0");
    const bp = bf.padEnd(len, "0");
    return ap === bp ? 0 : ap < bp ? -1 : 1;
}
/**
 * Is this an error a wallet raises BEFORE submitting anything?
 *
 * Only these may clear the pending marker. Everything else - a timeout, a lost
 * response, a wallet that vanished - has to be treated as "it may have gone
 * through", because the alternative is telling a payer it is safe to pay again
 * when it is not.
 */
export function didNotReachTheChain(err) {
    const raw = err instanceof Error ? err.message : String(err ?? "");
    return (isInsufficientFunds(err) ||
        /dismissed the wallet prompt|user (rejected|refused|denied)|USER_REFUSED|is not connected|expired|invalid|missing its receive address|wrong network|is for (mainnet|sepolia)/i.test(raw));
}
/** Does this wallet error mean "you do not have enough shielded funds"? */
export function isInsufficientFunds(err) {
    const raw = err instanceof Error ? err.message : String(err ?? "");
    return /insufficient|not enough|no (unspent )?notes|balance too low|NOT_ENOUGH/i.test(raw);
}
/**
 * The default "confirmation", which confirms nothing. Named so the receipt can
 * tell whether a real check happened, and so the name shows up in a stack.
 */
const alwaysConfirm = async () => true;
/**
 * An earlier attempt may or may not have spent money, and nothing here can
 * tell. Distinct from a plain failure so a UI can offer the one action that
 * resolves it, instead of a Retry button that might pay twice.
 */
export class PendingPaymentError extends Error {
    needsPayerCheck = true;
    constructor(message) {
        super(message);
        this.name = "PendingPaymentError";
    }
}
function defaultStore() {
    const probe = "strk20-pay.probe";
    const usable = (get) => {
        try {
            const s = get();
            if (!s)
                return null;
            // Write-probe, then blank it. A custom store owes us getItem and setItem
            // and nothing more, so this cannot remove the key, but leaving "1" there
            // forever on someone's origin is litter.
            s.setItem(probe, "1");
            s.setItem(probe, "");
            return s;
        }
        catch {
            return null; // private mode, quota, or storage disabled entirely
        }
    };
    return (usable(() => (typeof localStorage === "undefined" ? undefined : localStorage)) ??
        usable(() => (typeof sessionStorage === "undefined" ? undefined : sessionStorage)) ??
        memoryStore);
}
/**
 * Last resort. Protects a retry inside one page load, which is the common
 * case, and cannot survive a reload: callers are told so, loudly.
 */
const memoryStore = (() => {
    const map = new Map();
    return {
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => void map.set(k, v),
    };
})();
/** True when the store cannot outlive this page load. */
function isEphemeral(store) {
    return store === memoryStore;
}
/**
 * Does a remembered payment settle THIS invoice? Same id is not enough: an id
 * can be reused with a different amount or recipient, and treating that as
 * already-paid would hand over goods for a payment that never covered them.
 */
export function matchesInvoice(sent, invoice) {
    try {
        const recipient = invoice.receiveAddress ?? invoice.merchantPoolAddress ?? "";
        return (sent.invoiceId === invoice.id &&
            sent.token === invoice.token &&
            sameFelt(sent.recipient, recipient) &&
            compareAmounts(sent.amount, invoice.amount) === 0);
    }
    catch {
        // A malformed record must not throw out of pay(): that used to leave the
        // payer unable to pay the invoice at all from this browser.
        return false;
    }
}
/**
 * Compare Starknet addresses by value. Text form is not canonical, and
 * comparing the strings made the SAME address re-rendered with different
 * padding or case look like a different one, so the payment went out twice.
 */
export function sameFelt(a, b) {
    try {
        return BigInt(a) === BigInt(b);
    }
    catch {
        return a === b;
    }
}
/** Add two decimal-string amounts exactly, with no float. */
export function addAmounts(a, b, decimals = 18) {
    const units = (x) => {
        const [ip, fp] = parseAmount(x, decimals);
        return BigInt(ip || "0") * 10n ** BigInt(decimals) + BigInt(fp.padEnd(decimals, "0") || "0");
    };
    const total = units(a) + units(b);
    const one = 10n ** BigInt(decimals);
    const ip = total / one;
    const fp = (total % one).toString().padStart(decimals, "0").replace(/0+$/, "");
    return fp ? `${ip}.${fp}` : ip.toString();
}
