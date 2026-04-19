import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FileGraph } from "@/components/FileGraph";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ImportGraphView } from "@/components/ImportGraph";
import { SymbolGraphView } from "@/components/SymbolGraph";
import { buildImportGraph, type ImportGraph } from "@/lib/importGraph";
import { buildSymbolGraph, type SymbolGraph } from "@/lib/symbolGraph";

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

type ViewMode = "json" | "graph" | "imports" | "symbols" | "symbolsJson";

type SymbolTreeNode =
  | { [key: string]: SymbolTreeNode }
  | Record<string, string[]>;

function symbolGraphToTree(g: SymbolGraph): Record<string, SymbolTreeNode> {
  const idToLabel = new Map(g.nodes.map((n) => [n.id, n.label]));
  // Group nodes by file, collect referenced labels per export name
  const perFile = new Map<string, Record<string, string[]>>();
  for (const n of g.nodes) {
    if (!perFile.has(n.file)) perFile.set(n.file, {});
    perFile.get(n.file)![n.name] = [];
  }
  for (const l of g.links) {
    const sId = typeof l.source === "string" ? l.source : (l.source as { id: string }).id;
    const tId = typeof l.target === "string" ? l.target : (l.target as { id: string }).id;
    const sNode = g.nodes.find((n) => n.id === sId);
    const tLabel = idToLabel.get(tId);
    if (!sNode || !tLabel) continue;
    perFile.get(sNode.file)?.[sNode.name]?.push(tLabel);
  }

  const root: Record<string, SymbolTreeNode> = {};
  for (const [file, exportsMap] of perFile) {
    const parts = file.split("/");
    let cursor: Record<string, SymbolTreeNode> = root;
    parts.forEach((name, idx) => {
      const isLast = idx === parts.length - 1;
      if (isLast) {
        cursor[name] = exportsMap as SymbolTreeNode;
      } else {
        if (!cursor[name] || Array.isArray((cursor[name] as Record<string, unknown>))) {
          cursor[name] = {};
        }
        cursor = cursor[name] as Record<string, SymbolTreeNode>;
      }
    });
  }
  return root;
}

function Index() {
  const [input, setInput] = useState("d3/d3");
  const [view, setView] = useState<ViewMode>("json");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FetchResult | null>(null);
  const [importGraph, setImportGraph] = useState<ImportGraph | null>(null);
  const [symbolGraph, setSymbolGraph] = useState<SymbolGraph | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setImportGraph(null);
    setSymbolGraph(null);

    const parsed = parseRepoInput(input);
    if (!parsed) {
      setError("Enter a repo as 'owner/name' or a github.com URL.");
      return;
    }

    setLoading(true);
    setProgress(null);
    try {
      const repoRes = await fetch(
        `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`,
      );
      if (!repoRes.ok) throw new Error(`Repository not found (${repoRes.status})`);
      const repoData = await repoRes.json();
      const branch: string = repoData.default_branch;

      if (view === "imports" || view === "symbols" || view === "symbolsJson") {
        if (view === "imports") {
          const graph = await buildImportGraph(
            parsed.owner,
            parsed.repo,
            branch,
            (msg) => setProgress(msg),
          );
          setImportGraph(graph);
        } else {
          const graph = await buildSymbolGraph(
            parsed.owner,
            parsed.repo,
            branch,
            (msg) => setProgress(msg),
          );
          setSymbolGraph(graph);
        }
        setResult({
          repo: `${parsed.owner}/${parsed.repo}`,
          branch,
          truncated: false,
          items: [],
          json: "",
        });
      } else {
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
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }

  return (
    <div className="min-h-screen bg-background px-4 py-12">
      <div className="mx-auto max-w-4xl">
        <header className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">
              GitHub Repo Explorer
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Enter a repository (e.g. <code className="font-mono">facebook/react</code>) to
              view its files and folders as JSON or as a D3 graph.
            </p>
          </div>
          <ThemeToggle />
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
            <Tabs value={view} onValueChange={(v) => setView(v as ViewMode)}>
              <TabsList>
                <TabsTrigger value="json">JSON</TabsTrigger>
                <TabsTrigger value="graph">Files</TabsTrigger>
                <TabsTrigger value="imports">Imports</TabsTrigger>
                <TabsTrigger value="symbols">Symbols</TabsTrigger>
                <TabsTrigger value="symbolsJson">Symbols JSON</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <Button type="submit" disabled={loading}>
            {loading
              ? "Loading…"
              : view === "imports"
                ? "Analyze imports"
                : view === "symbols" || view === "symbolsJson"
                  ? "Analyze symbols"
                  : "Fetch tree"}
          </Button>
        </form>

        {loading && progress && (
          <div className="mt-6 rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
            {progress}
          </div>
        )}

        {error && (
          <div className="mt-6 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {result && (
          <div className="mt-6">
            <div className="mb-3 text-xs text-muted-foreground">
              <span className="font-mono">{result.repo}</span> · branch{" "}
              <span className="font-mono">{result.branch}</span>
              {view !== "imports" && view !== "symbols" && view !== "symbolsJson" && (
                <> · {result.items.length} entries</>
              )}
              {view === "imports" && importGraph && (
                <> · {importGraph.fileCount} source files</>
              )}
              {(view === "symbols" || view === "symbolsJson") && symbolGraph && (
                <>
                  {" "}
                  · {symbolGraph.fileCount} files · {symbolGraph.nodes.length} symbols ·{" "}
                  {symbolGraph.links.length} refs
                </>
              )}
              {result.truncated && " · truncated"}
            </div>
            {view === "json" && (
              <pre className="max-h-[70vh] overflow-auto rounded-md border border-border bg-muted p-4 font-mono text-xs text-foreground">
                {result.json}
              </pre>
            )}
            {view === "graph" && (
              <FileGraph items={result.items} rootLabel={result.repo} />
            )}
            {view === "imports" && importGraph && <ImportGraphView data={importGraph} />}
            {view === "symbols" && symbolGraph && <SymbolGraphView data={symbolGraph} />}
            {view === "symbolsJson" && symbolGraph && (
              <pre className="max-h-[70vh] overflow-auto rounded-md border border-border bg-muted p-4 font-mono text-xs text-foreground">
                {JSON.stringify(symbolGraphToTree(symbolGraph), null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
