// The admin's entire server-side surface.
//
// Deliberately not a general GitHub proxy: it exposes four named actions and
// will only ever write the files listed in CONTENT_PATHS. Even if the admin
// page were compromised, this is the most it can do.

import {
  gh, json, repo, requireUser, contentPaths, b64encode, b64decode, previewUrl,
  encPath, assetDir,
} from "./_lib.mjs";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;

// The editor re-encodes every upload to WebP and names it after a hash of its
// bytes, so a legitimate filename always looks like this. Anything else is
// refused rather than written.
const ASSET_NAME = /^[a-z0-9][a-z0-9-]{0,63}\.[0-9a-f]{8}\.webp$/;

const branchFor = (login) => `content/${String(login).toLowerCase()}`;

async function defaultBranch(token, r) {
  const info = await gh(token, `/repos/${r.owner}/${r.name}`);
  return info.default_branch || "main";
}

async function fileAt(token, r, path, ref) {
  try {
    const res = await gh(
      token,
      `/repos/${r.owner}/${r.name}/contents/${encPath(path)}?ref=${encodeURIComponent(ref)}`);
    return { sha: res.sha, content: b64decode(res.content.replace(/\n/g, "")) };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function openPrFor(token, r, branch) {
  const prs = await gh(
    token,
    `/repos/${r.owner}/${r.name}/pulls?state=open`
    + `&head=${encodeURIComponent(r.owner + ":" + branch)}&per_page=1`);
  return prs[0] || null;
}

/* ------------------------------------------------------------------ actions */

async function session(token, user, r) {
  const base = await defaultBranch(token, r);
  const path = contentPaths()[0];
  const live = await fileAt(token, r, path, base);
  const branch = branchFor(user.login);

  let draft = null;
  const pr = await openPrFor(token, r, branch);
  if (pr) {
    const f = await fileAt(token, r, path, branch);
    // The list endpoint omits `mergeable`; the single-PR endpoint computes it.
    const full = await gh(token, `/repos/${r.owner}/${r.name}/pulls/${pr.number}`);
    draft = {
      branch,
      pr: pr.number,
      url: pr.html_url,
      preview: previewUrl(pr.number),
      mergeable: full.mergeable,
      behindBy: full.mergeable_state === "behind",
      content: f?.content ?? null,
      sha: f?.sha ?? null,
      updatedAt: pr.updated_at,
    };
  }
  return { user, repo: r.full, base, path, live, draft };
}

async function ensureBranch(token, r, branch) {
  const api = `/repos/${r.owner}/${r.name}`;
  const base = await defaultBranch(token, r);
  try {
    await gh(token, `${api}/git/ref/heads/${encPath(branch)}`);
  } catch (e) {
    if (e.status !== 404) throw e;
    const head = await gh(token, `${api}/git/ref/heads/${encPath(base)}`);
    await gh(token, `${api}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: head.object.sha }),
    });
  }
  return base;
}

/** Commit one re-encoded image onto the draft branch. */
async function asset(token, user, r, body) {
  const name = String(body.name || "");
  if (!ASSET_NAME.test(name)) return json({ error: "kelvoton tiedostonimi" }, 400);

  const b64 = String(body.content || "").replace(/\s/g, "");
  if (!b64) return json({ error: "tyhjä tiedosto" }, 400);
  if (Math.ceil(b64.length * 3 / 4) > MAX_ASSET_BYTES) {
    return json({ error: "kuva on liian suuri" }, 413);
  }

  const branch = branchFor(user.login);
  await ensureBranch(token, r, branch);
  const path = `${assetDir()}/${name}`;
  const api = `/repos/${r.owner}/${r.name}`;

  // Content-addressed: if these exact bytes are already committed, reuse them.
  let existing = null;
  try {
    existing = await gh(token,
      `${api}/contents/${encPath(path)}?ref=${encodeURIComponent(branch)}`);
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  if (!existing) {
    await gh(token, `${api}/contents/${encPath(path)}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `Kuva: ${name}`,
        content: b64,
        branch,
      }),
    });
  }
  return json({ ok: true, path, url: "/" + path.replace(/^site\//, "") });
}

async function save(token, user, r, body) {
  const path = contentPaths()[0];
  const content = String(body.content ?? "");
  if (!content) return json({ error: "tyhjä sisältö" }, 400);
  if (Buffer.byteLength(content, "utf8") > MAX_BYTES) {
    return json({ error: "sisältö on liian suuri" }, 413);
  }

  const branch = branchFor(user.login);
  const api = `/repos/${r.owner}/${r.name}`;
  const base = await ensureBranch(token, r, branch);

  const existing = await fileAt(token, r, path, branch);
  const count = Number(body.count) || 0;
  const commitMsg = body.message ||
    `Sisältömuutos: ${count} ${count === 1 ? "kohta" : "kohtaa"}`;

  const put = await gh(token, `${api}/contents/${encPath(path)}`, {
    method: "PUT",
    body: JSON.stringify({
      message: commitMsg,
      content: b64encode(content),
      branch,
      ...(existing ? { sha: existing.sha } : {}),
    }),
  });

  let pr = await openPrFor(token, r, branch);
  if (!pr) {
    pr = await gh(token, `${api}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title: `Sisältömuutokset — ${user.name || user.login}`,
        head: branch,
        base,
        body: body.summary || "Sisältömuutoksia Althean ylläpitosivulta.",
      }),
    });
  } else if (body.summary) {
    await gh(token, `${api}/pulls/${pr.number}`, {
      method: "PATCH",
      body: JSON.stringify({ body: body.summary }),
    });
  }

  return json({
    ok: true,
    sha: put.content.sha,
    pr: pr.number,
    url: pr.html_url,
    preview: previewUrl(pr.number),
  });
}

async function publish(token, user, r) {
  const branch = branchFor(user.login);
  const api = `/repos/${r.owner}/${r.name}`;
  const pr = await openPrFor(token, r, branch);
  if (!pr) return json({ error: "ei julkaistavia muutoksia" }, 404);

  const full = await gh(token, `${api}/pulls/${pr.number}`);

  // Someone published while this draft was open — fold their changes in first.
  if (full.mergeable_state === "behind" || full.mergeable === false) {
    try {
      await gh(token, `${api}/pulls/${pr.number}/update-branch`, {
        method: "PUT", body: JSON.stringify({}),
      });
      await new Promise((r) => setTimeout(r, 1500));
    } catch {
      return json({
        error: "conflict",
        message: "Toinen julkaisu ehti väliin, eivätkä muutokset yhdisty " +
                 "automaattisesti. Avaa veto­pyyntö GitHubissa ja selvitä ristiriita.",
        url: pr.html_url,
      }, 409);
    }
  }

  try {
    const merged = await gh(token, `${api}/pulls/${pr.number}/merge`, {
      method: "PUT",
      body: JSON.stringify({
        merge_method: "squash",
        commit_title: `${full.title} (#${pr.number})`,
      }),
    });
    await gh(token, `${api}/git/refs/heads/${encPath(branch)}`, {
      method: "DELETE",
    }).catch(() => {});
    return json({ ok: true, merged: true, sha: merged.sha, pr: pr.number });
  } catch (e) {
    return json({ error: "merge", message: e.message, url: pr.html_url }, 409);
  }
}

async function discard(token, user, r) {
  const branch = branchFor(user.login);
  const api = `/repos/${r.owner}/${r.name}`;
  const pr = await openPrFor(token, r, branch);
  if (pr) {
    await gh(token, `${api}/pulls/${pr.number}`, {
      method: "PATCH", body: JSON.stringify({ state: "closed" }),
    });
  }
  await gh(token, `${api}/git/refs/heads/${encPath(branch)}`, {
    method: "DELETE",
  }).catch(() => {});
  return json({ ok: true });
}

/* ------------------------------------------------------------------ router */

export default async (req) => {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    return json({ error: e.message, signedIn: false }, e.status || 401);
  }

  const r = repo();
  const action = new URL(req.url).searchParams.get("action") || "session";
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

  try {
    switch (action) {
      case "session": return json(await session(user.token, user, r));
      case "save":    return await save(user.token, user, r, body);
      case "asset":   return await asset(user.token, user, r, body);
      case "publish": return await publish(user.token, user, r);
      case "discard": return await discard(user.token, user, r);
      default:        return json({ error: `tuntematon toiminto: ${action}` }, 400);
    }
  } catch (e) {
    return json({ error: e.message, detail: e.body ?? null }, e.status || 500);
  }
};

export const config = { path: "/api/gh" };
