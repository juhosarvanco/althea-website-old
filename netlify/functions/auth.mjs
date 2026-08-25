// Step 1 of GitHub OAuth: bounce the editor to GitHub with a CSRF state token.
import { env, cookie } from "./_lib.mjs";

export default async (req) => {
  const site = new URL(req.url).origin;
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
