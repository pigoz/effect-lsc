/**
 * The browser runtime, inlined into every page. It is generic and knows
 * nothing about the application.
 *
 * - opens a WebSocket to the page's own URL and reconnects with backoff
 * - keeps the same statics/slots tree as the server (see `wire.ts`), merges
 *   each `render` patch into it, regenerates the HTML and morphs it into the
 *   page with idiomorph, so focus and typed input survive re-renders
 * - delegates DOM events to elements carrying `data-lsc-<event>` and sends
 *   the handler id plus a small payload (value, checked, key, form fields)
 */
import { idiomorph } from "./idiomorph.ts"

/**
 * Tree merge and HTML regeneration. DOM-free, so tests can run it as is
 * against patches produced by the server.
 */
export const core: string = `
  var statics = Object.create(null);
  var hasOwn = Object.prototype.hasOwnProperty;

  function full(patch) {
    return merge(undefined, patch);
  }

  // Merges a patch into the current value. Inside a list, an item without
  // its own fingerprint uses the list's default one.
  function merge(current, patch, defaultF) {
    if (typeof patch === "string") return patch;
    if (Array.isArray(patch)) return { f: defaultF, d: patch.map(full) };
    if (patch.k !== undefined || patch.i !== undefined) {
      var list = current && current.items ? current : { f: "", keys: [], items: Object.create(null) };
      var listF = patch.f !== undefined ? patch.f : list.f;
      if (patch.s) statics[listF] = patch.s;
      var keys = patch.k || list.keys;
      var items = Object.create(null);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var itemPatch = patch.i && hasOwn.call(patch.i, k) ? patch.i[k] : undefined;
        items[k] = itemPatch === undefined ? list.items[k] : merge(list.items[k], itemPatch, listF);
      }
      return { f: listF, keys: keys, items: items };
    }
    var f = patch.f !== undefined ? patch.f : defaultF;
    if (patch.s) statics[f] = patch.s;
    if (patch.d !== undefined) return { f: f, d: patch.d.map(full) };
    var node = current && current.f === f ? current : { f: f, d: new Array(statics[f].length - 1) };
    for (var key in patch) {
      if (key !== "f" && key !== "s") node.d[+key] = merge(node.d[+key], patch[key]);
    }
    return node;
  }

  function html(value) {
    if (typeof value === "string") return value;
    if (value.items) {
      var out = "";
      for (var i = 0; i < value.keys.length; i++) out += html(value.items[value.keys[i]]);
      return out;
    }
    var s = statics[value.f];
    var result = s[0];
    for (var j = 0; j < value.d.length; j++) result += html(value.d[j]) + s[j + 1];
    return result;
  }
`

export const script: string = `${idiomorph}
(function () {
  var root = document.querySelector("[data-lsc-root]");
  if (!root) return;
  ${core}
  var protocol = location.protocol === "https:" ? "wss:" : "ws:";
  var url = protocol + "//" + location.host + location.pathname + location.search;
  var ws = null;
  var tree = null;
  var delay = 250;

  function connect() {
    ws = new WebSocket(url);
    ws.onopen = function () {
      delay = 250;
      tree = null;
      statics = Object.create(null);
      root.removeAttribute("data-lsc-disconnected");
    };
    ws.onmessage = function (event) {
      var message = JSON.parse(event.data);
      if (message.t === "render") {
        tree = merge(tree, message.p);
        patch(html(tree));
      }
    };
    ws.onclose = function () {
      root.setAttribute("data-lsc-disconnected", "");
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 5000);
    };
  }

  function patch(markup) {
    Idiomorph.morph(root, markup, {
      morphStyle: "innerHTML",
      // The text input being typed into keeps the user's value.
      ignoreActiveValue: true,
      callbacks: { afterNodeAdded: autofocus }
    });
  }

  // Browsers only honour autofocus on page load; do it for inserted nodes too.
  function autofocus(node) {
    if (node.nodeType !== 1) return;
    var element = node.hasAttribute("autofocus") ? node : node.querySelector("[autofocus]");
    if (!element) return;
    element.focus();
    if (typeof element.setSelectionRange === "function" && typeof element.value === "string") {
      try {
        element.setSelectionRange(element.value.length, element.value.length);
      } catch (_) {}
    }
  }

  var events = ["click", "dblclick", "input", "change", "submit", "keydown", "keyup", "focus", "blur"];
  events.forEach(function (type) {
    document.addEventListener(type, function (event) {
      var element = event.target;
      while (element && element.nodeType === 1) {
        var id = element.getAttribute("data-lsc-" + type);
        if (id !== null) {
          dispatch(type, id, event, element);
          return;
        }
        element = element.parentNode;
      }
    }, true);
  });

  function dispatch(type, id, event, element) {
    if (type === "submit") event.preventDefault();
    var message = { t: "event", type: type, id: id };
    if (typeof element.value === "string") message.value = element.value;
    if (element.type === "checkbox" || element.type === "radio") message.checked = element.checked;
    if (typeof event.key === "string") message.key = event.key;
    if (type === "submit") {
      message.form = {};
      new FormData(element).forEach(function (value, name) {
        if (typeof value === "string") message.form[name] = value;
      });
    }
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
    // A native submit would navigate to a fresh page; a live submit resets
    // the form instead. The server re-renders any values it wants to keep.
    if (type === "submit") element.reset();
  }

  connect();
})();
`
