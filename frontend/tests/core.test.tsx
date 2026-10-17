import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { parseExpression } from "../src/expression";
import { advanceReplay, mergeEvents, replay } from "../src/store";
import { ApiError } from "../src/api";
import { ErrorBox } from "../src/components";

describe("safe expression parser", () => {
  it("supports parentheses, Japanese words and scalar precedence", () => {
    const ast = parseExpression("(東京 - 日本 + 中国) / 2");
    expect("op" in ast && ast.op).toBe("divide");
    expect(() => parseExpression("0.5 * 猫")).not.toThrow();
    expect(() => parseExpression('"a/b" - 犬')).not.toThrow();
  });
  it("supports bracketed vector notation", () => {
    const ast = parseExpression("[東京] - [日本] + [中国]");
    expect(ast).toEqual({
      op: "add",
      left: {
        op: "subtract",
        left: { type: "word", value: "東京" },
        right: { type: "word", value: "日本" },
      },
      right: { type: "word", value: "中国" },
    });
    expect(() => parseExpression("[二語からなる 単語] / 2")).not.toThrow();
    expect(() =>
      parseExpression("([東京] − [日本] ＋ [中国]) ÷ 2"),
    ).not.toThrow();
    expect(() => parseExpression("2 × [猫]")).not.toThrow();
  });
  it.each([
    "猫 * 犬",
    "猫 / 犬",
    "2 / 猫",
    "猫 + 2",
    "猫 - 2",
    "(猫 + 犬",
    "[猫 + 犬",
    "猫 犬",
    "3",
  ])("rejects %s before network submission", (expression) => {
    expect(() => parseExpression(expression)).toThrow();
  });
});
describe("event recovery and replay", () => {
  const events = [
    { sequence: 1, type: "iteration_started", iteration: 1, k: 2 },
    { sequence: 2, type: "node_discovered", word: "猫", state: "open", g: 0 },
    { sequence: 3, type: "node_expanded", word: "猫", state: "closed", g: 0 },
    { sequence: 4, type: "iteration_started", iteration: 2, k: 5 },
    { sequence: 5, type: "node_discovered", word: "犬", state: "open", g: 1 },
  ];
  it("recovers out-of-order and duplicate events deterministically", () => {
    expect(
      mergeEvents(events.slice(0, 3), [events[4], events[2], events[3]]),
    ).toEqual(events);
  });
  it("reconstructs historical state without changing source events", () => {
    expect(replay(events, 2).nodes["猫"].state).toBe("open");
    expect(replay(events, 3).nodes["猫"].state).toBe("closed");
    expect(Object.keys(replay(events).nodes)).toEqual(["犬"]);
    expect(events[1].state).toBe("open");
  });
  it("advances a live replay and resets it when widening starts a new graph", () => {
    const first = replay(events.slice(0, 3));
    expect(advanceReplay(first, events.slice(3))).toEqual(replay(events));
    expect(mergeEvents(events.slice(0, 3), events.slice(3))[2]).toBe(events[2]);
  });
});
it("shows OOV suggestions, model and error ID", () => {
  render(
    <ErrorBox
      error={
        new ApiError({
          error: {
            code: "GOAL_OOV",
            message: "この単語はモデルに含まれません。",
            details: { word: "未登録", model: "tiny-ja", suggestions: ["猫"] },
            request_id: "req_test",
          },
        })
      }
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("モデルに含まれません");
  expect(screen.getByRole("alert")).toHaveTextContent("猫");
  expect(screen.getByRole("alert")).toHaveTextContent("req_test");
});
