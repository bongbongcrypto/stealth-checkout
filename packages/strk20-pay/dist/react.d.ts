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
import { type MountOptions } from "./ui.js";
/** The two hooks this needs, passed in rather than imported. */
export interface ReactLike {
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
    useRef<T>(initial: T): {
        current: T;
    };
}
export type CheckoutHook = (opts: MountOptions) => {
    current: HTMLDivElement | null;
};
export declare function createCheckoutHook({ useEffect, useRef }: ReactLike): CheckoutHook;
