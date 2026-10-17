from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class Request(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class ContextRequest(Request):
    model_id: str | None = None
    experiment_id: str | None = None


class ModelMetadata(Request):
    display_name: str = Field("持ち込みモデル", max_length=120)
    creator: str = Field("不明", max_length=200)
    source_url: str | None = Field(None, max_length=2000)
    license_spdx: str = Field("UNKNOWN", max_length=100)
    license_text_url: str | None = Field(None, max_length=2000)
    training_corpus: str = Field("不明", max_length=5000)
    training_parameters: dict = Field(default_factory=dict)
    language: str = Field("不明", max_length=100)
    tokenization: str = Field("不明", max_length=1000)
    normalization_policy: str = Field("none", max_length=500)
    redistribution_allowed: bool | None = None


class Filters(Request):
    exclude: list[str] = Field(default_factory=list, max_length=1000)
    min_count: int | None = Field(None, ge=0)
    regex: str | None = Field(None, max_length=256)


class Neighbor(Request):
    mode: Literal["exact", "ann"] = "exact"
    k: int = Field(25, ge=2, le=200)
    progressive_widening: list[int] = Field(default_factory=lambda: [10, 25, 50, 100], max_length=10)


class Cost(Request):
    kind: Literal["angular_with_hop_penalty"] = "angular_with_hop_penalty"
    penalty: float = Field(0.15, alias="lambda", ge=0, le=1)


class Limits(Request):
    max_expansions: int = Field(5000, ge=1, le=100000)
    timeout_seconds: float = Field(30, gt=0, le=300)


class SearchRequest(ContextRequest):
    start: str = Field(min_length=1, max_length=512)
    goal: str = Field(min_length=1, max_length=512)
    strategy: Literal["optimal", "reach_first"] = "optimal"
    neighbor: Neighbor = Field(default_factory=lambda: Neighbor())
    cost: Cost = Field(default_factory=lambda: Cost())
    limits: Limits = Field(default_factory=lambda: Limits())
    filters: Filters = Field(default_factory=lambda: Filters())
    start_paused: bool = False


class RankRequest(ContextRequest):
    positive: list[str] = Field(default_factory=list, max_length=50)
    negative: list[str] = Field(default_factory=list, max_length=50)
    vector: list[float] | None = Field(None, max_length=4096)
    top_n: int = Field(20, ge=1, le=200)
    exclude: list[str] = Field(default_factory=list, max_length=1000)
    min_similarity: float = Field(-1, ge=-1, le=1)
    max_similarity: float = Field(1, ge=-1, le=1)
    order: Literal["nearest", "farthest"] = "nearest"
    filters: Filters = Field(default_factory=lambda: Filters())


class ArithmeticRequest(ContextRequest):
    expression: dict[str, Any]
    top_n: int = Field(20, ge=1, le=200)
    exclude_input_words: bool = True


class DistanceRequest(ContextRequest):
    words: list[str] = Field(min_length=2, max_length=50)


class ProjectionVector(Request):
    label: str = Field(min_length=1, max_length=100)
    vector: list[float] = Field(min_length=1, max_length=4096)


class ProjectionRequest(ContextRequest):
    words: list[str] = Field(default_factory=list, max_length=5000)
    vectors: list[ProjectionVector] = Field(default_factory=list, max_length=10)
    roles: dict[str, Literal["start", "goal", "path", "word"]] = Field(default_factory=dict, max_length=5000)
    method: Literal["pca", "tsne", "umap"] = "pca"
    dimensions: Literal[2, 3] = 2
    parameters: dict[str, float] = Field(default_factory=dict)
    seed: int = Field(42, ge=0, le=2**32 - 1)


class InspectRequest(ContextRequest):
    word: str = Field(min_length=1, max_length=512)
    offset: int = Field(0, ge=0)
    limit: int = Field(100, ge=1, le=1000)


class PatchRequest(Request):
    expected_revision: int = Field(ge=0)
    operations: list[dict[str, Any]] = Field(min_length=1, max_length=100)
    preview: bool = False


class PatchImport(Request):
    expected_revision: int = Field(ge=0)
    model_sha256: str
    edits: dict[str, list[float]]


class ExportRequest(ContextRequest):
    kind: Literal["search", "arithmetic", "similarity", "distance", "vector", "projection", "experiment"]
    format: Literal["json", "csv", "zip"] = "json"
    search_id: str | None = None
    projection_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    bom: bool = True
    safe_csv: bool = True
