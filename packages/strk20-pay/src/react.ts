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
 */
import { mountCheckout, type MountOptions } from "./ui.js";

/** The two hooks this needs, passed in rather than imported. */
export interface ReactLike {
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useRef<T>(initial: T): { current: T };
}

export type CheckoutHook = (opts: MountOptions) => { current: HTMLDivElement | null };

export function createCheckoutHook({ useEffect, useRef }: ReactLike): CheckoutHook {
  return function useCheckout(opts: MountOptions) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    // Callbacks are usually inline arrows, so a new identity every render.
    // Reading them through a ref keeps the widget from being torn down and
    // remounted mid-payment, which would abandon a payment already broadcast.
    const latest = useRef(opts);
    latest.current = opts;

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      const mounted = mountCheckout(host, {
        ...opts,
        onPaid: (receipt) => latest.current.onPaid?.(receipt),
        onFailed: (error) => latest.current.onFailed?.(error),
        confirm: (invoice, txHash) =>
          latest.current.confirm ? latest.current.confirm(invoice, txHash) : Promise.resolve(true),
      });
      return () => mounted.unmount();
      // Remount only when the payment's own terms change. Depending on `opts`
      // would remount on every parent render.
    }, [
      opts.invoice.id,
      opts.invoice.amount,
      opts.invoice.token,
      opts.invoice.receiveAddress,
      opts.invoice.merchantPoolAddress,
      opts.invoice.network,
      opts.wallet,
      opts.label,
      opts.allowInlineShield,
    ]);

    return hostRef;
  };
}
