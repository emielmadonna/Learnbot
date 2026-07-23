class FakeStyle {
  #values = new Map();
  display = "";

  setProperty(name, value) {
    this.#values.set(name, String(value));
  }

  getPropertyValue(name) {
    return this.#values.get(name) ?? "";
  }

  removeProperty(name) {
    const prior = this.#values.get(name) ?? "";
    this.#values.delete(name);
    return prior;
  }
}

class FakeClassList {
  #owner;

  constructor(owner) {
    this.#owner = owner;
  }

  toggle(name, force) {
    const names = new Set(this.#owner.className.split(/\s+/).filter(Boolean));
    const enabled = force ?? !names.has(name);
    if (enabled) names.add(name);
    else names.delete(name);
    this.#owner.className = [...names].join(" ");
    return enabled;
  }
}

class FakeElement extends EventTarget {
  constructor(tagName = "host") {
    super();
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = new FakeStyle();
    this.className = "";
    this.classList = new FakeClassList(this);
    this.hidden = false;
    this.value = "";
    this.textContent = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.isConnected = false;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node?.isFragment) {
        this.append(...node.children);
        continue;
      }
      if (node == null) continue;
      this.children.push(node);
      if (typeof node === "object") node.parentNode = this;
    }
    this.scrollHeight = this.children.length * 20;
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  setAttribute(name, value) {
    const prior = this.getAttribute(name);
    this.attributes.set(name, String(value));
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[key] = String(value);
    }
    const observed = this.constructor.observedAttributes;
    if (Array.isArray(observed) && observed.includes(name)) {
      this.attributeChangedCallback?.(name, prior, String(value));
    }
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  attachShadow() {
    const root = new FakeShadowRoot(this);
    this.shadowRoot = root;
    return root;
  }

  focus() {
    fakeDocument.activeElement = this;
  }

  click() {
    this.dispatchEvent(new Event("click"));
  }

  closest(selector) {
    if (selector === "button" && this.tagName === "BUTTON") return this;
    return this.parentNode?.closest?.(selector) ?? null;
  }

  setPointerCapture() {}
}

class FakeShadowRoot extends FakeElement {
  constructor(host) {
    super("#shadow-root");
    this.host = host;
  }
}

class FakeDocumentFragment extends FakeElement {
  constructor() {
    super("#fragment");
    this.isFragment = true;
  }
}

class FakeCustomElementRegistry {
  #definitions = new Map();

  define(name, constructor) {
    if (this.#definitions.has(name)) throw new Error("already_defined");
    this.#definitions.set(name, constructor);
  }

  get(name) {
    return this.#definitions.get(name);
  }
}

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.get(key) ?? null;
  }

  setItem(key, value) {
    this.#values.set(String(key), String(value));
  }

  removeItem(key) {
    this.#values.delete(key);
  }

  clear() {
    this.#values.clear();
  }

  key(index) {
    return [...this.#values.keys()][index] ?? null;
  }

  get length() {
    return this.#values.size;
  }
}

class FakeCustomEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    this.detail = init.detail;
  }
}

const registry = new FakeCustomElementRegistry();
const fakeDocument = {
  title: "Minimum Day",
  currentScript: null,
  activeElement: null,
  body: new FakeElement("body"),
  head: new FakeElement("head"),
  createElement(tagName) {
    const constructor = registry.get(tagName);
    return constructor ? new constructor() : new FakeElement(tagName);
  },
  createDocumentFragment() {
    return new FakeDocumentFragment();
  },
  querySelector() {
    return null;
  },
};

const windowEvents = new EventTarget();

export function installDomEnvironment({ width = 1200, height = 900 } = {}) {
  Object.assign(globalThis, {
    HTMLElement: FakeElement,
    ShadowRoot: FakeShadowRoot,
    CustomEvent: FakeCustomEvent,
    customElements: registry,
    document: fakeDocument,
    localStorage: new MemoryStorage(),
    location: { href: "https://learning.example/courses/momentum/minimum-day" },
    innerWidth: width,
    innerHeight: height,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
  });
  return {
    document: fakeDocument,
    storage: globalThis.localStorage,
    setViewport(nextWidth, nextHeight) {
      globalThis.innerWidth = nextWidth;
      globalThis.innerHeight = nextHeight;
      globalThis.dispatchEvent(new Event("resize"));
    },
  };
}

export { FakeElement, MemoryStorage };
