import JSZip from "jszip";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import type { NodePath } from "@babel/traverse";
import type * as t from "@babel/types";

// @babel/traverse ships as CJS; the default export differs across bundlers.
const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

export type SymbolNode = {
  id: string; // `${file}#${name}`
  label: string; // `${shortFile}:${name}`
  file: string;
  name: string;
  kind: "function" | "value";
};

export type SymbolLink = { source: string; target: string };

export type SymbolGraph = {
  nodes: SymbolNode[];
  links: SymbolLink[];
  fileCount: number;
  functionCount: number;
};

const SOURCE_EXT = /\.(jsx?|tsx?|mjs|cjs)$/i;
const SKIP_DIRS = /(^|\/)(node_modules|dist|build|\.next|\.turbo|coverage|\.git)(\/|$)/;
const RESOLVE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const INDEX_EXTS = RESOLVE_EXTS.filter(Boolean).map((e) => `/index${e}`);

function resolveRelative(
  fromFile: string,
  spec: string,
  files: Set<string>,
): string | null {
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
    const c = base + ext;
    if (files.has(c)) return c;
  }
  for (const ext of INDEX_EXTS) {
    const c = base + ext;
    if (files.has(c)) return c;
  }
  return null;
}

function shortFile(path: string): string {
  const parts = path.split("/");
  return parts.slice(-2).join("/");
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

type FileExports = {
  // local binding name -> exported name
  exports: Map<string, { exportName: string; kind: "function" | "value"; bodyPath?: NodePath }>;
  // imported local binding -> { sourceFile, importedName ("default" or named) }
  imports: Map<string, { sourceFile: string | null; importedName: string }>;
};

function parseFile(code: string, isTs: boolean) {
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

function collectFile(
  path: string,
  code: string,
  files: Set<string>,
): FileExports {
  const isTs = /\.tsx?$/i.test(path);
  const result: FileExports = { exports: new Map(), imports: new Map() };
  let ast: ReturnType<typeof parse>;
  try {
    ast = parseFile(code, isTs);
  } catch {
    return result;
  }

  traverse(ast, {
    ImportDeclaration(p) {
      const spec = p.node.source.value;
      let target: string | null = null;
      if (spec.startsWith(".") || spec.startsWith("/")) {
        target = resolveRelative(path, spec.replace(/^\//, ""), files);
      }
      for (const s of p.node.specifiers) {
        if (s.type === "ImportDefaultSpecifier") {
          result.imports.set(s.local.name, { sourceFile: target, importedName: "default" });
        } else if (s.type === "ImportSpecifier") {
          const imported =
            s.imported.type === "Identifier" ? s.imported.name : s.imported.value;
          result.imports.set(s.local.name, { sourceFile: target, importedName: imported });
        } else if (s.type === "ImportNamespaceSpecifier") {
          result.imports.set(s.local.name, { sourceFile: target, importedName: "*" });
        }
      }
    },

    ExportNamedDeclaration(p) {
      const node = p.node;
      // export { a, b as c } [from "..."]
      if (node.specifiers.length) {
        let reExportTarget: string | null = null;
        if (node.source) {
          const spec = node.source.value;
          if (spec.startsWith(".") || spec.startsWith("/")) {
            reExportTarget = resolveRelative(path, spec.replace(/^\//, ""), files);
          }
        }
        for (const s of node.specifiers) {
          if (s.type !== "ExportSpecifier") continue;
          const exportedName =
            s.exported.type === "Identifier" ? s.exported.name : s.exported.value;
          const localName = s.local.name;
          if (node.source) {
            // Treat re-export as a value export (no body to traverse)
            result.exports.set(`__reexport_${exportedName}`, {
              exportName: exportedName,
              kind: "value",
            });
            if (reExportTarget) {
              result.imports.set(`__reexport_${exportedName}`, {
                sourceFile: reExportTarget,
                importedName: localName,
              });
            }
          } else {
            result.exports.set(localName, { exportName: exportedName, kind: "value" });
          }
        }
      }
      // export const/let/var/function/class
      const decl = node.declaration;
      if (!decl) return;
      // skip type-only
      if (
        decl.type === "TSTypeAliasDeclaration" ||
        decl.type === "TSInterfaceDeclaration" ||
        decl.type === "TSEnumDeclaration"
      ) {
        return;
      }
      if (decl.type === "FunctionDeclaration" && decl.id) {
        const fnPath = p.get("declaration") as NodePath;
        result.exports.set(decl.id.name, {
          exportName: decl.id.name,
          kind: "function",
          bodyPath: fnPath,
        });
      } else if (decl.type === "ClassDeclaration" && decl.id) {
        const clsPath = p.get("declaration") as NodePath;
        result.exports.set(decl.id.name, {
          exportName: decl.id.name,
          kind: "function",
          bodyPath: clsPath,
        });
      } else if (decl.type === "VariableDeclaration") {
        const declPath = p.get("declaration") as NodePath<t.VariableDeclaration>;
        const declarators = declPath.get("declarations") as NodePath<t.VariableDeclarator>[];
        declarators.forEach((dPath) => {
          const d = dPath.node;
          if (d.id.type !== "Identifier") return;
          const name = d.id.name;
          const init = d.init;
          if (init && isFunctionNode(init)) {
            result.exports.set(name, {
              exportName: name,
              kind: "function",
              bodyPath: dPath.get("init") as NodePath,
            });
          } else {
            result.exports.set(name, { exportName: name, kind: "value" });
          }
        });
      }
    },

    ExportDefaultDeclaration(p) {
      const decl = p.node.declaration;
      if (
        decl.type === "TSTypeAliasDeclaration" ||
        decl.type === "TSInterfaceDeclaration"
      ) {
        return;
      }
      if (decl.type === "FunctionDeclaration" || decl.type === "FunctionExpression") {
        result.exports.set("__default__", {
          exportName: "default",
          kind: "function",
          bodyPath: p.get("declaration") as NodePath,
        });
      } else if (decl.type === "ArrowFunctionExpression") {
        result.exports.set("__default__", {
          exportName: "default",
          kind: "function",
          bodyPath: p.get("declaration") as NodePath,
        });
      } else if (decl.type === "ClassDeclaration") {
        result.exports.set("__default__", {
          exportName: "default",
          kind: "function",
          bodyPath: p.get("declaration") as NodePath,
        });
      } else if (decl.type === "Identifier") {
        // re-export of a local binding as default
        result.exports.set(decl.name, { exportName: "default", kind: "value" });
      } else {
        result.exports.set("__default__", { exportName: "default", kind: "value" });
      }
    },
  });

  return result;
}

export async function buildSymbolGraph(
  owner: string,
  repo: string,
  branch: string,
  onProgress?: (msg: string) => void,
): Promise<SymbolGraph> {
  onProgress?.("Downloading repository archive…");
  const url = `/api/zipball?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download archive (${res.status})`);
  const buf = await res.arrayBuffer();

  onProgress?.("Unpacking archive…");
  const zip = await JSZip.loadAsync(buf);
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

  // First pass: collect per-file exports + imports
  const fileData = new Map<string, FileExports>();
  let parsed = 0;
  for (const { path, file } of sourceFiles) {
    const code = await file.async("string");
    fileData.set(path, collectFile(path, code, fileSet));
    parsed++;
    if (parsed % 100 === 0) onProgress?.(`Parsed ${parsed}/${sourceFiles.length} files…`);
  }

  // Build node id index: file -> exportedName -> nodeId
  const exportIndex = new Map<string, Map<string, string>>();
  const nodes: SymbolNode[] = [];
  for (const [file, data] of fileData) {
    const m = new Map<string, string>();
    for (const [, exp] of data.exports) {
      const id = `${file}#${exp.exportName}`;
      if (!m.has(exp.exportName)) {
        m.set(exp.exportName, id);
        nodes.push({
          id,
          label: `${shortFile(file)}:${exp.exportName}`,
          file,
          name: exp.exportName,
          kind: exp.kind,
        });
      }
    }
    exportIndex.set(file, m);
  }

  onProgress?.("Linking function references…");

  const linkSet = new Set<string>();
  const links: SymbolLink[] = [];
  let functionCount = 0;

  for (const [file, data] of fileData) {
    for (const [localName, exp] of data.exports) {
      if (exp.kind !== "function" || !exp.bodyPath) continue;
      functionCount++;
      const sourceId = `${file}#${exp.exportName}`;

      // Identifiers inside this function body
      const seen = new Set<string>();
      exp.bodyPath.traverse({
        Identifier(p) {
          // Skip property access (foo.bar — `bar` is not a binding)
          const parent = p.parent;
          if (
            parent.type === "MemberExpression" &&
            parent.property === p.node &&
            !parent.computed
          )
            return;
          if (
            parent.type === "ObjectProperty" &&
            parent.key === p.node &&
            !parent.computed
          )
            return;
          // Skip the function's own name
          if (p.node.name === localName) return;
          seen.add(p.node.name);
        },
        JSXIdentifier(p) {
          // JSX tag/attr references — useful for component graphs
          const name = p.node.name;
          if (/^[A-Z]/.test(name)) seen.add(name);
        },
      });

      for (const ref of seen) {
        let targetId: string | null = null;

        // 1) Same-file export?
        const sameFileMap = exportIndex.get(file);
        if (sameFileMap?.has(ref)) {
          targetId = sameFileMap.get(ref)!;
        }

        // 2) Imported binding pointing at an internal file?
        if (!targetId) {
          const imp = data.imports.get(ref);
          if (imp && imp.sourceFile) {
            const targetMap = exportIndex.get(imp.sourceFile);
            if (targetMap) {
              if (imp.importedName === "*") {
                // namespace import — skip; we don't know which member
              } else if (targetMap.has(imp.importedName)) {
                targetId = targetMap.get(imp.importedName)!;
              }
            }
          }
        }

        if (targetId && targetId !== sourceId) {
          const key = `${sourceId}→${targetId}`;
          if (!linkSet.has(key)) {
            linkSet.add(key);
            links.push({ source: sourceId, target: targetId });
          }
        }
      }
    }
  }

  return {
    nodes,
    links,
    fileCount: sourceFiles.length,
    functionCount,
  };
}
