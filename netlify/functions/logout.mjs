import { cookie } from "./_lib.mjs";

export default async () =>
  new Response(null, {
    status: 302,
    headers: { location: "/admin/", "set-cookie": cookie("gh_token", "", 0) },
  });

export const config = { path: "/api/logout" };
