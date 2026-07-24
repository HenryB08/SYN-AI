(function () {
  "use strict";

  /* SYN Growth widget shell. Runs on a client's site inside CSS we do not control.
     Isolation strategy: a custom-element host with all:initial + inline fixed
     positioning, a CLOSED shadow root, and every widget style scoped inside it.
     One namespaced global only. Idempotent: a second load is a no-op. No !important. */

  var NS = "__synGrowth";
  if (window[NS] && window[NS].loaded) return;   // second load on the same page = no-op
  var api = window[NS] = window[NS] || {};
  api.loaded = true;

  function warn(msg) { try { console.warn("[syn-growth widget] " + msg); } catch (e) {} }

  // ---- find our own <script> tag and read data-key + base URL ----
  var me = document.currentScript;
  if (!me) {
    var all = document.getElementsByTagName("script");
    for (var i = all.length - 1; i >= 0; i--) {
      if (all[i].src && all[i].src.indexOf("/w/widget.js") !== -1) { me = all[i]; break; }
    }
  }
  if (!me) { warn("could not locate the widget script tag; not rendering."); return; }

  var key = me.getAttribute("data-key") || "";
  if (!key) { warn("missing data-key; not rendering."); return; }

  var base;
  try { base = new URL(me.src, location.href).origin; }
  catch (e) { warn("could not resolve the widget origin; not rendering."); return; }

  var q = "?k=" + encodeURIComponent(key);

  // ---- config, then render. Any failure renders NOTHING (one warning). ----
  fetch(base + "/w/config" + q, { method: "GET", mode: "cors", credentials: "omit" })
    .then(function (r) {
      if (!r.ok) { warn("config request failed (" + r.status + "); not rendering."); return null; }
      return r.json();
    })
    .then(function (cfg) { if (cfg) render(cfg); })
    .catch(function () { warn("could not reach the widget backend; not rendering."); });

  // ---- helpers ----
  function safeColor(c) {
    // Only accept a small, safe set of color syntaxes (defense-in-depth against CSS injection).
    if (typeof c !== "string") return null;
    var s = c.trim();
    if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return s;
    if (/^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/i.test(s)) return s;
    if (/^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d+)\s*\)$/i.test(s)) return s;
    if (/^hsl\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*\)$/i.test(s)) return s;
    if (/^[a-z]{3,20}$/i.test(s)) return s;   // a named color
    return null;
  }
  function readableInk(hex) {
    // Pick black/white ink for a hex accent by luminance; fall back to white otherwise.
    var m = /^#([0-9a-f]{6})$/i.exec(hex) || /^#([0-9a-f]{3})$/i.exec(hex);
    if (!m) return "#fff";
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    var L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return L > 0.6 ? "#111" : "#fff";
  }

  function render(cfg) {
    if (api.mounted) return;   // guard against any double-invoke
    api.mounted = true;

    var conf = (cfg && cfg.config) || {};
    var brandName = (cfg && cfg.brand && cfg.brand.name) || "Chat";
    var installId = (cfg && cfg.install_id) || "anon";
    var accent = safeColor(conf.accent) || "#111111";
    var ink = readableInk(accent);
    var greeting = typeof conf.greeting === "string" && conf.greeting ? conf.greeting : "Hi! How can we help?";
    var side = conf.position === "bottom-left" ? "left" : "right";

    // ---- host element: dodges tag/class selectors, all:initial, fixed, near-max z-index ----
    var host = document.createElement("syn-growth-root");
    var hs = host.style;
    hs.all = "initial";
    hs.position = "fixed";
    hs.top = "0";
    hs.left = "0";
    hs.width = "0";
    hs.height = "0";
    hs.margin = "0";
    hs.padding = "0";
    hs.border = "0";
    hs.zIndex = "2147483000";   // just under the 2147483647 max, leaving headroom
    hs.colorScheme = "light";

    var root = host.attachShadow({ mode: "closed" });
    if (api.expose) api.expose(host, root);   // test-only hook (never set in production)

    // ---- styles, fully scoped inside the shadow root ----
    var style = document.createElement("style");
    style.textContent = [
      ":host{ all: initial; }",
      "*{ box-sizing: border-box; }",
      ".wrap{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;",
      "  font-size: 14px; line-height: 1.45; color: #1a1a1a; -webkit-font-smoothing: antialiased; }",
      // launcher
      ".launcher{ position: fixed; bottom: 20px; " + side + ": 20px; width: 56px; height: 56px;",
      "  border-radius: 999px; border: 0; cursor: pointer; display: flex; align-items: center;",
      "  justify-content: center; background: " + accent + "; color: " + ink + ";",
      "  box-shadow: 0 4px 16px rgba(0,0,0,.22); transition: transform .15s ease, box-shadow .15s ease; }",
      ".launcher:hover{ transform: translateY(-1px); box-shadow: 0 6px 20px rgba(0,0,0,.28); }",
      ".launcher:focus-visible{ outline: 2px solid " + accent + "; outline-offset: 3px; }",
      ".launcher svg{ width: 26px; height: 26px; display: block; }",
      ".hidden{ display: none !important; }",   // the ONE allowed !important: a local visibility toggle, not isolation
      // panel
      ".panel{ position: fixed; bottom: 20px; " + side + ": 20px; width: 380px; height: 600px;",
      "  max-width: calc(100vw - 40px); max-height: calc(100vh - 40px);",
      "  background: #fff; border-radius: 14px; border: 1px solid rgba(0,0,0,.08);",
      "  box-shadow: 0 12px 48px rgba(0,0,0,.24); display: flex; flex-direction: column; overflow: hidden; }",
      ".head{ display: flex; align-items: center; gap: 10px; padding: 14px 16px;",
      "  background: " + accent + "; color: " + ink + "; }",
      ".head .name{ font-weight: 600; font-size: 15px; flex: 1 1 auto; white-space: nowrap;",
      "  overflow: hidden; text-overflow: ellipsis; }",
      ".head .close{ background: transparent; border: 0; color: " + ink + "; cursor: pointer;",
      "  width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center;",
      "  opacity: .85; transition: opacity .15s ease, background .15s ease; }",
      ".head .close:hover{ opacity: 1; background: rgba(0,0,0,.12); }",
      ".head .close svg{ width: 18px; height: 18px; }",
      ".msgs{ flex: 1 1 auto; overflow-y: auto; padding: 16px; background: #fafafa; }",
      ".bubble{ max-width: 85%; padding: 10px 13px; border-radius: 12px; background: #fff;",
      "  border: 1px solid rgba(0,0,0,.07); margin-bottom: 10px; white-space: pre-wrap; word-wrap: break-word; }",
      ".composer{ display: flex; align-items: flex-end; gap: 8px; padding: 12px; border-top: 1px solid rgba(0,0,0,.08);",
      "  background: #fff; }",
      ".composer textarea{ flex: 1 1 auto; resize: none; max-height: 96px; min-height: 22px; border: 0; outline: 0;",
      "  font: inherit; color: #1a1a1a; background: transparent; padding: 8px 4px; }",
      ".composer .send{ flex: 0 0 auto; width: 36px; height: 36px; border-radius: 9px; border: 0; cursor: pointer;",
      "  background: " + accent + "; color: " + ink + "; display: flex; align-items: center; justify-content: center; }",
      ".composer .send:disabled{ opacity: .5; cursor: default; }",
      ".composer .send svg{ width: 18px; height: 18px; }",
      // mobile: full-screen panel below 480px
      "@media (max-width: 479px){",
      "  .panel{ inset: 0; width: 100%; height: 100%; max-width: 100%; max-height: 100%; border-radius: 0; border: 0; }",
      "  .launcher{ bottom: 16px; " + side + ": 16px; }",
      "}",
      "@media (prefers-reduced-motion: reduce){ .launcher, .head .close{ transition: none; } }"
    ].join("\n");
    root.appendChild(style);

    var wrap = document.createElement("div");
    wrap.className = "wrap";

    // ---- launcher ----
    var launcher = document.createElement("button");
    launcher.className = "launcher";
    launcher.type = "button";
    launcher.setAttribute("aria-label", brandName);
    launcher.innerHTML = "<svg viewBox='0 0 24 24' fill='none' aria-hidden='true'>" +
      "<path d='M4 5.5h16v10.5H8l-4 4V5.5z' stroke='currentColor' stroke-width='1.7' stroke-linejoin='round'/></svg>";

    // ---- panel ----
    var panel = document.createElement("div");
    panel.className = "panel hidden";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", brandName);

    var head = document.createElement("div");
    head.className = "head";
    var nm = document.createElement("div");
    nm.className = "name";
    nm.textContent = brandName;   // textContent, never innerHTML, for untrusted brand text
    var close = document.createElement("button");
    close.className = "close";
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = "<svg viewBox='0 0 24 24' fill='none' aria-hidden='true'>" +
      "<path d='M6 6l12 12M18 6L6 18' stroke='currentColor' stroke-width='1.8' stroke-linecap='round'/></svg>";
    head.appendChild(nm);
    head.appendChild(close);

    var msgs = document.createElement("div");
    msgs.className = "msgs";
    var greet = document.createElement("div");
    greet.className = "bubble";
    greet.textContent = greeting;   // textContent, never innerHTML
    msgs.appendChild(greet);

    var composer = document.createElement("div");
    composer.className = "composer";
    var ta = document.createElement("textarea");
    ta.setAttribute("rows", "1");
    ta.setAttribute("placeholder", "Type a message…");
    ta.setAttribute("aria-label", "Message");
    var send = document.createElement("button");
    send.className = "send";
    send.type = "button";
    send.setAttribute("aria-label", "Send");
    send.innerHTML = "<svg viewBox='0 0 24 24' fill='none' aria-hidden='true'>" +
      "<path d='M4 12l16-8-6 16-3-6-7-2z' stroke='currentColor' stroke-width='1.6' stroke-linejoin='round'/></svg>";
    // Sending is wired in Prompt 15. For now the composer is inert but present.
    send.disabled = false;
    composer.appendChild(ta);
    composer.appendChild(send);

    panel.appendChild(head);
    panel.appendChild(msgs);
    panel.appendChild(composer);

    wrap.appendChild(launcher);
    wrap.appendChild(panel);
    root.appendChild(wrap);
    document.body.appendChild(host);

    // ---- open/closed state, remembered for the SESSION only ----
    var openKey = "syn_gw_open_" + installId;
    var isOpen = false;
    function setOpen(v) {
      isOpen = !!v;
      if (isOpen) { panel.classList.remove("hidden"); launcher.classList.add("hidden"); ta.focus(); }
      else { panel.classList.add("hidden"); launcher.classList.remove("hidden"); }
      try { sessionStorage.setItem(openKey, isOpen ? "1" : "0"); } catch (e) {}
    }
    launcher.addEventListener("click", function () { setOpen(true); });
    close.addEventListener("click", function () { setOpen(false); });

    // Close on Escape.
    document.addEventListener("keydown", function (e) {
      if (isOpen && (e.key === "Escape" || e.keyCode === 27)) setOpen(false);
    });
    // Close on click outside. Clicks inside the closed shadow retarget to the host, so
    // any document-level click whose target is not our host is an "outside" click.
    document.addEventListener("click", function (e) {
      if (isOpen && e.target !== host) setOpen(false);
    });

    // restore session state (default closed)
    var prev = null;
    try { prev = sessionStorage.getItem(openKey); } catch (e) {}
    if (prev === "1") setOpen(true);

    // ---- log conversation_started exactly once per session ----
    logStarted(installId);
  }

  function logStarted(installId) {
    var sentKey = "syn_gw_started_" + installId;
    var idkKey = "syn_gw_cs_idk_" + installId;
    var already = null, idk = null;
    try { already = sessionStorage.getItem(sentKey); idk = sessionStorage.getItem(idkKey); } catch (e) {}
    if (already === "1") return;   // already logged this session; the stable idk also dedupes server-side
    if (!idk) {
      idk = "cs_" + installId + "_" + (
        (window.crypto && crypto.randomUUID) ? crypto.randomUUID() :
        (Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36))
      );
      try { sessionStorage.setItem(idkKey, idk); } catch (e) {}
    }
    fetch(base + "/w/events" + q, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "conversation_started", idempotency_key: idk, payload: { url: location.href } })
    }).then(function (r) {
      if (r && r.ok) { try { sessionStorage.setItem(sentKey, "1"); } catch (e) {} }
    }).catch(function () { /* logging is best-effort; never breaks the widget */ });
  }
})();
