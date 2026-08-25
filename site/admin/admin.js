/* Althea content editor.
 *
 * The page being edited is loaded into a same-origin iframe straight from git,
 * so what you see is exactly what will be committed. All logic lives here in
 * the parent; nothing is injected into the page itself beyond a stylesheet for
 * the edit outlines, which is stripped again before saving.
 */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const norm = (s) => String(s).replace(/\s+/g, " ").trim();

  // An element is a text field when every element inside it is inline.
  const INLINE = new Set(["A", "SPAN", "STRONG", "EM", "B", "I", "U", "SMALL",
    "BR", "MARK", "SUP", "SUB", "ABBR", "TIME"]);
  const SKIP = new Set(["SCRIPT", "STYLE", "SVG", "CANVAS", "IFRAME", "NOSCRIPT",
    "TEXTAREA", "INPUT", "SELECT", "VIDEO", "AUDIO", "CODE", "PRE", "BASE",
    "LINK", "META", "TITLE"]);

  const CHROME_CSS = `
    html.ce-on [contenteditable]{outline:1px dashed rgba(74,93,78,.5);
      outline-offset:3px; border-radius:2px; transition:outline-color .15s}
    html.ce-on [contenteditable]:hover{outline-color:rgba(74,93,78,.9)}
    html.ce-on [contenteditable]:focus{outline:2px solid #4A5D4E;
      outline-offset:3px; background:rgba(74,93,78,.04)}
    @media print{html.ce-on [contenteditable]{outline:none !important}}`;

  const S = {
    session: null,
    baseline: new Map(),   // field id -> { text, section } as published
    fields: new Map(),     // field id -> element in the iframe
    editing: false,
    saved: null,           // serialized HTML as last committed
  };

  /* ------------------------------------------------------------------ api */

  async function api(action, body) {
    const res = await fetch(`/api/gh?action=${action}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || data.error || `virhe ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /* --------------------------------------------------------------- fields */

  function directText(el) {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.data;
    return t.trim();
  }

  function qualifies(el) {
    if (SKIP.has(el.tagName) || el.closest("[data-ce-chrome]")) return false;
    if (!norm(el.textContent)) return false;
    for (const c of el.children) if (!INLINE.has(c.tagName)) return false;
    // A bare row of links or spans (nav, price rows) is edited item by item
    // rather than as one run-together blob.
    if (el.children.length >= 2 && !directText(el)) return false;
    return true;
  }

  function collectFields(doc) {
    const out = [];
    (function walk(el) {
      for (const child of el.children) {
        if (SKIP.has(child.tagName)) continue;
        if (qualifies(child)) out.push(child);   // qualifying: do not descend
        else walk(child);
      }
    })(doc.body);
    return out;
  }

  /** Position-derived id, stable across save and reopen. */
  function fieldId(el) {
    const parts = [];
    for (let n = el; n && n.tagName !== "BODY"; n = n.parentElement) {
      let i = 1;
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) {
        if (s.tagName === n.tagName) i++;
      }
      parts.unshift(`${n.tagName.toLowerCase()}:${i}`);
    }
    return parts.join("/");
  }

  function sectionLabel(el) {
    for (let n = el; n && n.tagName !== "BODY"; n = n.parentElement) {
      if (/^(SECTION|HEADER|FOOTER|MAIN|ARTICLE)$/.test(n.tagName)) {
        const lbl = n.getAttribute("data-screen-label");
        if (lbl) return lbl;
        if (n.id) return n.id;
        const h = n.querySelector("h1,h2,h3");
        if (h) return norm(h.textContent).slice(0, 60);
        return { HEADER: "Yläpalkki", FOOTER: "Alatunniste",
                 MAIN: "Sisältö", ARTICLE: "Artikkeli" }[n.tagName] || "Osio";
      }
    }
    return "Sivu";
  }

  /** Text and section label of every field, as currently published. Labels are
   *  taken from here rather than the live DOM: editing a heading would
   *  otherwise rename the very section the change list files it under. */
  function snapshot(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const map = new Map();
    for (const el of collectFields(doc)) {
      map.set(fieldId(el), { text: norm(el.textContent), section: sectionLabel(el) });
    }
    return map;
  }

  /* ---------------------------------------------------------------- frame */

  const frameDoc = () => $("#page").contentDocument;

  async function mount() {
    const html = S.session.draft?.content ?? S.session.live.content;
    const frame = $("#page");

    await new Promise((done) => {
      frame.onload = () => { frame.onload = null; done(); };
      frame.src = "about:blank";
    });

    const doc = frame.contentDocument;
    doc.open();
    // document.open() resets the frame's document URL to this page's (/admin/),
    // so every relative asset path in the page would resolve under /admin/ and
    // 404. A <base> puts them back at the site root. It carries the chrome
    // marker, so serialize() strips it out again before anything is committed.
    doc.write(html.replace(/<head(\s[^>]*)?>/i,
      (m) => m + '<base href="/" data-ce-chrome>'));
    doc.close();

    const style = doc.createElement("style");
    style.setAttribute("data-ce-chrome", "");
    style.textContent = CHROME_CSS;
    doc.head.appendChild(style);

    S.fields = new Map();
    for (const el of collectFields(doc)) S.fields.set(fieldId(el), el);
    S.baseline = snapshot(S.session.live.content);
    S.saved = serialize();

    doc.addEventListener("click", (e) => {
      const a = e.target.closest && e.target.closest("a");
      if (a) e.preventDefault();       // the frame is a preview, not a browser
    });
    doc.addEventListener("input", refresh);
    doc.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.isContentEditable) e.preventDefault();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    });
    doc.addEventListener("paste", (e) => {
      if (!e.target.isContentEditable) return;
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData("text/plain");
      doc.execCommand("insertText", false, norm(text));
    });
  }

  function serialize() {
    const clone = frameDoc().documentElement.cloneNode(true);
    clone.classList.remove("ce-on");
    if (!clone.getAttribute("class")) clone.removeAttribute("class");
    clone.querySelectorAll("[data-ce-chrome]").forEach((n) => n.remove());
    clone.querySelectorAll("[contenteditable]").forEach((n) => {
      n.removeAttribute("contenteditable");
      n.removeAttribute("spellcheck");
    });
    return "<!DOCTYPE html>\n" + clone.outerHTML;
  }

  /* -------------------------------------------------------------- changes */

  function changes() {
    const out = [];
    for (const [id, el] of S.fields) {
      const base = S.baseline.get(id);
      if (!base) continue;
      const after = norm(el.textContent);
      if (base.text !== after) {
        out.push({ id, before: base.text, after, section: base.section });
      }
    }
    return out;
  }

  const dirty = () => S.saved !== null && serialize() !== S.saved;

  function markdown(list) {
    const who = S.session.user.name || S.session.user.login;
    const date = new Date().toISOString().slice(0, 10);
    let md = `**Sisältömuutokset ${date}** — ${who}\n\n`;
    if (!list.length) return md + "_Ei tekstimuutoksia._\n";
    list.forEach((c, i) => {
      md += `${i + 1}. **${c.section}**\n`;
      md += `   - Ennen: ${c.before}\n`;
      md += `   - Nyt: ${c.after}\n\n`;
    });
    return md;
  }

  function renderChanges(list) {
    const box = $("#chg-list");
    box.innerHTML = "";
    if (!list.length) {
      box.innerHTML = '<div class="empty">Ei muutoksia julkaistuun versioon.</div>';
      return;
    }
    for (const c of list) {
      const el = document.createElement("div");
      el.className = "chg";
      el.innerHTML =
        `<div class="sec"></div>
         <div class="row"><span class="tag">Ennen</span><span class="was"></span></div>
         <div class="row"><span class="tag">Nyt</span><span class="now"></span></div>`;
      el.querySelector(".sec").textContent = c.section;
      el.querySelector(".was").textContent = c.before;
      el.querySelector(".now").textContent = c.after;
      box.appendChild(el);
    }
  }

  /* ------------------------------------------------------------------- ui */

  let toastTimer;
  function toast(msg, bad) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast show" + (bad ? " bad" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = "toast"), 4200);
  }

  function refresh() {
    const list = changes();
    const unsaved = dirty();
    const draft = S.session.draft;

    $("#b-changes").textContent = list.length ? `Muutokset (${list.length})` : "Muutokset";
    $("#b-save").disabled = !unsaved;
    $("#b-pub").disabled = !(draft || unsaved);
    $("#b-discard").classList.toggle("hidden", !draft);

    const dot = $("#dot");
    dot.className = "dot" + (unsaved ? " unsaved" : draft ? " saved" : "");
    $("#status").textContent = unsaved
      ? `${list.length} muutosta · tallentamattomia`
      : draft
        ? `${list.length} muutosta · luonnos tallennettu`
        : "Ei muutoksia";

    const prev = $("#b-preview");
    if (draft?.preview) {
      prev.href = draft.preview;
      prev.classList.remove("hidden");
    } else {
      prev.classList.add("hidden");
    }
    renderChanges(list);
  }

  function setEditing(on) {
    S.editing = on;
    const doc = frameDoc();
    for (const el of S.fields.values()) {
      if (on) {
        el.setAttribute("contenteditable", "true");
        el.setAttribute("spellcheck", "true");
      } else {
        el.removeAttribute("contenteditable");
        el.removeAttribute("spellcheck");
      }
    }
    doc.documentElement.classList.toggle("ce-on", on);
    $("#b-edit").classList.toggle("on", on);
    $("#b-edit").textContent = on ? "Lopeta muokkaus" : "Muokkaa tekstiä";
    refresh();
  }

  /* -------------------------------------------------------------- actions */

  let busy = false;
  async function guard(label, fn) {
    if (busy) return;
    busy = true;
    try { await fn(); }
    catch (e) { toast(`${label} epäonnistui: ${e.message}`, true); }
    finally { busy = false; refresh(); }
  }

  const save = () => guard("Tallennus", async () => {
    const list = changes();
    const content = serialize();
    if (content === S.saved) return;
    const r = await api("save", {
      content,
      count: list.length,
      summary: markdown(list),
      message: `Sisältömuutos: ${list.length} ${list.length === 1 ? "kohta" : "kohtaa"}`,
    });
    S.saved = content;
    S.session.draft = { ...(S.session.draft || {}), pr: r.pr, url: r.url, preview: r.preview };
    toast("Luonnos tallennettu. Esikatselu valmistuu hetkessä.");
  });

  const publish = () => guard("Julkaisu", async () => {
    if (dirty()) {
      const list = changes();
      const content = serialize();
      const r = await api("save", { content, count: list.length, summary: markdown(list) });
      S.saved = content;
      S.session.draft = { ...(S.session.draft || {}), pr: r.pr, url: r.url, preview: r.preview };
    }
    if (!S.session.draft) { toast("Ei julkaistavia muutoksia."); return; }
    await api("publish");
    toast("Julkaistu. Sivusto päivittyy noin minuutissa.");
    S.session = await api("session");
    S.baseline = snapshot(S.session.live.content);
    S.saved = serialize();
  });

  const discard = () => guard("Hylkäys", async () => {
    if (!confirm("Hylätäänkö luonnos ja palataan julkaistuun versioon?")) return;
    await api("discard");
    S.session = await api("session");
    await mount();
    setEditing(false);
    toast("Luonnos hylätty.");
  });

  /* ----------------------------------------------------------------- boot */

  function wire() {
    $("#b-edit").onclick = () => setEditing(!S.editing);
    $("#b-save").onclick = save;
    $("#b-pub").onclick = publish;
    $("#b-discard").onclick = discard;
    $("#b-changes").onclick = () => $("#panel").classList.toggle("open");
    $("#b-close-panel").onclick = () => $("#panel").classList.remove("open");
    $("#b-copy").onclick = async () => {
      await navigator.clipboard.writeText(markdown(changes()));
      toast("Muutoslista kopioitu.");
    };
    $("#b-dl").onclick = () => {
      const blob = new Blob([markdown(changes())], { type: "text/markdown" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `sisaltomuutokset-${new Date().toISOString().slice(0, 10)}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    });
    window.addEventListener("beforeunload", (e) => {
      if (dirty()) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  async function boot() {
    try {
      S.session = await api("session");
    } catch (e) {
      $("#gate-load").classList.add("hidden");
      $("#gate-in").classList.remove("hidden");
      if (e.status !== 401) {
        const box = $("#gate-err");
        box.textContent = e.message;
        box.classList.remove("hidden");
      }
      return;
    }

    $("#gate-in").classList.add("hidden");
    $("#gate-load").classList.remove("hidden");
    await mount();
    $("#gate-load").classList.add("hidden");
    $("#bar").classList.remove("hidden");
    $("#stage").classList.remove("hidden");

    const u = S.session.user;
    $("#who").innerHTML = `<img alt=""><span></span>`;
    $("#who img").src = u.avatar;
    $("#who span").textContent = u.name || u.login;

    wire();
    refresh();
  }

  boot();
})();
