import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FileGraph } from "@/components/FileGraph";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ImportGraphView } from "@/components/ImportGraph";
import { SymbolGraphView } from "@/components/SymbolGraph";
import { SymbolLoomView } from "@/components/SymbolLoom";
import { SymbolTreeGraph } from "@/components/SymbolTreeGraph";
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

type ViewMode =
  | "json"
  | "graph"
  | "imports"
  | "symbols"
  | "symbolsLoom"
  | "symbolsJson"
  | "symbolTree";

type SymbolLeaf = {
  kind: "function" | "value";
  refs: string[];
};
type SymbolTreeNode =
  | { [key: string]: SymbolTreeNode }
  | Record<string, SymbolLeaf>;

function symbolGraphToTree(g: SymbolGraph): Record<string, SymbolTreeNode> {
  const idToLabel = new Map(g.nodes.map((n) => [n.id, n.label]));
  // Group nodes by file, collect referenced labels per export name
  const perFile = new Map<string, Record<string, SymbolLeaf>>();
  for (const n of g.nodes) {
    if (!perFile.has(n.file)) perFile.set(n.file, {});
    perFile.get(n.file)![n.name] = { kind: n.kind, refs: [] };
  }
  for (const l of g.links) {
    const sId = typeof l.source === "string" ? l.source : (l.source as { id: string }).id;
    const tId = typeof l.target === "string" ? l.target : (l.target as { id: string }).id;
    const sNode = g.nodes.find((n) => n.id === sId);
    const tLabel = idToLabel.get(tId);
    if (!sNode || !tLabel) continue;
    perFile.get(sNode.file)?.[sNode.name]?.refs.push(tLabel);
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
  const [input, setInput] = useState("jsinterface/interface");
  const [view, setView] = useState<ViewMode>("symbolTree");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FetchResult | null>(null);
  const [importGraph, setImportGraph] = useState<ImportGraph | null>(null);
  const [symbolGraph, setSymbolGraph] = useState<SymbolGraph | null>(null);
  const [inputJson, setInputJson] = useState<string>("{}");
  const [repoMeta, setRepoMeta] = useState<{ owner: string; repo: string; branch: string } | null>(null);

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
      setRepoMeta({ owner: parsed.owner, repo: parsed.repo, branch });
      if (view === "imports" || view === "symbols" || view === "symbolsLoom" || view === "symbolsJson" || view === "symbolTree") {
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
    <div className="min-h-screen bg-background">
      {/* Full-screen visualization area */}
      <div className="h-screen w-full">
        <div className="h-full w-full">
          {view === "json" && result && (
            <pre className="h-full w-full overflow-auto rounded-none border-0 bg-muted p-4 font-mono text-xs text-foreground">
              {result.json}
            </pre>
          )}
          {view === "graph" && result && (
            <FileGraph items={result.items} rootLabel={result.repo} />
          )}
          {view === "imports" && importGraph && <ImportGraphView data={importGraph} />}
          {view === "symbols" && symbolGraph && <SymbolGraphView data={symbolGraph} />}
          {view === "symbolsLoom" && symbolGraph && <SymbolLoomView data={symbolGraph} />}
          {view === "symbolsJson" && symbolGraph && (
            <pre className="h-full w-full overflow-auto rounded-none border-0 bg-muted p-4 font-mono text-xs text-foreground">
              {JSON.stringify(symbolGraphToTree(symbolGraph), null, 2)}
            </pre>
          )}
          {view === "symbolTree" && symbolGraph && (
            <SymbolTreeGraph
              data={symbolGraphToTree(symbolGraph)}
              repo={repoMeta}
              inputJson={inputJson}
            />
          )}
        </div>
      </div>

      {/* Form at the bottom */}
      <div className="fixed bottom-0 left-0 right-0 border-t border-border bg-background p-4">
        <form
          onSubmit={handleSubmit}
          className="mx-auto flex max-w-4xl items-end gap-3"
        >
          <div className="flex-1">
            <Input
              id="repo"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="owner/name or https://github.com/owner/name"
            />
          </div>
          <Select value={view} onValueChange={(v) => setView(v as ViewMode)}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="View" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="json">JSON</SelectItem>
              <SelectItem value="graph">Files</SelectItem>
              <SelectItem value="imports">Imports</SelectItem>
              <SelectItem value="symbols">Symbols</SelectItem>
              <SelectItem value="symbolsLoom">Symbols Loom</SelectItem>
              <SelectItem value="symbolsJson">Symbols JSON</SelectItem>
              <SelectItem value="symbolTree">Symbol Tree</SelectItem>
            </SelectContent>
          </Select>
          <Button type="submit" disabled={loading}>
            {loading
              ? "Loading…"
              : view === "imports"
                ? "Analyze imports"
              : view === "symbols" || view === "symbolsLoom" || view === "symbolsJson" || view === "symbolTree"
                  ? "Analyze symbols"
                  : "Fetch tree"}
          </Button>
          <ThemeToggle />
        </form>

        {/* Status messages */}
        {loading && progress && (
          <div className="mx-auto mt-2 max-w-4xl rounded-md border border-border bg-muted p-2 text-xs text-muted-foreground">
            {progress}
          </div>
        )}

        {error && (
          <div className="mx-auto mt-2 max-w-4xl rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {result && (
          <div className="mx-auto mt-2 max-w-4xl rounded-md border border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground">
            <span className="font-mono">{result.repo}</span> · branch{" "}
            <span className="font-mono">{result.branch}</span>
            {view !== "imports" && view !== "symbols" && view !== "symbolsLoom" && view !== "symbolsJson" && view !== "symbolTree" && (
              <> · {result.items.length} entries</>
            )}
            {view === "imports" && importGraph && (
              <> · {importGraph.fileCount} source files</>
            )}
            {(view === "symbols" || view === "symbolsLoom" || view === "symbolsJson" || view === "symbolTree") && symbolGraph && (
              <>
                {" "}
                · {symbolGraph.fileCount} files · {symbolGraph.nodes.length} symbols ·{" "}
                {symbolGraph.links.length} refs
              </>
            )}
            {result.truncated && " · truncated"}
          </div>
        )}

        {(view === "symbolTree" || view === "symbols" || view === "symbolsLoom") && (
          <div className="mx-auto mt-3 max-w-4xl">
            <textarea
              id="input-json"
              value={inputJson}
              onChange={(e) => setInputJson(e.target.value)}
              spellCheck={false}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              rows={2}
              placeholder='Input JSON: {"name": "world"}'
            />
          </div>
        )}
      </div>
    </div>
  );
}
