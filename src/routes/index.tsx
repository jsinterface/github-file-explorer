import { createFileRoute } from "@tanstack/react-router";
import { Github, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FileGraph } from "@/components/FileGraph";

import { ImportGraphView } from "@/components/ImportGraph";
import { SymbolGraphView } from "@/components/SymbolGraph";

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
  const [inputArgs, setInputArgs] = useState<string[]>(["{}"]);
  // Combined string passed downstream: parsed as a JSON array then spread as args.
  const inputJson = inputArgs.join(",");
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
      if (view === "imports" || view === "symbols" || view === "symbolsJson" || view === "symbolTree") {
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

      {/* Floating pill-shaped form at the bottom */}
      <div className="pointer-events-none fixed bottom-6 left-0 right-0 z-20 flex flex-col items-end gap-2 px-4">
        {(view === "symbolTree" && symbolGraph) || (loading && progress) || error || result ? (
          <div className="pointer-events-auto inline-flex w-auto max-w-full flex-col items-end gap-1 self-end px-2 py-1 text-xs text-muted-foreground">
            {view === "symbolTree" && symbolGraph && (
              <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "var(--color-muted-foreground)" }} />
                  file
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "#536dfe" }} />
                  function
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "#6d4c41" }} />
                  value
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-3 w-0.5" style={{ background: "var(--color-muted-foreground)" }} />
                  reference
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-3 w-0.5" style={{ background: "#5c6bc0" }} />
                  referenced
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-3 w-0.5" style={{ background: "#6d4c41" }} />
                  referencing
                </span>
              </div>
            )}
            {(loading && progress) || error || result ? (
              <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
                {loading && progress ? (
                  <span>{progress}</span>
                ) : error ? (
                  <span className="text-destructive">{error}</span>
                ) : result ? (
                  <>
                    <span>
                      <span className="font-mono">{result.repo}</span> · branch{" "}
                      <span className="font-mono">{result.branch}</span>
                    </span>
                    {view !== "imports" && view !== "symbols" && view !== "symbolsJson" && view !== "symbolTree" && (
                      <span>· {result.items.length} entries</span>
                    )}
                    {view === "imports" && importGraph && (
                      <span>· {importGraph.fileCount} source files</span>
                    )}
                    {(view === "symbols" || view === "symbolsJson" || view === "symbolTree") && symbolGraph && (
                      <span>
                        · {symbolGraph.fileCount} files · {symbolGraph.nodes.length} symbols ·{" "}
                        {symbolGraph.links.length} refs
                      </span>
                    )}
                    {result.truncated && <span>· truncated</span>}
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <form
          onSubmit={handleSubmit}
          className="pointer-events-auto flex w-full max-w-4xl items-center gap-2 self-center rounded-full border border-border px-2 py-2 shadow-lg backdrop-blur-md"
          style={{ background: "color-mix(in oklab, var(--surface-elevated) 85%, transparent)" }}
        >
          <span className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#1a1a1a]">
            <Github className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </span>
          <Input
            id="repo"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="owner/name or https://github.com/owner/name"
            className="flex-1 rounded-full border-0 bg-transparent shadow-none focus-visible:ring-0"
            disabled={loading}
          />
          <Select value={view} onValueChange={(v) => setView(v as ViewMode)}>
            <SelectTrigger className="w-[160px] rounded-full border-0 bg-transparent text-foreground shadow-none focus:ring-0">
              <SelectValue placeholder="View" />
            </SelectTrigger>
            <SelectContent className="border-border bg-[#1a1a1a] text-foreground">
              <SelectItem value="json">JSON</SelectItem>
              <SelectItem value="graph">Files</SelectItem>
              <SelectItem value="imports">Imports</SelectItem>
              <SelectItem value="symbols">Symbols</SelectItem>
              
              <SelectItem value="symbolsJson">References</SelectItem>
              <SelectItem value="symbolTree">Semantics</SelectItem>
            </SelectContent>
          </Select>
          {(view === "symbolTree" || view === "symbols") && (
            <div className="flex items-center font-mono text-xs text-muted-foreground">
              <button
                type="submit"
                aria-label="Submit"
                className="select-none border-0 bg-transparent pl-1 pr-0.5 text-2xl leading-none text-muted-foreground hover:cursor-pointer focus:outline-none"
              >
                (
              </button>
              {inputArgs.map((arg, i) => {
                const placeholder = '{"name":"world"}';
                const display = arg.length > 0 ? arg : placeholder;
                return (
                  <span key={i} className="flex items-center">
                    {i > 0 && <span className="select-none px-0.5">,</span>}
                    <span className="relative inline-block font-mono text-xs leading-none">
                      {/* Invisible sizer mirrors the input text to size the wrapper. */}
                      <span
                        aria-hidden="true"
                        className="invisible whitespace-pre font-mono text-xs"
                      >
                        {display}
                      </span>
                      <input
                        value={arg}
                        onChange={(e) => {
                          const next = [...inputArgs];
                          next[i] = e.target.value;
                          setInputArgs(next);
                        }}
                        onKeyDown={(e) => {
                          if (
                            e.key === "Backspace" &&
                            arg === "" &&
                            inputArgs.length > 1
                          ) {
                            e.preventDefault();
                            const next = inputArgs.filter((_, idx) => idx !== i);
                            setInputArgs(next);
                            const form = (e.currentTarget as HTMLInputElement).form;
                            requestAnimationFrame(() => {
                              const inputs = form?.querySelectorAll<HTMLInputElement>(
                                'input[data-arg-input="true"]',
                              );
                              const target = inputs?.[Math.max(0, i - 1)];
                              target?.focus();
                              target?.setSelectionRange(target.value.length, target.value.length);
                            });
                          }
                        }}
                        data-arg-input="true"
                        spellCheck={false}
                        className="absolute inset-0 w-full border-0 bg-transparent p-0 font-mono text-xs text-foreground outline-none focus:ring-0"
                        placeholder={placeholder}
                      />
                    </span>
                  </span>
                );
              })}
              <button
                type="button"
                aria-label="Add argument"
                onClick={() => setInputArgs((args) => [...args, args[args.length - 1] ?? "{}"])}
                className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-[#3a3a3a] hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              <button
                type="submit"
                aria-label="Submit"
                className="select-none border-0 bg-transparent pl-0.5 pr-1 text-2xl leading-none text-muted-foreground hover:cursor-pointer focus:outline-none"
              >
                )
              </button>
            </div>
          )}
          {/* Hidden submit so Enter key triggers form submission */}
          <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
        </form>
      </div>
    </div>
  );
}
