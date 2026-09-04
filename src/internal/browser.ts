/**
 * The browser runtime, inlined into every page. It is intentionally generic
 * and small: it knows nothing about the application.
 *
 * - opens a WebSocket to the page's own URL and reconnects with backoff
 * - replaces the page content on every `render` message, using a simple
 *   DOM morph so focus and form input survive re-renders
 * - delegates DOM events to elements carrying `data-lsc-<event>` and sends
 *   the handler id plus a small payload (value, checked, key, form fields)
 */
export const script: string = `
(function () {
  var root = document.querySelector("[data-lsc-root]");
  if (!root) return;
  var protocol = location.protocol === "https:" ? "wss:" : "ws:";
  var url = protocol + "//" + location.host + location.pathname + location.search;
  var ws = null;
  var delay = 250;

  function connect() {
    ws = new WebSocket(url);
    ws.onopen = function () {
      delay = 250;
      root.removeAttribute("data-lsc-disconnected");
    };
    ws.onmessage = function (event) {
      var message = JSON.parse(event.data);
      if (message.t === "render") patch(message.html);
    };
    ws.onclose = function () {
      root.setAttribute("data-lsc-disconnected", "");
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 5000);
    };
  }

  function patch(html) {
    var template = document.createElement("template");
    template.innerHTML = html;
    morphChildren(root, template.content);
  }

  function morphChildren(from, to) {
    var current = Array.prototype.slice.call(from.childNodes);
    var next = Array.prototype.slice.call(to.childNodes);
    for (var i = 0; i < next.length; i++) {
      if (i < current.length) {
        morph(current[i], next[i]);
      } else {
        from.appendChild(next[i]);
        autofocus(next[i]);
      }
    }
    for (var j = current.length - 1; j >= next.length; j--) from.removeChild(current[j]);
  }

  function morph(from, to) {
    if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) {
      from.replaceWith(to);
      autofocus(to);
      return;
    }
    if (from.nodeType === 3 || from.nodeType === 8) {
      if (from.data !== to.data) from.data = to.data;
      return;
    }
    if (from.nodeType !== 1) return;
    var i, attribute;
    var previous = Array.prototype.slice.call(from.attributes);
    for (i = 0; i < previous.length; i++) {
      attribute = previous[i];
      if (!to.hasAttribute(attribute.name)) {
        from.removeAttribute(attribute.name);
        sync(from, attribute.name, null);
      }
    }
    for (i = 0; i < to.attributes.length; i++) {
      attribute = to.attributes[i];
      if (from.getAttribute(attribute.name) !== attribute.value) {
        from.setAttribute(attribute.name, attribute.value);
        sync(from, attribute.name, attribute.value);
      }
    }
    if (from.nodeName === "TEXTAREA") {
      if (from.value !== to.textContent) from.value = to.textContent;
      return;
    }
    morphChildren(from, to);
  }

  function isTextual(element) {
    if (element.nodeName === "TEXTAREA") return true;
    if (element.nodeName !== "INPUT") return false;
    var type = element.type;
    return type !== "checkbox" && type !== "radio" && type !== "submit" && type !== "button" &&
      type !== "reset" && type !== "file" && type !== "range" && type !== "color";
  }

  // The server changed an attribute that also lives as a DOM property.
  // Mirror it, so server intent wins over what the user toggled. The one
  // exception is the text input being typed into: its value is the user's.
  function sync(element, name, value) {
    if (name === "value" && "value" in element) {
      if (element === document.activeElement && isTextual(element)) return;
      var next = value === null ? "" : value;
      if (element.value !== next) element.value = next;
    } else if (name === "checked" && "checked" in element) {
      element.checked = value !== null;
    } else if (name === "selected" && "selected" in element) {
      element.selected = value !== null;
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
