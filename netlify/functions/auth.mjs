// Step 1 of GitHub OAuth: bounce the editor to GitHub with a CSRF state token.
import { env, cookie } from "./_lib.mjs";

const setupNeeded = (missing, origin) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>Ylläpito ei ole vielä käytössä</title>` +
    `<body style="font:16px/1.65 system-ui,sans-serif;max-width:38rem;margin:14vh auto;padding:0 1.5rem;color:#0d1f29">` +
    `<h1 style="font:400 27px Georgia,serif;margin:0 0 14px">Ylläpito ei ole vielä käytössä</h1>` +
    `<p>Sivusto toimii, mutta GitHub-kirjautumista ei ole vielä määritetty. ` +
    `Puuttuu: <code>${missing.join("</code>, <code>")}</code>.</p>` +
    `<p style="color:#48555C">Luo GitHubissa OAuth-sovellus, jonka callback-osoite on ` +
    `<code>${origin}/api/callback</code>, ja tallenna sen tunnukset Netlifyn ` +
    `ympäristömuuttujiin. Ohjeet ovat repositorion README-tiedostossa.</p>` +
    `<p><a href="/" style="color:#4A5D4E">Takaisin etusivulle</a></p>`,
    { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

export default async (req) => {
  const site = new URL(req.url).origin;

  // Fail readably rather than as a 502 while the OAuth app is still being set up.
  const missing = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]
    .filter((k) => !process.env[k]);
  if (missing.length) return setupNeeded(missing, site);

  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: env("GITHUB_CLIENT_ID"),
    redirect_uri: `${site}/api/callback`,
    // `repo` is the narrowest scope that still allows committing to a private
    // repository. Use `public_repo` instead if the repo is public.
    scope: env("GITHUB_SCOPE", "repo"),
    state,
    allow_signup: "false",
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: `https://github.com/login/oauth/authorize?${params}`,
      "set-cookie": cookie("gh_state", state, 600),
      "cache-control": "no-store",
    },
  });
};

export const config = { path: "/api/auth" };
