import { useEffect, useRef } from "react";
import * as d3 from "d3";

type TreeItem = {
  path: string;
  type: "blob" | "tree" | string;
};

type RawNode = {
  name: string;
  path: string;
  kind: "root" | "folder" | "file";
  children?: RawNode[];
};

function buildHierarchy(items: TreeItem[], rootLabel: string): RawNode {
  const root: RawNode = { name: rootLabel, path: "", kind: "root", children: [] };
  const lookup = new Map<string, RawNode>();
  lookup.set("", root);

  for (const item of items) {
    const parts = item.path.split("/");
    parts.forEach((name, idx) => {
      const path = parts.slice(0, idx + 1).join("/");
      if (lookup.has(path)) return;
      const parentPath = parts.slice(0, idx).join("/");
      const parent = lookup.get(parentPath)!;
      const isLast = idx === parts.length - 1;
      const kind: RawNode["kind"] =
        isLast && item.type === "blob" ? "file" : "folder";
      const node: RawNode = { name, path, kind, children: kind === "folder" ? [] : undefined };
      parent.children!.push(node);
      lookup.set(path, node);
    });
  }
  return root;
}

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

    const data = buildHierarchy(items, rootLabel);
    const root = d3.hierarchy<RawNode>(data, (d) => d.children);

    const nodeCount = root.descendants().length;
    const rowHeight = 18;
    const colWidth = 180;
    const marginTop = 20;
    const marginLeft = 20;
    const marginRight = 240;
    const marginBottom = 20;

    const height = Math.max(400, nodeCount * rowHeight + marginTop + marginBottom);
    const depth = (root.height ?? 1) + 1;
    const innerWidth = depth * colWidth;
    const width = innerWidth + marginLeft + marginRight;

    const layout = d3.tree<RawNode>().nodeSize([rowHeight, colWidth]);
    layout(root);

    // Normalize y-extent so it starts at 0
    let minY = Infinity;
    let maxY = -Infinity;
    root.each((n) => {
      if (n.x! < minY) minY = n.x!;
      if (n.x! > maxY) maxY = n.x!;
    });
    const yOffset = -minY + marginTop;
    const finalHeight = maxY - minY + marginTop + marginBottom;

    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();
    svg
      .attr("viewBox", `0 0 ${width} ${finalHeight}`)
      .attr("preserveAspectRatio", "xMinYMin meet");

    const container = svg.append("g").attr("transform", `translate(${marginLeft}, 0)`);

    const zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on("zoom", (event) => {
        container.attr(
          "transform",
          `translate(${marginLeft + event.transform.x}, ${event.transform.y}) scale(${event.transform.k})`,
        );
      });

    svg.call(zoomBehavior);

    const colorFor = (n: RawNode) => {
      if (n.kind === "root") return "var(--color-primary)";
      if (n.kind === "folder") return "var(--color-chart-1)";
      return "var(--color-chart-2)";
    };
    const radiusFor = (n: RawNode) =>
      n.kind === "root" ? 6 : n.kind === "folder" ? 4 : 3;

    // Links: horizontal step paths from parent to child
    const linkGen = d3
      .linkHorizontal<d3.HierarchyLink<RawNode>, d3.HierarchyPointNode<RawNode>>()
      .x((d) => d.y!)
      .y((d) => d.x! + yOffset);

    container
      .append("g")
      .attr("fill", "none")
      .attr("stroke", "var(--color-border)")
      .attr("stroke-width", 1)
      .selectAll("path")
      .data(root.links())
      .join("path")
      .attr("d", linkGen as never);

    const node = container
      .append("g")
      .selectAll("g")
      .data(root.descendants())
      .join("g")
      .attr("transform", (d) => `translate(${d.y}, ${d.x! + yOffset})`);

    node
      .append("circle")
      .attr("r", (d) => radiusFor(d.data))
      .attr("fill", (d) => colorFor(d.data))
      .attr("stroke", "var(--color-background)")
      .attr("stroke-width", 1);

    node
      .append("text")
      .attr("dy", "0.32em")
      .attr("x", (d) => (d.children ? -8 : 8))
      .attr("text-anchor", (d) => (d.children ? "end" : "start"))
      .attr("font-family", "ui-monospace, monospace")
      .attr("font-size", 11)
      .attr("fill", "var(--color-foreground)")
      .text((d) => d.data.name)
      .append("title")
      .text((d) => d.data.path || rootLabel);

    return () => {
      svg.on(".zoom", null);
      svg.selectAll("*").remove();
    };
  }, [items, rootLabel]);

  return (
    <div className="rounded-md border border-border bg-muted">
      <div className="max-h-[70vh] overflow-auto">
        <svg ref={ref} className="w-full" />
      </div>
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
        <span className="ml-auto">scroll to pan • pinch/scroll to zoom</span>
      </div>
    </div>
  );
}
