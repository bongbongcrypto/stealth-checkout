// A DOM small enough to read in one sitting, and real enough to mount the
// widget into. It exists so the widget's behaviour is asserted by tests rather
// than by someone clicking around: every defect the audit found in the UI was
// invisible to a test suite that never rendered anything.
//
// Deliberately not jsdom: this is ~120 lines with no install, and the widget
// only uses a handful of DOM calls. If it ever needs more than this, that is a
// signal the widget is doing too much.

class ClassList {
  constructor(el) {
    this.el = el;
  }
  get set() {
    return new Set((this.el.className || "").split(/\s+/).filter(Boolean));
  }
  add(...names) {
    const s = this.set;
    names.forEach((n) => s.add(n));
    this.el.className = [...s].join(" ");
  }
  remove(...names) {
    const s = this.set;
    names.forEach((n) => s.delete(n));
    this.el.className = [...s].join(" ");
  }
  contains(name) {
    return this.set.has(name);
  }
  toggle(name, force) {
    const on = force ?? !this.contains(name);
    if (on) this.add(name);
    else this.remove(name);
    return on;
  }
}

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.listeners = new Map();
    this.classList = new ClassList(this);
    this._text = "";
    this.focused = false;
  }

  // textContent replaces children, exactly like the real thing: the widget
  // relies on that to avoid ever interpolating untrusted values as markup.
  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }
  get textContent() {
    return this._text + this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
  }

  append(...nodes) {
    for (const n of nodes) {
      if (n && typeof n === "object") n.parentNode = this;
      this.children.push(n);
    }
  }
  after(...nodes) {
    if (!this.parentNode) return; // matches the real API: a detached node has nowhere to put them
    const i = this.parentNode.children.indexOf(this);
    this.parentNode.children.splice(i + 1, 0, ...nodes);
    for (const n of nodes) if (n && typeof n === "object") n.parentNode = this.parentNode;
  }
  replaceChildren(...nodes) {
    this.children = [];
    this._text = "";
    this.append(...nodes);
  }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  click() {
    // A real button does nothing when disabled, and a hidden one cannot be
    // clicked at all. Ignoring both meant no test could prove the pay /
    // pay-anyway gating worked, because every click landed regardless.
    if (this.disabled) return;
    if (this.hidden || this.hiddenByAncestor()) return;
    this.dispatch("click", {});
  }

  hiddenByAncestor() {
    let node = this.parentNode;
    while (node) {
      if (node.hidden) return true;
      node = node.parentNode;
    }
    return false;
  }
  focus() {
    this.focused = true;
  }

  /** Depth-first search by class name, for assertions. */
  find(className) {
    for (const c of this.children) {
      if (typeof c === "string") continue;
      if (c.classList.contains(className)) return c;
      const hit = c.find(className);
      if (hit) return hit;
    }
    return null;
  }
  findAll(className, out = []) {
    for (const c of this.children) {
      if (typeof c === "string") continue;
      if (c.classList.contains(className)) out.push(c);
      c.findAll(className, out);
    }
    return out;
  }
  findTag(tagName, out = []) {
    for (const c of this.children) {
      if (typeof c === "string") continue;
      if (c.tagName === tagName.toUpperCase()) out.push(c);
      c.findTag(tagName, out);
    }
    return out;
  }
}

/** Install a fake `document` globally and return the host to mount into. */
export function installDom() {
  const head = new El("head");
  globalThis.document = {
    createElement: (tag) => new El(tag),
    getElementById: () => null,
    head,
  };
  return { head, host: new El("div"), El };
}
