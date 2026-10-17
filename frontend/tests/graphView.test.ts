import { describe, expect, it } from "vitest";
import type { SearchEdge, SearchNode } from "../src/api";
import { buildGraphView, routeTo } from "../src/graphView";

function node(word: string, parent: string | null, h: number): SearchNode {
  return {
    word, parent, h, g: 0, f: h, depth: 0, state: "open",
    discovered_sequence: 0, expanded_sequence: null,
  };
}
function edge(source: string, target: string): SearchEdge {
  return {
    source, target, cost: 1, cosine_similarity: 0.5,
    angular_distance: 0.5, selected: true,
  };
}

describe("condensed exploration graph", () => {
  const nodes = Object.fromEntries([
    node("猫", null, 0.9),
    node("動物", "猫", 0.5),
    node("星", "動物", 0.2),
    node("犬", "猫", 0.8),
    node("哺乳類", "動物", 0.6),
    node("生物", "動物", 0.7),
    ...Array.from({ length: 1000 }, (_, i) => node(`別${i}`, "犬", 0.95)),
  ].map((item) => [item.word, item]));
  const edges = [
    edge("猫", "動物"), edge("動物", "星"), edge("猫", "犬"),
    edge("動物", "哺乳類"), edge("動物", "生物"),
    ...Array.from({ length: 1000 }, (_, i) => edge("犬", `別${i}`)),
  ];

  it("shows the most promising parent route and a few real branches", () => {
    const view = buildGraphView(nodes, edges, "猫", [], false);
    expect(view.route).toEqual(["猫", "動物", "星"]);
    expect(view.completed).toBe(false);
    expect(view.visible.map((item) => item.word)).toEqual([
      "猫", "動物", "星", "犬", "哺乳類", "生物",
    ]);
    expect([...view.edges.keys()]).toContain('["動物","星"]');
    expect(view.edges.size).toBe(5);
    expect(view.positions.get("星")?.x).toBeGreaterThan(view.positions.get("猫")!.x);
  });

  it("keeps a confirmed route and can hide its branches", () => {
    const view = buildGraphView(nodes, edges, "猫", ["猫", "動物", "星"], true);
    expect(view.completed).toBe(true);
    expect(view.visible.map((item) => item.word)).toEqual(view.route);
    expect(view.edges.size).toBe(2);
  });

  it("rejects a broken or cyclic parent chain", () => {
    expect(routeTo({ a: node("a", "b", 0), b: node("b", "a", 0) }, "猫", "a")).toEqual([]);
  });
});
