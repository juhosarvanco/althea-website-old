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
    html.ce-on img{outline:1px dashed rgba(74,93,78,.5); outline-offset:3px; cursor:pointer}
    html.ce-on img:hover{outline:2px solid #4A5D4E; outline-offset:3px}
    @media print{html.ce-on [contenteditable]{outline:none !important}}`;

  const S = {
    session: null,
    baseline: null,        // { text, links, images } as published
    fields: new Map(),     // field id -> text element in the iframe
    links: new Map(),      // field id -> <a> in the iframe
    images: new Map(),     // field id -> <img> in the iframe
    editing: false,
    saved: null,           // serialized HTML as last committed
    popFor: null,          // element the popover currently describes
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

  /** Everything editable, as currently published: text, link targets and
   *  images. Section labels are taken from here rather than the live DOM,
   *  because editing a heading would otherwise rename the very section the
   *  change list files that edit under. */
  function snapshot(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const text = new Map(), links = new Map(), images = new Map();
    for (const el of collectFields(doc)) {
      text.set(fieldId(el), { text: norm(el.textContent), section: sectionLabel(el) });
    }
    for (const el of doc.body.querySelectorAll("a[href]")) {
      links.set(fieldId(el), {
        href: el.getAttribute("href"),
        label: norm(el.textContent).slice(0, 40),
        section: sectionLabel(el),
      });
    }
    for (const el of doc.body.querySelectorAll("img")) {
      images.set(fieldId(el), {
        src: el.getAttribute("src"),
        alt: el.getAttribute("alt") || "",
        section: sectionLabel(el),
      });
    }
    return { text, links, images, colors: readPalette(doc) };
  }

  /* --------------------------------------------------------------- images */

  const imgSrc = (el) => el.getAttribute("data-ce-src") || el.getAttribute("src");

  function b64(buf) {
    const bytes = new Uint8Array(buf);
    let out = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(out);
  }

  /** Resize, re-encode as WebP and name by content hash — the same treatment
   *  tools/flatten.py gives the design's own uploads, done in the browser. */
  async function encodeImage(file, el) {
    const doc = frameDoc();
    // The frame is narrower than the real site, so scale the slot back up to a
    // 1440px reference before doubling it for retina.
    const frameW = doc.documentElement.clientWidth || 1440;
    const slot = el.getBoundingClientRect().width || 700;
    const target = Math.min(2400, Math.round(slot * (1440 / frameW) * 2));

    const bmp = await createImageBitmap(file);
    const w = Math.min(bmp.width, target);
    const h = Math.max(1, Math.round(bmp.height * w / bmp.width));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d", { alpha: false }).drawImage(bmp, 0, 0, w, h);
    bmp.close?.();

    const blob = await new Promise((r) => canvas.toBlob(r, "image/webp", 0.72));
    if (!blob) throw new Error("selain ei osaa tallentaa WebP-muotoa");
    const buf = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    const hash = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
    const stem = (file.name.replace(/\.[^.]+$/, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)) || "kuva";

    return { name: `${stem}.${hash}.webp`, content: b64(buf), blob, w, h,
             bytes: buf.byteLength };
  }

  async function replaceImage(el, file) {
    const enc = await encodeImage(file, el);
    await api("asset", { name: enc.name, content: enc.content });
    // Commit the real path, but display the local blob: the uploaded file only
    // exists on the draft branch and is not on the live site yet.
    el.setAttribute("data-ce-src", `assets/img/${enc.name}`);
    el.src = URL.createObjectURL(enc.blob);
    el.removeAttribute("srcset");
    return enc;
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
    S.links = new Map();
    for (const el of doc.body.querySelectorAll("a[href]")) S.links.set(fieldId(el), el);
    S.images = new Map();
    for (const el of doc.body.querySelectorAll("img")) S.images.set(fieldId(el), el);
    S.baseline = snapshot(S.session.live.content);
    S.palette = paletteManifest(doc);

    // An image swapped in an earlier session lives only on the draft branch, so
    // the live site would 404 it. Point those at the deploy preview, which is
    // built from that branch. Cross-origin <img> needs no CORS.
    const preview = S.session.draft?.preview;
    if (preview) {
      for (const [id, el] of S.images) {
        const src = el.getAttribute("src");
        const published = S.baseline.images.get(id)?.src;
        if (src && src !== published) {
          el.setAttribute("data-ce-src", src);
          el.src = `${preview}/${src.replace(/^\//, "")}`;
        }
      }
    }
    S.saved = serialize();

    doc.addEventListener("click", (e) => {
      const a = e.target.closest && e.target.closest("a");
      if (a) e.preventDefault();       // the frame is a preview, not a browser
      const img = e.target.closest && e.target.closest("img");
      if (S.editing && img) {
        e.preventDefault();
        openImagePopover(img);
      } else if (!img && !a) {
        hidePopover();
      }
    });

    // Links are also text fields, so opening their URL editor on any click
    // would fight typing. Show it when the caret lands inside one instead.
    doc.addEventListener("selectionchange", () => {
      if (!S.editing) return;
      const sel = doc.getSelection();
      const node = sel && sel.anchorNode;
      if (!node) return;
      const el = node.nodeType === 3 ? node.parentElement : node;
      const a = el && el.closest && el.closest("a");
      if (a) openLinkPopover(a);
      else if (S.popFor && S.popFor.tagName === "A") hidePopover();
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
    // Images display a blob: or preview URL while editing; commit the real path.
    clone.querySelectorAll("[data-ce-src]").forEach((n) => {
      n.setAttribute("src", n.getAttribute("data-ce-src"));
      n.removeAttribute("data-ce-src");
    });
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
      const base = S.baseline.text.get(id);
      if (!base) continue;
      const after = norm(el.textContent);
      if (base.text !== after) {
        out.push({ kind: "text", id, section: base.section,
                   before: base.text, after });
      }
    }
    for (const [id, el] of S.links) {
      const base = S.baseline.links.get(id);
      if (!base) continue;
      const after = el.getAttribute("href");
      if (base.href !== after) {
        out.push({ kind: "link", id, section: base.section, label: base.label,
                   before: base.href, after });
      }
    }
    for (const [id, el] of S.images) {
      const base = S.baseline.images.get(id);
      if (!base) continue;
      const src = imgSrc(el);
      if (base.src !== src) {
        out.push({ kind: "image", id, section: base.section,
                   before: base.src.split("/").pop(), after: src.split("/").pop() });
      }
      const alt = el.getAttribute("alt") || "";
      if (base.alt !== alt) {
        out.push({ kind: "alt", id, section: base.section, before: base.alt, after: alt });
      }
    }
    if (S.palette) {
      const now = readPalette(frameDoc());
      for (const c of S.palette.colors) {
        const before = S.baseline.colors.get(c.var) || c.value.toLowerCase();
        const after = (now.get(c.var) || "").toLowerCase();
        if (after && before !== after) {
          out.push({ kind: "color", id: c.var, section: c.label, before, after });
        }
      }
    }
    return out;
  }

  const KIND = { text: "Teksti", link: "Linkki", image: "Kuva",
                 alt: "Kuvateksti", color: "Väri" };

  const dirty = () => S.saved !== null && serialize() !== S.saved;

  function markdown(list) {
    const who = S.session.user.name || S.session.user.login;
    const date = new Date().toISOString().slice(0, 10);
    let md = `**Sisältömuutokset ${date}** — ${who}\n\n`;
    if (!list.length) return md + "_Ei tekstimuutoksia._\n";
    list.forEach((c, i) => {
      const what = c.kind === "text" ? "" : ` — ${KIND[c.kind]}`;
      md += `${i + 1}. **${c.section}**${what}\n`;
      md += `   - Ennen: ${c.before || "_tyhjä_"}\n`;
      md += `   - Nyt: ${c.after || "_tyhjä_"}\n\n`;
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
      el.querySelector(".sec").textContent =
        c.kind === "text" ? c.section : `${c.section} · ${KIND[c.kind]}`;
      el.querySelector(".was").textContent = c.before;
      el.querySelector(".now").textContent = c.after;
      box.appendChild(el);
    }
  }

  /* -------------------------------------------------------------- palette */

  /** Read the :root block flatten.py emits. Editing this text is what makes a
   *  colour change real: the stylesheet is part of the document we commit. */
  function readPalette(doc) {
    const map = new Map();
    const el = paletteStyle(doc);
    const block = el && el.textContent.match(/:root\{([^}]*)\}/);
    if (!block) return map;
    for (const m of block[1].matchAll(/--([a-z-]+)\s*:\s*([^;]+)/g)) {
      map.set(m[1], m[2].trim().toLowerCase());
    }
    return map;
  }

  const paletteStyle = (doc) =>
    [...doc.querySelectorAll("style:not([data-ce-chrome])")]
      .find((el) => el.textContent.includes(":root{"));

  function paletteManifest(doc) {
    const el = doc.getElementById("ce-palette");
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch { return null; }
  }

  function setPaletteVar(name, value) {
    const el = paletteStyle(frameDoc());
    if (!el) return;
    el.textContent = el.textContent.replace(
      new RegExp(`(--${name}\\s*:\\s*)[^;}]+`), `$1${value}`);
  }

  const hexRgb = (h) => {
    const v = h.replace("#", "");
    return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
  };

  function luminance(hex) {
    const [r, g, b] = hexRgb(hex).map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  function renderPalette() {
    const box = $("#swatches");
    const man = S.palette;
    if (!man) {
      box.innerHTML = '<div class="empty">Tällä sivulla ei ole nimettyä väripalettia.</div>';
      return;
    }
    const now = readPalette(frameDoc());
    box.innerHTML = "";
    for (const c of man.colors) {
      const value = now.get(c.var) || c.value;
      const changed = value.toLowerCase() !== c.value.toLowerCase();
      const row = document.createElement("div");
      row.className = "sw" + (changed ? " changed" : "");
      row.innerHTML =
        `<input type="color"><div class="meta">
           <div class="name"></div><div class="val"></div></div>`;
      row.querySelector(".name").textContent = c.label;
      row.querySelector(".val").textContent = value;
      const input = row.querySelector("input");
      input.value = value;
      input.oninput = () => {
        setPaletteVar(c.var, input.value);
        row.querySelector(".val").textContent = input.value;
        row.classList.toggle("changed",
          input.value.toLowerCase() !== c.value.toLowerCase());
        renderContrast();
        refresh();
      };
      box.appendChild(row);
    }
    renderContrast();
  }

  function renderContrast() {
    const man = S.palette;
    const box = $("#contrast");
    if (!man) return;
    const now = readPalette(frameDoc());
    const base = S.baseline.colors;
    const label = (v) => man.colors.find((c) => c.var === v)?.label || v;
    const orig = (v) => base.get(v) || man.colors.find((c) => c.var === v)?.value;

    // A pair that already failed on the published site is not this editor's
    // doing. Separating the two keeps the panel from blaming someone for
    // something they did not touch — and from being ignored as noise.
    const broke = [], already = [];
    for (const p of man.pairs) {
      const fg = now.get(p.fg), bg = now.get(p.bg);
      if (!fg || !bg) continue;
      const ratio = contrast(fg, bg);
      if (ratio >= 4.5) continue;
      const line = `${label(p.fg)} / ${label(p.bg)} — ${ratio.toFixed(1)}:1`;
      (contrast(orig(p.fg), orig(p.bg)) >= 4.5 ? broke : already).push(line);
    }

    let html = "";
    if (broke.length) {
      html += `<span class="bad"><strong>Muutoksesi heikensi kontrastia:</strong>
               <br>${broke.join("<br>")}<br><br>Alle 4.5:1 on vaikea lukea.</span>`;
    }
    if (already.length) {
      html += `${broke.length ? "<br><br>" : ""}<span style="color:var(--dim)">
               Nämä olivat heikkoja jo ennestään, eivät sinun muutoksestasi:<br>
               ${already.join("<br>")}</span>`;
    }
    if (!html) html = '<span class="good">Kaikki tekstiparit ylittävät 4.5:1.</span>';
    box.innerHTML = html;
  }

  /* -------------------------------------------------------------- popover */

  function hidePopover() {
    $("#pop").hidden = true;
    S.popFor = null;
  }

  function placePopover(el) {
    const pop = $("#pop");
    const fr = $("#page").getBoundingClientRect();
    const r = el.getBoundingClientRect();
    pop.hidden = false;
    const top = fr.top + r.bottom + 8;
    pop.style.top =
      Math.max(8, Math.min(top, innerHeight - pop.offsetHeight - 12)) + "px";
    pop.style.left =
      Math.max(12, Math.min(fr.left + r.left, innerWidth - pop.offsetWidth - 12)) + "px";
  }

  function openLinkPopover(a) {
    if (S.popFor === a) return;
    S.popFor = a;
    const pop = $("#pop");
    pop.innerHTML =
      `<h3>Linkki</h3>
       <label for="p-href">Osoite</label>
       <input type="text" id="p-href" spellcheck="false">
       <p class="hint"></p>`;
    const input = pop.querySelector("#p-href");
    input.value = a.getAttribute("href") || "";
    pop.querySelector(".hint").textContent =
      input.value.startsWith("#")
        ? "Alkaa risuaidalla: siirtyy tämän sivun osioon."
        : input.value.startsWith("mailto:")
          ? "Avaa sähköpostiohjelman."
          : "Koko osoite, esim. https://…";
    input.oninput = () => {
      a.setAttribute("href", input.value.trim());
      refresh();
    };
    placePopover(a);
  }

  function openImagePopover(img) {
    S.popFor = img;
    const pop = $("#pop");
    pop.innerHTML =
      `<h3>Kuva</h3>
       <img class="thumb" alt="">
       <div class="row">
         <button class="btn" id="p-pick">Vaihda kuva</button>
         <span class="busy" id="p-busy"></span>
       </div>
       <label for="p-alt">Kuvateksti (näkyy ruudunlukijalle)</label>
       <input type="text" id="p-alt">
       <p class="hint">Kuva pienennetään ja pakataan automaattisesti.</p>`;
    pop.querySelector(".thumb").src = img.currentSrc || img.src;
    const alt = pop.querySelector("#p-alt");
    alt.value = img.getAttribute("alt") || "";
    alt.oninput = () => {
      img.setAttribute("alt", alt.value);
      refresh();
    };
    pop.querySelector("#p-pick").onclick = () => {
      const picker = $("#filepick");
      picker.value = "";
      picker.onchange = async () => {
        const file = picker.files[0];
        if (!file) return;
        const busy = pop.querySelector("#p-busy");
        if (busy) busy.textContent = "Käsitellään…";
        try {
          const enc = await replaceImage(img, file);
          pop.querySelector(".thumb").src = img.src;
          toast(`Kuva vaihdettu — ${enc.w}×${enc.h}, ${Math.round(enc.bytes / 1024)} KB.`);
        } catch (e) {
          toast(`Kuvan vaihto epäonnistui: ${e.message}`, true);
        } finally {
          if (busy) busy.textContent = "";
          refresh();
        }
      };
      picker.click();
    };
    placePopover(img);
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
    if (!on) hidePopover();
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
    await mount();
    setEditing(false);
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
    $("#b-changes").onclick = () => {
      $("#colorpanel").classList.remove("open");
      $("#panel").classList.toggle("open");
    };
    $("#b-colors").onclick = () => {
      $("#panel").classList.remove("open");
      const open = $("#colorpanel").classList.toggle("open");
      if (open) renderPalette();
    };
    $("#b-close-colors").onclick = () => $("#colorpanel").classList.remove("open");
    $("#b-reset-colors").onclick = () => {
      if (!S.palette) return;
      for (const c of S.palette.colors) {
        setPaletteVar(c.var, S.baseline.colors.get(c.var) || c.value);
      }
      renderPalette();
      refresh();
    };
    addEventListener("resize", hidePopover);
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
