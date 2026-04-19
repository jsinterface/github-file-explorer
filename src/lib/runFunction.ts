import { transform } from "sucrase";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import type { NodePath } from "@babel/traverse";
import type * as t from "@babel/types";

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

export type CallSite = {
  name: string; // identifier text as written
  start: number; // byte offset in source
  end: number;
  line: number;
  column: number;
};

export type FunctionTrace = {
  source: string;
  exportName: string;
  bodyStart: number;
  bodyEnd: number;
  callSites: CallSite[];
};

export async function fetchRawFile(
  owner: string,
  repo: string,
  branch: string,
  path: string,
): Promise<string> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch ${path} (${r.status})`);
  return r.text();
}

function parseSource(code: string, isTs: boolean) {
  return parse(code, {
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
}

function isFunctionNode(node: t.Node | null | undefined): boolean {
  if (!node) return false;
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "ClassDeclaration" ||
    node.type === "ClassExpression"
  );
}

/**
 * Locate the named export within `source` and return its body span plus
 * call sites (identifiers that match `refLabels`) in source order.
 */
export function analyzeFunctionInSource(
  source: string,
  path: string,
  exportName: string,
  refLabels: Set<string>,
): FunctionTrace | null {
  const isTs = /\.tsx?$/i.test(path);
  let ast: ReturnType<typeof parse>;
  try {
    ast = parseSource(source, isTs);
  } catch {
    return null;
  }

  const holder: { path: NodePath<t.Node> | null } = { path: null };
  const ownName = exportName === "default" ? null : exportName;

  traverse(ast, {
    ExportNamedDeclaration(p) {
      if (holder.path) return;
      const decl = p.node.declaration;
      if (!decl) return;
      if (decl.type === "FunctionDeclaration" && decl.id?.name === exportName) {
        holder.path = p.get("declaration") as NodePath<t.Node>;
      } else if (decl.type === "ClassDeclaration" && decl.id?.name === exportName) {
        holder.path = p.get("declaration") as NodePath<t.Node>;
      } else if (decl.type === "VariableDeclaration") {
        const declPath = p.get("declaration") as NodePath<t.VariableDeclaration>;
        const declarators = declPath.get("declarations") as NodePath<t.VariableDeclarator>[];
        for (const dPath of declarators) {
          const d = dPath.node;
          if (d.id.type === "Identifier" && d.id.name === exportName && d.init && isFunctionNode(d.init)) {
            holder.path = dPath.get("init") as NodePath<t.Node>;
            break;
          }
        }
      }
    },
    ExportDefaultDeclaration(p) {
      if (holder.path) return;
      if (exportName !== "default") return;
      const decl = p.node.declaration;
      if (
        decl.type === "FunctionDeclaration" ||
        decl.type === "FunctionExpression" ||
        decl.type === "ArrowFunctionExpression" ||
        decl.type === "ClassDeclaration"
      ) {
        holder.path = p.get("declaration") as NodePath<t.Node>;
      }
    },
  });

  const bodyPath = holder.path;
  if (!bodyPath) return null;
  const bodyNode = bodyPath.node;
  const bodyStart = bodyNode.start ?? 0;
  const bodyEnd = bodyNode.end ?? source.length;

  const callSites: CallSite[] = [];
  const seen = new Set<number>();
  bodyPath.traverse({
    Identifier(p) {
      const parent = p.parent;
      if (parent.type === "MemberExpression" && parent.property === p.node && !parent.computed) return;
      if (parent.type === "ObjectProperty" && parent.key === p.node && !parent.computed) return;
      if (ownName && p.node.name === ownName) return;
      if (!refLabels.has(p.node.name)) return;
      const start = p.node.start ?? -1;
      if (start < 0 || seen.has(start)) return;
      seen.add(start);
      callSites.push({
        name: p.node.name,
        start,
        end: p.node.end ?? start + p.node.name.length,
        line: p.node.loc?.start.line ?? 1,
        column: p.node.loc?.start.column ?? 0,
      });
    },
    JSXIdentifier(p) {
      const name = p.node.name;
      if (!/^[A-Z]/.test(name)) return;
      if (!refLabels.has(name)) return;
      const start = p.node.start ?? -1;
      if (start < 0 || seen.has(start)) return;
      seen.add(start);
      callSites.push({
        name,
        start,
        end: p.node.end ?? start + name.length,
        line: p.node.loc?.start.line ?? 1,
        column: p.node.loc?.start.column ?? 0,
      });
    },
  });

  callSites.sort((a, b) => a.start - b.start);

  return { source, exportName, bodyStart, bodyEnd, callSites };
}

/**
 * Transpile TS/JSX source to plain ESM using sucrase, then load it as a
 * blob-url module.
 */
export async function loadModuleFromSource(
  source: string,
  path: string,
): Promise<Record<string, unknown>> {
  const isTs = /\.tsx?$/i.test(path);
  const isJsx = /\.[jt]sx$/i.test(path);
  const transforms: ("typescript" | "jsx" | "imports")[] = [];
  if (isTs) transforms.push("typescript");
  if (isJsx) transforms.push("jsx");
  const out = transform(source, { transforms, production: true });

  // Strip non-relative imports (we cannot resolve them in the browser).
  // Replace bare imports with no-op so the module can still load.
  const sanitized = out.code.replace(
    /^\s*import\s+(?:[^"';]+from\s+)?["']([^"']+)["'];?\s*$/gm,
    (full, spec: string) => {
      if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("http")) {
        return full; // we will fail on these too, but leave them for clarity
      }
      return `// stripped import: ${spec}`;
    },
  );

  const blob = new Blob([sanitized], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    const mod = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
    return mod;
  } finally {
    URL.revokeObjectURL(url);
  }
}
