import { useEffect, useRef, useMemo, useState, useCallback } from "react";
import * as d3 from "d3";
import { analyzeFunctionInSource, fetchRawFile, loadModuleFromSource, type FunctionTrace } from "@/lib/runFunction";
import { CodeTracePanel } from "./CodeTracePanel";

export type SymbolLeaf = {
  kind: "function" | "value";
  refs: string[];
};
export type SymbolTreeNode = { [key: string]: SymbolTreeNode } | Record<string, SymbolLeaf>;

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
  kindById: Map<string, "function" | "value">;
} {
  const trees: RawNode[] = [];
  const labelToId = new Map<string, string>();
  const refsByExport = new Map<string, string[]>();
  const kindById = new Map<string, "function" | "value">();

  function build(obj: Record<string, SymbolTreeNode>, pathParts: string[]): RawNode[] {
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
          kindById.set(exportId, leaf.kind);
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
  return { trees, labelToId, refsByExport, kindById };
}

type RepoMeta = { owner: string; repo: string; branch: string };

export function SymbolTreeGraph({
  data,
  repo,
  inputJson,
}: {
  data: Record<string, SymbolTreeNode>;
  repo?: RepoMeta | null;
  inputJson?: string;
}) {
  const ref = useRef<SVGSVGElement | null>(null);
  const built = useMemo(() => buildHierarchy(data), [data]);

  // A single frame in the call stack: one function that is currently executing.
  // The animation always reflects the TOP of the stack.
  type Frame = {
    filePath: string;
    trace: FunctionTrace;
    sourceExportId: string;
    edgeOrder: string[]; // ordered target export ids aligned with trace.callSites
    step: number; // -1 = not yet at a call, 0..edgeOrder.length-1 = at that call, edgeOrder.length = past last
    result: { ok: true; value: unknown } | { ok: false; error: string } | null;
    direction: "forward" | "returning"; // traveler direction for current step
  };
  const [stack, setStack] = useState<Frame[]>([]);
  const cancelRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  // Animation speed multiplier: higher = faster. 1 = base 1500ms per step.
  const [speed, setSpeed] = useState(1);
  const speedRef = useRef(speed);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);
  const BASE_STEP_MS = 1500;
  const stepMs = () => BASE_STEP_MS / speedRef.current;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, ms);
    });

  // Build a Frame for a given export id. Fetches source, builds trace, and aligns edgeOrder.
  // Returns null if the export cannot be located or has no animatable refs.
  const buildFrame = useCallback(
    async (exportId: string, executeFn: boolean): Promise<Frame | null> => {
      if (!repo) return null;
      const m = exportId.match(/^export:(.+)#([^#]+)$/);
      if (!m) return null;
      const filePath = m[1];
      const exportName = m[2];

      const refs = built.refsByExport.get(exportId) ?? [];
      const refLabels = new Set(refs.map((r) => r.split(":").pop() ?? r));
      const labelToTargetId = new Map<string, string>();
      refs.forEach((label) => {
        const tid = built.labelToId.get(label);
        if (tid) labelToTargetId.set(label.split(":").pop() ?? label, tid);
      });

      let source = "";
      try {
        source = await fetchRawFile(repo.owner, repo.repo, repo.branch, filePath);
      } catch (e) {
        return {
          filePath,
          trace: { source: "", exportName, bodyStart: 0, bodyEnd: 0, callSites: [] },
          sourceExportId: exportId,
          edgeOrder: [],
          step: -1,
          result: { ok: false, error: e instanceof Error ? e.message : String(e) },
          direction: "forward",
        };
      }

      const trace = analyzeFunctionInSource(source, filePath, exportName, refLabels);
      if (!trace) {
        return {
          filePath,
          trace: { source, exportName, bodyStart: 0, bodyEnd: source.length, callSites: [] },
          sourceExportId: exportId,
          edgeOrder: [],
          step: -1,
          result: { ok: false, error: "Could not locate export in source." },
          direction: "forward",
        };
      }

      const filteredCallSites: typeof trace.callSites = [];
      const edgeOrder: string[] = [];
      for (const cs of trace.callSites) {
        const tid = labelToTargetId.get(cs.name);
        if (!tid) continue;
        if (built.kindById.get(tid) !== "function") continue;
        filteredCallSites.push(cs);
        edgeOrder.push(tid);
      }
      trace.callSites = filteredCallSites;

      let result: Frame["result"] = null;
      if (executeFn) {
        try {
          const data = inputJson?.trim() ? JSON.parse(inputJson) : undefined;
          const mod = await loadModuleFromSource(source, filePath);
          const fn = mod[exportName];
          if (typeof fn !== "function") {
            result = { ok: false, error: `Export "${exportName}" is not a callable function (got ${typeof fn}).` };
          } else {
            const value = await (fn as (...a: unknown[]) => unknown)(data);
            result = { ok: true, value };
          }
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }

      return {
        filePath,
        trace,
        sourceExportId: exportId,
        edgeOrder,
        step: edgeOrder.length > 0 ? 0 : -1,
        result,
        direction: "forward",
      };
    },
    [repo, inputJson, built],
  );

  // Recursively animate: forward traveler -> hover/click target -> recurse into target -> return traveler -> next step.
  // `pathIds` = export ids currently on the stack to prevent cycles.
  const animateFrame = useCallback(
    async (exportId: string, pathIds: Set<string>, executeFn: boolean): Promise<void> => {
      const token = cancelRef.current;
      if (token.cancelled) return;
      const frame = await buildFrame(exportId, executeFn);
      if (token.cancelled || !frame) return;

      // Push frame onto stack.
      setStack((s) => [...s, frame]);

      const total = frame.edgeOrder.length;
      const nextPath = new Set(pathIds);
      nextPath.add(exportId);

      for (let i = 0; i < total; i++) {
        if (token.cancelled) return;
        // Update top frame: forward direction at step i.
        setStack((s) => {
          if (s.length === 0) return s;
          const top = { ...s[s.length - 1], step: i, direction: "forward" as const };
          return [...s.slice(0, -1), top];
        });
        // Wait for the forward traveler to arrive.
        await sleep(stepMs());
        if (token.cancelled) return;

        const targetId = frame.edgeOrder[i];
        // Recurse if target is a known function with its own refs and not already on the stack.
        const targetIsKnown =
          built.refsByExport.has(targetId) && built.kindById.get(targetId) === "function";
        if (targetIsKnown && !nextPath.has(targetId)) {
          await animateFrame(targetId, nextPath, false);
          if (token.cancelled) return;
        }

        // Animate return: target -> source.
        setStack((s) => {
          if (s.length === 0) return s;
          const top = { ...s[s.length - 1], step: i, direction: "returning" as const };
          return [...s.slice(0, -1), top];
        });
        await sleep(stepMs());
        if (token.cancelled) return;
      }

      // Pop frame.
      setStack((s) => s.slice(0, -1));
    },
    [buildFrame, built],
  );

  const handleExportClick = useCallback(
    async (exportId: string, exportKind: "function" | "value") => {
      if (exportKind !== "function" || !repo) return;
      // Cancel any previous animation.
      cancelRef.current.cancelled = true;
      cancelRef.current = { cancelled: false };
      setStack([]);
      await animateFrame(exportId, new Set(), true);
    },
    [repo, animateFrame],
  );

  useEffect(() => {
    return () => {
      cancelRef.current.cancelled = true;
    };
  }, []);

  // Convenience: top frame drives the visualization & code panel.
  const run = stack.length > 0 ? stack[stack.length - 1] : null;

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
      hierarchies.reduce((acc, h) => acc + h.leaves().reduce((s, l) => s + exportRadiusFor(l.data.id), 0), 0) /
      Math.max(1, totalLeaves);
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
        if (l.source.data.kind === "folder" || l.target.data.kind === "folder") {
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
    svg.attr("viewBox", `${-size / 2} ${-size / 2} ${size} ${size}`).attr("preserveAspectRatio", "xMidYMid meet");

    const container = svg.append("g");

    const zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 8])
      .filter((event: Event) => {
        // Always allow wheel zoom; restrict drag start to inside the innermost ring.
        if (event.type === "wheel") return true;
        const svgEl = ref.current;
        if (!svgEl) return true;
        const src = event as MouseEvent | TouchEvent;
        const touch = "touches" in src ? src.touches[0] : (src as MouseEvent);
        if (!touch) return false;
        const pt = svgEl.createSVGPoint();
        pt.x = (touch as { clientX: number }).clientX;
        pt.y = (touch as { clientY: number }).clientY;
        const ctm = (container.node() as SVGGElement).getScreenCTM();
        if (!ctm) return true;
        const local = pt.matrixTransform(ctm.inverse());
        const dist = Math.hypot(local.x - cx, local.y - cy);
        return dist <= innerR;
      })
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
    const leafAncestors = new Map<string, { folders: Set<string>; files: Set<string>; links: Set<string> }>();
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
      .attr("fill", "#5c6bc0");

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

    // White glow filter applied to a node label on hover.
    const glow = defs.append("filter").attr("id", "label-glow").attr("x", "-50%").attr("y", "-50%").attr("width", "200%").attr("height", "200%");
    glow.append("feGaussianBlur").attr("in", "SourceAlpha").attr("stdDeviation", 2.5).attr("result", "blur1");
    glow.append("feFlood").attr("flood-color", "#ffffff").attr("flood-opacity", 1).attr("result", "white");
    glow.append("feComposite").attr("in", "white").attr("in2", "blur1").attr("operator", "in").attr("result", "glow1");
    const merge = glow.append("feMerge");
    merge.append("feMergeNode").attr("in", "glow1");
    merge.append("feMergeNode").attr("in", "glow1");
    merge.append("feMergeNode").attr("in", "glow1");
    merge.append("feMergeNode").attr("in", "SourceGraphic");

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
      .attr("data-src", (p) => p.s.node.data.id)
      .attr("data-tgt", (p) => p.t.node.data.id)
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
    const VALUE_COLOR = "#6d4c41";
    const colorFor = (n: RawNode) => {
      if (n.kind === "folder") return "var(--color-chart-1)";
      if (n.kind === "file") return "var(--color-muted-foreground)";
      return n.exportKind === "function" ? FUNCTION_COLOR : VALUE_COLOR;
    };

    // File outdegree: total outgoing refs from all exports in the file.
    const fileOutdegree = new Map<string, number>();
    outgoingByExport.forEach((targets, exportId) => {
      const hash = exportId.indexOf("#");
      if (!exportId.startsWith("export:") || hash < 0) return;
      const fileId = "file:" + exportId.slice("export:".length, hash);
      fileOutdegree.set(fileId, (fileOutdegree.get(fileId) ?? 0) + targets.size);
    });
    const maxFileOut = Math.max(1, ...Array.from(fileOutdegree.values()));

    const radiusFor = (n: RawNode) => {
      if (n.kind === "folder") return 4;
      if (n.kind === "file") {
        const out = fileOutdegree.get(n.id) ?? 0;
        // sqrt scale from 3 (no outgoing) up to ~10 at max outdegree.
        return 3 + 7 * Math.sqrt(out / maxFileOut);
      }
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
      .attr("font-family", '"Averia Sans Libre", ui-monospace, monospace')
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
      .attr("data-node-id", (d) => d.node.data.id)
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

      linkSel.attr("stroke-opacity", (l) => (links.has(linkKey(l.s.node.data.id, l.t.node.data.id)) ? FULL : DIM));
      folderArcSel.attr("stroke-opacity", (a) => (folders.has(a.id) ? FULL : DIM));
      refSel
        .attr("stroke", (p) => {
          const sId = p.s.node.data.id;
          const tId = p.t.node.data.id;
          // Outgoing from a target = referenced edge; incoming to a target = referencing edge.
          if (targetIds.has(sId)) return "#5c6bc0";
          if (targetIds.has(tId)) return "#6d4c41";
          return "var(--color-muted-foreground)";
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
      .on("mouseenter", (e, d) => {
        if (d.node.data.kind === "export") {
          applyHighlight(new Set([d.node.data.id]));
        } else {
          const exports = exportsByContainer.get(d.node.data.id) ?? new Set();
          applyHighlight(exports);
        }
        d3.select(e.currentTarget as SVGGElement)
          .select<SVGTextElement>("text.node-label")
          .attr("filter", "url(#label-glow)");
      })
      .on("mouseleave", (e) => {
        clearHighlight();
        d3.select(e.currentTarget as SVGGElement)
          .select<SVGTextElement>("text.node-label")
          .attr("filter", null);
      })
      .on("click", (_e, d) => {
        if (d.node.data.kind !== "export") return;
        if (d.node.data.exportKind !== "function") return;
        handleExportClick(d.node.data.id, "function");
      });

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

    node.append("title").text((d) => `${d.node.data.kind}: ${d.node.data.name}`);

    // Scale labels by ring distance: center = 0em, outer ring = 1em.
    const nodeFontSizeFor = (r: number) => `${r / outerR}em`;

    // All labels point radially outward (away from the chart center).
    node
      .append("text")
      .attr("class", "node-label")
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
        const r = radiusFor(d.node.data) + 8;
        const flip = d.angle > Math.PI / 2 && d.angle < (3 * Math.PI) / 2;
        return flip ? -r : r;
      })
      .attr("dy", "0.32em")
      .attr("font-family", '"Averia Sans Libre", ui-monospace, monospace')
      .attr("font-size", (d) => nodeFontSizeFor(d.radius))
      .attr("fill", "white")
      .attr("stroke", "black")
      .attr("stroke-width", 7)
      .attr("stroke-linejoin", "round")
      .attr("paint-order", "stroke")
      .attr("font-weight", 700)
      .text((d) => d.node.data.name);

    return () => {
      svg.on(".zoom", null);
      svg.selectAll("*").remove();
    };
  }, [built, handleExportClick]);

  // Animate the highlighted edge as the trace step advances.
  // Active edge gets a steady glowing-green node traveling along it (no edge glow).
  const travelerRafRef = useRef<number | null>(null);
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const paths = svg.querySelectorAll<SVGPathElement>("path[data-src]");

    // Stop any existing traveler animation
    if (travelerRafRef.current !== null) {
      cancelAnimationFrame(travelerRafRef.current);
      travelerRafRef.current = null;
    }
    // Remove any existing traveler node
    svg.querySelectorAll(".edge-traveler").forEach((n) => n.remove());
    // Clear any prior label glow
    svg.querySelectorAll<SVGTextElement>("g[data-node-id] text").forEach((t) => {
      t.style.filter = "";
    });

    if (!run) {
      paths.forEach((p) => {
        p.style.stroke = "";
        p.style.strokeWidth = "";
        p.style.strokeOpacity = "";
        p.style.filter = "";
      });
      return;
    }
    const activeTarget =
      run.step >= 0 && run.step < run.edgeOrder.length ? run.edgeOrder[run.step] : null;
    const visited = new Set(run.edgeOrder.slice(0, Math.max(0, run.step)));

    let activePath: SVGPathElement | null = null;
    paths.forEach((p) => {
      const src = p.getAttribute("data-src");
      const tgt = p.getAttribute("data-tgt");
      // Never modify the edge color/width during execution — only opacity
      // is used to focus the viewer on the active source's outgoing edges.
      p.style.stroke = "";
      p.style.strokeWidth = "";
      p.style.filter = "";
      if (src !== run.sourceExportId) {
        p.style.strokeOpacity = "0.05";
        return;
      }
      if (tgt === activeTarget) {
        p.style.strokeOpacity = "0.9";
        activePath = p;
      } else if (tgt && visited.has(tgt)) {
        p.style.strokeOpacity = "0.9";
      } else {
        p.style.strokeOpacity = "0.4";
      }
    });

    // Glow the active target's label so the user sees which symbol is being called.
    if (activeTarget) {
      const targetText = svg.querySelector<SVGTextElement>(
        `g[data-node-id="${CSS.escape(activeTarget)}"] text`,
      );
      if (targetText) {
        targetText.style.filter =
          "drop-shadow(0 0 4px #ffff00) drop-shadow(0 0 10px #ffff00)";
      }
    }

    // Spawn the green traveler. Direction "forward" runs source -> target along
    // the reference chord. Direction "returning" runs target -> source along
    // an outer arc bulging past the symbol ring (simulating the call returning).
    if (activePath) {
      const path = activePath as SVGPathElement;
      const ns = "http://www.w3.org/2000/svg";

      // Derive outer ring radius from viewBox: size = (outerR + 60) * 2.
      const vb = svg.viewBox.baseVal;
      const outerR = vb.width / 2 - 60;
      const cx = 0;
      const cy = 0;

      const fwdLen = path.getTotalLength();
      const startPt = path.getPointAtLength(0);
      const endPt = path.getPointAtLength(fwdLen);

      // Outer return arc geometry (used for "returning" direction).
      const ringR = outerR + 120;
      const rT = Math.hypot(endPt.x - cx, endPt.y - cy) || 1;
      const rS = Math.hypot(startPt.x - cx, startPt.y - cy) || 1;
      const uTx = (endPt.x - cx) / rT;
      const uTy = (endPt.y - cy) / rT;
      const uSx = (startPt.x - cx) / rS;
      const uSy = (startPt.y - cy) / rS;
      const c1x = cx + uTx * ringR;
      const c1y = cy + uTy * ringR;
      const c2x = cx + uSx * ringR;
      const c2y = cy + uSy * ringR;

      // Build an animation path that matches the requested direction.
      let animD: string;
      if (run.direction === "forward") {
        animD = path.getAttribute("d") ?? `M${startPt.x},${startPt.y} L${endPt.x},${endPt.y}`;
      } else {
        // Return arc: target -> outer arc -> source.
        animD = `M${endPt.x},${endPt.y} C${c1x},${c1y} ${c2x},${c2y} ${startPt.x},${startPt.y}`;
      }

      const animPath = document.createElementNS(ns, "path");
      animPath.setAttribute("class", "edge-traveler");
      animPath.setAttribute("d", animD);
      animPath.setAttribute("fill", "none");
      animPath.setAttribute("stroke", "none");
      animPath.style.pointerEvents = "none";
      path.parentNode?.appendChild(animPath);
      const animLen = animPath.getTotalLength();

      const traveler = document.createElementNS(ns, "circle");
      traveler.setAttribute("class", "edge-traveler");
      traveler.setAttribute("r", "4");
      traveler.setAttribute("fill", "#ffff00");
      traveler.setAttribute("stroke", "#ffff00");
      traveler.setAttribute("stroke-width", "0.5");
      traveler.style.filter = "drop-shadow(0 0 6px #ffff00) drop-shadow(0 0 12px #ffff00)";
      traveler.style.pointerEvents = "none";
      path.parentNode?.appendChild(traveler);

      const duration = BASE_STEP_MS / speedRef.current; // matches stepMs()
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        const pt = animPath.getPointAtLength(t * animLen);
        traveler.setAttribute("cx", String(pt.x));
        traveler.setAttribute("cy", String(pt.y));
        if (t < 1) {
          travelerRafRef.current = requestAnimationFrame(tick);
        } else {
          travelerRafRef.current = null;
        }
      };
      travelerRafRef.current = requestAnimationFrame(tick);
    }

    return () => {
      if (travelerRafRef.current !== null) {
        cancelAnimationFrame(travelerRafRef.current);
        travelerRafRef.current = null;
      }
      svg.querySelectorAll(".edge-traveler").forEach((n) => n.remove());
      svg.querySelectorAll<SVGTextElement>("g[data-node-id] text").forEach((t) => {
        t.style.filter = "";
      });
    };
  }, [run?.sourceExportId, run?.step, run?.direction, run?.edgeOrder]);

  const refCount = Array.from(built.refsByExport.values()).reduce((a, b) => a + b.length, 0);
  const exportCount = built.refsByExport.size;

  return (
    <div className="flex h-full flex-col">
      <div className="relative flex-1 overflow-hidden">
        {run && (
          <CodeTracePanel
            trace={run.trace}
            filePath={run.filePath}
            step={run.step}
            result={run.result}
            onClose={() => {
              cancelRef.current.cancelled = true;
              cancelRef.current = { cancelled: false };
              setStack([]);
            }}
          />
        )}
        {stack.length > 0 && (
          <div className="pointer-events-auto fixed bottom-24 left-4 z-30 flex max-w-md flex-col-reverse gap-1.5 rounded-md border border-border p-2 text-xs shadow-md backdrop-blur-md" style={{ background: "color-mix(in oklab, var(--surface-elevated) 80%, transparent)" }}>
            {/* Speed dial — first child = bottom row in flex-col-reverse */}
            <div className="flex items-center gap-2 font-mono text-[10px]">
              <span className="text-muted-foreground">speed</span>
              <input
                type="range"
                min={0.25}
                max={4}
                step={0.25}
                value={speed}
                onChange={(e) => setSpeed(parseFloat(e.target.value))}
                className="h-1 flex-1 cursor-pointer accent-[#6d4c41]"
              />
              <span className="w-8 shrink-0 text-right font-semibold text-foreground">
                {speed.toFixed(2)}x
              </span>
            </div>
            {stack.map((f, i) => {
              const total = Math.max(1, f.edgeOrder.length);
              const done = f.direction === "returning" ? f.step + 1 : f.step;
              const pct = Math.max(0, Math.min(100, (done / total) * 100));

              // For non-root frames, copy the exact call expression text from the parent's source.
              let callLabel = `${f.trace.exportName}()`;
              if (i > 0) {
                const parent = stack[i - 1];
                const cs = parent.trace.callSites[parent.step];
                const src = parent.trace.source;
                if (cs && src) {
                  // Extend from identifier end through the matching parenthesized argument list.
                  let j = cs.end;
                  while (j < src.length && /\s/.test(src[j])) j++;
                  if (src[j] === "(") {
                    let depth = 0;
                    let inStr: string | null = null;
                    let esc = false;
                    let end = j;
                    for (let k = j; k < src.length; k++) {
                      const c = src[k];
                      if (inStr) {
                        if (esc) esc = false;
                        else if (c === "\\") esc = true;
                        else if (c === inStr) inStr = null;
                      } else if (c === '"' || c === "'" || c === "`") {
                        inStr = c;
                      } else if (c === "(") depth++;
                      else if (c === ")") {
                        depth--;
                        if (depth === 0) {
                          end = k + 1;
                          break;
                        }
                      }
                    }
                    callLabel = src.slice(cs.start, end).replace(/\s+/g, " ").trim();
                  } else {
                    callLabel = src.slice(cs.start, cs.end);
                  }
                }
              }

              const fullCallLabel = callLabel;
              const displayCallLabel =
                callLabel.length > 50 ? callLabel.slice(0, 49) + "…" : callLabel;

              return (
                <div key={`${f.sourceExportId}-${i}`} className="flex flex-col gap-0.5">
                  <div className="flex items-center justify-between gap-2 font-mono text-[10px]">
                    <span className="truncate text-muted-foreground">{f.filePath}</span>
                    <span className="shrink-0 font-semibold text-foreground" title={fullCallLabel}>
                      {displayCallLabel}
                    </span>
                  </div>
                  <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${pct}%`, background: "#536dfe" }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <svg
          ref={ref}
          className="relative h-full w-full [&_*]:pointer-events-auto"
          style={{ pointerEvents: "none" }}
        />
      </div>
    </div>
  );
}
