from __future__ import annotations

import hashlib
import json
import os
import threading
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

import numpy as np
from gensim.models import KeyedVectors

from .core import ROOT, LabError, setting, utcnow


class Model:
    def __init__(self, meta: dict, path: Path, kv: KeyedVectors | None = None):
        self.meta, self.path, self.kv = meta, path, kv
        self.users = 0

    def public(self) -> dict:
        return dict(self.meta, references=self.users)


class ModelRegistry:
    def __init__(self, data_dir: Path | None = None):
        self.directory = data_dir or Path(os.environ.get("LAB_DATA_DIR", ROOT / "data"))
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.models: dict[str, Model] = {}
        self.default_id = "tiny-ja"
        fixture = ROOT / "fixtures" / "tiny_vectors.txt"
        metadata = json.loads((ROOT / "fixtures" / "metadata.json").read_text(encoding="utf-8"))
        self.models[self.default_id] = self._read(fixture, self.default_id, metadata, False)
        for manifest in self.directory.glob("*.json"):
            try:
                meta = json.loads(manifest.read_text(encoding="utf-8"))
                model_id = str(manifest.stem)
                if str(__import__("uuid").UUID(model_id)) != model_id:
                    continue
                path = self.directory / (
                    model_id + (".bin" if meta["format"] == "word2vec_binary" else ".txt")
                )
                if path.is_file():
                    meta["state"] = "unloaded"
                    self.models[model_id] = Model(meta, path)
            except (ValueError, KeyError, OSError):
                continue
        default_file = self.directory / "default-model.json"
        try:
            selected = json.loads(default_file.read_text(encoding="utf-8"))["model_id"]
            model = self.models.get(selected)
            if model is not None:
                if model.kv is None:
                    self.models[selected] = self._read(
                        model.path,
                        selected,
                        model.meta,
                        model.meta["format"] == "word2vec_binary",
                    )
                self.default_id = selected
        except (OSError, ValueError, KeyError, TypeError, LabError):
            pass

    def _read(
        self,
        path: Path,
        model_id: str,
        metadata: dict,
        binary: bool,
        checkpoint: Callable[[float], None] | None = None,
    ) -> Model:
        def check(progress: float):
            if checkpoint:
                checkpoint(progress)

        check(0.0)
        with path.open("rb") as header_source:
            header = header_source.readline(100)
        try:
            n, d = map(int, header.split())
        except ValueError:
            raise LabError("INVALID_MODEL", "word2vec の語彙数・次元ヘッダーが必要です。") from None
        estimate = n * (d * 8 + 400)
        used = sum(m.meta["estimated_memory_bytes"] for m in self.models.values() if m.kv is not None)
        if not (1 <= n <= 2_000_000 and 1 <= d <= 4096):
            raise LabError("INVALID_MODEL", "語彙数または次元が許容範囲を超えています。")
        if estimate + used > setting("MAX_MEMORY_MB", 256) * 1024**2:
            raise LabError(
                "RESOURCE_LIMIT",
                "モデルの推定メモリが設定上限を超えます。",
                413,
                estimated_memory_bytes=estimate,
            )
        if sum(m.kv is not None for m in self.models.values()) >= setting("MAX_LOADED_MODELS", 3):
            raise LabError("RESOURCE_LIMIT", "常駐モデル数が上限です。先にアンロードしてください。", 409)
        with path.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        try:
            seen: set[str] = set()
            if not binary:
                with path.open(encoding="utf-8") as f:
                    next(f)
                    count = 0
                    for line in f:
                        parts = line.split()
                        if len(parts) != d + 1:
                            raise ValueError()
                        if len(parts[0]) > 512 or parts[0] in seen:
                            raise ValueError()
                        seen.add(parts[0])
                        values = np.asarray(parts[1:], dtype=np.float32)
                        if not np.all(np.isfinite(values)):
                            raise ValueError()
                        count += 1
                        if count % 512 == 0:
                            check(min(0.7, count / n * 0.7))
                    if count != n:
                        raise ValueError()
            else:
                with path.open("rb") as source:
                    source.readline()
                    for row in range(n):
                        token = bytearray()
                        char = source.read(1)
                        while char in (b"\n", b"\r"):
                            char = source.read(1)
                        while char != b" ":
                            if not char or len(token) > 2048:
                                raise ValueError()
                            token.extend(char)
                            char = source.read(1)
                        word = token.decode("utf-8")
                        if not word or len(word) > 512 or word in seen:
                            raise ValueError()
                        seen.add(word)
                        block = source.read(d * 4)
                        if len(block) != d * 4 or not np.all(np.isfinite(np.frombuffer(block, dtype="<f4"))):
                            raise ValueError()
                        if row % 512 == 0:
                            check(row / n * 0.7)
                    if source.read().strip():
                        raise ValueError()
            check(0.75)
            kv = KeyedVectors.load_word2vec_format(str(path), binary=binary, unicode_errors="strict")
            if len(kv) != n or kv.vector_size != d or not np.all(np.isfinite(kv.vectors)):
                raise ValueError()
            with path.open("rb") as source:
                if hashlib.file_digest(source, "sha256").hexdigest() != digest:
                    raise ValueError()
            kv.vectors.flags.writeable = False
            check(0.95)
        except (ValueError, UnicodeError, EOFError, OSError, OverflowError):
            raise LabError(
                "INVALID_MODEL", "モデルの行数、次元、語彙の重複、有限値または形式が不正です。"
            ) from None
        defaults: dict[str, Any] = {
            "display_name": "持ち込みモデル",
            "source_url": None,
            "creator": "不明",
            "license_spdx": "UNKNOWN",
            "license_text_url": None,
            "training_corpus": "不明",
            "training_parameters": {},
            "language": "不明",
            "tokenization": "不明",
            "normalization_policy": "none",
            "redistribution_allowed": None,
        }
        safe = {k: metadata.get(k, v) for k, v in defaults.items()}
        safe.update(
            id=model_id,
            state="loaded",
            vocabulary_size=n,
            dimension=d,
            sha256=digest,
            generation_id=digest[:16],
            file_size_bytes=path.stat().st_size,
            estimated_memory_bytes=estimate,
            format="word2vec_binary" if binary else "word2vec_text",
            registered_at=metadata.get("registered_at", utcnow()),
            last_loaded_at=utcnow(),
        )
        return Model(safe, path, kv)

    def get(self, model_id: str | None = None, loaded: bool = True) -> Model:
        with self.lock:
            model = self.models.get(model_id or self.default_id)
            if model is None:
                raise LabError("MODEL_NOT_FOUND", "モデルが存在しません。", 404)
            if loaded and model.kv is None:
                raise LabError("MODEL_NOT_LOADED", "モデルを読み込んでください。", 409)
            return model

    def register(
        self, temp: Path, metadata: dict, binary: bool, checkpoint: Callable[[float], None] | None = None
    ) -> Model:
        with self.lock:
            model_id = str(uuid4())
            model = self._read(temp, model_id, metadata, binary, checkpoint)
            target = self.directory / (model_id + (".bin" if binary else ".txt"))
            temp.replace(target)
            model.path = target
            (self.directory / (model_id + ".json")).write_text(
                json.dumps(model.meta, ensure_ascii=False), encoding="utf-8"
            )
            self.models[model_id] = model
            return model

    def action(self, model_id: str, action: str, checkpoint: Callable[[float], None] | None = None) -> dict:
        with self.lock:
            model = self.get(model_id, loaded=False)
            if action == "load":
                if model.kv is None:
                    self.models[model_id] = model = self._read(
                        model.path,
                        model_id,
                        model.meta,
                        model.meta["format"] == "word2vec_binary",
                        checkpoint,
                    )
            elif action == "activate":
                self.get(model_id)
                default_file = self.directory / "default-model.json"
                temporary = self.directory / "default-model.json.tmp"
                temporary.write_text(json.dumps({"model_id": model_id}), encoding="utf-8")
                temporary.replace(default_file)
                self.default_id = model_id
            elif action in ("unload", "delete"):
                if model.users or model_id == self.default_id:
                    raise LabError("MODEL_IN_USE", "既定または使用中のモデルです。", 409)
                model.kv = None
                model.meta["state"] = "unloaded"
                if action == "delete":
                    if model_id == "tiny-ja":
                        raise LabError("BUILTIN_MODEL", "組み込みモデルは削除できません。", 409)
                    model.path.unlink(missing_ok=True)
                    (self.directory / (model_id + ".json")).unlink(missing_ok=True)
                    del self.models[model_id]
            return model.public()
