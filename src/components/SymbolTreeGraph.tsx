import { useEffect, useRef, useMemo } from "react";
import * as d3 from "d3";

export type SymbolTreeNode =
  | { [key: string]: SymbolTreeNode }
  | Record<string, string[]>;

type RawNode = {
  id: string;
  name: string;
  kind: "folder" | "file" | "export";
  children?: RawNode[];
};

function isExportLeaf(v: unknown): v is Record<string, string[]> {
  if (!v || typeof v !== "object") return false;
  const vals = Object.values(v as Record<string, unknown>);
  if (vals.length === 0) return false;
  return vals.every((x) => Array.isArray(x));
}

function buildHierarchy(tree: Record<string, SymbolTreeNode>): {
  // Forest of top-level folder/file trees (no synthetic root).
  trees: RawNode[];
  labelToId: Map<string, string>;
  refsByExport: Map<string, string[]>;
} {
  const trees: RawNode[] = [];
  const labelToId = new Map<string, string>();
  const refsByExport = new Map<string, string[]>();

  function build(
    obj: Record<string, SymbolTreeNode>,
    pathParts: string[],
  ): RawNode[] {
    const out: RawNode[] = [];
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
        const shortFile = parts.slice(-2).join("/");
        for (const [exportName, refs] of Object.entries(child)) {
          const exportId = `export:${path}#${exportName}`;
          fileNode.children!.push({
            id: exportId,
            name: exportName,
            kind: "export",
          });
          labelToId.set(`${shortFile}:${exportName}`, exportId);
          refsByExport.set(exportId, refs);
        }
        out.push(fileNode);
      } else {
        out.push({
          id: `folder:${path}`,
          name,
          kind: "folder",
          children: build(child as Record<string, SymbolTreeNode>, parts),
        });
      }
    }
    return out;
  }

  trees.push(...build(tree, []));
  return { trees, labelToId, refsByExport };
}

export function SymbolTreeGraph({ data }: { data: Record<string, SymbolTreeNode> }) {
  const ref = useRef<SVGSVGElement | null>(null);
  const built = useMemo(() => buildHierarchy(data), [data]);

  useEffect(() => {
    if (!ref.current) return;

    const { trees, labelToId, refsByExport } = built;
    if (trees.length === 0) return;

    const size = 960;
    const cx = size / 2;
    const cy = size / 2;

    // Inner ring = export leaves; outer ring = top-level folder/file roots.
    const innerR = 120;
    const outerR = size / 2 - 60;

    // Hierarchies for each top-level tree, with leaves counted to allocate
    // angular width proportional to leaf count.
    const hierarchies = trees.map((t) => d3.hierarchy<RawNode>(t, (d) => d.children));
    const leafCounts = hierarchies.map((h) => Math.max(1, h.leaves().length));
    const totalLeaves = leafCounts.reduce((a, b) => a + b, 0);

    // Small angular gap between adjacent top-level trees.
    const gap = trees.length > 1 ? 0.012 : 0;
    const totalGap = gap * trees.length;
    const usable = Math.PI * 2 - totalGap;

    // Precompute angular spans per top-level tree.
    const spans: Array<{ a0: number; a1: number }> = [];
    let cursor = -Math.PI / 2; // start at top
    for (let i = 0; i < hierarchies.length; i++) {
      const span = (leafCounts[i] / totalLeaves) * usable;
      spans.push({ a0: cursor, a1: cursor + span });
      cursor += span + gap;
    }

    // Place each tree using a tree layout in (angle, depth) space, then
    // map (angle, depth) -> (x, y) on a polar grid where depth 0 sits on
    // the OUTER ring and the deepest depth sits on the INNER ring.
    type Placed = {
      node: d3.HierarchyNode<RawNode>;
      x: number;
      y: number;
      angle: number;
      radius: number;
      depth: number;
      maxDepth: number;
    };
    const placed: Placed[] = [];
    const idToPlaced = new Map<string, Placed>();
    const allLinks: Array<{ s: Placed; t: Placed }> = [];

    hierarchies.forEach((h, i) => {
      const { a0, a1 } = spans[i];
      const span = a1 - a0;
      const maxDepth = Math.max(1, h.height);

      // d3.tree with size [angularSpan, 1] gives x in [0..span], y in [0..1].
      const layout = d3
        .tree<RawNode>()
        .size([span, 1])
        .separation((a, b) => (a.parent === b.parent ? 1 : 1.3));
      layout(h);

      h.each((n) => {
        const angle = a0 + (n.x ?? 0);
        // depth normalized 0..1 (0 = root, 1 = deepest)
        const depthFrac = (n.depth ?? 0) / maxDepth;
        // Map: root (depth 0) -> outerR; deepest -> innerR.
        const radius = outerR - depthFrac * (outerR - innerR);
        const px = cx + radius * Math.cos(angle);
        const py = cy + radius * Math.sin(angle);
        const p: Placed = {
          node: n,
          x: px,
          y: py,
          angle,
          radius,
          depth: n.depth ?? 0,
          maxDepth,
        };
        placed.push(p);
        idToPlaced.set(n.data.id, p);
      });

      // Containment links
      h.links().forEach((l) => {
        const s = idToPlaced.get(l.source.data.id);
        const t = idToPlaced.get(l.target.data.id);
        if (s && t) allLinks.push({ s, t });
      });
    });

    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();
    svg
      .attr("viewBox", `0 0 ${size} ${size}`)
      .attr("preserveAspectRatio", "xMidYMid meet");

    const container = svg.append("g");

    const zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 8])
      .on("zoom", (event) => container.attr("transform", event.transform.toString()));
    svg.call(zoomBehavior);

    // ---------- Tree containment links (radial smooth curve) ----------
    // Use a smooth radial path from parent (further out) to child (further in).
    function linkPath(s: Placed, t: Placed): string {
      // Cubic with control points along the radial direction of each endpoint.
      const sLift = (s.radius - t.radius) * 0.5;
      const tLift = (s.radius - t.radius) * 0.5;
      const c1r = s.radius - sLift;
      const c2r = t.radius + tLift;
      const c1x = cx + c1r * Math.cos(s.angle);
      const c1y = cy + c1r * Math.sin(s.angle);
      const c2x = cx + c2r * Math.cos(t.angle);
      const c2y = cy + c2r * Math.sin(t.angle);
      return `M${s.x},${s.y} C${c1x},${c1y} ${c2x},${c2y} ${t.x},${t.y}`;
    }

    container
      .append("g")
      .attr("fill", "none")
      .attr("stroke", "var(--color-border)")
      .attr("stroke-width", 1)
      .selectAll("path")
      .data(allLinks)
      .join("path")
      .attr("d", (l) => linkPath(l.s, l.t));

    // ---------- Reference chords through center ----------
    type RefPair = { s: Placed; t: Placed };
    const refPairs: RefPair[] = [];
    for (const [exportId, refs] of refsByExport) {
      const sp = idToPlaced.get(exportId);
      if (!sp) continue;
      for (const refLabel of refs) {
        const targetId = labelToId.get(refLabel);
        if (!targetId) continue;
        const tp = idToPlaced.get(targetId);
        if (!tp) continue;
        if (targetId === exportId) continue;
        refPairs.push({ s: sp, t: tp });
      }
    }

    function refPath(p: RefPair): string {
      // Cubic with both controls at the center -> smooth chord.
      return `M${p.s.x},${p.s.y} C${cx},${cy} ${cx},${cy} ${p.t.x},${p.t.y}`;
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
      .attr("stroke-opacity", 0.4)
      .attr("stroke-width", 0.7)
      .selectAll("path")
      .data(refPairs)
      .join("path")
      .attr("d", refPath)
      .attr("marker-end", "url(#arrow-ref-stg)");

    // ---------- Nodes ----------
    const colorFor = (k: RawNode["kind"]) =>
      k === "folder"
        ? "var(--color-chart-1)"
        : k === "file"
          ? "var(--color-chart-2)"
          : "var(--color-chart-4)";

    const radiusFor = (k: RawNode["kind"]) =>
      k === "folder" ? 4 : k === "file" ? 3.5 : 2.5;

    const node = container
      .append("g")
      .selectAll("g")
      .data(placed)
      .join("g")
      .attr("transform", (d) => `translate(${d.x},${d.y})`);

    node
      .append("circle")
      .attr("r", (d) => radiusFor(d.node.data.kind))
      .attr("fill", (d) => colorFor(d.node.data.kind))
      .attr("stroke", "var(--color-background)")
      .attr("stroke-width", 1);

    node
      .append("title")
      .text((d) => `${d.node.data.kind}: ${d.node.data.name}`);

    // All labels point radially outward (away from the chart center).
    node
      .append("text")
      .attr("transform", (d) => {
        const deg = (d.angle * 180) / Math.PI;
        const flip = d.angle > Math.PI / 2 && d.angle < (3 * Math.PI) / 2;
        return flip ? `rotate(${deg + 180})` : `rotate(${deg})`;
      })
      .attr("text-anchor", (d) => {
        const flip = d.angle > Math.PI / 2 && d.angle < (3 * Math.PI) / 2;
        return flip ? "end" : "start";
      })
      .attr("dx", (d) => {
        const r = radiusFor(d.node.data.kind) + 3;
        const flip = d.angle > Math.PI / 2 && d.angle < (3 * Math.PI) / 2;
        return flip ? -r : r;
      })
      .attr("dy", "0.32em")
      .attr("font-family", "ui-monospace, monospace")
      .attr("font-size", (d) =>
        d.node.data.kind === "folder" ? 9 : d.node.data.kind === "file" ? 8 : 7,
      )
      .attr("fill", "var(--color-foreground)")
      .text((d) => d.node.data.name);

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
      <div className="max-h-[80vh] overflow-hidden">
        <svg ref={ref} className="w-full" style={{ height: "75vh" }} />
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
        <span className="ml-auto">scroll to zoom</span>
      </div>
    </div>
  );
}
