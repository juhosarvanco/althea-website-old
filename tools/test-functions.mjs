// Exercises netlify/functions in-process against a fake GitHub API.
//
//     node tools/test-functions.mjs
//
// No network, no credentials, no Netlify CLI. Covers the OAuth handshake
// (including a forged state), the editor allowlist, and the whole draft
// lifecycle: save -> branch -> pull request -> publish -> live.
process.env.GITHUB_CLIENT_ID = "cid123";
process.env.GITHUB_CLIENT_SECRET = "secret456";
process.env.GITHUB_REPO = "juho/althea-website";
process.env.ALLOWED_LOGINS = "juho,julia";
process.env.SITE_NAME = "althea";
process.env.CONTENT_PATHS = "site/index.html";

const F = new URL("../netlify/functions/", import.meta.url).href;
let pass = 0, fail = 0;
const calls = [];

function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name} ${extra}`); }
}

// ---- fake GitHub ---------------------------------------------------------
let branchExists = false;
let prs = [];
const B64 = (s) => Buffer.from(s, "utf8").toString("base64");
const HEAD = '<!DOCTYPE html>\n<html lang="fi"><head></head><body><p>vanha</p></body></html>';
const PAGE_PATH = "site/index.html";
const files = { [`main:${PAGE_PATH}`]: HEAD };   // "ref:path" -> contents
const pathOf = (u) => decodeURIComponent(u.split("/contents/")[1].split("?")[0]);

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = init.method || "GET";
  calls.push(`${method} ${u.replace("https://api.github.com", "")}`);
  const body = init.body ? JSON.parse(init.body) : null;
  const J = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

  if (u.includes("login/oauth/access_token")) return J({ access_token: "tok_abc" });
  if (u.endsWith("/user")) return J({ login: "julia", name: "Julia Grahn", avatar_url: "a.png" });
  if (/\/repos\/juho\/althea-website$/.test(u)) return J({ default_branch: "main" });

  if (u.includes("/contents/") && method === "GET") {
    const key = `${new URL(u).searchParams.get("ref")}:${pathOf(u)}`;
    if (!(key in files)) return J({ message: "Not Found" }, 404);
    return J({ sha: `sha_${key}`, content: B64(files[key]) });
  }
  if (u.includes("/contents/") && method === "PUT") {
    const key = `${body.branch}:${pathOf(u)}`;
    files[key] = body.content ? Buffer.from(body.content, "base64").toString("utf8") : "";
    calls.push(`WROTE ${pathOf(u)}`);
    return J({ content: { sha: "filesha2" } });
  }

  if (u.includes("/pulls?") ) return J(prs);
  if (/\/pulls$/.test(u) && method === "POST") {
    const pr = { number: 12, html_url: "https://github.com/x/pull/12", head: { ref: body.head } };
    prs = [pr]; return J(pr);
  }
  if (/\/pulls\/12$/.test(u) && method === "GET")
    return J({ number: 12, mergeable: true, mergeable_state: "clean", title: "Sisältömuutokset — Julia Grahn" });
  if (/\/pulls\/12$/.test(u) && method === "PATCH") return J({});
  if (/\/pulls\/12\/merge$/.test(u)) {
    for (const k of Object.keys(files)) {
      if (k.startsWith("content/julia:")) files["main:" + k.split(":")[1]] = files[k];
    }
    prs = []; return J({ sha: "mergesha" });
  }

  if (u.includes("/git/ref/heads/")) {
    if (u.endsWith("/main")) return J({ object: { sha: "mainsha" } });
    return branchExists ? J({ object: { sha: "brsha" } }) : J({ message: "Not Found" }, 404);
  }
  if (u.includes("/git/refs") && method === "POST") { branchExists = true; return J({}); }
  if (u.includes("/git/refs/heads/") && method === "DELETE") {
    branchExists = false;
    Object.keys(files).filter(k => k.startsWith("content/julia:")).forEach(k => delete files[k]);
    return J({});
  }

  return J({ message: `unmocked: ${method} ${u}` }, 500);
};

const load = async (f) => (await import(F + f)).default;
const req = (url, opts) => new Request(url, opts);

// ---- auth ----------------------------------------------------------------
console.log("\nauth.mjs");
{
  const res = await (await load("auth.mjs"))(req("https://althea.fi/api/auth"));
  const loc = new URL(res.headers.get("location"));
  ok("redirects to GitHub", res.status === 302 && loc.host === "github.com");
  ok("passes client_id", loc.searchParams.get("client_id") === "cid123");
  ok("callback points at /api/callback", loc.searchParams.get("redirect_uri") === "https://althea.fi/api/callback");
  const sc = res.headers.get("set-cookie") || "";
  ok("state cookie is HttpOnly+Secure", sc.includes("HttpOnly") && sc.includes("Secure"));
  ok("state cookie matches the state param",
     decodeURIComponent(sc.split(";")[0].split("=")[1]) === loc.searchParams.get("state"));
}

// ---- callback ------------------------------------------------------------
console.log("\ncallback.mjs");
{
  const cb = await load("callback.mjs");
  let res = await cb(req("https://althea.fi/api/callback"));
  ok("rejects a missing code", res.status === 400);

  res = await cb(req("https://althea.fi/api/callback?code=c&state=WRONG",
                     { headers: { cookie: "gh_state=RIGHT" } }));
  ok("rejects a forged state (CSRF)", res.status === 400);

  res = await cb(req("https://althea.fi/api/callback?code=c&state=RIGHT",
                     { headers: { cookie: "gh_state=RIGHT" } }));
  const sc = res.headers.get("set-cookie") || "";
  ok("accepts a valid exchange", res.status === 302);
  ok("stores token httpOnly", sc.includes("gh_token=tok_abc") && sc.includes("HttpOnly"));
  ok("returns to /admin/", res.headers.get("location") === "/admin/");
}

// ---- gh ------------------------------------------------------------------
console.log("\ngh.mjs");
{
  const api = await load("gh.mjs");
  const auth = { headers: { cookie: "gh_token=tok_abc" } };

  let res = await api(req("https://althea.fi/api/gh?action=session"));
  ok("401 without a token", res.status === 401);

  process.env.ALLOWED_LOGINS = "juho";           // julia removed
  res = await api(req("https://althea.fi/api/gh?action=session", auth));
  ok("403 for a login off the allowlist", res.status === 403);
  process.env.ALLOWED_LOGINS = "juho,julia";

  calls.length = 0;
  res = await api(req("https://althea.fi/api/gh?action=session", auth));
  let data = await res.json();
  ok("session returns live content", res.status === 200 && data.live.content.includes("vanha"));
  ok("session reports the user", data.user.login === "julia");
  ok("no draft initially", data.draft === null);
  ok("contents URL keeps its slash", calls.some(c => c.includes("/contents/site/index.html")),
     `got: ${calls.filter(c => c.includes("contents")).join(", ")}`);

  calls.length = 0;
  res = await api(req("https://althea.fi/api/gh?action=save", {
    ...auth, method: "POST",
    headers: { ...auth.headers, "content-type": "application/json" },
    body: JSON.stringify({ content: "<!DOCTYPE html>\n<html lang=\"fi\"><head></head><body><p>uusi</p></body></html>",
                           count: 1, summary: "1. **Hero**\n   - Ennen: vanha\n   - Nyt: uusi" }),
  }));
  data = await res.json();
  ok("save succeeds", res.status === 200 && data.ok);
  ok("save opens PR 12", data.pr === 12);
  ok("preview URL built from SITE_NAME",
     data.preview === "https://deploy-preview-12--althea.netlify.app", data.preview);
  ok("branch ref URL keeps its slash", calls.some(c => c.includes("/git/ref/heads/content/julia")),
     `got: ${calls.filter(c => c.includes("git/ref")).join(", ")}`);
  ok("creates the branch when absent", calls.some(c => c.startsWith("POST /repos/juho/althea-website/git/refs")));

  res = await api(req("https://althea.fi/api/gh?action=session", auth));
  data = await res.json();
  ok("draft is reported after save", data.draft?.pr === 12 && data.draft.content.includes("uusi"));

  calls.length = 0;
  res = await api(req("https://althea.fi/api/gh?action=publish", { ...auth, method: "POST" }));
  data = await res.json();
  ok("publish merges", res.status === 200 && data.merged);
  ok("publish deletes the branch", calls.some(c => c.startsWith("DELETE") && c.includes("content/julia")));

  res = await api(req("https://althea.fi/api/gh?action=session", auth));
  data = await res.json();
  ok("published copy is now live", data.live.content.includes("uusi"));
  ok("draft cleared after publish", data.draft === null);

  res = await api(req("https://althea.fi/api/gh?action=publish", { ...auth, method: "POST" }));
  ok("publish with nothing pending is a clean 404", res.status === 404);

  res = await api(req("https://althea.fi/api/gh?action=save", {
    ...auth, method: "POST",
    headers: { ...auth.headers, "content-type": "application/json" },
    body: JSON.stringify({ content: "" }),
  }));
  ok("empty content rejected", res.status === 400);

  res = await api(req("https://althea.fi/api/gh?action=wipe-everything", auth));
  ok("unknown action rejected", res.status === 400);
}

// ---- image uploads -------------------------------------------------------
console.log("\ngh.mjs — image uploads");
{
  const api = await load("gh.mjs");
  const auth = { headers: { cookie: "gh_token=tok_abc" } };
  const post = (body) => api(req("https://althea.fi/api/gh?action=asset", {
    ...auth, method: "POST",
    headers: { ...auth.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  const PNG = Buffer.from("fake-webp-bytes").toString("base64");

  let res = await post({ name: "hero.a1b2c3d4.webp", content: PNG });
  let data = await res.json();
  ok("accepts a correctly named image", res.status === 200 && data.ok);
  ok("writes into site/assets/img", data.path === "site/assets/img/hero.a1b2c3d4.webp", data.path);
  ok("returns a site-root URL", data.url === "/assets/img/hero.a1b2c3d4.webp", data.url);

  calls.length = 0;
  res = await post({ name: "hero.a1b2c3d4.webp", content: PNG });
  ok("identical bytes are not rewritten", res.status === 200 && !calls.some(c => c.startsWith("WROTE")));

  for (const bad of [
    "../../../netlify/functions/gh.mjs",
    "site/index.html",
    "hero.webp",
    "hero.a1b2c3d4.js",
    "hero.NOTHEX12.webp",
    "../evil.a1b2c3d4.webp",
  ]) {
    res = await post({ name: bad, content: PNG });
    ok(`rejects ${JSON.stringify(bad)}`, res.status === 400);
  }

  res = await post({ name: "big.a1b2c3d4.webp", content: "A".repeat(8 * 1024 * 1024) });
  ok("rejects an oversized image", res.status === 413);

  res = await post({ name: "empty.a1b2c3d4.webp", content: "" });
  ok("rejects an empty image", res.status === 400);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
