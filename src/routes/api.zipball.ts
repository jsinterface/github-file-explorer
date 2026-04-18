import { createFileRoute } from "@tanstack/react-router";
import "@tanstack/react-start";

export const Route = createFileRoute("/api/zipball")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const owner = url.searchParams.get("owner");
        const repo = url.searchParams.get("repo");
        const branch = url.searchParams.get("branch");

        if (!owner || !repo || !branch) {
          return new Response(
            JSON.stringify({ error: "Missing owner, repo, or branch" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }

        // Validate to avoid SSRF / weird inputs
        const safe = /^[A-Za-z0-9._\-/]+$/;
        if (!safe.test(owner) || !safe.test(repo) || !safe.test(branch)) {
          return new Response(JSON.stringify({ error: "Invalid parameters" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const upstream = `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${branch}`;
        const res = await fetch(upstream, {
          headers: { "User-Agent": "lovable-repo-explorer" },
        });

        if (!res.ok || !res.body) {
          return new Response(
            JSON.stringify({ error: `Upstream returned ${res.status}` }),
            { status: res.status, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response(res.body, {
          status: 200,
          headers: {
            "Content-Type": "application/zip",
            "Cache-Control": "public, max-age=300",
          },
        });
      },
    },
  },
});
