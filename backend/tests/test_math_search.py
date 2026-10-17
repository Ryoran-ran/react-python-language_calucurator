import heapq

import numpy as np
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from backend.app.core import LabError
from backend.app.registry import ModelRegistry
from backend.app.schemas import SearchRequest
from backend.app.search import SearchJob
from backend.app.vectors import Context, angular, cosine, evaluate, statistics


@pytest.fixture(scope="module")
def ctx(tmp_path_factory):
    return Context(ModelRegistry(tmp_path_factory.mktemp("models")).get())


def dijkstra(ctx, start, goal, k, penalty):
    # Independent exhaustive reference graph with no A* heuristic or event code.
    graph = {
        w: [
            (n["word"], penalty + (1 - penalty) * angular(ctx.word(w), ctx.word(n["word"])))
            for n in ctx.neighbors(w, k, {})
        ]
        for w in ctx.kv.index_to_key
        if w != "ゼロ"
    }
    queue = [(0.0, start)]
    distances = {start: 0.0}
    while queue:
        cost, word = heapq.heappop(queue)
        if cost > distances[word] + 1e-12:
            continue
        if word == goal:
            return cost
        for neighbor, weight in graph[word]:
            candidate = cost + weight
            if candidate < distances.get(neighbor, float("inf")):
                distances[neighbor] = candidate
                heapq.heappush(queue, (candidate, neighbor))
    return None


@pytest.mark.parametrize("k", [2, 3, 10])
def test_astar_all_fixture_pairs_against_dijkstra(ctx, k):
    words = [w for w in ctx.kv.index_to_key if w != "ゼロ"]
    # Every reachable and unreachable pair in the checked-in synthetic fixture.
    for start in words:
        for goal in words:
            request = SearchRequest(start=start, goal=goal, neighbor={"k": k, "progressive_widening": []})
            job = SearchJob(ctx, request)
            job.run()
            expected = dijkstra(ctx, start, goal, k, 0.15)
            assert job.result is not None
            if expected is None:
                assert job.result["code"] == "NO_ROUTE_IN_GRAPH"
                assert not job.result["optimal_within_fixed_graph"]
            else:
                assert job.status == "succeeded"
                assert job.result["total_cost"] == pytest.approx(expected, abs=1e-8)
                assert job.result["path"][0] == start and job.result["path"][-1] == goal
                assert job.result["optimal_within_fixed_graph"]


@given(
    st.lists(st.floats(-10, 10, allow_nan=False, allow_infinity=False), min_size=9, max_size=9),
    st.floats(0, 1, allow_nan=False),
)
@settings(max_examples=100)
def test_angular_heuristic_is_consistent(values, penalty):
    vectors = np.asarray(values).reshape(3, 3)
    if min(np.linalg.norm(v) for v in vectors) < 1e-7:
        return
    a, b, goal = vectors
    assert (1 - penalty) * angular(a, goal) <= penalty + (1 - penalty) * angular(a, b) + (
        1 - penalty
    ) * angular(b, goal) + 1e-8


def test_statistics_and_zero(ctx):
    assert cosine(np.array([1.0, 0]), np.array([0.0, 1])) == 0
    assert angular(np.array([1.0, 0]), np.array([0.0, 1])) == 0.5
    assert statistics(np.array([-1.0, 0.0, 1.0]))["l1"] == 2
    with pytest.raises(LabError, match="") as e:
        ctx.top(ctx.word("ゼロ"), 5)
    assert e.value.code == "INVALID_VECTOR"


def test_stable_ties_and_directed_graph(ctx):
    ranking = ctx.top(ctx.word("同点A"), 4)
    assert [r["word"] for r in ranking[:2]] == ["同点A", "同点B"]
    graph = {w: {n["word"] for n in ctx.neighbors(w, 2, {})} for w in ctx.kv.index_to_key if w != "ゼロ"}
    assert any(a not in graph[b] for a in graph for b in graph[a])


def test_farthest_ranking_uses_lowest_cosine_and_stable_ties(ctx):
    nearest = ctx.top(ctx.word("猫"), 100, {"猫"})
    farthest = ctx.top(ctx.word("猫"), 100, {"猫"}, farthest=True)
    expected = sorted(nearest, key=lambda row: (row["cosine_similarity"], row["index"]))
    assert [row["word"] for row in farthest] == [row["word"] for row in expected]
    assert "ゼロ" not in {row["word"] for row in farthest}
    threshold = farthest[2]["cosine_similarity"]
    bounded = ctx.top(ctx.word("猫"), 100, {"猫"}, farthest=True, max_similarity=threshold)
    assert bounded and all(row["cosine_similarity"] <= threshold for row in bounded)


@pytest.mark.parametrize("penalty", [0.0, 1.0])
def test_extreme_penalties_and_deterministic_paths(ctx, penalty):
    request = SearchRequest(
        start="猫", goal="宇宙", neighbor={"k": 5, "progressive_widening": []}, cost={"lambda": penalty}
    )
    first, second = SearchJob(ctx, request), SearchJob(ctx, request)
    first.run()
    second.run()
    assert first.result["path"] == second.result["path"]
    assert first.result["total_cost"] == pytest.approx(dijkstra(ctx, "猫", "宇宙", 5, penalty), abs=1e-8)


def test_widening_has_fresh_iterations(ctx):
    job = SearchJob(ctx, SearchRequest(start="猫", goal="北京", neighbor={"progressive_widening": [2, 35]}))
    job.run()
    assert [t["status"] for t in job.result["trials"]] == ["NO_ROUTE_IN_GRAPH", "succeeded"]
    assert [e["k"] for e in job.events if e["type"] == "iteration_started"] == [2, 35]


def test_reach_first_uses_one_wide_graph_without_claiming_optimality(ctx):
    request = SearchRequest(
        start="猫",
        goal="宇宙",
        strategy="reach_first",
        neighbor={"k": 35, "progressive_widening": [2, 5, 35]},
    )
    job = SearchJob(ctx, request)
    job.run()
    assert job.status == "succeeded"
    assert job.result["path"][0] == "猫"
    assert job.result["path"][-1] == "宇宙"
    assert job.result["strategy"] == "reach_first"
    assert job.result["heuristic_weight"] == 15.0
    assert not job.result["optimal_within_fixed_graph"]
    assert [e["k"] for e in job.events if e["type"] == "iteration_started"] == [35]


def test_arithmetic_typed_ast(ctx):
    def word(w):
        return {"type": "word", "value": w}

    expression = {
        "op": "add",
        "left": {"op": "subtract", "left": word("東京"), "right": word("日本")},
        "right": word("中国"),
    }
    vector, words = evaluate(ctx, expression)
    assert np.allclose(vector, ctx.word("北京"))
    assert words == {"東京", "日本", "中国"}
    assert ctx.top(vector, 1, words)[0]["word"] == "北京"
    for op in ("multiply", "divide"):
        with pytest.raises(LabError) as e:
            evaluate(ctx, {"op": op, "left": word("猫"), "right": word("犬")})
        assert e.value.code == "UNSUPPORTED_OPERATION"
