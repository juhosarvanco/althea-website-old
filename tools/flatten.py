#!/usr/bin/env python3
"""
Flatten a Claude Design .dc.html export into a real static page.

Claude Design exports render client-side: they ship an <x-dc> template plus
support.js, which pulls React, ReactDOM and Babel from unpkg at runtime. That
is fine inside the design tool and wrong on a live site, so this script does
that work ahead of time and writes plain HTML with self-hosted assets.

Re-run it whenever a new export lands in project/:

    python3 tools/flatten.py

Everything it emits under site/ is generated; edit the design in Claude Design
and re-run, or edit copy through /admin. Do not hand-edit site/index.html.
"""

import base64
import hashlib
import io
import json
import os
import re
import shutil
import sys
import urllib.request
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "project")
SITE = os.path.join(ROOT, "site")
INTERNAL = os.path.join(ROOT, "internal")
CACHE = os.path.join(ROOT, ".cache", "fonts")

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# Target pixel width per source image: 2x its largest CSS display width in the
# layout. Images are never upscaled past their source width.
IMAGE_TARGETS = {
    "temple1.webp": 1440,   # hero, full-bleed
    "house.jpg":    1380,   # left half of the photo grid
    "eating.png":   1380,   # right column, top
    "bed.jpg":       670,   # right column, bottom-left
    "room.jpg":      670,   # right column, bottom-right
}
WEBP_QUALITY = 72

# Claude Design emits a desktop-only layout: inline styles, fixed pixel grid
# columns, no breakpoints. Rather than restructure the markup — which would
# fight every re-export — we override the specific inline values it produces.
# Attribute selectors match on those values, and !important is what lets a
# stylesheet beat an inline style. check_responsive() below fails the build if
# any of these selectors stops matching, so a redesign cannot silently drop the
# mobile layout.
# The design hard-codes every colour as an inline style. To make a palette
# editable at all, those values have to become CSS variables — and because
# Claude Design will keep emitting raw hex on every export, that conversion has
# to happen here rather than by hand.
#
# Only colours named below become editable. A colour the design introduces
# later stays literal until someone gives it a name, which is deliberate: an
# unnamed swatch in the admin would mean nothing to the person using it.
PALETTE = [
    ("paper",  "#FAF8F4", "Tausta"),
    ("panel",  "#F0EDE6", "Korostustausta"),
    ("ink",    "#0d1f29", "Tumma tausta ja otsikot"),
    ("body",   "#48555C", "Leipäteksti"),
    ("dim",    "#7A8A82", "Vaimennettu teksti"),
    ("accent", "#4A5D4E", "Korostusväri"),
    ("line",   "#A9B5AB", "Viivat"),
    ("footer", "#C9D2D6", "Alatunnisteen teksti"),
    ("frame",  "#E1DDD4", "Kuvapaikan tausta"),
    ("caption", "#5A6560", "Kuvapaikan teksti"),
]

# Foreground/background pairs the admin checks for WCAG AA contrast, so a
# swatch change cannot quietly make text unreadable.
CONTRAST_PAIRS = [
    ("body", "paper"), ("body", "panel"), ("ink", "paper"), ("ink", "panel"),
    ("dim", "paper"), ("dim", "panel"), ("footer", "ink"), ("paper", "ink"),
    ("paper", "accent"), ("accent", "paper"),
]

RGBA_RE = re.compile(r"rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)")
HEX_RE = re.compile(r"#[0-9A-Fa-f]{6}\b")


def _palette_maps():
    by_hex, by_rgb = {}, {}
    for var, hexv, _ in PALETTE:
        by_hex[hexv.lower()] = var
        h = hexv.lstrip("#")
        by_rgb[tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))] = var
    return by_hex, by_rgb


def _sub_hex(text, by_hex):
    return HEX_RE.sub(
        lambda m: f"var(--{by_hex[m.group(0).lower()]})"
        if m.group(0).lower() in by_hex else m.group(0), text)


def apply_palette(html):
    """Rewrite inline colours to palette variables.

    rgba() values are the awkward part: the sticky header's background and every
    hairline border are the paper and ink colours with alpha, so leaving them
    literal would make those the only things that ignore a palette change. They
    become relative-colour syntax, preceded by the original as a fallback for
    engines that do not support it — within one style attribute the later
    declaration wins wherever it parses.
    """
    by_hex, by_rgb = _palette_maps()
    used = set()

    def fix(m):
        out = []
        for decl in (d.strip() for d in m.group(1).split(";")):
            if not decl:
                continue
            rm = RGBA_RE.search(decl)
            if rm:
                rgb = tuple(int(rm.group(i)) for i in (1, 2, 3))
                var = by_rgb.get(rgb)
                if var:
                    used.add(var)
                    rel = (f"rgb(from var(--{var}) r g b / {rm.group(4)})")
                    out.append(decl)
                    out.append(decl[:rm.start()] + rel + decl[rm.end():])
                    continue
            new = _sub_hex(decl, by_hex)
            if new != decl:
                used.update(by_hex[h.lower()] for h in HEX_RE.findall(decl)
                            if h.lower() in by_hex)
            out.append(new)
        return 'style="' + "; ".join(out) + '"'

    return re.sub(r'style="([^"]*)"', fix, html), used


def palette_css():
    # One declaration per line, lower-cased: changing a swatch through /admin
    # then rewrites exactly one line, so the pull request names the colour that
    # actually moved instead of showing the whole block as modified.
    body = "".join(f"  --{var}: {hexv.lower()};\n" for var, hexv, _ in PALETTE)
    return ":root{\n" + body + "}"


def palette_json():
    data = {
        "colors": [{"var": v, "value": h, "label": l} for v, h, l in PALETTE],
        "pairs": [{"fg": a, "bg": b} for a, b in CONTRAST_PAIRS],
    }
    return ('<script type="application/json" id="ce-palette">'
            + json.dumps(data, ensure_ascii=False) + "</script>")


RESPONSIVE_CSS = """
@media (max-width: 900px){
  [style*="grid-template-columns: 340px 1fr"],
  [style*="grid-template-columns: 230px 1fr"],
  [style*="grid-template-columns: 200px 1fr"],
  [style*="grid-template-columns: 1fr 460px"],
  [style*="grid-template-columns: repeat(3, 1fr)"],
  [style*="grid-template-columns: 1fr 1fr"]{grid-template-columns:1fr !important}
  [style*="grid-template-columns: 1.4fr 1fr 1fr 1fr"]{grid-template-columns:1fr 1fr !important}
  [style*="gap: 96px"],[style*="gap: 88px"],[style*="gap: 72px"]{gap:44px !important}
  [style*="padding: 150px 56px 160px"]{padding:84px 24px 90px !important}
  [style*="padding: 140px 56px 130px"]{padding:72px 24px 68px !important}
  [style*="padding: 0 56px 150px"]{padding:0 24px 84px !important}
  [style*="padding: 160px 56px 170px"]{padding:88px 24px 92px !important}
  [style*="padding: 90px 56px 70px"]{padding:64px 24px 52px !important}
  [style*="padding: 26px 56px"]{padding:18px 24px !important}
  h1[style]{font-size:40px !important}
  h2[style]{font-size:30px !important}
  [style*="height: 640px"]{height:420px !important}
  [style*="height: 620px"]{height:340px !important}
}
@media (max-width: 620px){
  header[style*="position: sticky"]{position:static !important;flex-wrap:wrap !important;gap:14px !important}
  nav[style*="gap: 34px"]{gap:14px 18px !important;flex-wrap:wrap !important;font-size:14px !important}
  [style*="grid-template-columns: 220px 1fr"],
  [style*="grid-template-columns: 1.4fr 1fr 1fr 1fr"]{grid-template-columns:1fr !important}
  [style*="padding: 150px 56px 160px"],
  [style*="padding: 140px 56px 130px"],
  [style*="padding: 160px 56px 170px"],
  [style*="padding: 0 56px 150px"],
  [style*="padding: 90px 56px 70px"],
  [style*="padding: 26px 56px"]{padding-left:18px !important;padding-right:18px !important}
  [style*="padding: 44px 46px"]{padding:28px 22px !important}
  [style*="padding: 38px 40px"]{padding:26px 22px !important}
  [style*="padding: 34px 38px"]{padding:24px 22px !important}
  h1[style]{font-size:32px !important;line-height:1.22 !important}
  h2[style]{font-size:26px !important}
  [style*="font-size: 42px"]{font-size:32px !important}
  [style*="height: 640px"]{height:300px !important}
  [style*="height: 620px"]{height:240px !important}
  [style*="height: 280px"]{height:230px !important}
  [style*="justify-content: space-between"]{flex-wrap:wrap !important}
  [style*="border-radius: 110px 110px 18px 18px"]{border-radius:90px 90px 14px 14px !important}
}
"""


def check_responsive(html):
    """Every [style*="..."] selector must still match something in the page.

    If a redesign renames or reformats an inline value, the matching override
    silently stops applying and the mobile layout quietly breaks. Catch it at
    build time instead of on someone's phone.
    """
    wanted = sorted(set(re.findall(r'\[style\*="([^"]+)"\]', RESPONSIVE_CSS)))
    dead = [w for w in wanted if w not in html]
    tag_sel = {
        "header[style*=\"position: sticky\"]": "position: sticky",
        "nav[style*=\"gap: 34px\"]": "gap: 34px",
    }
    for sel, needle in tag_sel.items():
        if needle not in html and needle not in dead:
            dead.append(needle)
    return wanted, dead


PAGES = [
    {
        "src": "Aamuvalo x Metsanpohja.dc.html",
        "out": os.path.join(SITE, "index.html"),
        "lang": "fi",
        "title": "Althea — ohjattuja psilosybiiniretriittejä suomeksi",
        "description": (
            "Ohjattuja retriittejä pienelle suomenkieliselle ryhmälle "
            "Alankomaissa. Kaksi fasilitaattoria, huolellinen valmistautuminen "
            "ja integraatio. Varaa maksuton keskustelu."),
        "editable": True,
        "responsive": True,
        "palette": True,
        "assets_prefix": "assets/",
        "assets_root": os.path.join(SITE, "assets"),
    },
    {
        "src": "Suunnat.dc.html",
        "out": os.path.join(INTERNAL, "suunnat.html"),
        "lang": "fi",
        "title": "Viisi suuntaa AVARA-designille — sisäinen",
        "description": "Sisäinen designvertailu. Ei julkaista.",
        "editable": False,
        "noindex": True,
        "assets_prefix": "assets/",
        "assets_root": os.path.join(INTERNAL, "assets"),
    },
]


# ---------------------------------------------------------------- utilities

def log(msg):
    print(f"  {msg}")


def human(n):
    return f"{n/1024:.0f} KB" if n < 1024 * 1024 else f"{n/1048576:.2f} MB"


def fetch(url):
    os.makedirs(CACHE, exist_ok=True)
    p = os.path.join(CACHE, hashlib.sha1(url.encode()).hexdigest()[:20])
    if os.path.exists(p):
        return open(p, "rb").read()
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    data = urllib.request.urlopen(req, timeout=90).read()
    open(p, "wb").write(data)
    return data


# ------------------------------------------------------------ dc.html parse

def split_export(raw):
    """Pull the helmet, the template body and the logic props out of an export."""
    m = re.search(r"<x-dc[^>]*>(.*)</x-dc>", raw, re.S)
    if not m:
        raise SystemExit("no <x-dc> block found — is this a Claude Design export?")
    inner = m.group(1)

    helmet = ""
    hm = re.search(r"<helmet[^>]*>(.*?)</helmet>", inner, re.S)
    if hm:
        helmet = hm.group(1)
        inner = inner[:hm.start()] + inner[hm.end():]

    props = {}
    pm = re.search(r'data-props="([^"]*)"', raw)
    if pm:
        import html as _html
        try:
            for key, spec in json.loads(_html.unescape(pm.group(1))).items():
                props[key] = spec.get("default", True)
        except Exception:
            pass

    return helmet, inner, props


def resolve_conditionals(html, props):
    """Evaluate <sc-if value="{{ prop }}"> against the export's prop defaults."""
    out, pos = [], 0
    open_re = re.compile(r'<sc-if\b([^>]*)>', re.I)
    while True:
        m = open_re.search(html, pos)
        if not m:
            out.append(html[pos:])
            break
        out.append(html[pos:m.start()])
        close = html.find("</sc-if>", m.end())
        if close == -1:
            out.append(html[m.end():])
            break
        body = html[m.end():close]
        val = re.search(r'value="\{\{\s*([\w.]+)\s*\}\}"', m.group(1))
        keep = True
        if val:
            keep = bool(props.get(val.group(1), True))
        if keep:
            out.append(body)
        pos = close + len("</sc-if>")
    return "".join(out)


TAG_RE = re.compile(r"<([a-zA-Z][\w-]*)((?:[^>\"']|\"[^\"]*\"|'[^']*')*)>")


def importantify(css):
    """Match support.js: every declaration in a style-* attribute wins."""
    decls = [d.strip() for d in css.split(";") if d.strip()]
    return "; ".join(
        d if re.search(r"!\s*important$", d, re.I) else d + " !important"
        for d in decls)


def extract_pseudo_styles(html):
    """Turn style-hover="..." attributes into real CSS rules.

    Claude Design's runtime generates a class per unique (pseudo, css) pair and
    marks every declaration !important. We do the same so hover states survive
    without the runtime.
    """
    rules, seen, counter = [], {}, [0]

    def repl(m):
        tag, attrs = m.group(1), m.group(2)
        found = re.findall(r'\bstyle-([a-z]+)\s*=\s*"([^"]*)"', attrs)
        if not found:
            return m.group(0)
        attrs = re.sub(r'\s*\bstyle-[a-z]+\s*=\s*"[^"]*"', "", attrs)
        classes = []
        for pseudo, css in found:
            key = pseudo + "|" + css
            if key not in seen:
                cls = f"scp{counter[0]}"
                counter[0] += 1
                seen[key] = cls
                sep = "::" if pseudo in ("before", "after") else ":"
                body = css if pseudo in ("before", "after") else importantify(css)
                rules.append(f".{cls}{sep}{pseudo}{{{body}}}")
            classes.append(seen[key])
        add = " ".join(classes)
        cm = re.search(r'\bclass\s*=\s*"([^"]*)"', attrs)
        if cm:
            attrs = attrs[:cm.start(1)] + (cm.group(1) + " " + add) + attrs[cm.end(1):]
        else:
            attrs = attrs.rstrip() + f' class="{add}"'
        return f"<{tag}{attrs}>"

    return TAG_RE.sub(repl, html), rules


# ------------------------------------------------------------------- images

def build_images(html, prefix, assets_root):
    """Re-encode every referenced upload as a sized WebP and rewrite its src."""
    from PIL import Image

    outdir = os.path.join(assets_root, "img")
    shutil.rmtree(outdir, ignore_errors=True)
    os.makedirs(outdir, exist_ok=True)
    total = 0
    for name in sorted(set(re.findall(r'src="uploads/([^"]+)"', html))):
        srcp = os.path.join(SRC, "uploads", name)
        if not os.path.exists(srcp):
            log(f"! missing upload: {name}")
            continue
        stem = os.path.splitext(name)[0]
        im = Image.open(srcp)
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGB")
        target = IMAGE_TARGETS.get(name, 1400)
        if im.width > target:
            h = round(im.height * target / im.width)
            im = im.resize((target, h), Image.LANCZOS)
        # save() without exif/icc arguments drops all source metadata
        buf = io.BytesIO()
        im.save(buf, "WEBP", quality=WEBP_QUALITY, method=6)
        blob = buf.getvalue()
        # Content hash in the name lets these be cached immutably for a year.
        digest = hashlib.sha256(blob).hexdigest()[:8]
        fname = f"{stem}.{digest}.webp"
        outp = os.path.join(outdir, fname)
        open(outp, "wb").write(blob)

        size = len(blob)
        total += size
        log(f"{name:14} {Image.open(srcp).width:>5}px -> {im.width:>5}px  "
            f"{human(os.path.getsize(srcp)):>9} -> {human(size):>9}")
        html = html.replace(f'src="uploads/{name}"', f'src="{prefix}img/{fname}"')
    return html, total


# -------------------------------------------------------------------- fonts

# A deliberately generous subset: every character the pages use today, plus all
# of Latin-1 and the common typographic punctuation. Copy gets edited through
# /admin, so the fonts have to cover characters nobody has typed yet.
def editing_charset():
    cps = set(range(0x20, 0x7F)) | set(range(0xA0, 0x100))
    cps |= {0x0131, 0x0152, 0x0153, 0x0160, 0x0161, 0x0178, 0x017D, 0x017E}
    cps |= set(range(0x2010, 0x2016))          # hyphens and dashes
    cps |= {0x2018, 0x2019, 0x201A, 0x201C, 0x201D, 0x201E}
    cps |= {0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203A, 0x2044}
    cps |= {0x20AC, 0x2122, 0x2212, 0x2013, 0x2014}
    return cps


def parse_unicode_range(spec):
    out = set()
    for part in (spec or "").split(","):
        part = part.strip()
        if not part.upper().startswith("U+"):
            continue
        body = part[2:]
        if "-" in body:
            a, b = body.split("-", 1)
            out.update(range(int(a, 16), int(b, 16) + 1))
        elif "?" in body:
            out.update(range(int(body.replace("?", "0"), 16),
                             int(body.replace("?", "F"), 16) + 1))
        else:
            out.add(int(body, 16))
    return out


def parse_font_css(css):
    faces = []
    pat = r"(?:/\*\s*([a-z0-9-]+)\s*\*/\s*)?@font-face\s*\{(.*?)\}"
    for m in re.finditer(pat, css, re.S | re.I):
        label, block = m.group(1), m.group(2)

        def g(prop):
            mm = re.search(prop + r"\s*:\s*([^;]+);", block)
            return mm.group(1).strip() if mm else None

        u = re.search(r"url\(([^)]+)\)", block)
        faces.append({
            "subset": label or "x",
            "family": (g("font-family") or "").strip("'\""),
            "style": g("font-style") or "normal",
            "weight": g("font-weight") or "400",
            "range": g("unicode-range"),
            "url": u.group(1).strip("'\"") if u else None,
        })
    return faces


def build_fonts(google_url, prefix, assets_root):
    """Download, subset and self-host the fonts a page asks Google for.

    Google serves these families as variable fonts: one file backs several
    weights. We group by file so each is embedded once, and declare the weight
    range it covers.
    """
    from fontTools import subset
    from fontTools.ttLib import TTFont

    outdir = os.path.join(assets_root, "fonts")
    shutil.rmtree(outdir, ignore_errors=True)
    os.makedirs(outdir, exist_ok=True)
    charset = editing_charset()

    faces = parse_font_css(fetch(google_url).decode("utf-8"))

    groups = {}
    for f in faces:
        if not f["url"]:
            continue
        if not (charset & parse_unicode_range(f["range"])):
            continue                      # cyrillic, greek, vietnamese, math...
        key = (f["url"], f["style"])
        g = groups.setdefault(key, {"family": f["family"], "style": f["style"],
                                    "range": f["range"], "subset": f["subset"],
                                    "weights": set()})
        try:
            g["weights"].add(int(f["weight"]))
        except ValueError:
            g["weights"].add(400)

    css, total = [], 0
    for (url, style), g in sorted(groups.items(), key=lambda kv: kv[1]["family"]):
        want = sorted(charset & parse_unicode_range(g["range"]))
        # recalcTimestamp=False keeps the upstream head.modified date. Without
        # it fontTools stamps "now" on save, so every rebuild would produce a
        # new content hash, a new filename, and a pointless cache bust.
        font = TTFont(io.BytesIO(fetch(url)), fontNumber=0, recalcTimestamp=False)
        cmap = set()
        for t in font["cmap"].tables:
            cmap |= set(t.cmap.keys())
        want = [c for c in want if c in cmap]
        if not want:
            font.close()
            continue

        opts = subset.Options()
        opts.flavor = "woff2"
        opts.notdef_outline = False
        opts.ignore_missing_glyphs = True
        opts.drop_tables += ["FFTM", "PfEd", "TeX", "BASE", "JSTF", "DSIG"]
        s = subset.Subsetter(options=opts)
        s.populate(unicodes=want)
        s.subset(font)

        lo, hi = min(g["weights"]), max(g["weights"])
        slug = re.sub(r"[^a-z0-9]+", "-", g["family"].lower()).strip("-")
        fname = f"{slug}-{lo}{'' if lo == hi else '-' + str(hi)}"
        fname += ("-italic" if style == "italic" else "")
        buf = io.BytesIO()
        font.flavor = "woff2"
        font.save(buf)
        font.close()
        blob = buf.getvalue()
        fname += f"-{g['subset']}.{hashlib.sha256(blob).hexdigest()[:8]}.woff2"
        outp = os.path.join(outdir, fname)
        open(outp, "wb").write(blob)

        size = len(blob)
        total += size
        log(f"{g['family']:18} {style:7} {lo}"
            f"{'' if lo == hi else '-' + str(hi):>4}  {g['subset']:9} "
            f"{len(want):>3} glyphs  {human(size):>8}")

        weight = str(lo) if lo == hi else f"{lo} {hi}"
        css.append(
            "@font-face{"
            f"font-family:'{g['family']}';"
            f"font-style:{style};"
            f"font-weight:{weight};"
            "font-display:swap;"
            f"src:url('{prefix}fonts/{fname}') format('woff2');"
            f"unicode-range:{g['range']}"
            "}")
    return css, total


# -------------------------------------------------------------------- build

def build_page(page):
    raw = open(os.path.join(SRC, page["src"]), encoding="utf-8").read()
    print(f"\n{page['src']}")

    helmet, body, props = split_export(raw)
    body = resolve_conditionals(body, props)
    body, hover_rules = extract_pseudo_styles(body)
    helmet, helmet_hover = extract_pseudo_styles(helmet)
    hover_rules += helmet_hover

    prefix = page["assets_prefix"]
    body, img_bytes = build_images(body, prefix, page["assets_root"])

    # Lift the design's own <style> out of the helmet; drop its Google Fonts
    # <link> and preconnects, which we are replacing with self-hosted files.
    design_css = "\n".join(
        m.group(1) for m in re.finditer(r"<style[^>]*>(.*?)</style>", helmet, re.S))
    google = re.search(r'href="(https://fonts\.googleapis\.com/css2[^"]+)"', helmet)
    font_css, font_bytes = ([], 0)
    if google:
        import html as _html
        font_css, font_bytes = build_fonts(
            _html.unescape(google.group(1)), prefix, page["assets_root"])

    canvas = re.search(
        r'<meta[^>]*name="design_doc_mode"[^>]*content="(\w+)"', helmet)
    canvas_css = ""
    if canvas and canvas.group(1) == "canvas":
        # Reproduces the runtime's canvas backdrop, which sits after the
        # design's own body rule and therefore wins.
        canvas_css = "html,body{background:#f0eee6}"

    head = [
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        f'<title>{page["title"]}</title>',
        f'<meta name="description" content="{page["description"]}">',
    ]
    if page.get("noindex"):
        head.append('<meta name="robots" content="noindex, nofollow">')
    else:
        head += [
            '<meta property="og:type" content="website">',
            f'<meta property="og:title" content="{page["title"]}">',
            f'<meta property="og:description" content="{page["description"]}">',
        ]

    style = "\n".join(font_css) + "\n"
    if page.get("palette"):
        style += palette_css() + "\n"
    style += design_css + "\n" + "\n".join(hover_rules) + "\n" + canvas_css

    palette_used = set()
    if page.get("palette"):
        body, palette_used = apply_palette(body)
        design_css = _sub_hex(design_css, _palette_maps()[0])
        hover_rules = [_sub_hex(r, _palette_maps()[0]) for r in hover_rules]
        missing = [v for v, _, _ in PALETTE if v not in palette_used]
        log(f"palette: {len(PALETTE) - len(missing)}/{len(PALETTE)} colours in use"
            + (f", unused: {', '.join(missing)}" if missing else ""))

    if page.get("responsive"):
        wanted, dead = check_responsive(body)
        if dead:
            print("  ! responsive overrides that no longer match anything:")
            for d in dead:
                print(f"      {d}")
            print("    The design changed these inline values. Update "
                  "RESPONSIVE_CSS in tools/flatten.py before shipping.")
            raise SystemExit(1)
        log(f"responsive: {len(wanted)} overrides, all matching")
        style += "\n" + RESPONSIVE_CSS

    # No newline between <html> and <head>, and none after </html>: the HTML
    # parser discards whitespace in both places, so emitting it would make the
    # first save through /admin produce a whole-file reformatting diff. This
    # shape survives a DOM round-trip byte-for-byte, which keeps content PRs
    # down to the sentence that actually changed.
    doc = (f'<!DOCTYPE html>\n<html lang="{page["lang"]}"><head>\n'
           + "\n".join(head)
           + f'\n<style>\n{style.strip()}\n</style>\n</head>\n<body>\n'
           + body.strip()
           + (("\n" + palette_json()) if page.get("palette") else "")
           + "\n</body></html>")

    os.makedirs(os.path.dirname(page["out"]), exist_ok=True)
    open(page["out"], "w", encoding="utf-8").write(doc)

    html_bytes = len(doc.encode("utf-8"))
    log(f"-> {os.path.relpath(page['out'], ROOT)}  "
        f"html {human(html_bytes)} + img {human(img_bytes)} + fonts {human(font_bytes)}")
    return html_bytes, img_bytes, font_bytes


STAMP = os.path.join(ROOT, ".flatten-stamp.json")


def load_stamp():
    try:
        return json.load(open(STAMP, encoding="utf-8"))
    except Exception:
        return {}


def file_hash(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def main():
    if not os.path.isdir(SRC):
        raise SystemExit(f"no design bundle at {SRC}")
    force = "--force" in sys.argv
    stamp = load_stamp()

    # Copy edited through /admin lands in site/index.html as a commit. Re-running
    # this script regenerates that file from the design export and would throw
    # those edits away, so refuse to touch a file that has changed since we last
    # wrote it. Port the current copy into the export first, then --force.
    blocked = []
    for page in PAGES:
        out, key = page["out"], os.path.relpath(page["out"], ROOT)
        if os.path.exists(out) and key in stamp and file_hash(out) != stamp[key]:
            blocked.append(key)

    if blocked and not force:
        print("refusing to overwrite files edited since the last flatten:\n")
        for key in blocked:
            print(f"    {key}")
        print("\nThose edits came from /admin and are not in the design export.")
        print("Port the current copy into project/*.dc.html first, then re-run")
        print("with --force. To discard the edits instead, run with --force now.")
        raise SystemExit(1)

    for page in PAGES:
        build_page(page)
        stamp[os.path.relpath(page["out"], ROOT)] = file_hash(page["out"])

    json.dump(stamp, open(STAMP, "w", encoding="utf-8"), indent=2, sort_keys=True)
    print("\ndone.")


if __name__ == "__main__":
    main()
