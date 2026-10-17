from __future__ import annotations

import heapq
import threading
import time
from uuid import uuid4

from .core import LabError, setting, utcnow
from .events import EventLog
from .schemas import SearchRequest
from .vectors import Context, angular, valid

TERMINAL = {"succeeded", "failed", "cancelled", "expired"}
REACH_FIRST_HEURISTIC_WEIGHT = 15.0


class SearchJob:
    def __init__(self, ctx: Context, request: SearchRequest):
        self.id, self.ctx, self.request = str(uuid4()), ctx, request
        self.condition = threading.Condition(threading.RLock())
        self.status = "paused" if request.start_paused else "queued"
        self.cancelled = False
        self.steps = 0
        self.events = EventLog()
        self.snapshot: dict | None = None
        self.result: dict | None = None
        self.created_at = utcnow()
        self.created = time.time()
        self.started = time.monotonic()
        self.expansions = 0
        self.nodes: dict[str, dict] = {}
        self.edges: list[dict] = []
        self.best = request.start.strip()
        self.trials: list[dict] = []
        self.pinned = False

    def emit(self, event: str, **data) -> None:
        with self.condition:
            compacted = self.events.append(
                dict(sequence=len(self.events) + 1, type=event, timestamp=utcnow(), **data)
            )
            if compacted:
                self.snapshot = dict(
                    sequence=len(self.events),
                    nodes={w: n.copy() for w, n in self.nodes.items()},
                    edges=[e.copy() for e in self.edges],
                    best_word=self.best,
                )
                self.events.append(
                    dict(
                        sequence=len(self.events) + 1,
                        type="events_compacted",
                        timestamp=utcnow(),
                        archived_through=self.events.archived_through,
                        missing_ranges=[],
                    )
                )
            self.condition.notify_all()

    def control(self, action: str) -> None:
        with self.condition:
            if self.status in TERMINAL:
                return
            if action == "cancel":
                self.cancelled = True
            elif action == "pause":
                self.status = "paused"
            elif action == "resume":
                self.status = "running"
            elif action == "step":
                self.status = "paused"
                self.steps += 1
            self.condition.notify_all()

    def checkpoint(self) -> None:
        with self.condition:
            while self.status == "paused" and not self.steps and not self.cancelled:
                remaining = self.request.limits.timeout_seconds - (time.monotonic() - self.started)
                if remaining <= 0:
                    break
                self.condition.wait(min(0.1, remaining))
            if self.cancelled:
                raise LabError("CANCELLED", "探索をキャンセルしました。")
            if time.monotonic() - self.started >= self.request.limits.timeout_seconds:
                raise LabError("TIMEOUT", "探索時間の上限に到達しました。")
            if self.expansions >= self.request.limits.max_expansions:
                raise LabError("MAX_EXPANSIONS", "展開数の上限に到達しました。")
            if self.events.bytes >= setting("MAX_EVENT_ARCHIVE_MB", 64) * 1024**2:
                raise LabError(
                    "RESOURCE_LIMIT",
                    "イベント履歴の総容量上限に到達しました。",
                    limit_mb=setting("MAX_EVENT_ARCHIVE_MB", 64),
                )
            if len(self.nodes) > 20000 or len(self.edges) > 100000:
                raise LabError(
                    "RESOURCE_LIMIT", "探索状態の保持上限に到達しました。", max_nodes=20000, max_edges=100000
                )
            if self.steps:
                self.steps -= 1

    def path(self, current: str) -> list[str]:
        out = [current]
        while self.nodes[current]["parent"] is not None:
            current = self.nodes[current]["parent"]
            out.append(current)
        return out[::-1]

    def run(self) -> None:
        req, ctx = self.request, self.ctx
        start, goal = req.start.strip(), req.goal.strip()
        weight = REACH_FIRST_HEURISTIC_WEIGHT if req.strategy == "reach_first" else 1.0
        goal_vector = ctx.word(goal)
        goal_angles: dict[str, float] = {}

        def goal_angle(word: str) -> float:
            if word not in goal_angles:
                goal_angles[word] = angular(ctx.word(word), goal_vector)
            return goal_angles[word]

        penalty = req.cost.penalty
        filters = req.filters.model_dump()
        stages = [req.neighbor.k] if req.strategy == "reach_first" else (req.neighbor.progressive_widening or [req.neighbor.k])
        if self.status != "paused":
            self.status = "running"
        if not self.pinned:
            ctx.model.users += 1
        try:
            self.emit("search_started", settings=req.model_dump(by_alias=True), **ctx.meta())
            for trial, k in enumerate(stages):
                self.nodes, self.edges = {}, []
                h0 = (1 - penalty) * goal_angle(start)
                self.best = start
                self.emit("iteration_started", iteration=trial + 1, k=k)
                self.nodes[start] = dict(
                    word=start,
                    g=0.0,
                    h=h0,
                    f=weight * h0,
                    parent=None,
                    depth=0,
                    state="open",
                    discovered_sequence=len(self.events) + 1,
                    expanded_sequence=None,
                )
                self.emit("node_discovered", **self.nodes[start])
                queue = [(weight * h0, 0.0, 0, start)]
                closed: set[str] = set()
                order = 0
                trial_expansions = self.expansions
                while queue:
                    f, queued_g, _, current = heapq.heappop(queue)
                    node = self.nodes[current]
                    if abs(queued_g - node["g"]) > 1e-10 or current in closed:
                        continue
                    self.checkpoint()
                    self.expansions += 1
                    node.update(state="closed", expanded_sequence=len(self.events) + 1)
                    closed.add(current)
                    self.emit(
                        "node_expanded",
                        **node,
                        open_count=len(self.nodes) - len(closed),
                        closed_count=len(closed),
                        discovered_count=len(self.nodes),
                        edge_count=len(self.edges),
                        expansions=self.expansions,
                        elapsed_seconds=time.monotonic() - self.started,
                    )
                    if current == goal:
                        path = self.path(goal)
                        self.trials.append(
                            dict(k=k, status="succeeded", expansions=self.expansions - trial_expansions)
                        )
                        self.result = self.finish("succeeded", "GOAL_FOUND", path, k)
                        self.emit(
                            "goal_found",
                            path=path,
                            total_cost=node["g"],
                            nodes=[self.nodes[w].copy() for w in path],
                            edges=[
                                next(e for e in self.edges if e["source"] == a and e["target"] == b)
                                for a, b in zip(path, path[1:])
                            ],
                        )
                        self.status = "succeeded"
                        self.emit("search_completed", **self.result)
                        return
                    current_vector = ctx.word(current)
                    for neighbor in ctx.neighbors(current, k, filters):
                        if self.cancelled:
                            raise LabError("CANCELLED", "探索をキャンセルしました。")
                        word = neighbor["word"]
                        word_vector = ctx.word(word)
                        distance = angular(current_vector, word_vector)
                        cost = penalty + (1 - penalty) * distance
                        edge = dict(
                            source=current,
                            target=word,
                            cost=cost,
                            cosine_similarity=neighbor["cosine_similarity"],
                            angular_distance=distance,
                            selected=False,
                            forced=False,
                        )
                        self.edges.append(edge)
                        tentative = queued_g + cost
                        if tentative >= self.nodes.get(word, {}).get("g", float("inf")) - 1e-12:
                            self.emit("edge_observed", **edge)
                            continue
                        previous = self.nodes.get(word)
                        angle = goal_angle(word)
                        h = (1 - penalty) * angle
                        order += 1
                        new = dict(
                            word=word,
                            g=tentative,
                            h=h,
                            f=tentative + weight * h,
                            parent=current,
                            depth=node["depth"] + 1,
                            state="open",
                            expanded_sequence=None,
                            discovered_sequence=previous["discovered_sequence"]
                            if previous
                            else len(self.events) + 1,
                        )
                        self.nodes[word] = new
                        closed.discard(word)
                        heapq.heappush(queue, (tentative + weight * h, tentative, order, word))
                        if angle < goal_angle(self.best):
                            self.best = word
                        self.emit("node_updated" if previous else "node_discovered", **new, edge=edge)
                self.trials.append(
                    dict(k=k, status="NO_ROUTE_IN_GRAPH", expansions=self.expansions - trial_expansions)
                )
                self.emit(
                    "iteration_exhausted", k=k, best_word=self.best, provisional_path=self.path(self.best)
                )
            raise LabError("NO_ROUTE_IN_GRAPH", "指定した近傍グラフでは経路が見つかりませんでした。")
        except LabError as e:
            k = stages[min(len(self.trials), len(stages) - 1)]
            self.status = "cancelled" if e.code == "CANCELLED" else "failed"
            provisional = self.path(self.best) if self.best in self.nodes else [start]
            self.result = self.finish(self.status, e.code, [], k, provisional)
            self.result["message"] = e.message
            self.emit("search_cancelled" if self.status == "cancelled" else "search_failed", **self.result)
        except Exception:
            self.status = "failed"
            self.result = dict(
                ctx.meta(),
                status="failed",
                code="INTERNAL_ERROR",
                message="探索処理に失敗しました。条件を確認して再実行してください。",
                optimal_within_fixed_graph=False,
            )
            self.emit("search_failed", **self.result)
        finally:
            ctx.model.users -= 1

    def finish(self, status: str, code: str, path: list, k: int, provisional: list | None = None) -> dict:
        if status != "succeeded" and (not self.trials or self.trials[-1]["k"] != k):
            self.trials.append(
                dict(k=k, status=code, expansions=self.expansions - sum(t["expansions"] for t in self.trials))
            )
        path_edges = set(zip(path, path[1:]))
        for edge in self.edges:
            edge["selected"] = (edge["source"], edge["target"]) in path_edges
        return dict(
            self.ctx.meta(),
            status=status,
            code=code,
            path=path,
            provisional_path=provisional or [],
            total_cost=self.nodes[path[-1]]["g"] if path else None,
            best_word=self.best,
            minimum_h=self.nodes.get(self.best, {}).get("h"),
            best_angular_distance=angular(self.ctx.word(self.best), self.ctx.word(self.request.goal)),
            open_count=sum(n["state"] == "open" for n in self.nodes.values()),
            expansions=self.expansions,
            discovered_count=len(self.nodes),
            edge_count=len(self.edges),
            elapsed_seconds=time.monotonic() - self.started,
            k=k,
            trials=self.trials.copy(),
            settings=self.request.model_dump(by_alias=True),
            optimal_within_fixed_graph=status == "succeeded" and self.request.strategy == "optimal",
            strategy=self.request.strategy,
            heuristic_weight=REACH_FIRST_HEURISTIC_WEIGHT if self.request.strategy == "reach_first" else 1.0,
            graph_scope="top_k_directed",
            neighbor_exact=True,
            terminated_by_limit=code in {"TIMEOUT", "MAX_EXPANSIONS", "RESOURCE_LIMIT"},
            interpretation=(
                "指定された固定近傍グラフ内での最小コスト経路"
                if self.request.strategy == "optimal"
                else "目標への到達を優先した経路。最小コストは保証しません"
            ),
        )

    def public(self, after: int = 0) -> dict:
        with self.condition:
            return dict(
                search_id=self.id,
                status=self.status,
                result=self.result,
                events=self.events.since(after),
                archived_ranges=[[1, self.events.archived_through]] if self.events.archived_through else [],
                missing_ranges=[],
                last_sequence=len(self.events),
                created_at=self.created_at,
                **self.ctx.meta(),
            )


class SearchStore:
    def __init__(self):
        self.jobs: dict[str, SearchJob] = {}
        self.lock = threading.RLock()

    def create(self, ctx: Context, request: SearchRequest) -> SearchJob:
        valid(ctx.word(request.start, "START_OOV"))
        valid(ctx.word(request.goal, "GOAL_OOV"))
        if request.neighbor.mode == "ann":
            raise LabError(
                "ANN_UNAVAILABLE", "この構成はexact検索に対応しています。ANNは有効化されていません。"
            )
        stages = request.neighbor.progressive_widening
        if any(k < 2 or k > 200 for k in stages) or stages != sorted(set(stages)):
            raise LabError("INVALID_WIDENING", "拡張段階は2〜200の重複しない昇順にしてください。")
        for word in (request.start.strip(), request.goal.strip()):
            if not ctx.allowed(word, request.filters.model_dump()):
                raise LabError(
                    "FILTERED_ENDPOINT", "開始語または目標語がフィルターで除外されています。", word=word
                )
        with self.lock:
            self.jobs = {
                k: j
                for k, j in self.jobs.items()
                if j.status not in TERMINAL or time.time() - j.created < setting("JOB_TTL_SECONDS", 86400)
            }
            if sum(j.status not in TERMINAL for j in self.jobs.values()) >= setting("MAX_JOBS", 4):
                raise LabError("RESOURCE_LIMIT", "同時探索数が上限です。", 409)
            if len(self.jobs) >= 100:
                raise LabError(
                    "RESOURCE_LIMIT", "保持ジョブ数の上限です。サーバーを再起動してください。", 409
                )
            job = SearchJob(ctx, request)
            # Reserve the model before the worker is scheduled; activation/unload cannot race job creation.
            ctx.model.users += 1
            job.pinned = True
            self.jobs[job.id] = job
            threading.Thread(target=job.run, daemon=True).start()
            return job

    def get(self, key: str) -> SearchJob:
        job = self.jobs.get(key)
        if job is None or (
            job.status in TERMINAL and time.time() - job.created >= setting("JOB_TTL_SECONDS", 86400)
        ):
            raise LabError("SEARCH_NOT_FOUND", "探索が存在しないか、保持期間を過ぎています。", 404)
        return job
