import { useEffect, useMemo, useRef, useState } from "react";
import cytoscape from "cytoscape";
import { Focus, Minus, Plus } from "lucide-react";
import type { SearchEdge, SearchNode } from "./api";
import { buildGraphView } from "./graphView";

const palette = {
  start: "#5b85b6",
  goal: "#c79d3c",
  current: "#d8894f",
  path: "#3d8168",
  open: "#9bcfcf",
  closed: "#b1bab6",
};
export function Graph({
  nodes,
  edges,
  path,
  current,
  start,
  goal,
  focus,
  labels,
  size,
  select,
  maxNodes = 5000,
  maxEdges = 6000,
  condensed = false,
}: {
  nodes: Record<string, SearchNode>;
  edges: SearchEdge[];
  path: string[];
  current: string;
  start: string;
  goal: string;
  focus: boolean;
  labels: boolean;
  size: string;
  select: (word: string) => void;
  maxNodes?: number;
  maxEdges?: number;
  condensed?: boolean;
}) {
  const element = useRef<HTMLDivElement>(null),
    cy = useRef<cytoscape.Core | null>(null);
  const previousCount = useRef(0),
    interacted = useRef(false),
    previousView = useRef("");
  const renderedNodes = useRef(new Map<string, string>()),
    renderedEdges = useRef(new Map<string, string>());
  const [drawing, setDrawing] = useState(false);
  const callback = useRef(select);
  const view = useMemo(
    () => (condensed ? buildGraphView(nodes, edges, start, path, focus) : null),
    [condensed, nodes, edges, start, path, focus],
  );
  useEffect(() => {
    callback.current = select;
  }, [select]);
  useEffect(() => {
    if (!element.current) return;
    cy.current = cytoscape({
      container: element.current,
      minZoom: 0.15,
      maxZoom: 4,
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "background-color": "data(color)",
            color: "#263c36",
            width: "data(size)",
            height: "data(size)",
            shape: (node) => node.data("shape") as cytoscape.Css.NodeShape,
            "text-wrap": "wrap",
            "font-size": 13,
            "min-zoomed-font-size": 6,
            "font-family": "sans-serif",
            "text-valign": "bottom",
            "text-margin-y": 8,
            "border-width": 5,
            "border-color": "#ffffff",
            "text-outline-color": "#f8faf7",
            "text-outline-width": 3,
          },
        },
        {
          selector: "edge",
          style: {
            width: 1.3,
            "line-color": "#d6dfd9",
            "target-arrow-color": "#d6dfd9",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            "arrow-scale": 0.7,
            "font-size": 9,
            color: "#74877b",
            label: "data(label)",
            "text-background-color": "#fafcf9",
            "text-background-opacity": 1,
          },
        },
        {
          selector: ".path",
          style: {
            "line-color": "#4b8e72",
            "target-arrow-color": "#4b8e72",
            width: 2.5,
          },
        },
        { selector: ".dim", style: { opacity: 0.15 } },
        {
          selector: "node:selected",
          style: { "border-color": "#c1dacf", "border-width": 8 },
        },
      ],
      elements: [],
      layout: { name: "preset" },
    });
    cy.current.on("tap", "node", (e) =>
      callback.current(e.target.data("word")),
    );
    cy.current.on("pan zoom", (e) => {
      if (e.originalEvent) interacted.current = true;
    });
    return () => {
      cy.current?.destroy();
    };
  }, []);
  useEffect(() => {
    const graph = cy.current;
    if (!graph) return;
    const all = Object.values(nodes);
    const route = view?.route || path;
    const priority = new Set([start, goal, current, ...path]);
    const important = [...priority].map((word) => nodes[word]).filter(Boolean);
    const remaining = all.filter((node) => !priority.has(node.word));
    const visible = view?.visible || important.concat(
      remaining.slice(-Math.max(0, maxNodes - important.length)),
    );
    const ids = new Set(visible.map((n) => n.word));
    const pathWords = new Set(route);
    const pathEdges = new Set(
      route.slice(1).map((w, i) => JSON.stringify([route[i], w])),
    );
    const dedup = view?.edges || new Map<string, SearchEdge>();
    if (!view) {
      for (const edge of edges.slice(-maxEdges)) {
        if (ids.has(edge.source) && ids.has(edge.target))
          dedup.set(JSON.stringify([edge.source, edge.target]), edge);
      }
      if (pathEdges.size)
        for (const edge of edges) {
          const id = JSON.stringify([edge.source, edge.target]);
          if (pathEdges.has(id) && ids.has(edge.source) && ids.has(edge.target))
            dedup.set(id, edge);
        }
    }
    let cancelled = false;
    const draw = async () => {
      const newNodes: cytoscape.ElementDefinition[] = [],
        newEdges: cytoscape.ElementDefinition[] = [];
      const changedNodes: {
          id: string;
          data: cytoscape.NodeDataDefinition;
          classes: string;
          signature: string;
        }[] = [],
        changedEdges: {
          id: string;
          data: cytoscape.EdgeDataDefinition;
          classes: string;
          signature: string;
        }[] = [];
      const columns = Math.ceil(Math.sqrt(visible.length * 2.5));
      for (const [index, n] of visible.entries()) {
        const color =
          n.word === start
            ? palette.start
            : n.word === goal
              ? palette.goal
              : pathWords.has(n.word)
                ? palette.path
                : n.word === current
                  ? palette.current
                  : n.state === "open"
                    ? palette.open
                    : palette.closed;
        const id = "node:" + n.word;
        const data = {
          id,
          word: n.word,
          label: n.word,
          color,
          shape:
            n.word === start
              ? "roundrectangle"
              : n.word === goal
                ? "star"
                : "ellipse",
          size: size === "fixed" ? 30 : 25 + 20 * (1 - n.h),
        };
        const classes =
          !view && focus && path.length && !pathWords.has(n.word) ? "dim" : "";
        const signature = JSON.stringify([data, classes]);
        if (
          !renderedNodes.current.has(id) ||
          !graph.getElementById(id).length
        ) {
          renderedNodes.current.delete(id);
          newNodes.push({
            data,
            position: view?.positions.get(n.word) || {
              x: (index % columns) * 120 + 60,
              y: Math.floor(index / columns) * 95 + 60,
            },
            classes,
          });
        } else if (renderedNodes.current.get(id) !== signature)
          changedNodes.push({ id, data, classes, signature });
      }
      for (const [pair, edge] of dedup) {
        const id = "edge:" + pair;
        const data = {
          id,
          source: "node:" + edge.source,
          target: "node:" + edge.target,
          label: labels
            ? `${edge.cost.toFixed(2)} · cos ${edge.cosine_similarity.toFixed(2)}`
            : "",
        };
        const classes = pathEdges.has(pair)
          ? "path"
          : !view && focus && path.length
            ? "dim"
            : "";
        const signature = JSON.stringify([data, classes]);
        if (
          !renderedEdges.current.has(id) ||
          !graph.getElementById(id).length
        ) {
          renderedEdges.current.delete(id);
          newEdges.push({ data, classes });
        } else if (renderedEdges.current.get(id) !== signature)
          changedEdges.push({ id, data, classes, signature });
      }
      if (newNodes.length + newEdges.length > 400) setDrawing(true);
      graph.batch(() => {
        for (const id of renderedEdges.current.keys())
          if (!dedup.has(id.slice(5))) {
            graph.getElementById(id).remove();
            renderedEdges.current.delete(id);
          }
        for (const id of renderedNodes.current.keys())
          if (!ids.has(id.slice(5))) {
            graph.getElementById(id).remove();
            renderedNodes.current.delete(id);
          }
        for (const item of changedNodes) {
          graph.getElementById(item.id).data(item.data).classes(item.classes);
          renderedNodes.current.set(item.id, item.signature);
        }
        for (const item of changedEdges) {
          graph.getElementById(item.id).data(item.data).classes(item.classes);
          renderedEdges.current.set(item.id, item.signature);
        }
      });
      const add = async (
        items: cytoscape.ElementDefinition[],
        signatures: Map<string, string>,
        edgeBatch = false,
      ) => {
        for (let index = 0; index < items.length; index += 200) {
          if (cancelled || graph.destroyed()) return;
          const batch = items
            .slice(index, index + 200)
            .filter((item) =>
              edgeBatch
                ? graph.getElementById(String(item.data.source)).length &&
                  graph.getElementById(String(item.data.target)).length
                : true,
            );
          graph.batch(() => graph.add(batch));
          for (const item of batch)
            signatures.set(
              String(item.data.id),
              JSON.stringify([item.data, item.classes || ""]),
            );
          if (items.length > 400)
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            );
        }
      };
      await add(newNodes, renderedNodes.current);
      await add(newEdges, renderedEdges.current, true);
      if (cancelled || graph.destroyed()) return;
      const viewKey = view ? JSON.stringify([route, [...ids]]) : "";
      if (view && viewKey !== previousView.current) {
        graph.batch(() => {
          for (const [word, position] of view.positions) {
            const node = graph.getElementById("node:" + word);
            if (node.length) node.position(position);
          }
        });
      }
      if (
        !view &&
        visible.length &&
        visible.length <= 60 &&
        previousCount.current === 0
      ) {
        graph
          .layout({
            name: "cose",
            animate: false,
            fit: false,
            randomize: false,
            nodeDimensionsIncludeLabels: true,
            nodeRepulsion: () => 10000,
            idealEdgeLength: () => 100,
            gravity: 0.3,
            numIter: 400,
          })
          .run();
      }
      if (
        visible.length &&
        !interacted.current &&
        (previousCount.current === 0 || (view && viewKey !== previousView.current))
      )
        graph.fit(undefined, 45);
      previousView.current = viewKey;
      previousCount.current = visible.length;
      setDrawing(false);
    };
    void draw();
    return () => {
      cancelled = true;
    };
  }, [
    nodes,
    edges,
    path,
    current,
    start,
    goal,
    focus,
    labels,
    size,
    maxNodes,
    maxEdges,
    view,
  ]);
  // The graph is complemented by the keyboard-selectable table below.
  return (
    <div className="graph-wrap" data-render-complete={!drawing}>
      {drawing && (
        <div className="graph-drawing" role="status">
          グラフを描画中…
        </div>
      )}
      <div
        ref={element}
        className="graph-canvas"
        role="img"
        aria-label={`探索グラフ、全${Object.keys(nodes).length}語のうち${view?.visible.length ?? Math.min(Object.keys(nodes).length, maxNodes)}語を表示。下のノード一覧から全語を確認できます。`}
      />
      <div className="graph-controls">
        <button
          title="拡大"
          aria-label="グラフを拡大"
          onClick={() => cy.current?.zoom(cy.current.zoom() * 1.25)}
        >
          <Plus size={17} />
        </button>
        <button
          title="縮小"
          aria-label="グラフを縮小"
          onClick={() => cy.current?.zoom(cy.current.zoom() / 1.25)}
        >
          <Minus size={17} />
        </button>
        <button
          title="全体を表示"
          aria-label="グラフ全体を表示"
          onClick={() => cy.current?.fit(undefined, 55)}
        >
          <Focus size={17} />
        </button>
      </div>
      <div className="graph-note">
        ドラッグで移動 · スクロールでズーム{" "}
        {view ? (
          `· ${view.completed ? "到達した経路" : "目標に近い候補までの暫定経路（未到達）"}${focus ? "" : "と分岐"} ${view.visible.length}語を表示 · 全${Object.keys(nodes).length}語はノード一覧へ`
        ) : (
        <>
        {Object.keys(nodes).length > maxNodes &&
          `· 直近の${maxNodes}語を表示（全${Object.keys(nodes).length}語は表で確認できます）`}
        {edges.length > maxEdges &&
          ` · 直近の辺を表示（全${edges.length}件の履歴は保存）`}
        </>
        )}
      </div>
    </div>
  );
}
