"""Train only a developer validation model on our CC0 corpus; no product training feature."""

import hashlib
import json
import tempfile
import time
from pathlib import Path

from fastapi.testclient import TestClient
from gensim.models import Word2Vec

from backend.app.core import ROOT
from backend.app.main import create_app


def stable_hash(word):
    return int.from_bytes(hashlib.sha256(word.encode()).digest()[:4], "little")


def run():
    corpus = ROOT / "fixtures/training_corpus.txt"
    sentences = [line.split() for line in corpus.read_text(encoding="utf-8").splitlines() if line.strip()]
    trained = Word2Vec(
        sentences=sentences,
        vector_size=32,
        min_count=1,
        window=4,
        workers=1,
        seed=42,
        epochs=400,
        sg=1,
        hashfxn=stable_hash,
    )
    record = dict(
        license="CC0-1.0",
        creator="Kotoba Lab contributors",
        corpus_sha256=hashlib.sha256(corpus.read_bytes()).hexdigest(),
        note="Gensimで実際に学習した小型モデル。第三者の事前学習モデルではなく、言語品質や大規模性能の検証には使えません。",
        settings=dict(vector_size=32, min_count=1, window=4, workers=1, seed=42, epochs=400, sg=1),
        checks={},
    )
    with tempfile.TemporaryDirectory() as directory:
        directory = Path(directory)
        with TestClient(create_app(directory / "registry")) as client:
            for binary in (False, True):
                file = directory / ("trained.bin" if binary else "trained.txt")
                trained.wv.save_word2vec_format(str(file), binary=binary)
                response = client.post(
                    "/api/v1/models",
                    files={"file": (file.name, file.read_bytes())},
                    data={
                        "format": "word2vec_binary" if binary else "word2vec_text",
                        "metadata": json.dumps(
                            dict(
                                display_name="Original CC0 trained validation model",
                                license_spdx="CC0-1.0",
                                creator="Kotoba Lab contributors",
                                redistribution_allowed=True,
                                training_corpus="Project-original fixtures/training_corpus.txt",
                            )
                        ),
                    },
                )
                response.raise_for_status()
                model = response.json()
                context = dict(model_id=model["id"])
                checks = {}
                for name, path, body in [
                    ("inspect", "/words/inspect", {"word": "猫"}),
                    ("rank", "/similarity/rank", {"positive": ["猫"]}),
                    ("distance", "/distances/compare", {"words": ["猫", "犬", "宇宙"]}),
                    (
                        "arithmetic",
                        "/arithmetic/evaluate",
                        {
                            "expression": {
                                "op": "subtract",
                                "left": {"type": "word", "value": "東京"},
                                "right": {"type": "word", "value": "日本"},
                            }
                        },
                    ),
                    ("projection", "/projections", {"words": ["猫", "犬", "宇宙"], "dimensions": 3}),
                ]:
                    response = client.post("/api/v1" + path, json=dict(body, **context))
                    response.raise_for_status()
                    checks[name] = response.status_code
                response = client.post("/api/v1/searches", json=dict(context, start="猫", goal="宇宙"))
                response.raise_for_status()
                key = response.json()["search_id"]
                for _ in range(500):
                    search = client.get("/api/v1/searches/" + key).json()
                    if search["result"]:
                        break
                    time.sleep(0.01)
                assert search["status"] == "succeeded", search
                checks["search"] = {
                    k: search["result"][k] for k in ("path", "total_cost", "k", "optimal_within_fixed_graph")
                }
                exp = client.post("/api/v1/experiments", json=context).json()
                edited = client.patch(
                    "/api/v1/experiments/" + exp["id"] + "/words/猫",
                    json={"expected_revision": 0, "operations": [{"op": "scale", "value": 1.1}]},
                )
                edited.raise_for_status()
                checks["edit"] = edited.json()["revision"]
                exported = client.post(
                    "/api/v1/exports", json=dict(context, kind="search", search_id=key, format="zip")
                )
                exported.raise_for_status()
                checks["export_zip_bytes"] = len(exported.content)
                record["checks"]["binary" if binary else "text"] = dict(
                    model_sha256=model["sha256"],
                    vocabulary_size=model["vocabulary_size"],
                    dimensions=model["dimension"],
                    checks=checks,
                )
    target = ROOT / "docs/trained-validation.json"
    target.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    print("Trained text/binary model validation passed:", target.name)


if __name__ == "__main__":
    run()
