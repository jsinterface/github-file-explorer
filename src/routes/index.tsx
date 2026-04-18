import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FileGraph } from "@/components/FileGraph";

export const Route = createFileRoute("/")({
  component: Index,
});

type TreeItem = {
  path: string;
  mode: string;
  type: "blob" | "tree" | string;
  sha: string;
  size?: number;
  url: string;
};

type NestedNode = {
  name: string;
  type: "file" | "folder";
  children?: Record<string, NestedNode>;
};

type FetchResult = {
  repo: string;
  branch: string;
  truncated: boolean;
  items: TreeItem[];
  json: string;
};

function parseRepoInput(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim().replace(/\.git$/, "").replace(/\/$/, "");
  const urlMatch = trimmed.match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2] };
  const slashMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (slashMatch) return { owner: slashMatch[1], repo: slashMatch[2] };
  return null;
}

function buildTree(items: TreeItem[]): Record<string, NestedNode> {
  const root: Record<string, NestedNode> = {};
  for (const item of items) {
    const parts = item.path.split("/");
    let cursor = root;
    parts.forEach((name, idx) => {
      const isLast = idx === parts.length - 1;
      const isFile = isLast && item.type === "blob";
      if (!cursor[name]) {
        cursor[name] = {
          name,
          type: isFile ? "file" : "folder",
          ...(isFile ? {} : { children: {} }),
        };
      }
      if (!isFile) {
        if (!cursor[name].children) cursor[name].children = {};
        cursor = cursor[name].children!;
      }
    });
  }
  return root;
}

function Index() {
  const [input, setInput] = useState("d3/d3");
  const [view, setView] = useState<"json" | "graph">("json");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FetchResult | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);

    const parsed = parseRepoInput(input);
    if (!parsed) {
      setError("Enter a repo as 'owner/name' or a github.com URL.");
      return;
    }

    setLoading(true);
    try {
      const repoRes = await fetch(
        `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`,
      );
      if (!repoRes.ok) throw new Error(`Repository not found (${repoRes.status})`);
      const repoData = await repoRes.json();
      const branch: string = repoData.default_branch;

      const treeRes = await fetch(
        `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${branch}?recursive=1`,
      );
      if (!treeRes.ok) throw new Error(`Failed to fetch tree (${treeRes.status})`);
      const treeData = await treeRes.json();
      const items = treeData.tree as TreeItem[];

      const nested = buildTree(items);
      const output = {
        repository: `${parsed.owner}/${parsed.repo}`,
        branch,
        truncated: !!treeData.truncated,
        total_entries: items.length,
        tree: nested,
      };
      setResult({
        repo: `${parsed.owner}/${parsed.repo}`,
        branch,
        truncated: !!treeData.truncated,
        items,
        json: JSON.stringify(output, null, 2),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-background px-4 py-12">
      <div className="mx-auto max-w-4xl">
        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            GitHub Repo Explorer
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Enter a repository (e.g. <code className="font-mono">facebook/react</code>) to
            view its files and folders as JSON or as a D3 graph.
          </p>
        </header>

        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          <div className="flex-1">
            <Label htmlFor="repo">Repository</Label>
            <Input
              id="repo"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="owner/name or https://github.com/owner/name"
              className="mt-1.5"
            />
          </div>
          <div className="flex flex-col">
            <Label className="mb-1.5">View</Label>
            <Tabs value={view} onValueChange={(v) => setView(v as "json" | "graph")}>
              <TabsList>
                <TabsTrigger value="json">JSON</TabsTrigger>
                <TabsTrigger value="graph">Graph</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? "Loading…" : "Fetch tree"}
          </Button>
        </form>

        {error && (
          <div className="mt-6 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {result && (
          <div className="mt-6">
            <div className="mb-3 text-xs text-muted-foreground">
              <span className="font-mono">{result.repo}</span> · branch{" "}
              <span className="font-mono">{result.branch}</span> · {result.items.length}{" "}
              entries
              {result.truncated && " · truncated"}
            </div>
            {view === "json" ? (
              <pre className="max-h-[70vh] overflow-auto rounded-md border border-border bg-muted p-4 font-mono text-xs text-foreground">
                {result.json}
              </pre>
            ) : (
              <FileGraph items={result.items} rootLabel={result.repo} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
