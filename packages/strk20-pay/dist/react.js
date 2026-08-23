/**
 * React binding. Deliberately not a rewrite of the widget in JSX: the widget is
 * plain DOM, and this mounts it into a ref and tears it down again. That keeps
 * exactly one implementation of the payment flow, so a fix to the honesty panel
 * or the fee display cannot land in one framework and miss the other.
 *
 * React is a peer dependency and is never imported here. Nothing in this file
 * touches the React runtime: it takes the two hooks it needs as arguments, so
 * `strk20-pay` stays installable in a project that has no React at all.
 *
 *   import { useEffect, useRef } from "react";
 *   import { createCheckoutHook } from "strk20-pay/react";
 *
 *   const useCheckout = createCheckoutHook({ useEffect, useRef });
 *
 *   function Pay({ invoice, wallet }) {
 *     const ref = useCheckout({ invoice, wallet, onPaid: (r) => console.log(r) });
 *     return <div ref={ref} />;
 *   }
 *
 * Keep `wallet` stable. It is in the effect's dependencies, because a
 * different wallet is a different payment, so constructing the adapter inline
 * (`wallet={new WalletApiAdapter(...)}`) makes a new one every render and
 * remounts the widget each time, which would tear down a payment in flight.
 * Build it once with `useMemo`, or above the component.
 */
import { mountCheckout } from "./ui.js";
export function createCheckoutHook({ useEffect, useRef }) {
    return function useCheckout(opts) {
        const hostRef = useRef(null);
        // Callbacks are usually inline arrows, so a new identity every render.
        // Reading them through a ref keeps the widget from being torn down and
        // remounted mid-payment, which would abandon a payment already broadcast.
        const latest = useRef(opts);
        latest.current = opts;
        useEffect(() => {
            const host = hostRef.current;
            if (!host)
                return;
            const mounted = mountCheckout(host, {
                ...opts,
                onPaid: (receipt) => latest.current.onPaid?.(receipt),
                onFailed: (error) => latest.current.onFailed?.(error),
                // Only when the consumer actually supplied one. Synthesising a wrapper
                // unconditionally made the core believe a real confirmation existed,
                // so the receipt told a React integrator who had wired no backend that
                // the money had arrived - the exact claim the check exists to withhold.
                ...(opts.confirm
                    ? { confirm: (invoice, txHash) => latest.current.confirm(invoice, txHash) }
                    : {}),
            });
            return () => mounted.unmount();
            // Remount only when the payment's own terms change. Depending on `opts`
            // would remount on every parent render.
            // Every field that changes what is paid, to whom, or under what terms.
            // `mode` and `expiresAt` were missing: flipping mode while both
            // addresses stayed the same kept the old widget, which then paid the
            // wrong destination.
        }, [
            opts.invoice.id,
            opts.invoice.amount,
            opts.invoice.token,
            opts.invoice.mode,
            opts.invoice.receiveAddress,
            opts.invoice.merchantPoolAddress,
            opts.invoice.network,
            opts.invoice.expiresAt,
            opts.wallet,
            opts.label,
            opts.allowInlineShield,
            opts.store,
        ]);
        return hostRef;
    };
}
