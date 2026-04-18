import JSZip from "jszip";
import { parse } from "@babel/parser";

export type ImportNode = {
  id: string;
  label: string;
  kind: "internal" | "external";
};

export type ImportLink = {
  source: string;
  target: string;
};

export type ImportGraph = {
  nodes: ImportNode[];
  links: ImportLink[];
  fileCount: number;
  externalCount: number;
};

const SOURCE_EXT = /\.(jsx?|tsx?|mjs|cjs)$/i;
const SKIP_DIRS = /(^|\/)(node_modules|dist|build|\.next|\.turbo|coverage|\.git)(\/|$)/;
const RESOLVE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const INDEX_EXTS = RESOLVE_EXTS.filter(Boolean).map((e) => `/index${e}`);

function extractImports(code: string, isTs: boolean): string[] {
  const sources: string[] = [];
  try {
    const ast = parse(code, {
      sourceType: "unambiguous",
      allowImportExportEverywhere: true,
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: [
        isTs ? "typescript" : "flow",
        "jsx",
        "decorators-legacy",
        "classProperties",
        "dynamicImport",
        "importMeta",
        "topLevelAwait",
      ],
    });
    for (const node of ast.program.body) {
      if (
        (node.type === "ImportDeclaration" ||
          node.type === "ExportAllDeclaration" ||
          node.type === "ExportNamedDeclaration") &&
        node.source?.value
      ) {
        sources.push(node.source.value);
      }
    }
    // dynamic import() — naive regex fallback for nested expressions
    const dyn = code.matchAll(/\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g);
    for (const m of dyn) sources.push(m[1]);
    const req = code.matchAll(/\brequire\(\s*["'`]([^"'`]+)["'`]\s*\)/g);
    for (const m of req) sources.push(m[1]);
  } catch {
    // ignore parse failures, return whatever we have
  }
  return sources;
}

function resolveRelative(fromFile: string, spec: string, files: Set<string>): string | null {
  const fromDir = fromFile.split("/").slice(0, -1).join("/");
  const parts = (fromDir ? fromDir + "/" + spec : spec).split("/");
  const stack: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") stack.pop();
    else stack.push(p);
  }
  const base = stack.join("/");
  for (const ext of RESOLVE_EXTS) {
    const candidate = base + ext;
    if (files.has(candidate)) return candidate;
  }
  for (const ext of INDEX_EXTS) {
    const candidate = base + ext;
    if (files.has(candidate)) return candidate;
  }
  return null;
}

function externalName(spec: string): string {
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    return parts.slice(0, 2).join("/");
  }
  return spec.split("/")[0];
}

export async function buildImportGraph(
  owner: string,
  repo: string,
  branch: string,
  onProgress?: (msg: string) => void,
): Promise<ImportGraph> {
  onProgress?.("Downloading repository archive…");
  const url = `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${branch}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download archive (${res.status})`);
  const buf = await res.arrayBuffer();

  onProgress?.("Unpacking archive…");
  const zip = await JSZip.loadAsync(buf);

  // Strip the top-level "<repo>-<branch>/" prefix
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  const stripped = entries
    .map((f) => {
      const idx = f.name.indexOf("/");
      const path = idx >= 0 ? f.name.slice(idx + 1) : f.name;
      return { path, file: f };
    })
    .filter(({ path }) => path && !SKIP_DIRS.test(path));

  const sourceFiles = stripped.filter(({ path }) => SOURCE_EXT.test(path));
  const fileSet = new Set(sourceFiles.map((s) => s.path));

  onProgress?.(`Parsing ${sourceFiles.length} source files…`);

  const nodes = new Map<string, ImportNode>();
  const linkSet = new Set<string>();
  const links: ImportLink[] = [];

  for (const { path } of sourceFiles) {
    nodes.set(path, { id: path, label: path, kind: "internal" });
  }

  // Cap to keep the graph readable & fast
  const MAX_FILES = 800;
  const toParse = sourceFiles.slice(0, MAX_FILES);

  for (const { path, file } of toParse) {
    const code = await file.async("string");
    const isTs = /\.tsx?$/i.test(path);
    const specs = extractImports(code, isTs);
    for (const spec of specs) {
      let targetId: string | null = null;
      let kind: "internal" | "external" = "external";
      if (spec.startsWith(".") || spec.startsWith("/")) {
        targetId = resolveRelative(path, spec.replace(/^\//, ""), fileSet);
        if (targetId) kind = "internal";
      }
      if (!targetId) {
        // Treat as external package
        targetId = `npm:${externalName(spec)}`;
        if (!nodes.has(targetId)) {
          nodes.set(targetId, { id: targetId, label: externalName(spec), kind: "external" });
        }
      }
      const key = `${path}→${targetId}`;
      if (!linkSet.has(key) && targetId !== path) {
        linkSet.add(key);
        links.push({ source: path, target: targetId });
      }
    }
  }

  // Drop internal files with no edges to reduce noise
  const used = new Set<string>();
  for (const l of links) {
    used.add(l.source);
    used.add(l.target);
  }
  const finalNodes = [...nodes.values()].filter(
    (n) => n.kind === "external" || used.has(n.id),
  );

  return {
    nodes: finalNodes,
    links,
    fileCount: sourceFiles.length,
    externalCount: finalNodes.filter((n) => n.kind === "external").length,
  };
}
