from __future__ import annotations

import multiprocessing as mp
import threading
import time
from pathlib import Path
from uuid import uuid4

import numpy as np

from .core import LabError
from .operations import calculate_projection, prepare_projection, projection_result
from .registry import ModelRegistry
from .schemas import ProjectionRequest
from .vectors import Context


def projection_worker(connection, matrix, settings):
    # Only app-created numerical data crosses this private process boundary.
    try:
        coordinates, parameters = calculate_projection(matrix, ProjectionRequest(**settings))
        connection.send(dict(coordinates=coordinates, parameters=parameters))
    except LabError as error:
        connection.send(dict(error=dict(code=error.code, message=error.message)))
    except Exception:
        connection.send(dict(error=dict(code="PROJECTION_FAILED", message="射影処理に失敗しました。")))
    finally:
        connection.close()


class ProjectionJob:
    def __init__(self, context: Context, request: ProjectionRequest):
        self.id, self.ctx, self.request = str(uuid4()), context, request
        self.words, self.matrix = prepare_projection(context, request)
        if self.matrix.nbytes > 64 * 1024**2:
            raise LabError("RESOURCE_LIMIT", "射影に使用する行列が64MBを超えています。", 413)
        self.status = "queued"
        self.result: dict | None = None
        self.error: dict | None = None
        self.cancelled = threading.Event()
        self.created = time.time()
        self.ctx.model.users += 1

    def run(self) -> None:
        self.status = "running"
        spawn = mp.get_context("spawn")
        receiver, sender = spawn.Pipe(duplex=False)
        process = spawn.Process(
            target=projection_worker, args=(sender, self.matrix, self.request.model_dump()), daemon=True
        )
        try:
            process.start()
            sender.close()
            while not receiver.poll(0.05):
                if self.cancelled.is_set():
                    raise LabError("CANCELLED", "射影をキャンセルしました。")
                if time.time() - self.created > 180:
                    raise LabError("TIMEOUT", "射影の180秒上限に到達しました。")
                if not process.is_alive():
                    raise LabError(
                        "PROJECTION_FAILED", "射影ワーカーが停止しました。対象集合を減らしてください。"
                    )
            response = receiver.recv()
            if self.cancelled.is_set():
                raise LabError("CANCELLED", "射影をキャンセルしました。")
            if "error" in response:
                raise LabError(**response["error"])
            self.result = projection_result(
                self.ctx,
                self.request,
                self.words,
                np.asarray(response["coordinates"]),
                response["parameters"],
            )
            self.result["projection_id"] = self.id
            self.status = "succeeded"
        except LabError as error:
            self.status = "cancelled" if error.code == "CANCELLED" else "failed"
            self.error = error.body()
        except Exception:
            self.status = "failed"
            self.error = LabError("PROJECTION_FAILED", "射影を開始できませんでした。").body()
        finally:
            if process.is_alive():
                process.terminate()
            if process.pid:
                process.join(timeout=2)
            receiver.close()
            sender.close()
            self.matrix = np.empty((0, 0))
            self.ctx.model.users -= 1

    def public(self) -> dict:
        return dict(projection_id=self.id, status=self.status, result=self.result, error=self.error)


class ProjectionStore:
    def __init__(self):
        self.jobs: dict[str, ProjectionJob] = {}
        self.lock = threading.RLock()

    def create(self, context: Context, request: ProjectionRequest) -> dict:
        with self.lock:
            self.jobs = {key: job for key, job in self.jobs.items() if time.time() - job.created < 86400}
            if (
                len(self.jobs) >= 30
                or sum(j.status in {"queued", "running"} for j in self.jobs.values()) >= 2
            ):
                raise LabError("RESOURCE_LIMIT", "射影ジョブの保持数または同時実行数が上限です。", 409)
            job = ProjectionJob(context, request)
            self.jobs[job.id] = job
            threading.Thread(target=job.run, daemon=True).start()
            return job.public()

    def get(self, key: str) -> ProjectionJob:
        job = self.jobs.get(key)
        if job is None or time.time() - job.created > 86400:
            raise LabError("PROJECTION_NOT_FOUND", "射影が存在しないか、保持期間を過ぎています。", 404)
        return job


class ModelImportJob:
    def __init__(
        self, registry: ModelRegistry, path: Path, metadata: dict, binary: bool, model_id: str | None = None
    ):
        self.id, self.registry, self.path = str(uuid4()), registry, path
        self.metadata, self.binary = metadata, binary
        self.model_id = model_id
        self.cancelled = threading.Event()
        self.created = time.time()
        self.status, self.progress = "queued", 0.0
        self.result: dict | None = None
        self.error: dict | None = None

    def checkpoint(self, progress: float) -> None:
        self.progress = progress
        if self.cancelled.is_set():
            raise LabError("CANCELLED", "モデルの読み込みをキャンセルしました。")
        if time.time() - self.created > 180:
            raise LabError("TIMEOUT", "モデル読み込みが180秒上限に到達しました。")

    def run(self) -> None:
        self.status = "validating"
        try:
            if self.model_id:
                self.result = self.registry.action(self.model_id, "load", self.checkpoint)
            else:
                self.result = self.registry.register(
                    self.path, self.metadata, self.binary, self.checkpoint
                ).public()
            self.status, self.progress = "succeeded", 1.0
        except LabError as error:
            self.status = "cancelled" if error.code == "CANCELLED" else "failed"
            self.error = error.body()
        except Exception:
            self.status = "failed"
            self.error = LabError("INVALID_MODEL", "モデルを読み込めませんでした。").body()
        finally:
            if self.model_id is None:
                self.path.unlink(missing_ok=True)

    def public(self) -> dict:
        return dict(
            import_id=self.id,
            status=self.status,
            progress=self.progress,
            result=self.result,
            error=self.error,
        )


class ModelImportStore:
    def __init__(self, registry: ModelRegistry):
        self.registry = registry
        self.jobs: dict[str, ModelImportJob] = {}
        self.lock = threading.RLock()

    def create(self, path: Path, metadata: dict, binary: bool, model_id: str | None = None) -> dict:
        with self.lock:
            self.jobs = {key: job for key, job in self.jobs.items() if time.time() - job.created < 86400}
            if (
                len(self.jobs) >= 30
                or sum(j.status in {"queued", "validating"} for j in self.jobs.values()) >= 2
            ):
                raise LabError("RESOURCE_LIMIT", "モデル登録ジョブ数が上限です。", 409)
            job = ModelImportJob(self.registry, path, metadata, binary, model_id)
            self.jobs[job.id] = job
            threading.Thread(target=job.run, daemon=True).start()
            return job.public()

    def get(self, key: str) -> ModelImportJob:
        job = self.jobs.get(key)
        if not job:
            raise LabError("IMPORT_NOT_FOUND", "モデル登録ジョブが存在しません。", 404)
        return job
