from __future__ import annotations

import asyncio
import json
import logging
import tempfile
import time
from collections import OrderedDict
from pathlib import Path
from uuid import uuid4

import numpy as np
from fastapi import FastAPI, File, Form, Header, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from .background import ModelImportStore, ProjectionStore
from .core import ROOT, VERSION, LabError, setting
from .exports import export_result
from .operations import compare, project, rank_query
from .registry import ModelRegistry
from .schemas import (
    ArithmeticRequest,
    ContextRequest,
    DistanceRequest,
    ExportRequest,
    InspectRequest,
    ModelMetadata,
    PatchImport,
    PatchRequest,
    ProjectionRequest,
    RankRequest,
    SearchRequest,
)
from .search import TERMINAL, SearchStore
from .vectors import Context, ExperimentStore, apply_operations, evaluate, statistics, valid

logger = logging.getLogger("kotoba")


def create_app(data_dir: Path | None = None) -> FastAPI:
    app = FastAPI(title="言葉の実験室", version=VERSION)
    registry = ModelRegistry(data_dir)
    experiments = ExperimentStore(registry)
    searches = SearchStore()
    projections = ProjectionStore()
    imports = ModelImportStore(registry)
    app.state.projections = projections
    contexts: OrderedDict[tuple, Context] = OrderedDict()
    app.state.registry, app.state.experiments, app.state.searches = registry, experiments, searches
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Content-Type", "Last-Event-ID"],
    )

    @app.middleware("http")
    async def request_guard(request: Request, call_next):
        started = time.monotonic()
        request_id = "req_" + uuid4().hex[:12]
        host = request.headers.get("host", "").split(":")[0]
        if host not in {"127.0.0.1", "localhost", "testserver"}:
            return JSONResponse(
                LabError("INVALID_HOST", "ローカルホストで利用してください。", 403).body(), 403
            )
        if request.method in {"POST", "PATCH", "DELETE"}:
            origin = request.headers.get("origin")
            if origin and origin not in {
                "http://127.0.0.1:5173",
                "http://localhost:5173",
                "http://127.0.0.1:8000",
                "http://localhost:8000",
            }:
                return JSONResponse(
                    LabError("INVALID_ORIGIN", "許可されていないオリジンです。", 403).body(), 403
                )
        try:
            size = int(request.headers.get("content-length", "0"))
        except ValueError:
            size = 0
        if size > (setting("MAX_UPLOAD_MB", 64) + 1) * 1024**2:
            return JSONResponse(
                LabError("UPLOAD_TOO_LARGE", "リクエストがサイズ上限を超えています。", 413).body(), 413
            )
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        logger.info(
            json.dumps(
                dict(
                    request_id=request_id,
                    method=request.method,
                    status=response.status_code,
                    duration_ms=round((time.monotonic() - started) * 1000),
                )
            )
        )
        return response

    @app.exception_handler(LabError)
    async def lab_error(request: Request, error: LabError):
        return JSONResponse(error.body(), status_code=error.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, error: RequestValidationError):
        return JSONResponse(
            LabError(
                "VALIDATION_ERROR",
                "入力形式または数値の範囲を確認してください。",
                fields=[".".join(map(str, e["loc"])) for e in error.errors()],
            ).body(),
            422,
        )

    @app.exception_handler(ValidationError)
    async def nested_validation_error(request: Request, error: ValidationError):
        return JSONResponse(
            LabError("VALIDATION_ERROR", "出力設定の入力形式を確認してください。").body(), 422
        )

    @app.exception_handler(Exception)
    async def internal_error(request: Request, error: Exception):
        logger.error("request_failed type=%s", type(error).__name__)
        return JSONResponse(
            LabError("INTERNAL_ERROR", "処理に失敗しました。入力を確認して再実行してください。", 500).body(),
            500,
        )

    def context(model_id: str | None = None, experiment_id: str | None = None) -> Context:
        with registry.lock, experiments.lock:
            model = registry.get(model_id)
            e = experiments.get(experiment_id) if experiment_id else None
            if e and (e.model is not model or e.model.meta["sha256"] != model.meta["sha256"]):
                raise LabError("MODEL_CHANGED", "実験セッションのモデルが一致しません。", 409)
            key = (
                model.meta["sha256"],
                model.meta["id"],
                model.meta["generation_id"],
                e.id if e else None,
                e.revision if e else None,
            )
            if key not in contexts:
                contexts[key] = Context(model, e)
                if len(contexts) > 4:
                    contexts.popitem(last=False)
            contexts.move_to_end(key)
            return contexts[key]

    api = "/api/v1"

    @app.get(api + "/health")
    def health():
        return dict(
            status="ok",
            version=VERSION,
            default_model_id=registry.default_id,
            active_jobs=sum(j.status not in TERMINAL for j in searches.jobs.values()),
            capabilities=dict(ann=False, umap=False, tsne=True),
        )

    @app.get(api + "/models")
    def models():
        experiments.expire()
        return dict(
            models=[
                dict(m.public(), is_default=m.meta["id"] == registry.default_id)
                for m in registry.models.values()
            ],
            default_model_id=registry.default_id,
        )

    @app.get(api + "/models/{model_id}")
    def model_detail(model_id: str):
        return registry.get(model_id, loaded=False).public()

    @app.post(api + "/models", status_code=201)
    def upload_model(
        file: UploadFile = File(),
        metadata: str = Form("{}"),
        format: str = Form("word2vec_text"),
        background: bool = False,
    ):
        if format not in {"word2vec_text", "word2vec_binary"}:
            raise LabError(
                "UNSUPPORTED_FORMAT", "word2vec text / binary のみ読み込めます。pickleや.kvは非対応です。"
            )
        if Path(file.filename or "").suffix.lower() in {".kv", ".pkl", ".pickle", ".gz", ".zip"}:
            raise LabError("UNSUPPORTED_FORMAT", "pickle、.kv、圧縮ファイルはアップロードできません。")
        try:
            meta = json.loads(metadata)
            if not isinstance(meta, dict) or len(metadata) > 20000:
                raise ValueError()
            meta = ModelMetadata(**meta).model_dump()
            json.dumps(meta, allow_nan=False)
        except ValueError:
            raise LabError("INVALID_METADATA", "メタデータはJSONオブジェクトで指定してください。") from None
        path = None
        try:
            with tempfile.NamedTemporaryFile(
                dir=registry.directory, suffix=".upload", delete=False
            ) as target:
                path = Path(target.name)
                size = 0
                while block := file.file.read(1024**2):
                    size += len(block)
                    if size > setting("MAX_UPLOAD_MB", 64) * 1024**2:
                        raise LabError("UPLOAD_TOO_LARGE", "モデルのアップロード上限を超えています。", 413)
                    target.write(block)
            if background:
                job = imports.create(path, meta, format == "word2vec_binary")
                path = None  # The job now owns temporary-file cleanup.
                return JSONResponse(job, status_code=202)
            return registry.register(path, meta, format == "word2vec_binary").public()
        finally:
            if path:
                path.unlink(missing_ok=True)
            file.file.close()

    @app.get(api + "/model-imports/{key}")
    def import_status(key: str):
        return imports.get(key).public()

    @app.delete(api + "/model-imports/{key}")
    def cancel_import(key: str):
        job = imports.get(key)
        job.cancelled.set()
        return job.public()

    @app.post(api + "/models/{model_id}/{action}")
    def model_action(model_id: str, action: str, background: bool = False):
        if action not in {"load", "activate", "unload"}:
            raise LabError("NOT_FOUND", "操作が存在しません。", 404)
        if action == "load" and background:
            model = registry.get(model_id, loaded=False)
            return JSONResponse(
                imports.create(model.path, model.meta, model.meta["format"] == "word2vec_binary", model_id),
                202,
            )
        result = registry.action(model_id, action)
        if action == "unload":
            contexts.clear()
        return result

    @app.delete(api + "/models/{model_id}")
    def model_delete(model_id: str):
        result = registry.action(model_id, "delete")
        contexts.clear()
        return result

    @app.get(api + "/vocabulary/suggest")
    def suggest(q: str = Query("", max_length=512), model_id: str | None = None):
        return dict(words=context(model_id).suggest(q))

    @app.post(api + "/words/inspect")
    def inspect_word(request: InspectRequest):
        return context(request.model_id, request.experiment_id).inspect(
            request.word, request.offset, request.limit
        )

    @app.get(api + "/words/{word}")
    def inspect_get(
        word: str,
        model_id: str | None = None,
        experiment_id: str | None = None,
        offset: int = Query(0, ge=0),
        limit: int = Query(100, ge=1, le=1000),
    ):
        return context(model_id, experiment_id).inspect(word, offset, limit)

    @app.post(api + "/similarity/rank")
    def rank(request: RankRequest):
        ctx = context(request.model_id, request.experiment_id)
        vector = rank_query(ctx, request.positive, request.negative, request.vector)
        return dict(
            ctx.meta(),
            ranking=ctx.top(
                vector,
                request.top_n,
                set(request.exclude + request.positive + request.negative),
                request.filters.model_dump(),
                request.min_similarity,
                farthest=request.order == "farthest",
                max_similarity=request.max_similarity,
            ),
            statistics=statistics(vector),
            settings=request.model_dump(),
        )

    @app.post(api + "/arithmetic/evaluate")
    def arithmetic(request: ArithmeticRequest):
        ctx = context(request.model_id, request.experiment_id)
        vector, words = evaluate(ctx, request.expression)
        return dict(
            ctx.meta(),
            vector=vector.tolist(),
            statistics=statistics(vector),
            ranking=ctx.top(vector, request.top_n, words if request.exclude_input_words else set()),
            settings=request.model_dump(),
        )

    @app.post(api + "/distances/compare")
    def distances(request: DistanceRequest):
        return compare(context(request.model_id, request.experiment_id), request.words)

    @app.post(api + "/projections")
    def projection(request: ProjectionRequest):
        return project(context(request.model_id, request.experiment_id), request)

    @app.post(api + "/projection-jobs", status_code=202)
    def create_projection_job(request: ProjectionRequest):
        with registry.lock:
            return projections.create(context(request.model_id, request.experiment_id), request)

    @app.get(api + "/projection-jobs/{key}")
    def projection_status(key: str):
        return projections.get(key).public()

    @app.delete(api + "/projection-jobs/{key}")
    def cancel_projection(key: str):
        job = projections.get(key)
        job.cancelled.set()
        return job.public()

    @app.post(api + "/experiments", status_code=201)
    def create_experiment(request: ContextRequest):
        with registry.lock:
            return experiments.create(registry.get(request.model_id))

    @app.get(api + "/experiments/{key}")
    def experiment(key: str):
        return experiments.get(key).public()

    @app.delete(api + "/experiments/{key}")
    def delete_experiment(key: str):
        experiments.get(key)
        experiments.drop(key)
        return dict(discarded=True)

    @app.patch(api + "/experiments/{key}/words/{word:path}")
    def patch(key: str, word: str, request: PatchRequest):
        with experiments.lock:
            e = experiments.get(key)
            if request.expected_revision != e.revision:
                raise LabError(
                    "REVISION_CONFLICT",
                    "他の編集が反映されています。再取得してください。",
                    409,
                    current_revision=e.revision,
                )
            ctx = Context(e.model, e)
            value = apply_operations(ctx, word, request.operations)
            if request.preview:
                return dict(
                    before=ctx.word(word).tolist(),
                    after=value.tolist(),
                    delta=(value - ctx.word(word)).tolist(),
                    statistics=statistics(value),
                    revision=e.revision,
                )
            e.edits[word.strip()] = value.copy()
            e.revision += 1
            return e.public()

    @app.delete(api + "/experiments/{key}/words/{word:path}")
    def reset_word(key: str, word: str, expected_revision: int = Query(ge=0)):
        with experiments.lock:
            e = experiments.get(key)
            if expected_revision != e.revision:
                raise LabError("REVISION_CONFLICT", "リビジョンが一致しません。", 409)
            e.edits.pop(word, None)
            e.revision += 1
            return e.public()

    @app.post(api + "/experiments/{key}/import")
    def import_patch(key: str, request: PatchImport):
        with experiments.lock:
            e = experiments.get(key)
            if request.expected_revision != e.revision or request.model_sha256 != e.model.meta["sha256"]:
                raise LabError("REVISION_CONFLICT", "リビジョンまたはモデルハッシュが一致しません。", 409)
            if len(request.edits) > 1000:
                raise LabError("RESOURCE_LIMIT", "一度に取り込む差分は1000語までです。")
            ctx = Context(e.model, e)
            prepared = {}
            for word, values in request.edits.items():
                base = ctx.kv[word] if word in ctx.kv else ctx.word(word)
                delta = np.asarray(values, dtype=np.float32)
                if delta.shape != base.shape:
                    raise LabError("INVALID_PATCH", "差分の次元が一致しません。")
                prepared[word] = valid(base + delta)
            e.edits.update(prepared)
            e.revision += 1
            return e.public()

    @app.post(api + "/searches", status_code=202)
    def create_search(request: SearchRequest):
        with registry.lock:
            job = searches.create(context(request.model_id, request.experiment_id), request)
        return dict(
            search_id=job.id,
            status=job.status,
            model_sha256=job.ctx.model.meta["sha256"],
            events_url=api + f"/searches/{job.id}/events",
        )

    @app.get(api + "/searches/{key}")
    def search_status(key: str, after_sequence: int = Query(0, ge=0)):
        return searches.get(key).public(after_sequence)

    @app.post(api + "/searches/{key}/words/inspect")
    def inspect_search_word(key: str, request: InspectRequest):
        return searches.get(key).ctx.inspect(request.word, request.offset, request.limit)

    @app.get(api + "/searches/{key}/snapshot")
    def search_snapshot(key: str):
        job = searches.get(key)
        with job.condition:
            return dict(
                snapshot=job.snapshot, archived_through=job.events.archived_through, missing_ranges=[]
            )

    @app.post(api + "/searches/{key}/{action}")
    def search_action(key: str, action: str):
        if action not in {"pause", "resume", "step"}:
            raise LabError("NOT_FOUND", "操作が存在しません。", 404)
        job = searches.get(key)
        job.control(action)
        return dict(search_id=key, status=job.status)

    @app.delete(api + "/searches/{key}")
    def cancel_search(key: str):
        job = searches.get(key)
        job.control("cancel")
        return dict(search_id=key, status=job.status, cancellation_requested=True)

    @app.get(api + "/searches/{key}/events")
    async def search_events(
        key: str,
        request: Request,
        after_sequence: int = Query(0, ge=0),
        last_event_id: str | None = Header(None),
    ):
        job = searches.get(key)
        try:
            after = max(after_sequence, int(last_event_id or 0))
        except ValueError:
            raise LabError("INVALID_SEQUENCE", "Last-Event-IDは整数で指定してください。") from None

        async def stream():
            cursor = after
            while True:
                if await request.is_disconnected():
                    return
                snapshot = job.public(cursor)
                for event in snapshot["events"]:
                    cursor = event["sequence"]
                    yield f"id: {cursor}\nevent: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False, allow_nan=False)}\n\n"
                if snapshot["status"] in TERMINAL and cursor >= snapshot["last_sequence"]:
                    return
                if not snapshot["events"]:
                    yield ": heartbeat\n\n"
                await asyncio.sleep(0.05)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post(api + "/exports")
    def export(request: ExportRequest):
        nodes = edges = events = None
        if request.kind == "search":
            if request.search_id is None:
                raise LabError("INVALID_EXPORT", "探索IDが必要です。")
            job = searches.get(request.search_id)
            with job.condition:
                payload = dict(
                    job.result or job.ctx.meta(),
                    status=job.status,
                    nodes=list(job.nodes.values()),
                    edges=job.edges.copy(),
                    events=job.events.copy(),
                )
                nodes, edges, events = list(job.nodes.values()), job.edges.copy(), job.events.copy()
        elif request.kind == "projection" and request.projection_id:
            projection_job = projections.get(request.projection_id)
            if projection_job.result is None:
                raise LabError("PROJECTION_NOT_READY", "射影が完了していません。", 409)
            payload = projection_job.result.copy()
        elif request.kind == "experiment":
            ctx = context(request.model_id, request.experiment_id)
            if not request.experiment_id:
                raise LabError("INVALID_EXPORT", "実験IDが必要です。")
            payload = dict(ctx.meta(), edits={w: (v - ctx.kv[w]).tolist() for w, v in ctx.edits.items()})
        else:
            ctx = context(request.model_id, request.experiment_id)
            # Recompute server-side: caller cannot forge provenance for unrelated payloads.
            params = dict(request.payload, model_id=ctx.model.meta["id"], experiment_id=ctx.experiment_id)
            if request.kind == "vector":
                payload = inspect_word(InspectRequest(**params))
                word = params["word"]
                payload["components"] = ctx.inspect(word, 0, ctx.kv.vector_size)["components"]
                payload["settings"] = params
            elif request.kind == "arithmetic":
                payload = arithmetic(ArithmeticRequest(**params))
            elif request.kind == "similarity":
                payload = rank(RankRequest(**params))
            elif request.kind == "distance":
                payload = distances(DistanceRequest(**params))
            else:
                payload = projection(ProjectionRequest(**params))
        payload["limitations"] = (
            "共起傾向を観察する実験です。人間の思考、真偽、因果や公平性を保証せず、射影は距離を歪めます。"
        )
        data, media, suffix = export_result(
            request.kind, request.format, payload, request.bom, request.safe_csv, nodes, edges, events
        )
        return Response(
            data,
            media_type=media,
            headers={"Content-Disposition": f'attachment; filename="kotoba-{request.kind}{suffix}"'},
        )

    if (ROOT / "frontend" / "dist").is_dir():
        app.mount("/", StaticFiles(directory=ROOT / "frontend" / "dist", html=True), name="frontend")
    return app


app = create_app()
