// Step 2 of GitHub OAuth: swap the code for a token and store it in an
// httpOnly cookie. The token is never handed to page JavaScript.
import { env, cookie, readCookie } from "./_lib.mjs";

const fail = (msg) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>Kirjautuminen epäonnistui</title>` +
    `<body style="font:16px/1.6 system-ui;max-width:34rem;margin:15vh auto;padding:0 1.5rem">` +
    `<h1 style="font-size:1.25rem">Kirjautuminen epäonnistui</h1><p>${msg}</p>` +
    `<p><a href="/admin/">Takaisin</a></p>`,
    { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });

export default async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = readCookie(req, "gh_state");

  if (!code) return fail("GitHub ei palauttanut koodia.");
  if (!state || !expected || state !== expected) {
    return fail("Istunnon tarkiste ei täsmännyt. Yritä kirjautua uudelleen.");
  }

  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env("GITHUB_CLIENT_ID"),
      client_secret: env("GITHUB_CLIENT_SECRET"),
      code,
      redirect_uri: `${url.origin}/api/callback`,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) {
    return fail(data.error_description || "Tokenin vaihto ei onnistunut.");
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: "/admin/",
      "cache-control": "no-store",
      // 30 days, then a fresh sign-in.
      "set-cookie": cookie("gh_token", data.access_token, 60 * 60 * 24 * 30),
    },
  });
};

export const config = { path: "/api/callback" };
