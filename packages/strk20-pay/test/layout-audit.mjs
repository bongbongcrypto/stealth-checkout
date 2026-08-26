// A layout audit that runs in a page and reports what is wrong with it.
//
// Written because a checkout was shipped whose pay button sat 699 pixels below
// the fold on a laptop and 1298 below it on a phone, and three rounds of
// clicking through the flow never noticed: whoever clicks already knows where
// the button is.
//
// Load it in a page and call `auditPage()`. Every rule returns a measurement,
// not an opinion, so the same check can be run again after a fix and answer
// the same way.

/** What each rule is protecting, so a failure explains itself. */
const RULES = {
  primaryVisible:
    "The main action must be reachable without scrolling. A judge who clicks and " +
    "sees nothing change assumes the demo is broken.",
  priceProminent:
    "The total is the number the payer agrees to, and in this product it is also " +
    "the finding worth the most. It cannot be set in the same size as its own label.",
  noSideScroll: "A page that scrolls sideways on a phone reads as unfinished.",
  tapTargets:
    "A discrete control smaller than 44px high is a miss on a touchscreen. WCAG " +
    "2.5.8 sets the floor at 24px and exempts links sitting inline in a sentence, " +
    "which cannot be enlarged without wrecking the line; buttons are held to the " +
    "44px of 2.5.5 because this one takes someone's money.",
  contrast: "Text below 4.5:1 against its background fails WCAG AA and disappears in a compressed video.",
  headingScale: "If the title, the body and the buttons are all one size, nothing leads the eye.",
  checkoutLength: "A payment box longer than three screens is a document, not a checkout.",
  hiddenIsHidden:
    "[hidden] is display:none in the browser's own stylesheet and any author rule " +
    "that sets display beats it. One label{display:block} kept an Amount field on " +
    "screen for a counter code that has no amount, and kept the previous code's QR " +
    "under a form that had moved on, which is how a shop prints the wrong one.",
};

const px = (v) => Number.parseFloat(v) || 0;

function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const parseRgb = (value) => {
  const m = /rgba?\(([^)]+)\)/.exec(value);
  if (!m) return null;
  const parts = m[1].split(",").map((n) => Number.parseFloat(n));
  if (parts.length >= 4 && parts[3] === 0) return null; // transparent
  return parts.slice(0, 3);
};

/** The nearest ancestor that actually paints a background. */
function backdrop(node, getComputedStyle, root) {
  let el = node;
  while (el && el !== root) {
    const c = parseRgb(getComputedStyle(el).backgroundColor);
    if (c) return c;
    el = el.parentElement;
  }
  return [0, 0, 0];
}

function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const makeVisible = (getComputedStyle) => (el) => {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
};

/**
 * @param {object} opts
 * @param {string} opts.primary   selector for the action the page exists for
 * @param {string} [opts.price]   selector for the total the payer agrees to
 * @param {string} [opts.checkout] selector for the payment box
 * @param {Window} [win] the window to measure; defaults to this one
 *
 * Taking the window as an argument is what lets the harness audit a page inside
 * an iframe. Reaching into the frame and evaluating a string there instead was
 * blocked outright by GitHub Pages' content security policy, so the harness
 * worked on a dev server and nowhere else, which is the wrong way round: the
 * deployed copy is the one a judge opens.
 */
export function auditPage(opts, win = globalThis) {
  const document = win.document;
  const innerWidth = win.innerWidth;
  const innerHeight = win.innerHeight;
  const getComputedStyle = (el) => win.getComputedStyle(el);
  const fails = [];
  const measured = {};
  const fail = (rule, detail) => fails.push({ rule, why: RULES[rule], detail });
  const visible = makeVisible(getComputedStyle);

  // 1. The action the page exists for, in the viewport.
  const primary = opts.primary ? document.querySelector(opts.primary) : null;
  if (!primary) {
    fail("primaryVisible", `no element matches ${opts.primary}`);
  } else {
    const r = primary.getBoundingClientRect();
    measured.primary = {
      label: primary.textContent.trim().slice(0, 40),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
    };
    // The WHOLE control, not a sliver of it. An earlier version of this rule
    // asked only whether the top edge was above the fold, and passed a button
    // showing nine of its forty-four pixels.
    // 16px of clearance, because a phone's address bar grows and shrinks as you
    // scroll and a button that ends one pixel inside the fold ends outside it on
    // the next device.
    const CLEAR = 16;
    if (r.bottom > innerHeight - CLEAR || r.top < 0) {
      fail(
        "primaryVisible",
        `"${measured.primary.label}" needs ${Math.max(0, Math.round(r.bottom - innerHeight + CLEAR))}px ` +
          `more room at ${innerWidth}x${innerHeight}; only ` +
          `${Math.max(0, Math.round(Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)))}px of its ` +
          `${Math.round(r.height)} is on screen`,
      );
    }
  }

  // 2. The total, larger than the text around it.
  if (opts.price) {
    const price = document.querySelector(opts.price);
    if (!price) fail("priceProminent", `no element matches ${opts.price}`);
    else {
      const size = px(getComputedStyle(price).fontSize);
      const body = px(getComputedStyle(document.body).fontSize);
      measured.priceFontSize = size;
      if (size < 20) fail("priceProminent", `the total is ${size}px; 20px is the floor for a video`);
      else if (size < body * 1.4) {
        fail("priceProminent", `the total is ${size}px against ${body}px body text, barely a difference`);
      }
    }
  }

  // 3. Anything the page says is hidden, actually gone.
  //
  // Measured rather than reasoned about: whether [hidden] wins depends on every
  // stylesheet that reaches the element, which for an embeddable widget includes
  // stylesheets nobody here has read.
  const leaking = [...document.querySelectorAll("[hidden]")]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && r.height > 0);
  measured.hiddenElements = document.querySelectorAll("[hidden]").length;
  if (leaking.length > 0) {
    fail(
      "hiddenIsHidden",
      leaking
        .map(
          ({ el, r }) =>
            `${el.id || el.className || el.tagName.toLowerCase()} is marked hidden and still ` +
            `${Math.round(r.width)}x${Math.round(r.height)} on screen ` +
            `(display: ${getComputedStyle(el).display})`,
        )
        .join("; "),
    );
  }

  // 4. Sideways scroll.
  measured.scrollWidth = document.documentElement.scrollWidth;
  if (document.documentElement.scrollWidth > innerWidth + 1) {
    fail("noSideScroll", `the page is ${document.documentElement.scrollWidth}px wide in a ${innerWidth}px viewport`);
  }

  // 5. Tap targets.
  //
  // A link inside a sentence is exempt, because making it 44px tall would break
  // the paragraph it lives in, and the standard says so. Everything a finger is
  // meant to aim at deliberately is not exempt.
  const inlineInSentence = (el) => {
    if (el.tagName !== "A") return false;
    if (!getComputedStyle(el).display.startsWith("inline")) return false;
    const parent = el.parentElement;
    if (!parent) return false;
    const own = el.textContent.trim();
    return parent.textContent.trim().length > own.length + 3;
  };
  const controls = [...document.querySelectorAll("button, a, input, select, summary")].filter(visible);
  // 2.5.8's exception is total, not a lower number: a link whose height is set
  // by the line it sits in cannot be grown without breaking the paragraph. The
  // count is reported so the exemption is visible rather than silent.
  const exempt = controls.filter(inlineInSentence);
  // Buttons and form controls are held to 44px, the AAA figure, because this is
  // a payment screen and a mis-tap there costs money or an abandoned purchase.
  // Standalone links get the AA figure of 24px: an explorer lookup is not the
  // interaction the product exists for.
  const floorFor = (el) => (el.tagName === "A" ? 24 : 44);
  const small = controls
    .filter((el) => !inlineInSentence(el))
    .map((el) => ({ el, r: el.getBoundingClientRect(), floor: floorFor(el) }))
    .filter(({ r, floor }) => r.height < floor || r.width < 24)
    .map(
      ({ el, r, floor }) =>
        `${el.tagName}"${el.textContent.trim().slice(0, 24)}" ` +
        `${Math.round(r.width)}x${Math.round(r.height)} (floor ${floor})`,
    );
  measured.controls = controls.length;
  measured.inlineLinksExempted = exempt.map((el) => el.textContent.trim().slice(0, 28));
  if (small.length > 0) fail("tapTargets", small.join("; "));

  // 5. Contrast, on text that carries meaning.
  const texty = [...document.querySelectorAll("p, span, div, strong, dt, dd, li, button, a, h1, h2, h3, summary")]
    .filter((el) => el.childElementCount === 0 && el.textContent.trim().length > 2)
    .filter(visible);
  const dim = [];
  for (const el of texty) {
    const fg = parseRgb(getComputedStyle(el).color);
    if (!fg) continue;
    const ratio = contrastRatio(fg, backdrop(el, getComputedStyle, document.documentElement));
    const size = px(getComputedStyle(el).fontSize);
    const bold = Number(getComputedStyle(el).fontWeight) >= 700;
    // WCAG treats 18.66px bold and 24px regular as large text.
    const floor = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    if (ratio < floor) {
      dim.push(`"${el.textContent.trim().slice(0, 30)}" ${ratio.toFixed(1)}:1 at ${size}px`);
    }
  }
  measured.textNodes = texty.length;
  if (dim.length > 0) fail("contrast", `${dim.length} below the floor: ${dim.slice(0, 6).join("; ")}`);

  // 6. Something has to be biggest.
  const heading = document.querySelector("h1");
  if (heading && visible(heading)) {
    const h = px(getComputedStyle(heading).fontSize);
    const body = px(getComputedStyle(document.body).fontSize);
    measured.headingFontSize = h;
    if (h < body * 1.6) fail("headingScale", `h1 is ${h}px against ${body}px body text`);
  }

  // 7. The payment box, in screens.
  if (opts.checkout) {
    const box = document.querySelector(opts.checkout);
    if (box) {
      const screens = box.getBoundingClientRect().height / innerHeight;
      measured.checkoutScreens = Number(screens.toFixed(2));
      if (screens > 3) fail("checkoutLength", `the checkout is ${screens.toFixed(1)} screens tall`);
    }
  }

  return { viewport: `${innerWidth}x${innerHeight}`, passed: fails.length === 0, fails, measured };
}
