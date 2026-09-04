/**
 * The browser runtime, inlined into every page. It is generic and knows
 * nothing about the application.
 *
 * - opens a WebSocket to the page's own URL and reconnects with backoff
 * - keeps the same statics/slots tree as the server (see `wire.ts`), merges
 *   each `render` patch into it, and updates only what the patch touched:
 *   nodes whose HTML is a single element carry an anchor (`data-lsc-n`,
 *   added here, never sent) so they can be located and morphed on their
 *   own with idiomorph, and a list whose keys changed is reconciled in
 *   place by key (existing elements are moved, new ones created, missing
 *   ones removed); focus and typed input survive
 * - delegates DOM events to elements carrying `data-lsc-<event>` and sends
 *   the handler id plus a small payload (value, checked, key, form fields)
 */
import { idiomorph } from "./idiomorph.ts"

/**
 * Tree merge, HTML regeneration and change collection. DOM-free, so tests
 * can run it as is against patches produced by the server.
 */
export const core: string = `
  var statics = Object.create(null);
  var rooted = Object.create(null);
  var changed = new Set();
  var hasOwn = Object.prototype.hasOwnProperty;

  function learn(f, patch) {
    if (patch.s) {
      statics[f] = patch.s;
      rooted[f] = patch.e === 1;
    }
  }

  function full(patch) {
    return merge(undefined, patch);
  }

  function fresh(f, slots) {
    var node = { f: f, d: slots.map(full) };
    changed.add(node);
    return node;
  }

  // The new key order of a list: drop removed and moved keys, then place
  // added and moved keys at their final index, ascending.
  function applyKeyOps(keys, removed, moved, added) {
    var gone = Object.create(null);
    var g;
    if (removed) for (g = 0; g < removed.length; g++) gone[removed[g]] = true;
    if (moved) for (g = 0; g < moved.length; g++) gone[moved[g]] = true;
    var result = [];
    for (var i = 0; i < keys.length; i++) if (!gone[keys[i]]) result.push(keys[i]);
    if (added) for (var a = 0; a < added.length; a++) result.splice(added[a][0], 0, added[a][1]);
    return result;
  }

  // Merges a patch into the current value, recording which nodes changed.
  // Inside a list, an item without its own fingerprint uses the list's
  // default one; \`owner\` is the node whose slot holds the value.
  function merge(current, patch, defaultF, owner) {
    if (typeof patch === "string") return patch;
    if (Array.isArray(patch)) return fresh(defaultF, patch);
    if (patch.k !== undefined || patch.r !== undefined || patch.m !== undefined || patch.a !== undefined || patch.i !== undefined) {
      var list = current && current.items ? current : { f: "", keys: [], items: Object.create(null) };
      var listF = patch.f !== undefined ? patch.f : list.f;
      learn(listF, patch);
      var reordered = patch.k !== undefined || patch.r !== undefined || patch.m !== undefined || patch.a !== undefined;
      var keys = patch.k !== undefined ? patch.k : reordered ? applyKeyOps(list.keys, patch.r, patch.m, patch.a) : list.keys;
      var items = Object.create(null);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var itemPatch = patch.i && hasOwn.call(patch.i, k) ? patch.i[k] : undefined;
        items[k] = itemPatch === undefined ? list.items[k] : merge(list.items[k], itemPatch, listF, owner);
        // a new item of a reordered list is inserted whole by the list
        // reconciliation, not morphed
        if (reordered && !(k in list.items)) changed.delete(items[k]);
      }
      var result = { f: listF, keys: keys, items: items };
      // remembered until the DOM is reconciled
      if (reordered && current && current.items) result.prev = list;
      return result;
    }
    var f = patch.f !== undefined ? patch.f : defaultF;
    learn(f, patch);
    if (patch.d !== undefined) return fresh(f, patch.d);
    var node = current && current.f === f ? current : { f: f, d: new Array(statics[f].length - 1) };
    for (var key in patch) {
      if (key === "f" || key === "s" || key === "e") continue;
      var before = node.d[+key];
      var after = merge(before, patch[key], undefined, node);
      node.d[+key] = after;
      if (typeof after === "string" && after !== before) changed.add(node);
    }
    return node;
  }

  // Regenerates HTML; \`path\` names the node so anchored ones get their id.
  function html(value, path) {
    if (typeof value === "string") return value;
    if (value.items) {
      var out = "";
      for (var i = 0; i < value.keys.length; i++) {
        var k = value.keys[i];
        out += html(value.items[k], path + ".k" + k);
      }
      return out;
    }
    var s = statics[value.f];
    var result = rooted[value.f] ? anchor(s[0], path) : s[0];
    for (var j = 0; j < value.d.length; j++) result += html(value.d[j], path + "." + j) + s[j + 1];
    return result;
  }

  function anchor(opening, path) {
    return opening.replace(/^(<[A-Za-z][^\\s/>]*)/, "$1 data-lsc-n=\\"" + path.replace(/"/g, "&quot;") + "\\"");
  }

  // The work to do after a merge: for each changed node, the nearest anchored
  // ancestor-or-self to morph; for each list whose keys changed, a
  // reconciliation. Descendants of a morph target are covered by it.
  function collect(node, path, anchorDesc, targets) {
    var self = rooted[node.f] ? { node: node, path: path, up: anchorDesc } : anchorDesc;
    if (!self) self = { node: node, path: path, up: null };
    if (changed.has(node)) {
      targets.push(self);
      return;
    }
    for (var i = 0; i < node.d.length; i++) {
      var v = node.d[i];
      if (typeof v === "string") continue;
      if (v.items) {
        if (v.prev) targets.push({ list: v, path: path + "." + i, up: self });
        for (var j = 0; j < v.keys.length; j++) {
          var k = v.keys[j];
          collect(v.items[k], path + "." + i + ".k" + k, self, targets);
        }
      } else {
        collect(v, path + "." + i, self, targets);
      }
    }
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
      rooted = Object.create(null);
      anchors = new Map();
      root.removeAttribute("data-lsc-disconnected");
    };
    ws.onmessage = function (event) {
      var message = JSON.parse(event.data);
      if (message.t === "render") apply(message.p);
    };
    ws.onclose = function () {
      root.setAttribute("data-lsc-disconnected", "");
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 5000);
    };
  }

  var morphOptions = {
    // The text input being typed into keeps the user's value.
    ignoreActiveValue: true,
    callbacks: { afterNodeAdded: autofocus, beforeNodeRemoved: forget }
  };

  // Anchored elements by path. A hit is verified, since a morph may have
  // replaced the element; removed subtrees are forgotten so nothing leaks.
  var anchors = new Map();

  function find(path) {
    var cached = anchors.get(path);
    if (cached && cached.isConnected && cached.getAttribute("data-lsc-n") === path) return cached;
    var element = root.querySelector('[data-lsc-n="' + CSS.escape(path) + '"]');
    if (element) anchors.set(path, element);
    else anchors.delete(path);
    return element;
  }

  function forget(node) {
    if (node.nodeType !== 1) return;
    if (node.hasAttribute("data-lsc-n")) anchors.delete(node.getAttribute("data-lsc-n"));
    var inner = node.querySelectorAll("[data-lsc-n]");
    for (var i = 0; i < inner.length; i++) anchors.delete(inner[i].getAttribute("data-lsc-n"));
  }

  // Builds the element for a single-element node, or null.
  function build(node, path) {
    if (!rooted[node.f]) return null;
    var template = document.createElement("template");
    template.innerHTML = html(node, path);
    var content = template.content;
    return content.childNodes.length === 1 && content.firstChild.nodeType === 1 ? content.firstChild : null;
  }

  // Reconciles a list in place by key: moves kept elements, inserts new
  // ones, removes the rest. Returns false when it cannot, in which case the
  // caller morphs the nearest anchored ancestor instead.
  function reconcile(target) {
    var previous = target.list.prev;
    var next = target.list;
    if (previous.keys.length === 0) return false;
    var elements = Object.create(null);
    var parent = null;
    for (var i = 0; i < previous.keys.length; i++) {
      var k = previous.keys[i];
      var element = find(target.path + ".k" + k);
      if (!element || (parent && element.parentNode !== parent)) return false;
      parent = element.parentNode;
      elements[k] = element;
    }
    var created = [];
    for (var j = 0; j < next.keys.length; j++) {
      var key = next.keys[j];
      if (elements[key]) continue;
      var built = build(next.items[key], target.path + ".k" + key);
      if (!built) return false;
      elements[key] = built;
      created.push(built);
    }
    var cursor = elements[previous.keys[0]];
    for (var n = 0; n < next.keys.length; n++) {
      var node = elements[next.keys[n]];
      if (node === cursor) cursor = cursor.nextSibling;
      else parent.insertBefore(node, cursor);
    }
    for (var m = 0; m < previous.keys.length; m++) {
      var old = previous.keys[m];
      if (!(old in next.items)) {
        forget(elements[old]);
        elements[old].remove();
      }
    }
    for (var c = 0; c < created.length; c++) autofocus(created[c]);
    return true;
  }

  function apply(patch) {
    changed = new Set();
    tree = merge(tree, patch, undefined, null);
    var targets = [];
    collect(tree, "r", null, targets);
    var nodes = [];
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      if (t.list) {
        var done = reconcile(t);
        delete t.list.prev;
        if (!done) nodes.push(t.up);
      } else {
        nodes.push(t);
      }
    }
    var morphs = [];
    for (var j = 0; j < nodes.length; j++) {
      var target = nodes[j];
      var element = null;
      // walk up until an anchor exists in the DOM; new nodes have none yet
      while (target.up !== null) {
        element = find(target.path);
        if (element) break;
        target = target.up;
      }
      if (target.up === null) {
        morphs = null;
        break;
      }
      morphs.push({ element: element, node: target.node, path: target.path });
    }
    changed = new Set();
    if (morphs === null) {
      anchors = new Map();
      Idiomorph.morph(root, html(tree, "r"), Object.assign({ morphStyle: "innerHTML" }, morphOptions));
      return;
    }
    for (var m = 0; m < morphs.length; m++) {
      var current = morphs[m];
      var covered = false;
      for (var n = 0; n < morphs.length && !covered; n++) {
        covered = n !== m && morphs[n].element !== current.element && morphs[n].element.contains(current.element);
      }
      if (covered || !current.element.isConnected) continue;
      Idiomorph.morph(current.element, html(current.node, current.path), Object.assign({ morphStyle: "outerHTML" }, morphOptions));
    }
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
