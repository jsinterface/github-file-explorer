import { useEffect, useRef, useMemo } from "react";
import * as d3 from "d3";

export type SymbolTreeNode =
  | { [key: string]: SymbolTreeNode }
  | Record<string, string[]>;

type RawNode = {
  id: string;
  name: string;
  kind: "root" | "folder" | "file" | "export";
  children?: RawNode[];
};

function isExportLeaf(v: unknown): v is Record<string, string[]> {
  if (!v || typeof v !== "object") return false;
  const vals = Object.values(v as Record<string, unknown>);
  if (vals.length === 0) return false;
  return vals.every((x) => Array.isArray(x));
}

function buildHierarchy(tree: Record<string, SymbolTreeNode>): {
  root: RawNode;
  // export label (e.g. "dir/file.ts:name") -> node id
  labelToId: Map<string, string>;
  // export id -> referenced labels
  refsByExport: Map<string, string[]>;
} {
  const root: RawNode = { id: "__root__", name: "/", kind: "root", children: [] };
  const labelToId = new Map<string, string>();
  const refsByExport = new Map<string, string[]>();

  function walk(
    obj: Record<string, SymbolTreeNode>,
    pathParts: string[],
    parent: RawNode,
  ) {
    for (const [name, child] of Object.entries(obj)) {
      const parts = [...pathParts, name];
      const path = parts.join("/");
      if (isExportLeaf(child)) {
        const fileNode: RawNode = {
          id: `file:${path}`,
          name,
          kind: "file",
          children: [],
        };
        parent.children!.push(fileNode);
        const shortFile = parts.slice(-2).join("/");
        for (const [exportName, refs] of Object.entries(child)) {
          const exportId = `export:${path}#${exportName}`;
          const exportNode: RawNode = {
            id: exportId,
            name: exportName,
            kind: "export",
          };
          fileNode.children!.push(exportNode);
          labelToId.set(`${shortFile}:${exportName}`, exportId);
          refsByExport.set(exportId, refs);
        }
      } else {
        const folderNode: RawNode = {
          id: `folder:${path}`,
          name,
          kind: "folder",
          children: [],
        };
        parent.children!.push(folderNode);
        walk(child as Record<string, SymbolTreeNode>, parts, folderNode);
      }
    }
  }

  walk(tree, [], root);
  return { root, labelToId, refsByExport };
}

export function SymbolTreeGraph({ data }: { data: Record<string, SymbolTreeNode> }) {
  const ref = useRef<SVGSVGElement | null>(null);
  const built = useMemo(() => buildHierarchy(data), [data]);

  useEffect(() => {
    if (!ref.current) return;

    const { root: rawRoot, labelToId, refsByExport } = built;

    // Vertical bottom-up tree: root at bottom, leaves (exports) at top.
    // d3.tree() lays out with root at top by default; we'll flip Y at draw time.
    const root = d3.hierarchy<RawNode>(rawRoot, (d) => d.children);

    const leafCount = Math.max(root.leaves().length, 1);
    const depth = (root.height ?? 1) + 1;

    const colWidth = Math.max(28, Math.min(80, 1400 / leafCount));
    const rowHeight = 90;

    const marginTop = 240; // generous top space for tall reference arcs
    const marginBottom = 40;
    const marginLeft = 40;
    const marginRight = 40;

    const innerWidth = leafCount * colWidth;
    const innerHeight = depth * rowHeight;

    const layout = d3
      .tree<RawNode>()
      .size([innerWidth, innerHeight])
      .separation((a, b) => (a.parent === b.parent ? 1 : 1.4));

    layout(root);

    // Flip y so root sits at the bottom
    root.each((n) => {
      n.y = innerHeight - n.y!;
    });

    const width = innerWidth + marginLeft + marginRight;
    const height = innerHeight + marginTop + marginBottom;

    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();
    svg
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("preserveAspectRatio", "xMidYMid meet");

    const container = svg
      .append("g")
      .attr("transform", `translate(${marginLeft}, ${marginTop})`);

    const zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 8])
      .on("zoom", (event) => {
        container.attr(
          "transform",
          `translate(${marginLeft + event.transform.x}, ${marginTop + event.transform.y}) scale(${event.transform.k})`,
        );
      });
    svg.call(zoomBehavior);

    // ---------- Tree links (containment) ----------
    const linkGen = d3
      .linkVertical<d3.HierarchyPointLink<RawNode>, d3.HierarchyPointNode<RawNode>>()
      .x((d) => d.x!)
      .y((d) => d.y!);

    container
      .append("g")
      .attr("fill", "none")
      .attr("stroke", "var(--color-border)")
      .attr("stroke-width", 1)
      .selectAll("path")
      .data(root.links())
      .join("path")
      .attr("d", linkGen as never);

    // ---------- Tree nodes ----------
    const colorFor = (k: RawNode["kind"]) =>
      k === "root"
        ? "var(--color-primary)"
        : k === "folder"
          ? "var(--color-chart-1)"
          : k === "file"
            ? "var(--color-chart-2)"
            : "var(--color-chart-4)";

    const radiusFor = (k: RawNode["kind"]) =>
      k === "root" ? 5 : k === "folder" ? 4 : k === "file" ? 3.5 : 2.5;

    const node = container
      .append("g")
      .selectAll("g")
      .data(root.descendants())
      .join("g")
      .attr("transform", (d) => `translate(${d.x},${d.y})`);

    node
      .append("circle")
      .attr("r", (d) => radiusFor(d.data.kind))
      .attr("fill", (d) => colorFor(d.data.kind))
      .attr("stroke", "var(--color-background)")
      .attr("stroke-width", 1);

    node.append("title").text((d) => `${d.data.kind}: ${d.data.name}`);

    // Labels: exports above the node (rotated for density), folders/files below
    node
      .filter((d) => d.data.kind === "export")
      .append("text")
      .attr("transform", "rotate(-60)")
      .attr("dx", 6)
      .attr("dy", "0.32em")
      .attr("font-family", "ui-monospace, monospace")
      .attr("font-size", 7)
      .attr("fill", "var(--color-foreground)")
      .text((d) => d.data.name);

    node
      .filter((d) => d.data.kind === "file" || d.data.kind === "folder" || d.data.kind === "root")
      .append("text")
      .attr("dy", "1.6em")
      .attr("text-anchor", "middle")
      .attr("font-family", "ui-monospace, monospace")
      .attr("font-size", (d) => (d.data.kind === "folder" || d.data.kind === "root" ? 9 : 8))
      .attr("fill", "var(--color-foreground)")
      .text((d) => d.data.name);

    // ---------- Reference bezier curves between export nodes ----------
    const idToPoint = new Map<string, { x: number; y: number }>();
    root.each((n) => {
      if (n.data.kind === "export") idToPoint.set(n.data.id, { x: n.x!, y: n.y! });
    });

    type RefPair = { sx: number; sy: number; tx: number; ty: number };
    const refPairs: RefPair[] = [];
    for (const [exportId, refs] of refsByExport) {
      const sp = idToPoint.get(exportId);
      if (!sp) continue;
      for (const refLabel of refs) {
        const targetId = labelToId.get(refLabel);
        if (!targetId) continue;
        const tp = idToPoint.get(targetId);
        if (!tp) continue;
        if (targetId === exportId) continue;
        refPairs.push({ sx: sp.x, sy: sp.y, tx: tp.x, ty: tp.y });
      }
    }

    // Bezier path: arcs upward (above export row) so they don't tangle with the tree.
    // Longer horizontal pull on control points + larger lift = taller, sweeping arches.
    function bezierPath(p: RefPair): string {
      const dx = p.tx - p.sx;
      const dist = Math.abs(dx);
      const lift = Math.min(marginTop * 0.95, 80 + dist * 0.9);
      const pull = Math.max(60, dist * 0.45);
      const c1x = p.sx + Math.sign(dx || 1) * pull;
      const c1y = p.sy - lift;
      const c2x = p.tx - Math.sign(dx || 1) * pull;
      const c2y = p.ty - lift;
      return `M${p.sx},${p.sy} C${c1x},${c1y} ${c2x},${c2y} ${p.tx},${p.ty}`;
    }

    svg
      .append("defs")
      .append("marker")
      .attr("id", "arrow-ref-stg")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 8)
      .attr("refY", 0)
      .attr("markerWidth", 5)
      .attr("markerHeight", 5)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", "var(--color-chart-3)");

    container
      .append("g")
      .attr("fill", "none")
      .attr("stroke", "var(--color-chart-3)")
      .attr("stroke-opacity", 0.45)
      .attr("stroke-width", 0.8)
      .selectAll("path")
      .data(refPairs)
      .join("path")
      .attr("d", (d) => bezierPath(d))
      .attr("marker-end", "url(#arrow-ref-stg)");

    return () => {
      svg.on(".zoom", null);
      svg.selectAll("*").remove();
    };
  }, [built]);

  const refCount = Array.from(built.refsByExport.values()).reduce(
    (a, b) => a + b.length,
    0,
  );
  const exportCount = built.refsByExport.size;

  return (
    <div className="rounded-md border border-border bg-muted">
      <div className="max-h-[70vh] overflow-auto">
        <svg ref={ref} className="w-full" style={{ minHeight: "60vh" }} />
      </div>
      <div className="flex flex-wrap items-center gap-4 border-t border-border px-3 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: "var(--color-chart-1)" }}
          />
          folder
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: "var(--color-chart-2)" }}
          />
          file
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: "var(--color-chart-4)" }}
          />
          export
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-0.5"
            style={{ background: "var(--color-chart-3)" }}
          />
          reference
        </span>
        <span>
          {exportCount} exports · {refCount} references
        </span>
        <span className="ml-auto">scroll to pan • pinch/scroll to zoom</span>
      </div>
    </div>
  );
}
