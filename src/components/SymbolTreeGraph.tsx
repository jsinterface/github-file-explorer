import { useEffect, useRef, useMemo } from "react";
import * as d3 from "d3";

export type SymbolTreeNode =
  | { [key: string]: SymbolTreeNode }
  | Record<string, string[]>;

type GNode = d3.SimulationNodeDatum & {
  id: string;
  label: string;
  kind: "folder" | "file" | "export";
};

type GLink = d3.SimulationLinkDatum<GNode> & {
  kind: "contains" | "ref";
};

function isExportLeaf(v: unknown): v is Record<string, string[]> {
  if (!v || typeof v !== "object") return false;
  return Object.values(v as Record<string, unknown>).every((x) => Array.isArray(x));
}

function buildGraph(tree: Record<string, SymbolTreeNode>): {
  nodes: GNode[];
  links: GLink[];
} {
  const nodes: GNode[] = [];
  const links: GLink[] = [];
  const seen = new Map<string, GNode>();
  // Map from export label (e.g. "dir/file.ts:name") -> node id
  const labelToId = new Map<string, string>();
  // Pending references to resolve after all exports are registered
  const pending: Array<{ from: string; label: string }> = [];

  function addNode(n: GNode) {
    if (!seen.has(n.id)) {
      seen.set(n.id, n);
      nodes.push(n);
    }
    return seen.get(n.id)!;
  }

  function walk(
    obj: Record<string, SymbolTreeNode>,
    pathParts: string[],
    parentId: string | null,
  ) {
    for (const [name, child] of Object.entries(obj)) {
      const parts = [...pathParts, name];
      const path = parts.join("/");
      if (isExportLeaf(child)) {
        // file node
        const fileId = `file:${path}`;
        addNode({ id: fileId, label: name, kind: "file" });
        if (parentId) links.push({ source: parentId, target: fileId, kind: "contains" });
        // exports
        const shortFile = parts.slice(-2).join("/");
        for (const [exportName, refs] of Object.entries(child)) {
          const exportId = `export:${path}#${exportName}`;
          const exportLabel = `${shortFile}:${exportName}`;
          addNode({ id: exportId, label: exportName, kind: "export" });
          labelToId.set(exportLabel, exportId);
          links.push({ source: fileId, target: exportId, kind: "contains" });
          for (const ref of refs) {
            pending.push({ from: exportId, label: ref });
          }
        }
      } else {
        const folderId = `folder:${path}`;
        addNode({ id: folderId, label: name, kind: "folder" });
        if (parentId) links.push({ source: parentId, target: folderId, kind: "contains" });
        walk(child as Record<string, SymbolTreeNode>, parts, folderId);
      }
    }
  }

  walk(tree, [], null);

  for (const { from, label } of pending) {
    const targetId = labelToId.get(label);
    if (targetId) links.push({ source: from, target: targetId, kind: "ref" });
  }

  return { nodes, links };
}

export function SymbolTreeGraph({ data }: { data: Record<string, SymbolTreeNode> }) {
  const ref = useRef<SVGSVGElement | null>(null);
  const built = useMemo(() => buildGraph(data), [data]);

  useEffect(() => {
    if (!ref.current) return;

    const width = 960;
    const height = 640;

    const nodes: GNode[] = built.nodes.map((n) => ({ ...n }));
    const links: GLink[] = built.links.map((l) => ({ ...l }));

    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();
    svg
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("preserveAspectRatio", "xMidYMid meet");

    const container = svg.append("g");

    const zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 8])
      .on("zoom", (event) => container.attr("transform", event.transform.toString()));
    svg.call(zoomBehavior);

    const defs = svg.append("defs");
    for (const [id, color] of [
      ["arrow-contains-tg", "var(--color-border)"],
      ["arrow-ref-tg", "var(--color-chart-3)"],
    ] as const) {
      defs
        .append("marker")
        .attr("id", id)
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 12)
        .attr("refY", 0)
        .attr("markerWidth", 6)
        .attr("markerHeight", 6)
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M0,-5L10,0L0,5")
        .attr("fill", color);
    }

    const link = container
      .append("g")
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("stroke", (d) =>
        d.kind === "ref" ? "var(--color-chart-3)" : "var(--color-border)",
      )
      .attr("stroke-opacity", (d) => (d.kind === "ref" ? 0.7 : 0.4))
      .attr("stroke-width", (d) => (d.kind === "ref" ? 1 : 0.8))
      .attr("stroke-dasharray", (d) => (d.kind === "ref" ? "3,2" : null))
      .attr("marker-end", (d) =>
        d.kind === "ref" ? "url(#arrow-ref-tg)" : "url(#arrow-contains-tg)",
      );

    const node = container
      .append("g")
      .selectAll<SVGGElement, GNode>("g")
      .data(nodes)
      .join("g")
      .style("cursor", "grab");

    const colorFor = (k: GNode["kind"]) =>
      k === "folder"
        ? "var(--color-chart-1)"
        : k === "file"
          ? "var(--color-chart-2)"
          : "var(--color-chart-4)";

    const radiusFor = (k: GNode["kind"]) =>
      k === "folder" ? 5 : k === "file" ? 3.5 : 2.5;

    node
      .append("circle")
      .attr("r", (d) => radiusFor(d.kind))
      .attr("fill", (d) => colorFor(d.kind))
      .attr("stroke", "var(--color-background)")
      .attr("stroke-width", 0.8);

    node.append("title").text((d) => `${d.kind}: ${d.label}`);

    node
      .filter((d) => d.kind !== "export")
      .append("text")
      .attr("x", 6)
      .attr("dy", "0.32em")
      .attr("font-family", "ui-monospace, monospace")
      .attr("font-size", (d) => (d.kind === "folder" ? 9 : 8))
      .attr("fill", "var(--color-foreground)")
      .text((d) => d.label);

    node
      .filter((d) => d.kind === "export")
      .append("text")
      .attr("x", 5)
      .attr("dy", "0.32em")
      .attr("font-family", "ui-monospace, monospace")
      .attr("font-size", 7)
      .attr("fill", "var(--color-muted-foreground)")
      .text((d) => d.label);

    const simulation = d3
      .forceSimulation<GNode>(nodes)
      .force(
        "link",
        d3
          .forceLink<GNode, GLink>(links)
          .id((d) => d.id)
          .distance((l) => (l.kind === "ref" ? 50 : 25))
          .strength((l) => (l.kind === "ref" ? 0.2 : 0.6)),
      )
      .force("charge", d3.forceManyBody().strength(-50))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide(7))
      .on("tick", () => {
        link
          .attr("x1", (d) => (d.source as GNode).x!)
          .attr("y1", (d) => (d.source as GNode).y!)
          .attr("x2", (d) => (d.target as GNode).x!)
          .attr("y2", (d) => (d.target as GNode).y!);
        node.attr("transform", (d) => `translate(${d.x},${d.y})`);
      });

    const drag = d3
      .drag<SVGGElement, GNode>()
      .on("start", (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    node.call(drag);

    return () => {
      simulation.stop();
      svg.on(".zoom", null);
      svg.selectAll("*").remove();
    };
  }, [built]);

  const refLinks = built.links.filter((l) => l.kind === "ref").length;

  return (
    <div className="rounded-md border border-border bg-muted">
      <div className="max-h-[70vh] overflow-hidden">
        <svg ref={ref} className="w-full" style={{ height: "70vh" }} />
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
        <span>
          {built.nodes.length} nodes · {refLinks} references
        </span>
        <span className="ml-auto">drag nodes • scroll to zoom</span>
      </div>
    </div>
  );
}
