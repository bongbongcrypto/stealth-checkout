// The widget had no automated tests while carrying the defects an audit found:
// hashes overflowing the card, a pool fee nobody was told about, an honesty
// panel collapsed under the button, and links to explorers that 404. Each test
// here pins one of those.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "./dom.mjs";

let host;
beforeEach(() => {
  ({ host } = installDom());
});

// Imported after installDom so module-level DOM access, if any, sees the fake.
const { mountCheckout } = await import("../dist/ui.js");
const { MockWallet } = await import("../dist/wallet/mock.js");

const invoice = (over = {}) => ({
  id: "inv_1",
  token: "STRK",
  amount: "10",
  mode: "address",
  receiveAddress: "0x0abc0000000000000000000000000000000000000000000000000000000def",
  network: "sepolia",
  createdAt: Date.now(),
  ...over,
});

/** Let the widget's own async work (fee lookup, preview) settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * Never await a payment forever. A refused payment resolves nothing, so a
 * missing `allowInlineShield` used to hang the whole suite instead of failing
 * with a message that says which promise is stuck.
 */
const withTimeout = (promise, label, ms = 5000) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms).unref?.()),
  ]);

/**
 * A store per test. Without it, the widget correctly recognises the payment an
 * EARLIER test in this file already made for invoice "inv_1" and goes straight
 * to the receipt: right behaviour, wrong test. That it happens at all is the
 * cross-tab double-pay guard working.
 */
const freshStore = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
};

const confirmRows = (root) => {
  const dl = root.find("spay-confirm");
  const out = {};
  for (let i = 0; i < dl.children.length; i += 2) {
    out[dl.children[i].textContent] = dl.children[i + 1].textContent;
  }
  return out;
};

test("the payer is shown the total, the fee, and the destination before signing", async () => {
  const wallet = new MockWallet({ funded: { STRK: "100" }, latency: 0 });
  mountCheckout(host, { invoice: invoice(), wallet, store: freshStore() });
  await settle();

  const rows = confirmRows(host);
  assert.equal(rows["Merchant receives"], "10 STRK");
  assert.equal(rows["Pool fee"], "6 STRK per operation");
  assert.equal(rows["Network"], "Starknet sepolia");
  assert.match(rows["To"], /^0x0abc00/);

  // The total has its own block, set large. As a 12px row in this table it was
  // the same size as its own label, which is no way to show the number someone
  // is agreeing to, and unreadable once a screen recording has been compressed.
  const total = host.find("spay-total");
  assert.equal(total.find("spay-total-value").textContent, "16 STRK");

  // Before connecting, the widget does not KNOW which case applies. Stating the
  // worst case as the total overstated a 1 STRK arcade coin by 86% on the first
  // screen anyone sees, and the best case understates it the same way. So the
  // figure is the funded one and the other is named underneath, rather than one
  // sentence carrying two prices.
  const note = total.find("spay-total-note");
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /22 STRK if nothing is shielded yet/);
});

test("a fee larger than the invoice is called out, not buried", async () => {
  const wallet = new MockWallet({ funded: { STRK: "100" }, latency: 0 });
  mountCheckout(host, { invoice: invoice({ amount: "1" }), wallet, store: freshStore() });
  await settle();

  const warn = host.find("spay-fee-warn");
  assert.equal(warn.hidden, false, "a 6 STRK fee on a 1 STRK invoice must be surfaced");
  assert.match(warn.textContent, /larger than this invoice/);
});

test("a payer who already holds shielded funds is quoted one fee, not two", async () => {
  const wallet = new MockWallet({ funded: { STRK: "100" }, shielded: { STRK: "50" }, latency: 0 });
  await wallet.connect();
  mountCheckout(host, { invoice: invoice(), wallet, store: freshStore() });
  await settle();
  await settle();

  const rows = confirmRows(host);
  assert.equal(rows["Pool fee"], "6 STRK");
  const total = host.find("spay-total");
  assert.equal(
    total.find("spay-total-value").textContent,
    "16 STRK",
    "10 to the merchant, 6 to the pool, no deposit leg",
  );
  // Nothing to warn about: they hold the funds, so there is no second fee.
  assert.equal(total.find("spay-total-note").hidden, true);
});

test("a fee smaller than the invoice does not nag", async () => {
  const wallet = new MockWallet({ funded: { STRK: "100" }, latency: 0 });
  mountCheckout(host, { invoice: invoice({ amount: "500" }), wallet, store: freshStore() });
  await settle();
  assert.equal(host.find("spay-fee-warn").hidden, true);
});

test("what the payment reveals is stated before the button, and in full after it", async () => {
  const wallet = new MockWallet({ funded: { STRK: "100" }, latency: 0 });
  mountCheckout(host, { invoice: invoice(), wallet, store: freshStore() });
  await settle();

  const root = host.children[0];
  const order = root.children.map((c) => c.className);
  assert.deepEqual(order, [
    "spay-amount",
    "spay-confirm",
    "spay-total",
    "spay-fee-warn",
    "spay-honesty-summary",
    "spay-btn",
    "spay-btn spay-btn-danger",
    "spay-status",
    "spay-honesty",
    "spay-receipt",
  ]);

  // A disclosure collapsed under the call to action is not a disclosure, so the
  // short version is above the button. The full list used to be there too, all
  // 985px of it, and a layout audit then found the button 699px below the fold
  // on a laptop and 1298 on a phone. Both halves of that matter, so both are
  // asserted here rather than left to whichever one someone edits next.
  const at = (name) => order.indexOf(name);
  assert.ok(at("spay-honesty-summary") < at("spay-btn"), "the summary must precede the button");
  assert.ok(at("spay-total") < at("spay-btn"), "and so must the price");
  assert.ok(at("spay-honesty") > at("spay-btn"), "the full list belongs after it");

  const summary = root.find("spay-honesty-summary");
  assert.match(summary.textContent, /PUBLIC/, "the summary must name what is exposed");
  assert.match(summary.textContent, /HIDDEN/, "and what is not");

  // Still open. Nothing here is behind a click.
  assert.equal(root.find("spay-honesty").open, true);

  // And the pay-anyway escape must stay hidden until a payment is actually
  // pending: offered up front it is just a way to pay twice.
  assert.equal(root.findAll("spay-btn-danger")[0].hidden, true);
});

test("the honesty panel is still open, and still visible, once the receipt appears", async () => {
  const wallet = new MockWallet({ funded: { STRK: "100" }, latency: 0 });
  const paid = withTimeout(
    new Promise((resolve) => {
      mountCheckout(host, { invoice: invoice(), wallet, allowInlineShield: true, onPaid: resolve, store: freshStore() });
    }),
    "onPaid",
  );
  await settle();
  host.find("spay-btn").click();
  await paid;

  const panel = host.find("spay-honesty");
  assert.equal(panel.hidden, false, "the caveats must not vanish when the claim appears");
  assert.equal(panel.open, true, "and collapsing them is the same thing with extra steps");
});

test("a receipt says whether anything actually checked the payment", async () => {
  // The default confirm returns true without looking. A receipt that reads
  // identically either way tells an integrator who forgot to wire a backend
  // exactly what they want to hear.
  const wallet = new MockWallet({ funded: { STRK: "100" }, latency: 0 });
  const unchecked = withTimeout(
    new Promise((resolve) => {
      mountCheckout(host, { invoice: invoice(), wallet, allowInlineShield: true, onPaid: resolve, store: freshStore() });
    }),
    "onPaid",
  );
  await settle();
  host.find("spay-btn").click();
  const receiptA = await unchecked;
  assert.match(receiptA.disclosure, /Nothing checked that it arrived/);

  const { host: host2 } = installDom();
  const wallet2 = new MockWallet({ funded: { STRK: "100" }, latency: 0 });
  const checked = withTimeout(
    new Promise((resolve) => {
      mountCheckout(host2, {
        invoice: invoice(),
        wallet: wallet2,
        allowInlineShield: true,
        confirm: async () => true,
        onPaid: resolve,
        store: freshStore(),
      });
    }),
    "onPaid",
  );
  await settle();
  host2.find("spay-btn").click();
  const receiptB = await checked;
  assert.match(receiptB.disclosure, /Records that 10 STRK reached this invoice's address/);
  assert.doesNotMatch(receiptB.disclosure, /Nothing checked/);
});

test("a receipt links hashes only where they can actually be looked up", async () => {
  const wallet = new MockWallet({ funded: { STRK: "100" }, latency: 0 });
  const paid = withTimeout(
    new Promise((resolve) => {
      mountCheckout(host, { invoice: invoice(), wallet, allowInlineShield: true, onPaid: resolve, store: freshStore() });
    }),
    "onPaid",
  );
  await settle();
  host.find("spay-btn").click();
  await paid;

  const receipt = host.find("spay-receipt");
  assert.equal(receipt.hidden, false);
  // MockWallet's hashes exist on no chain, so the widget must not link them:
  // a link that resolves to a 404 looks like proof and is not.
  assert.equal(receipt.findTag("a").length, 0);
  const rows = receipt.findAll("spay-receipt-row").map((r) => r.textContent);
  assert.ok(rows.some((r) => r.startsWith("payment tx ")));
  // Shortened, so a 66-character hash cannot push the card open.
  assert.ok(rows.every((r) => r.length < 40), `rows too long: ${JSON.stringify(rows)}`);
});

test("with an explorer-aware wallet the same hashes become links", async () => {
  const wallet = new MockWallet({ funded: { STRK: "100" }, latency: 0 });
  wallet.explorerUrl = (kind, value) => `https://example.test/${kind}/${value}`;
  const paid = withTimeout(
    new Promise((resolve) => {
      mountCheckout(host, { invoice: invoice(), wallet, allowInlineShield: true, onPaid: resolve, store: freshStore() });
    }),
    "onPaid",
  );
  await settle();
  host.find("spay-btn").click();
  await paid;

  const links = host.find("spay-receipt").findTag("a");
  assert.ok(links.length >= 1);
  assert.match(links[0].attributes.href ?? links[0].href, /^https:\/\/example\.test\/tx\/0x/);
});

test("the button reports progress, and failure is announced assertively", async () => {
  const wallet = new MockWallet({ funded: { STRK: "0" }, latency: 0 });
  let failure = null;
  mountCheckout(host, { invoice: invoice(), wallet, onFailed: (e) => (failure = e), store: freshStore() });
  await settle();

  host.find("spay-btn").click();
  // Wait on the signal, not on a guess: a fixed sleep passes until the widget
  // gains one more await and then fails for reasons that have nothing to do
  // with what is being tested.
  await withTimeout(
    new Promise((resolve) => {
      const poll = setInterval(() => {
        if (failure) {
          clearInterval(poll);
          resolve();
        }
      }, 5);
    }),
    "onFailed",
  );

  const status = host.find("spay-status");
  // Inline shielding is off by default, so an unfunded payer must be refused
  // with an explanation rather than walked into a public deposit.
  assert.ok(failure, "an unfunded payment must fail loudly");
  assert.equal(status.getAttribute("aria-live"), "assertive");
  assert.ok(status.classList.contains("spay-status-error"));
  // And the button must come back, not sit dead.
  assert.equal(host.find("spay-btn").disabled, false);
  assert.match(host.find("spay-btn").textContent, /^Retry: /);
});

test("unmount removes the widget and stops listening", async () => {
  const wallet = new MockWallet({ funded: { STRK: "100" }, latency: 0 });
  const mounted = mountCheckout(host, { invoice: invoice(), wallet, store: freshStore() });
  await settle();
  assert.equal(host.children.length, 1);
  mounted.unmount();
  assert.equal(host.children.length, 0);
});

test("the React binding mounts once and survives re-renders with new callbacks", async () => {
  const { createCheckoutHook } = await import("../dist/react.js");

  // A fake React: enough to drive the hook's effect and dependency comparison.
  let effects = [];
  const refs = [];
  let refCursor = 0;
  const react = {
    useRef: (initial) => {
      if (refs.length <= refCursor) refs.push({ current: initial });
      return refs[refCursor++];
    },
    useEffect: (fn, deps) => effects.push({ fn, deps }),
  };
  const useCheckout = createCheckoutHook(react);

  const wallet = new MockWallet({ funded: { STRK: "100" }, latency: 0 });
  let paidSeen = 0;
  const render = () => {
    refCursor = 0;
    effects = [];
    // A brand-new arrow every render, as in real JSX.
    const ref = useCheckout({ invoice: invoice(), wallet, allowInlineShield: true, onPaid: () => paidSeen++ });
    ref.current = host;
    return { ref, effect: effects[0] };
  };

  const first = render();
  const cleanup = first.effect.fn();
  assert.equal(host.children.length, 1, "the widget mounted");

  const second = render();
  // Same invoice terms and same wallet: React would skip the effect, and the
  // widget must not be torn down mid-payment just because a parent re-rendered.
  assert.deepEqual(second.effect.deps, first.effect.deps);

  // The fresh onPaid must still be reached, through the ref rather than the
  // stale closure captured at mount.
  host.find("spay-btn").click();
  await withTimeout(
    new Promise((resolve) => {
      const poll = setInterval(() => {
        if (paidSeen > 0) {
          clearInterval(poll);
          resolve();
        }
      }, 5);
    }),
    "onPaid via ref",
  );
  assert.equal(paidSeen, 1, "the latest onPaid ran");

  cleanup();
  assert.equal(host.children.length, 0, "cleanup unmounted the widget");
});

test("changing the amount changes the effect's dependencies, so it remounts", async () => {
  const { createCheckoutHook } = await import("../dist/react.js");
  let effects = [];
  const refs = [];
  let cursor = 0;
  const useCheckout = createCheckoutHook({
    useRef: (initial) => {
      if (refs.length <= cursor) refs.push({ current: initial });
      return refs[cursor++];
    },
    useEffect: (fn, deps) => effects.push({ fn, deps }),
  });
  const wallet = new MockWallet({ funded: { STRK: "100" }, latency: 0 });
  const run = (amount) => {
    cursor = 0;
    effects = [];
    useCheckout({ invoice: invoice({ amount }), wallet });
    return effects[0].deps;
  };
  assert.notDeepEqual(run("10"), run("999"), "a repriced invoice must not keep the old widget");
});
