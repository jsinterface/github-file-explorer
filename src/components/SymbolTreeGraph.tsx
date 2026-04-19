import { useEffect, useRef, useMemo } from "react";
import * as d3 from "d3";

export type SymbolLeaf = {
  kind: "function" | "value";
  refs: string[];
};
export type SymbolTreeNode =
  | { [key: string]: SymbolTreeNode }
  | Record<string, SymbolLeaf>;

type RawNode = {
  id: string;
  name: string;
  kind: "folder" | "file" | "export";
  exportKind?: "function" | "value";
  children?: RawNode[];
};

function isExportLeaf(v: unknown): v is Record<string, SymbolLeaf> {
  if (!v || typeof v !== "object") return false;
  const vals = Object.values(v as Record<string, unknown>);
  if (vals.length === 0) return false;
  return vals.every(
    (x) =>
      x !== null &&
      typeof x === "object" &&
      "kind" in (x as object) &&
      "refs" in (x as object) &&
      Array.isArray((x as { refs: unknown }).refs),
  );
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
        for (const [exportName, leaf] of Object.entries(child)) {
          const exportId = `export:${path}#${exportName}`;
          fileNode.children!.push({
            id: exportId,
            name: exportName,
            kind: "export",
            exportKind: leaf.kind,
          });
          labelToId.set(`${shortFile}:${exportName}`, exportId);
          refsByExport.set(exportId, leaf.refs);
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

    const cx = 0;
    const cy = 0;

    // Hierarchies for each top-level tree, with leaves counted to allocate
    // angular width proportional to leaf count.
    const hierarchies = trees.map((t) => d3.hierarchy<RawNode>(t, (d) => d.children));
    const leafCounts = hierarchies.map((h) => Math.max(1, h.leaves().length));
    const totalLeaves = leafCounts.reduce((a, b) => a + b, 0);

    // Precompute export indegrees (incoming reference count) for radius/spacing scaling.
    const indegByExport = new Map<string, number>();
    for (const refs of refsByExport.values()) {
      for (const label of refs) {
        const id = labelToId.get(label);
        if (!id) continue;
        indegByExport.set(id, (indegByExport.get(id) ?? 0) + 1);
      }
    }
    const maxIndeg = Math.max(1, ...indegByExport.values());

    // Export node radius scales with log(indegree).
    const EXPORT_R_MIN = 2.5;
    const EXPORT_R_MAX = 9;
    const exportRadiusFor = (id: string) => {
      const d = indegByExport.get(id) ?? 0;
      const t = Math.log1p(d) / Math.log1p(maxIndeg);
      return EXPORT_R_MIN + t * (EXPORT_R_MAX - EXPORT_R_MIN);
    };

    // Scale ring radii based on leaf density AND average export size so
    // larger nodes get proportionally more breathing room.
    const avgExportR =
      hierarchies.reduce(
        (acc, h) =>
          acc +
          h.leaves().reduce((s, l) => s + exportRadiusFor(l.data.id), 0),
        0,
      ) / Math.max(1, totalLeaves);
    const MIN_ARC_PER_LEAF = Math.max(14, avgExportR * 3.2);
    const BASE_INNER = 120;
    const BASE_OUTER = 420;
    const densityInnerR = (totalLeaves * MIN_ARC_PER_LEAF) / (2 * Math.PI);
    const innerR = Math.max(BASE_INNER, densityInnerR);
    const outerR = innerR + (BASE_OUTER - BASE_INNER);
    const size = (outerR + 60) * 2;

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
        .separation((a, b) => {
          // Base gap weighted by node sizes so larger leaves push neighbors out.
          const sizeWeight = (n: typeof a) => {
            if (n.data.kind !== "export") return 1;
            return exportRadiusFor(n.data.id) / EXPORT_R_MIN;
          };
          const sw = (sizeWeight(a) + sizeWeight(b)) / 2;
          if (a.parent === b.parent) return sw;
          if (a.parent?.parent === b.parent?.parent) return 3 * sw;
          return 4 * sw;
        });
      layout(h);

      h.each((n) => {
        const angle = a0 + (n.x ?? 0);
        let radius: number;
        if (n.data.kind === "export") {
          // All exports pinned to the innermost ring.
          radius = innerR;
        } else {
          // Folders/files distributed by depth between outerR and innerR,
          // reserving the innermost ring exclusively for exports.
          const nonExportMaxDepth = Math.max(1, maxDepth - 1);
          const depthFrac = Math.min(1, (n.depth ?? 0) / nonExportMaxDepth);
          const step = (outerR - innerR) / (nonExportMaxDepth + 1);
          radius = outerR - depthFrac * (outerR - innerR - step);
        }
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

      // Containment links — skip any link touching a folder; folders are
      // rendered as ring arcs spanning their descendants instead.
      h.links().forEach((l) => {
        if (
          l.source.data.kind === "folder" ||
          l.target.data.kind === "folder"
        ) {
          return;
        }
        const s = idToPlaced.get(l.source.data.id);
        const t = idToPlaced.get(l.target.data.id);
        if (s && t) allLinks.push({ s, t });
      });
    });

    // ---------- Folder arcs ----------
    // For each folder node, compute the angular extent of all its descendant
    // file/export leaves and render an arc at the folder's radius.
    type FolderArc = {
      id: string;
      a0: number;
      a1: number;
      radius: number;
      name: string;
    };
    const folderArcs: FolderArc[] = [];
    hierarchies.forEach((h) => {
      h.descendants().forEach((n) => {
        if (n.data.kind !== "folder") return;
        const fp = idToPlaced.get(n.data.id);
        if (!fp) return;
        const leafAngles: number[] = [];
        n.descendants().forEach((d) => {
          if (d.data.kind === "folder") return;
          const dp = idToPlaced.get(d.data.id);
          if (dp) leafAngles.push(dp.angle);
        });
        if (leafAngles.length === 0) return;
        const a0 = Math.min(...leafAngles);
        const a1 = Math.max(...leafAngles);
        folderArcs.push({
          id: n.data.id,
          a0,
          a1,
          radius: fp.radius,
          name: n.data.name,
        });
      });
    });

    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();
    svg
      .attr("viewBox", `${-size / 2} ${-size / 2} ${size} ${size}`)
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

    // Build leaf -> ancestor folder ids, file ids, and link key set per leaf.
    const linkKey = (s: string, t: string) => `${s}__${t}`;
    const leafAncestors = new Map<
      string,
      { folders: Set<string>; files: Set<string>; links: Set<string> }
    >();
    hierarchies.forEach((h) => {
      h.descendants().forEach((n) => {
        if (n.data.kind === "folder") return;
        const folders = new Set<string>();
        const files = new Set<string>();
        const links = new Set<string>();
        let cur: d3.HierarchyNode<RawNode> | null = n;
        while (cur && cur.parent) {
          links.add(linkKey(cur.parent.data.id, cur.data.id));
          if (cur.parent.data.kind === "folder") folders.add(cur.parent.data.id);
          if (cur.parent.data.kind === "file") files.add(cur.parent.data.id);
          cur = cur.parent;
        }
        leafAncestors.set(n.data.id, { folders, files, links });
      });
    });

    const linkSel = container
      .append("g")
      .attr("fill", "none")
      .attr("stroke", "var(--color-muted-foreground)")
      .attr("stroke-width", 1)
      .selectAll<SVGPathElement, { s: Placed; t: Placed }>("path")
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

    const defs = svg.append("defs");
    
    // Arrow marker for full opacity (highlighted)
    defs
      .append("marker")
      .attr("id", "arrow-ref-full")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 8)
      .attr("refY", 0)
      .attr("markerWidth", 5)
      .attr("markerHeight", 5)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", "var(--ref-out-color)");
    
    // Arrow marker for dimmed opacity
    defs
      .append("marker")
      .attr("id", "arrow-ref-dim")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 8)
      .attr("refY", 0)
      .attr("markerWidth", 5)
      .attr("markerHeight", 5)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", "var(--color-muted-foreground)")
      .attr("fill-opacity", 0.6);

    // Arrow marker for default (no hover) reference edges, matches file edge color.
    defs
      .append("marker")
      .attr("id", "arrow-ref-default")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 8)
      .attr("refY", 0)
      .attr("markerWidth", 5)
      .attr("markerHeight", 5)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", "var(--color-muted-foreground)");

    // Arrow marker for incoming highlighted edges (inverse color).
    defs
      .append("marker")
      .attr("id", "arrow-ref-in")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 8)
      .attr("refY", 0)
      .attr("markerWidth", 5)
      .attr("markerHeight", 5)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", "#536dfe");

    const refSel = container
      .append("g")
      .attr("fill", "none")
      .attr("stroke", "var(--color-muted-foreground)")
      .attr("stroke-width", 0.7)
      .selectAll<SVGPathElement, RefPair>("path")
      .data(refPairs)
      .join("path")
      .attr("d", refPath)
      .attr("stroke-opacity", 1)
      .attr("marker-end", "url(#arrow-ref-default)");

    // Build per-export ref maps: outgoing (this export references X) and incoming (X references this).
    const outgoingByExport = new Map<string, Set<string>>();
    const incomingByExport = new Map<string, Set<string>>();
    refPairs.forEach((p) => {
      const s = p.s.node.data.id;
      const t = p.t.node.data.id;
      if (!outgoingByExport.has(s)) outgoingByExport.set(s, new Set());
      outgoingByExport.get(s)!.add(t);
      if (!incomingByExport.has(t)) incomingByExport.set(t, new Set());
      incomingByExport.get(t)!.add(s);
    });

    // ---------- Nodes ----------
    // Distinct colors per export kind: functions vs values.
    const FUNCTION_COLOR = "#536dfe";
    const VALUE_COLOR = "#ffff00";
    const colorFor = (n: RawNode) => {
      if (n.kind === "folder") return "var(--color-chart-1)";
      if (n.kind === "file") return "var(--color-chart-2)";
      return n.exportKind === "function" ? FUNCTION_COLOR : VALUE_COLOR;
    };

    const radiusFor = (n: RawNode) => {
      if (n.kind === "folder") return 4;
      if (n.kind === "file") return 3.5;
      return exportRadiusFor(n.id);
    };

    // Folder ring arcs (drawn before nodes so node circles sit on top).
    const arcGen = d3
      .arc<FolderArc>()
      .innerRadius((d) => d.radius)
      .outerRadius((d) => d.radius)
      .startAngle((d) => d.a0 + Math.PI / 2)
      .endAngle((d) => d.a1 + Math.PI / 2);

    const folderArcSel = container
      .append("g")
      .attr("fill", "none")
      .attr("stroke", "var(--color-chart-1)")
      .attr("stroke-width", 2.5)
      .attr("stroke-linecap", "round")
      .attr("transform", `translate(${cx},${cy})`)
      .selectAll<SVGPathElement, FolderArc>("path")
      .data(folderArcs)
      .join("path")
      .attr("d", (d) => arcGen(d));
    folderArcSel.append("title").text((d) => `folder: ${d.name}`);

    // Bent labels along the outer rim of each folder arc.
    const LABEL_OFFSET = 10;
    const safeId = (s: string) => s.replace(/[^\w-]/g, "_");
    function labelPathD(d: FolderArc): string {
      const r = d.radius + LABEL_OFFSET;
      const mid = (d.a0 + d.a1) / 2;
      const m = Math.atan2(Math.sin(mid), Math.cos(mid));
      const flip = m > 0; // lower half -> reverse so text stays upright
      const a0 = flip ? d.a1 : d.a0;
      const a1 = flip ? d.a0 : d.a1;
      const x0 = cx + r * Math.cos(a0);
      const y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1);
      const y1 = cy + r * Math.sin(a1);
      const sweep = flip ? 0 : 1;
      const largeArc = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
      return `M${x0},${y0} A${r},${r} 0 ${largeArc} ${sweep} ${x1},${y1}`;
    }

    container
      .append("g")
      .selectAll("path")
      .data(folderArcs)
      .join("path")
      .attr("id", (d) => `folder-arc-label-${safeId(d.id)}`)
      .attr("fill", "none")
      .attr("stroke", "none")
      .attr("d", labelPathD);

    // Scale labels by ring distance: center = 0em, outer ring = 1em.
    const fontSizeFor = (r: number) => `${r / outerR}em`;

    container
      .append("g")
      .attr("font-family", "\"Averia Serif Libre\", ui-monospace, monospace")
      .attr("fill", "white")
      .attr("stroke", "black")
      .attr("stroke-width", 4)
      .attr("stroke-linejoin", "round")
      .attr("paint-order", "stroke")
      .attr("font-weight", 700)
      .selectAll<SVGTextElement, FolderArc>("text")
      .data(folderArcs)
      .join("text")
      .attr("dy", "0.32em")
      .attr("font-size", (d) => fontSizeFor(d.radius))
      .append("textPath")
      .attr("href", (d) => `#folder-arc-label-${safeId(d.id)}`)
      .attr("startOffset", "50%")
      .attr("text-anchor", "middle")
      .text((d) => d.name);

    // Map each file/folder id -> set of export ids contained within it.
    const exportsByContainer = new Map<string, Set<string>>();
    hierarchies.forEach((h) => {
      h.descendants().forEach((n) => {
        if (n.data.kind === "export") return;
        const exports = new Set<string>();
        n.descendants().forEach((d) => {
          if (d.data.kind === "export") exports.add(d.data.id);
        });
        exportsByContainer.set(n.data.id, exports);
      });
    });

    const node = container
      .append("g")
      .selectAll<SVGGElement, Placed>("g")
      .data(placed)
      .join("g")
      .attr("transform", (d) => `translate(${d.x},${d.y})`)
      .style("cursor", "pointer");

    const DIM = 0.04;
    const FULL = 1;

    // targetIds: export ids this hover "owns" (1 for an export, all under a file/folder).
    function applyHighlight(targetIds: Set<string>) {
      if (targetIds.size === 0) return;
      // relatedExports = targets + their referenced/referencing exports.
      const relatedExports = new Set<string>(targetIds);
      targetIds.forEach((id) => {
        outgoingByExport.get(id)?.forEach((x) => relatedExports.add(x));
        incomingByExport.get(id)?.forEach((x) => relatedExports.add(x));
      });

      // Highlight ancestors of targets AND of their referenced/referencing exports.
      const folders = new Set<string>();
      const files = new Set<string>();
      const links = new Set<string>();
      relatedExports.forEach((tid) => {
        const a = leafAncestors.get(tid);
        if (!a) return;
        a.folders.forEach((f) => folders.add(f));
        a.files.forEach((f) => files.add(f));
        a.links.forEach((l) => links.add(l));
      });

      linkSel.attr("stroke-opacity", (l) =>
        links.has(linkKey(l.s.node.data.id, l.t.node.data.id)) ? FULL : DIM,
      );
      folderArcSel.attr("stroke-opacity", (a) => (folders.has(a.id) ? FULL : DIM));
      refSel
        .attr("stroke", (p) => {
          const sId = p.s.node.data.id;
          const tId = p.t.node.data.id;
          // Outgoing from a target = referenced edge; incoming to a target = referencing edge.
          if (targetIds.has(sId)) return "var(--ref-out-color)";
          if (targetIds.has(tId)) return "#536dfe";
          return "var(--ref-out-color)";
        })
        .attr("stroke-opacity", (p) => {
          const sId = p.s.node.data.id;
          const tId = p.t.node.data.id;
          return targetIds.has(sId) || targetIds.has(tId) ? FULL : DIM;
        })
        .attr("marker-end", (p) => {
          const sId = p.s.node.data.id;
          const tId = p.t.node.data.id;
          if (targetIds.has(sId)) return "url(#arrow-ref-full)";
          if (targetIds.has(tId)) return "url(#arrow-ref-in)";
          return "url(#arrow-ref-dim)";
        });
      node.style("opacity", (n) => {
        const nid = n.node.data.id;
        return relatedExports.has(nid) || files.has(nid) ? FULL : DIM;
      });
    }

    function clearHighlight() {
      linkSel.attr("stroke-opacity", FULL);
      folderArcSel.attr("stroke-opacity", FULL);
      refSel
        .attr("stroke", "var(--color-muted-foreground)")
        .attr("stroke-opacity", 1)
        .attr("marker-end", "url(#arrow-ref-default)");
      node.style("opacity", FULL);
    }

    node
      .on("mouseenter", (_e, d) => {
        if (d.node.data.kind === "export") {
          applyHighlight(new Set([d.node.data.id]));
        } else {
          const exports = exportsByContainer.get(d.node.data.id) ?? new Set();
          applyHighlight(exports);
        }
      })
      .on("mouseleave", clearHighlight);

    // Folder arcs hoverable too.
    folderArcSel
      .style("cursor", "pointer")
      .style("pointer-events", "stroke")
      .on("mouseenter", (_e, a) => {
        const exports = exportsByContainer.get(a.id) ?? new Set();
        applyHighlight(exports);
      })
      .on("mouseleave", clearHighlight);

    node
      .append("circle")
      .attr("r", (d) => radiusFor(d.node.data))
      .attr("fill", (d) => colorFor(d.node.data));

    node
      .append("title")
      .text((d) => `${d.node.data.kind}: ${d.node.data.name}`);

    // Scale labels by ring distance: center = 0em, outer ring = 1em.
    const nodeFontSizeFor = (r: number) => `${r / outerR}em`;

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
        const r = radiusFor(d.node.data) + 3;
        const flip = d.angle > Math.PI / 2 && d.angle < (3 * Math.PI) / 2;
        return flip ? -r : r;
      })
      .attr("dy", "0.32em")
      .attr("font-family", "\"Averia Serif Libre\", ui-monospace, monospace")
      .attr("font-size", (d) => nodeFontSizeFor(d.radius))
      .attr("fill", "white")
      .attr("stroke", "black")
      .attr("stroke-width", 4)
      .attr("stroke-linejoin", "round")
      .attr("paint-order", "stroke")
      .attr("font-weight", 700)
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
            style={{ background: "#536dfe" }}
          />
          function
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: "#ffff00" }}
          />
          value
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-0.5"
            style={{ background: "var(--color-muted-foreground)" }}
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
