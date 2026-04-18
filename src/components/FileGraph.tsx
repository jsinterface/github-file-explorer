import { useEffect, useRef } from "react";
import * as d3 from "d3";

type TreeItem = {
  path: string;
  type: "blob" | "tree" | string;
};

type GraphNode = d3.SimulationNodeDatum & {
  id: string;
  name: string;
  kind: "root" | "folder" | "file";
  depth: number;
};

type GraphLink = d3.SimulationLinkDatum<GraphNode>;

export function FileGraph({
  items,
  rootLabel,
}: {
  items: TreeItem[];
  rootLabel: string;
}) {
  const ref = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!ref.current) return;

    const nodeMap = new Map<string, GraphNode>();
    const links: GraphLink[] = [];

    nodeMap.set("", { id: "", name: rootLabel, kind: "root", depth: 0 });

    for (const item of items) {
      const parts = item.path.split("/");
      parts.forEach((name, idx) => {
        const id = parts.slice(0, idx + 1).join("/");
        const parentId = parts.slice(0, idx).join("/");
        const isLast = idx === parts.length - 1;
        const kind: GraphNode["kind"] =
          isLast && item.type === "blob" ? "file" : "folder";
        if (!nodeMap.has(id)) {
          nodeMap.set(id, { id, name, kind, depth: idx + 1 });
          links.push({ source: parentId, target: id });
        }
      });
    }

    const nodes = Array.from(nodeMap.values());

    const width = ref.current.clientWidth || 800;
    const height = 600;

    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();
    svg.attr("viewBox", `0 0 ${width} ${height}`);

    const container = svg.append("g");

    svg.call(
      d3
        .zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.1, 8])
        .on("zoom", (event) => {
          container.attr("transform", event.transform.toString());
        }),
    );

    const colorFor = (n: GraphNode) => {
      if (n.kind === "root") return "var(--color-primary)";
      if (n.kind === "folder") return "var(--color-chart-1)";
      return "var(--color-chart-2)";
    };
    const radiusFor = (n: GraphNode) =>
      n.kind === "root" ? 10 : n.kind === "folder" ? 6 : 3;

    const simulation = d3
      .forceSimulation<GraphNode>(nodes)
      .force(
        "link",
        d3
          .forceLink<GraphNode, GraphLink>(links)
          .id((d) => d.id)
          .distance((l) => 30 + ((l.target as GraphNode).depth ?? 1) * 4)
          .strength(0.7),
      )
      .force("charge", d3.forceManyBody().strength(-60))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force(
        "collide",
        d3.forceCollide<GraphNode>().radius((d) => radiusFor(d) + 2),
      );

    const link = container
      .append("g")
      .attr("stroke", "var(--color-border)")
      .attr("stroke-opacity", 0.6)
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("stroke-width", 1);

    const node = container
      .append("g")
      .selectAll<SVGCircleElement, GraphNode>("circle")
      .data(nodes)
      .join("circle")
      .attr("r", radiusFor)
      .attr("fill", colorFor)
      .attr("stroke", "var(--color-background)")
      .attr("stroke-width", 1)
      .style("cursor", "grab");

    node.append("title").text((d) => d.id || rootLabel);

    const drag = d3
      .drag<SVGCircleElement, GraphNode>()
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

    simulation.on("tick", () => {
      link
        .attr("x1", (d) => (d.source as GraphNode).x ?? 0)
        .attr("y1", (d) => (d.source as GraphNode).y ?? 0)
        .attr("x2", (d) => (d.target as GraphNode).x ?? 0)
        .attr("y2", (d) => (d.target as GraphNode).y ?? 0);
      node.attr("cx", (d) => d.x ?? 0).attr("cy", (d) => d.y ?? 0);
    });

    return () => {
      simulation.stop();
    };
  }, [items, rootLabel]);

  return (
    <div className="rounded-md border border-border bg-muted">
      <svg ref={ref} className="h-[600px] w-full" />
      <div className="flex flex-wrap items-center gap-4 border-t border-border px-3 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-primary" /> root
        </span>
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
        <span className="ml-auto">drag nodes • scroll to zoom</span>
      </div>
    </div>
  );
}
