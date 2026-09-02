# Althea website

Static site, published by Netlify from `site/`. Copy is edited in the browser
at `/admin` and lands in this repository as a pull request.

There is no framework and no build step. `site/index.html` is the page.

---

## How the two lanes work

Design and copy both end up in git, which is what keeps them from drifting
apart.

**Design and code** — Juho redesigns in Claude Design, exports to
`project/*.dc.html`, and runs `tools/flatten.py`. That regenerates
`site/index.html` plus optimised images and subsetted fonts.

**Copy** — either of you opens `/admin`, edits text on the page, and saves.
A save commits to a branch `content/<github-login>` and opens a pull request;
Netlify builds a preview of it. **Julkaise** merges that PR and the site goes
live in about a minute.

Because both lanes commit to the same repository, Claude Code can always read
the copy that is actually live, and every change is revertable.

### The one place they can collide

`tools/flatten.py` regenerates `site/index.html` from the design export. If
copy has been edited through `/admin` since the last flatten, that edited copy
exists only in `site/index.html` — not in the `.dc.html` the script reads from.

The script refuses to run in that situation rather than silently discarding the
edits. When it stops, port the current copy into `project/*.dc.html` first (a
good task to hand Claude Code), then re-run with `--force`. Running `--force`
without porting throws the copy edits away.

---

## Layout

```
site/                 published by Netlify — everything in here is public
  index.html          the page (generated; do not hand-edit)
  assets/img          WebP, content-hashed filenames
  assets/fonts        self-hosted woff2 subsets
  admin/              the copy editor
netlify/functions/    OAuth + the GitHub actions the editor calls
project/              Claude Design exports and their uploads (not published)
internal/             flattened design comparison doc (not published)
tools/flatten.py      export -> static site
tools/serve.mjs       local preview server
```

Only `site/` is deployed. `project/` and `internal/` stay in the repo as
reference.

---

## Setup

Live: **https://althea-retriitit.netlify.app**
Repo: **https://github.com/juhosarvanco/althea-website** (private)
Netlify project: `althea-retriitit`, team `juhosarvanco`

Setup is complete. The repository is connected to Netlify (pushes to `main`
deploy automatically, pull requests get deploy previews), the GitHub OAuth app
is registered, and both editors can sign in.

| Variable | Value | Where it comes from |
| --- | --- | --- |
| `GITHUB_REPO` | `juhosarvanco/althea-website` | set once |
| `ALLOWED_LOGINS` | `juhosarvanco,juliagrahn` | one login per editor |
| `GITHUB_CLIENT_ID` | the OAuth app's id | public; appears in every authorize URL |
| `GITHUB_CLIENT_SECRET` | the OAuth app's secret | never committed, never pasted into chat |

`SITE_NAME` is reserved — Netlify injects it, so it needs no configuration.

The OAuth app lives at *Settings → Developer settings → OAuth Apps*, with
homepage `https://althea-retriitit.netlify.app` and callback
`https://althea-retriitit.netlify.app/api/callback`. Both URLs have to change
when the real domain is connected.

### Adding or removing an editor

Access has two halves, and both are required. `ALLOWED_LOGINS` is the admin's
front door: anyone in the world can complete a GitHub login, only listed logins
get past it. Repository write access is what lets their saves become branches
and their Julkaise merge.

```bash
npx netlify-cli env:set ALLOWED_LOGINS "juhosarvanco,<their-login>"
gh api -X PUT /repos/juhosarvanco/althea-website/collaborators/<their-login> -f permission=push
npx netlify-cli api createSiteBuild --data '{"site_id":"32ed0e2d-d89b-409d-a3a4-468ec772d7b2"}'
```

To invite someone who has no GitHub account yet, invite them by email address
from the repository's *Settings → Collaborators* page instead — that merges
signing up and accepting into one flow. `docs/julia-aloitus.md` is the Finnish
walkthrough to send them.

The last line redeploys. Environment changes do not reach already-deployed
functions until you do, so a login added without a rebuild still gets turned
away at the door.

To remove someone, drop their login from `ALLOWED_LOGINS`, redeploy, and revoke
their repository access. Either half alone is enough to stop them saving.

## Editing copy

1. Open `/admin` and sign in with GitHub.
2. **Muokkaa tekstiä** — every editable piece of text gets a dashed outline.
   Click and type. Enter is disabled inside fields so the layout cannot be
   broken by stray paragraphs, and pasted text arrives as plain text.
3. **Muutokset** lists every change as before/after, grouped by section, and
   can be copied or downloaded as Markdown.
4. **Tallenna luonnos** (or ⌘S) commits to your draft branch and opens a PR.
   **Esikatselu ↗** opens Netlify's preview of it.
5. **Julkaise** merges and the site is live in about a minute.
6. **Hylkää luonnos** closes the PR and deletes the branch.

Editable: text, link targets, images (with alt text) and a ten-colour palette.
Not editable: layout and structure, so no edit can break the design.

Images are re-encoded in the browser exactly as `tools/flatten.py` does at
build time — resized against a 1440px reference, WebP at quality 0.72, named
by content hash. A phone photo lands in the repository at tens of kilobytes.

Colours are CSS variables that `flatten.py` extracts from the design's inline
styles on every build. The admin checks each text/background pair for WCAG AA
contrast and distinguishes a pair the edit broke from one that was already
weak, so the warning means something.

---

## Working on the site

Preview `site/` locally:

```bash
node tools/serve.mjs
```

Re-flatten after a new design export:

```bash
python3 tools/flatten.py
```

It needs `pillow` and `fonttools[woff]`:

```bash
python3 -m pip install "fonttools[woff]" pillow
```

Test the functions — no network, credentials or Netlify CLI needed. It runs
them against a fake GitHub and covers the OAuth handshake, the allowlist, and
the save → pull request → publish lifecycle:

```bash
node tools/test-functions.mjs
```

To run the admin against the real thing locally you need the Netlify CLI and a
`.env` holding the same variables as step 4:

```bash
npx netlify dev
```

---

## Notes

- Fonts are self-hosted rather than fetched from Google. That is a GDPR
  consideration as much as a performance one — no visitor IP reaches a third
  party just to load a typeface.
- Asset filenames carry a content hash, so they are cached for a year and a
  redesign can never serve a stale image.
- `site/index.html` is written so that a browser DOM round-trip reproduces it
  byte for byte. That is deliberate: it keeps copy pull requests down to the
  sentences that actually changed instead of a whole-file reformat.
