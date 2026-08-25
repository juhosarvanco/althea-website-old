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

## First-time setup

**1. Push this repository to GitHub.**

**2. Create the Netlify site** from that repository. `netlify.toml` already
sets the publish directory and the functions directory, so accept the
defaults. Note the site name Netlify assigns — you need it in step 4.

**3. Create a GitHub OAuth app** at
*Settings → Developer settings → OAuth Apps → New OAuth App*:

| Field | Value |
| --- | --- |
| Application name | Althea admin |
| Homepage URL | `https://<your-site>` |
| Authorization callback URL | `https://<your-site>/api/callback` |

Generate a client secret and keep the page open for step 4.

**4. Set environment variables** in Netlify under *Site configuration →
Environment variables*:

| Variable | Value |
| --- | --- |
| `GITHUB_CLIENT_ID` | from the OAuth app |
| `GITHUB_CLIENT_SECRET` | from the OAuth app — **secret, never commit it** |
| `GITHUB_REPO` | `owner/repo` |
| `ALLOWED_LOGINS` | `juho,julia` — GitHub logins allowed to edit |
| `SITE_NAME` | your Netlify site name, used to build preview URLs |
| `GITHUB_SCOPE` | optional; `repo` by default, use `public_repo` if the repo is public |
| `CONTENT_PATHS` | optional; `site/index.html` by default |

`ALLOWED_LOGINS` is the access control. Anyone can complete a GitHub login;
only logins on this list get past it.

**5. Give the other editor write access** to the repository
(*Settings → Collaborators*). Write access is what lets their saves become
branches and their Publish merge.

**6. Open `https://<your-site>/admin`** and sign in.

---

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

Only text is editable — layout, images, colours and links are not reachable
from the editor, so a copy edit cannot break the design.

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
