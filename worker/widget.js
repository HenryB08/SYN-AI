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
      ".bubble.me{ margin-left: auto; background: " + accent + "; color: " + ink + "; border-color: transparent; }",
      ".typing{ display: inline-flex; gap: 4px; align-items: center; padding: 12px 13px; margin-bottom: 10px; }",
      ".typing span{ width: 6px; height: 6px; border-radius: 50%; background: #b8b8b8; animation: syn-gw-blink 1.2s infinite both; }",
      ".typing span:nth-child(2){ animation-delay: .2s; }",
      ".typing span:nth-child(3){ animation-delay: .4s; }",
      "@keyframes syn-gw-blink{ 0%,80%,100%{ opacity: .25; } 40%{ opacity: 1; } }",
      ".composer{ display: flex; align-items: flex-end; gap: 8px; padding: 12px; border-top: 1px solid rgba(0,0,0,.08);",
      "  background: #fff; }",
      ".composer textarea{ flex: 1 1 auto; resize: none; max-height: 96px; min-height: 22px; border: 0; outline: 0;",
      "  font: inherit; color: #1a1a1a; background: transparent; padding: 8px 4px; }",
      ".composer .send{ flex: 0 0 auto; width: 36px; height: 36px; border-radius: 9px; border: 0; cursor: pointer;",
      "  background: " + accent + "; color: " + ink + "; display: flex; align-items: center; justify-content: center; }",
      ".composer .send:disabled{ opacity: .5; cursor: default; }",
      ".composer .send svg{ width: 18px; height: 18px; }",
      // inline capture form
      ".capform{ border: 1px solid rgba(0,0,0,.1); border-radius: 12px; padding: 12px; margin-bottom: 10px; background: #fff; }",
      ".capform .cf-title{ font-weight: 600; font-size: 13px; margin-bottom: 8px; }",
      ".capform input{ width: 100%; box-sizing: border-box; border: 1px solid rgba(0,0,0,.15); border-radius: 8px;",
      "  padding: 8px 10px; font: inherit; margin-bottom: 8px; color: #1a1a1a; background: #fff; }",
      ".capform .cf-consent{ display: flex; gap: 8px; align-items: flex-start; font-size: 12px; color: #555; margin: 2px 0 10px; cursor: pointer; }",
      ".capform .cf-consent input{ width: auto; margin: 2px 0 0; flex: 0 0 auto; }",
      ".capform .cf-actions{ display: flex; gap: 8px; }",
      ".capform .cf-submit{ flex: 1 1 auto; border: 0; border-radius: 8px; padding: 9px 12px; cursor: pointer;",
      "  font: inherit; font-weight: 600; background: " + accent + "; color: " + ink + "; }",
      ".capform .cf-submit:disabled{ opacity: .5; cursor: default; }",
      ".capform .cf-skip{ flex: 0 0 auto; border: 1px solid rgba(0,0,0,.15); background: transparent;",
      "  border-radius: 8px; padding: 9px 12px; cursor: pointer; font: inherit; color: #555; }",
      ".capform .cf-err{ color: #c0392b; font-size: 12px; margin-bottom: 8px; }",
      // mobile: full-screen panel below 480px
      "@media (max-width: 479px){",
      "  .panel{ inset: 0; width: 100%; height: 100%; max-width: 100%; max-height: 100%; border-radius: 0; border: 0; }",
      "  .launcher{ bottom: 16px; " + side + ": 16px; }",
      "}",
      "@media (prefers-reduced-motion: reduce){ .launcher, .head .close{ transition: none; } .typing span{ animation: none; opacity: .5; } }"
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

    // ---- messaging: Enter sends, Shift+Enter newlines; visitor shows immediately, then typing, then reply ----
    var convKey = "syn_gw_conv_" + installId;
    var convId = null;
    try { convId = sessionStorage.getItem(convKey); } catch (e) {}
    var sending = false;
    var captured = false;   // once we have this visitor's details, stop offering the form
    var formEl = null;      // the inline capture form, when shown (at most one)

    function addBubble(kind, txt) {
      var b = document.createElement("div");
      b.className = kind === "me" ? "bubble me" : "bubble";
      b.textContent = txt;   // textContent, never innerHTML — visitor and model text are untrusted
      msgs.appendChild(b);
      msgs.scrollTop = msgs.scrollHeight;
      return b;
    }
    function showTyping() {
      var t = document.createElement("div");
      t.className = "typing";
      t.setAttribute("aria-label", "Assistant is typing");
      t.innerHTML = "<span></span><span></span><span></span>";
      msgs.appendChild(t);
      msgs.scrollTop = msgs.scrollHeight;
      return t;
    }
    // Every failure is copy, never a raw error — the widget must never look broken on a client's site.
    function failCopy(kind) {
      if (kind === "full") return "We've hit the length limit for this chat, but I'd be glad to connect you with our team — share your name and a good email or phone and we'll follow up.";
      if (kind === "rate") return "You're going a little faster than I can keep up with — give me a moment and try again, or leave your name and contact and our team will reach out.";
      return "Sorry, I'm having trouble responding right now. Leave your name and the best email or phone to reach you, and our team will follow up.";
    }
    function doSend() {
      if (sending) return;
      var txt = ta.value.trim();
      if (!txt) return;
      sending = true;
      send.disabled = true;
      addBubble("me", txt);
      ta.value = "";
      var typing = showTyping();
      fetch(base + "/w/messages" + q, {
        method: "POST", mode: "cors", credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: convId, text: txt })
      }).then(function (r) {
        return r.json().then(function (j) { return { status: r.status, body: j }; }, function () { return { status: r.status, body: {} }; });
      }).then(function (res) {
        if (typing.parentNode) typing.parentNode.removeChild(typing);
        var b = res.body || {};
        if (b.conversation_id) { convId = b.conversation_id; try { sessionStorage.setItem(convKey, convId); } catch (e) {} }
        if (res.status === 200 && typeof b.reply === "string" && b.reply) addBubble("bot", b.reply);
        else if (res.status === 409) addBubble("bot", failCopy("full"));
        else if (res.status === 429) addBubble("bot", failCopy("rate"));
        else addBubble("bot", failCopy("error"));
        if (b.captured) captured = true;                 // detection already stored details this turn
        if (b.offer_form) renderCaptureForm();           // assistant offered to connect — show the form
      }).catch(function () {
        if (typing.parentNode) typing.parentNode.removeChild(typing);
        addBubble("bot", failCopy("error"));
      }).then(function () {
        sending = false; send.disabled = false; ta.focus();
      });
    }
    send.addEventListener("click", doSend);
    ta.addEventListener("keydown", function (e) {
      if ((e.key === "Enter" || e.keyCode === 13) && !e.shiftKey) { e.preventDefault(); doSend(); }
    });

    // The explicit capture form. Submitting is a deliberate act; the consent checkbox is UNTICKED by
    // default and only a ticked box grants SMS consent. A phone typed in chat never implies consent.
    function renderCaptureForm() {
      if (captured || formEl) return;   // never nag: one at a time, and not once we have details
      var f = document.createElement("div");
      f.className = "capform";
      function input(type, ph, label) { var i = document.createElement("input"); i.type = type; i.placeholder = ph; i.setAttribute("aria-label", label); return i; }
      var title = document.createElement("div"); title.className = "cf-title"; title.textContent = "Share your details and we'll follow up";
      var name = input("text", "Name (optional)", "Name");
      var email = input("email", "Email", "Email");
      var phone = input("tel", "Phone (optional)", "Phone");
      var note = input("text", "Anything else? (optional)", "Note");
      var err = document.createElement("div"); err.className = "cf-err"; err.style.display = "none";
      var consent = document.createElement("label"); consent.className = "cf-consent";
      var cb = document.createElement("input"); cb.type = "checkbox";   // UNTICKED by default — never pre-ticked
      var cbText = document.createElement("span");
      cbText.textContent = "I agree to receive follow-up messages, including texts, from " + brandName + " about my inquiry. Message and data rates may apply.";
      consent.appendChild(cb); consent.appendChild(cbText);
      var actions = document.createElement("div"); actions.className = "cf-actions";
      var submit = document.createElement("button"); submit.type = "button"; submit.className = "cf-submit"; submit.textContent = "Send";
      var skip = document.createElement("button"); skip.type = "button"; skip.className = "cf-skip"; skip.textContent = "Not now";
      actions.appendChild(submit); actions.appendChild(skip);
      f.appendChild(title); f.appendChild(name); f.appendChild(email); f.appendChild(phone); f.appendChild(note);
      f.appendChild(err); f.appendChild(consent); f.appendChild(actions);
      msgs.appendChild(f); msgs.scrollTop = msgs.scrollHeight;
      formEl = f;
      function remove() { if (f.parentNode) f.parentNode.removeChild(f); if (formEl === f) formEl = null; }
      skip.addEventListener("click", remove);
      submit.addEventListener("click", function () {
        var em = email.value.trim(), ph = phone.value.trim();
        if (!em && !ph) { err.textContent = "Please add an email or phone so we can reach you."; err.style.display = "block"; return; }
        err.style.display = "none"; submit.disabled = true; skip.disabled = true;
        fetch(base + "/w/capture" + q, {
          method: "POST", mode: "cors", credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversation_id: convId, name: name.value.trim() || null, email: em || null, phone: ph || null, note: note.value.trim() || null, consent_sms: cb.checked })
        }).then(function (r) { return r.ok; }, function () { return false; }).then(function (okr) {
          if (okr) { captured = true; remove(); addBubble("bot", "Thanks! Someone from our team will be in touch soon."); }
          else { submit.disabled = false; skip.disabled = false; err.textContent = "Sorry, that didn't go through — please try again."; err.style.display = "block"; }
        });
      });
    }

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
