// Shared helpers for the admin's GitHub-backed functions.
//
// The OAuth token lives in an httpOnly cookie and is never exposed to page
// JavaScript. Every GitHub call happens here, server-side.

export const GH = "https://api.github.com";

export function env(name, fallback = undefined) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing environment variable: ${name}`);
  }
  return v;
}

export function repo() {
  const [owner, name] = env("GITHUB_REPO").split("/");
  if (!owner || !name) throw new Error("GITHUB_REPO must look like owner/name");
  return { owner, name, full: `${owner}/${name}` };
}

/** Files the admin is permitted to write. Anything else is rejected. */
export function contentPaths() {
  return env("CONTENT_PATHS", "site/index.html")
    .split(",").map((s) => s.trim()).filter(Boolean);
}

export function allowedLogins() {
  return env("ALLOWED_LOGINS", "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function readCookie(req, name) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return null;
}

export function cookie(name, value, maxAge) {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/", "HttpOnly", "Secure", "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  return bits.join("; ");
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

/** Call the GitHub API with the caller's token. Throws with GitHub's message. */
export async function gh(token, path, init = {}) {
  const res = await fetch(path.startsWith("http") ? path : GH + path, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "althea-admin",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error(body?.message || `GitHub ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/** Resolve the signed-in user, enforcing the allowlist. */
export async function requireUser(req) {
  const token = readCookie(req, "gh_token");
  if (!token) {
    const e = new Error("not signed in");
    e.status = 401;
    throw e;
  }
  const me = await gh(token, "/user");
  const allow = allowedLogins();
  if (allow.length && !allow.includes(String(me.login).toLowerCase())) {
    const e = new Error(`${me.login} is not on the editor allowlist`);
    e.status = 403;
    throw e;
  }
  return { token, login: me.login, name: me.name, avatar: me.avatar_url };
}

/** Encode a path for a GitHub URL segment by segment.
 *  encodeURIComponent() on a whole path turns its slashes into %2F, which the
 *  contents and git/ref endpoints do not accept — "site/index.html" and the
 *  branch "content/julia" both have to keep their separators. */
export function encPath(p) {
  return String(p).split("/").map(encodeURIComponent).join("/");
}

export function b64encode(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

export function b64decode(str) {
  return Buffer.from(str, "base64").toString("utf8");
}

/** Preview URL Netlify gives a pull request.
 *
 *  Netlify injects SITE_NAME itself, so this usually needs no configuration.
 *  If it is absent we recover the name from URL, which Netlify also sets — but
 *  that only helps while the primary domain is still *.netlify.app. Once a
 *  custom domain is primary, set SITE_NAME explicitly. */
export function previewUrl(pr) {
  let site = process.env.SITE_NAME;
  if (!site && process.env.URL) {
    const m = /^https?:\/\/([^.]+)\.netlify\.app/.exec(process.env.URL);
    if (m) site = m[1];
  }
  return site ? `https://deploy-preview-${pr}--${site}.netlify.app` : null;
}
