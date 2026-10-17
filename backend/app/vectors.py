from __future__ import annotations

import threading
import time
from collections import OrderedDict
from collections.abc import Collection
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import numpy as np
import regex

from .core import VERSION, LabError, setting, utcnow
from .registry import Model, ModelRegistry

EPS = 1e-10


def valid(vector: np.ndarray) -> np.ndarray:
    if vector.ndim != 1 or not np.all(np.isfinite(vector)) or np.linalg.norm(vector) <= EPS:
        raise LabError("INVALID_VECTOR", "ゼロまたは非有限値のベクトルでは計算できません。")
    return vector


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    a, b = valid(a).astype(np.float64), valid(b).astype(np.float64)
    return float(np.clip(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)), -1, 1))


def angular(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.arccos(cosine(a, b)) / np.pi)


def statistics(v: np.ndarray) -> dict:
    v = v.astype(np.float64)
    return dict(
        l1=float(np.linalg.norm(v, 1)),
        l2=float(np.linalg.norm(v)),
        mean=float(v.mean()),
        std=float(v.std()),
        min=float(v.min()),
        max=float(v.max()),
        zero_count=int((v == 0).sum()),
    )


@dataclass
class Experiment:
    id: str
    model: Model
    revision: int = 0
    edits: dict = field(default_factory=dict)
    touched: float = field(default_factory=time.time)
    created_at: str = field(default_factory=utcnow)

    def public(self) -> dict:
        return dict(
            id=self.id,
            model_id=self.model.meta["id"],
            model_sha256=self.model.meta["sha256"],
            revision=self.revision,
            created_at=self.created_at,
            expires_at=datetime.fromtimestamp(
                self.touched + setting("EXPERIMENT_TTL_SECONDS", 3600), timezone.utc
            ).isoformat(),
            edits={w: v.tolist() for w, v in self.edits.items()},
        )


class ExperimentStore:
    def __init__(self, registry: ModelRegistry):
        self.registry, self.lock = registry, threading.RLock()
        self.sessions: dict[str, Experiment] = {}

    def expire(self) -> None:
        with self.lock:
            for key, e in list(self.sessions.items()):
                if time.time() - e.touched >= setting("EXPERIMENT_TTL_SECONDS", 3600):
                    self.drop(key)

    def create(self, model: Model) -> dict:
        with self.lock:
            self.expire()
            if len(self.sessions) >= 100:
                raise LabError("RESOURCE_LIMIT", "実験セッション数が上限です。", 409)
            e = Experiment(str(uuid4()), model)
            self.sessions[e.id] = e
            model.users += 1
            return e.public()

    def get(self, key: str) -> Experiment:
        with self.lock:
            self.expire()
            e = self.sessions.get(key)
            if e is None:
                raise LabError("EXPERIMENT_EXPIRED", "実験が存在しないか、60分間未使用で失効しました。", 404)
            e.touched = time.time()
            return e

    def drop(self, key: str) -> None:
        with self.lock:
            e = self.sessions.pop(key, None)
            if e:
                e.model.users -= 1


class Context:
    def __init__(self, model: Model, experiment: Experiment | None = None):
        self.model = model
        assert model.kv is not None
        self.kv: Any = model.kv
        self.edits = {w: v.copy() for w, v in experiment.edits.items()} if experiment else {}
        self.experiment_id = experiment.id if experiment else None
        self.revision = experiment.revision if experiment else None
        self.cache: OrderedDict[tuple, list] = OrderedDict()
        self.lock = threading.RLock()
        self._normalized: np.ndarray | None = None
        self._valid_rows: np.ndarray | None = None

    def meta(self) -> dict:
        return dict(
            model_id=self.model.meta["id"],
            model_sha256=self.model.meta["sha256"],
            generation_id=self.model.meta["generation_id"],
            experiment_id=self.experiment_id,
            experiment_revision=self.revision,
            license=self.model.meta["license_spdx"],
            source_url=self.model.meta["source_url"],
            app_version=VERSION,
            generated_at=utcnow(),
        )

    def word(self, word: str, code: str = "OOV") -> np.ndarray:
        word = word.strip()
        if word not in self.kv:
            raise LabError(
                code,
                "この単語はモデルに含まれません。",
                word=word,
                model=self.model.meta["display_name"],
                suggestions=self.suggest(word[:1]),
            )
        return self.edits.get(word, self.kv[word])

    def suggest(self, prefix: str) -> list[str]:
        result = []
        for word in self.kv.index_to_key:
            if word.startswith(prefix.strip()):
                result.append(word)
                if len(result) == 20:
                    break
        return result

    def count(self, word: str) -> int | None:
        # word2vec files do not contain training frequencies. Gensim's loader synthesizes
        # descending "count" attributes from row order; never present those as real counts.
        if not self.model.meta.get("counts_available", False):
            return None
        try:
            return int(self.kv.get_vecattr(word, "count"))
        except KeyError:
            return None

    def allowed(self, word: str, filters: dict) -> bool:
        if word in filters.get("exclude", []):
            return False
        if filters.get("min_count") is not None and (self.count(word) or 0) < filters["min_count"]:
            return False
        pattern = filters.get("regex")
        if pattern:
            if len(pattern) > 256:
                raise LabError("INVALID_FILTER", "正規表現は256文字以内で指定してください。")
            try:
                if regex.search(pattern, word, timeout=0.005) is None:
                    return False
            except (regex.error, TimeoutError):
                raise LabError("INVALID_FILTER", "正規表現が不正、または処理時間を超過しました。") from None
        return True

    def top(
        self,
        vector: np.ndarray,
        n: int,
        exclude: Collection[str] = (),
        filters: dict | None = None,
        min_similarity: float = -1,
        *,
        farthest: bool = False,
        max_similarity: float = 1,
    ) -> list[dict]:
        filters = filters or {}
        valid(vector)
        q = vector.astype(np.float64)
        q /= np.linalg.norm(q)
        with self.lock:
            if self._normalized is None:
                matrix = self.kv.vectors.copy()
                for w, value in self.edits.items():
                    matrix[self.kv.key_to_index[w]] = value
                norms = np.linalg.norm(matrix, axis=1, keepdims=True)
                self._valid_rows = norms[:, 0] > EPS
                self._normalized = np.divide(matrix, norms, out=np.zeros_like(matrix), where=norms > EPS)
            scores = np.clip(self._normalized @ q, -1, 1)
            excluded = set(exclude)
            assert self._valid_rows is not None
            ranking_scores = -scores if farthest else scores
            ranking_scores[~self._valid_rows] = -np.inf
            for word in excluded:
                index = self.kv.key_to_index.get(word)
                if index is not None:
                    ranking_scores[index] = -np.inf
            if not np.isfinite(ranking_scores).any():
                return []

            # For farthest results, negated scores make the lowest cosine rank first.
            # Partition the full vocabulary, then sort only the highest ranking scores.
            # Include every score tied at the boundary so index-order ties stay stable.
            threshold = -max_similarity if farthest else min_similarity
            batch = min(len(ranking_scores), max(32, n * 2))
            while True:
                cutoff = np.partition(ranking_scores, len(ranking_scores) - batch)[
                    len(ranking_scores) - batch
                ]
                candidates = np.flatnonzero(np.isfinite(ranking_scores) & (ranking_scores >= cutoff))
                indices = candidates[np.lexsort((candidates, -ranking_scores[candidates]))]
                result = []
                for idx in indices:
                    score = float(scores[idx])
                    if ranking_scores[idx] < threshold:
                        break
                    word = self.kv.index_to_key[idx]
                    if not self.allowed(word, filters):
                        continue
                    result.append(
                        dict(
                            word=word,
                            index=int(idx),
                            cosine_similarity=score,
                            cosine_distance=1 - score,
                            angular_distance=float(np.arccos(score) / np.pi),
                            count=self.count(word),
                        )
                    )
                    if len(result) >= n:
                        return result
                if batch == len(ranking_scores) or cutoff < threshold:
                    return result
                batch = min(len(ranking_scores), batch * 2)

    def neighbors(self, word: str, k: int, filters: dict) -> list[dict]:
        key = (word, k, str(filters))
        if key not in self.cache:
            self.cache[key] = self.top(self.word(word), k, {word}, filters)
            if len(self.cache) > 1024:
                self.cache.popitem(last=False)
        return self.cache[key]

    def inspect(self, word: str, offset: int, limit: int) -> dict:
        v = self.word(word)
        base = self.kv[word.strip()]
        return dict(
            self.meta(),
            word=word.strip(),
            index=self.kv.key_to_index[word.strip()],
            dimension=len(v),
            count=self.count(word.strip()),
            statistics=statistics(v),
            components=[
                dict(dimension=i, base=float(base[i]), value=float(v[i]), delta=float(v[i] - base[i]))
                for i in range(offset, min(len(v), offset + limit))
            ],
            page=dict(offset=offset, limit=limit, total=len(v)),
            edited=word.strip() in self.edits,
        )


def evaluate(ctx: Context, expression: dict) -> tuple[np.ndarray, set[str]]:
    nodes = 0
    words: set[str] = set()

    def walk(node: Any, depth: int) -> Any:
        nonlocal nodes
        nodes += 1
        if depth > 16 or nodes > 127 or not isinstance(node, dict):
            raise LabError("INVALID_AST", "式の深さまたはノード数が上限を超えています。")
        if node.get("type") == "word":
            if not isinstance(node.get("value"), str):
                raise LabError("INVALID_AST", "単語は文字列で指定してください。")
            words.add(node["value"].strip())
            return ctx.word(node["value"]).copy()
        if node.get("type") == "scalar":
            value = node.get("value")
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not np.isfinite(value)
                or abs(value) > 1e6
            ):
                raise LabError("INVALID_SCALAR", "スカラーは絶対値100万以下の有限数で指定してください。")
            return float(value)
        left, right = walk(node.get("left"), depth + 1), walk(node.get("right"), depth + 1)
        lv, rv = isinstance(left, np.ndarray), isinstance(right, np.ndarray)
        op = node.get("op")
        with np.errstate(over="ignore", invalid="ignore"):
            if op in ("add", "subtract") and lv and rv:
                return left + right if op == "add" else left - right
            if op == "multiply" and lv != rv:
                return left * right
            if op == "divide" and lv and not rv:
                if abs(right) <= EPS:
                    raise LabError("DIVISION_BY_ZERO", "0または許容誤差以下の数では割れません。")
                return left / right
        raise LabError(
            "UNSUPPORTED_OPERATION", "加減算はベクトル同士、乗除算はスカラーとの演算を指定してください。"
        )

    result = walk(expression, 0)
    if not isinstance(result, np.ndarray):
        raise LabError("INVALID_AST", "式の結果はベクトルである必要があります。")
    return valid(result), words


def apply_operations(ctx: Context, word: str, operations: list) -> np.ndarray:
    v = ctx.word(word).copy()
    if not 1 <= len(operations) <= 100:
        raise LabError("INVALID_PATCH", "編集操作は1〜100件で指定してください。")
    for op in operations:
        kind = op.get("op")
        value = op.get("value", 0)
        if kind in ("set_component", "add_component", "scale"):
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not np.isfinite(value)
                or abs(value) > 1e6
            ):
                raise LabError("INVALID_PATCH", "編集値は絶対値100万以下の有限数が必要です。")
        if kind in ("set_component", "add_component"):
            d = op.get("dimension")
            if not isinstance(d, int) or isinstance(d, bool) or not 0 <= d < len(v):
                raise LabError("INVALID_PATCH", "次元番号が範囲外です。")
            v[d] = value if kind == "set_component" else v[d] + value
        elif kind == "scale":
            v *= value
        elif kind == "normalize":
            v = valid(v) / np.linalg.norm(v)
        elif kind == "add_difference":
            if "from_word" in op and "to_word" in op:
                v += ctx.word(op["to_word"]) - ctx.word(op["from_word"])
            elif "vector" in op:
                try:
                    delta = np.asarray(op["vector"], dtype=np.float32)
                except (ValueError, TypeError):
                    raise LabError("INVALID_PATCH", "差分ベクトルが不正です。") from None
                if delta.shape != v.shape or not np.all(np.isfinite(delta)):
                    raise LabError("INVALID_PATCH", "差分ベクトルの次元・有限値を確認してください。")
                v += delta
            else:
                raise LabError("INVALID_PATCH", "差分の開始語・目標語またはベクトルが必要です。")
        else:
            raise LabError("INVALID_PATCH", "未対応の編集操作です。")
    return valid(v)
