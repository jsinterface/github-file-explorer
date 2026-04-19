import { useEffect, useRef } from "react";
import * as d3 from "d3";
import type { ImportGraph as ImportGraphData } from "@/lib/importGraph";

type SimNode = d3.SimulationNodeDatum & {
  id: string;
  label: string;
  kind: "internal" | "external";
};

type SimLink = d3.SimulationLinkDatum<SimNode>;

export function ImportGraphView({ data }: { data: ImportGraphData }) {
  const ref = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!ref.current) return;

    const width = 960;
    const height = 640;

    const nodes: SimNode[] = data.nodes.map((n) => ({ ...n }));
    const links: SimLink[] = data.links.map((l) => ({ ...l }));

    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();
    svg.attr("viewBox", `0 0 ${width} ${height}`).attr("preserveAspectRatio", "xMidYMid meet");

    const container = svg.append("g");

    const zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 6])
      .on("zoom", (event) => container.attr("transform", event.transform.toString()));
    svg.call(zoomBehavior);

    // Arrow marker
    svg
      .append("defs")
      .append("marker")
      .attr("id", "arrow")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 20)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", "var(--color-border)");

    const link = container
      .append("g")
      .attr("stroke", "var(--color-border)")
      .attr("stroke-opacity", 0.6)
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("stroke-width", 1)
      .attr("marker-end", "url(#arrow)");

    const node = container
      .append("g")
      .selectAll<SVGGElement, SimNode>("g")
      .data(nodes)
      .join("g")
      .style("cursor", "grab");

    node
      .append("circle")
      .attr("r", (d) => (d.kind === "external" ? 5 : 3.5))
      .attr("fill", (d) => (d.kind === "external" ? "var(--color-chart-3)" : "var(--color-chart-2)"))
      .attr("stroke", "var(--color-background)")
      .attr("stroke-width", 1);

    node.append("title").text((d) => (d.kind === "external" ? `npm: ${d.label}` : d.label));

    node
      .filter((d) => d.kind === "external")
      .append("text")
      .attr("x", 8)
      .attr("dy", "0.32em")
      .attr("font-family", "ui-monospace, monospace")
      .attr("font-size", 10)
      .attr("fill", "var(--color-foreground)")
      .text((d) => d.label);

    const simulation = d3
      .forceSimulation<SimNode>(nodes)
      .force(
        "link",
        d3
          .forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance(40)
          .strength(0.3),
      )
      .force("charge", d3.forceManyBody().strength(-60))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide(8))
      .on("tick", () => {
        link
          .attr("x1", (d) => (d.source as SimNode).x!)
          .attr("y1", (d) => (d.source as SimNode).y!)
          .attr("x2", (d) => (d.target as SimNode).x!)
          .attr("y2", (d) => (d.target as SimNode).y!);
        node.attr("transform", (d) => `translate(${d.x},${d.y})`);
      });

    const drag = d3
      .drag<SVGGElement, SimNode>()
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
  }, [data]);

  return (
    <div className="rounded-md border border-border bg-muted">
      <div className="max-h-[70vh] overflow-hidden">
        <svg ref={ref} className="w-full" style={{ height: "70vh" }} />
      </div>
      <div className="flex flex-wrap items-center gap-4 border-t border-border px-3 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "var(--color-chart-2)" }} />
          internal module
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "var(--color-chart-3)" }} />
          npm package
        </span>
        <span>
          {data.nodes.length} nodes · {data.links.length} edges · {data.externalCount} external
        </span>
        <span className="ml-auto">drag nodes • scroll to zoom</span>
      </div>
    </div>
  );
}
