"""Cancellable exact search on original synthetic vectors; no network or external model."""

import json
import platform
import tempfile
import time
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient
from gensim.models import KeyedVectors

from backend.app.main import create_app


def run():
    count, dimensions = 10000, 32
    angles = np.arange(count) * (2 * np.pi / count)
    matrix = np.column_stack(
        [np.cos(angles), np.sin(angles)] + [0.03 * np.sin(angles * i) for i in range(2, dimensions)]
    ).astype(np.float32)
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        kv = KeyedVectors(dimensions)
        kv.add_vectors([f"n{i}" for i in range(count)], matrix)
        model_file = directory / "ring.bin"
        kv.save_word2vec_format(str(model_file), binary=True)
        with TestClient(create_app(directory / "registry")) as client:
            response = client.post(
                "/api/v1/models",
                files={"file": ("ring.bin", model_file.read_bytes())},
                data={"format": "word2vec_binary", "metadata": '{"license_spdx":"CC0-1.0"}'},
            )
            response.raise_for_status()
            model = response.json()
            start = time.perf_counter()
            response = client.post(
                "/api/v1/searches",
                json=dict(
                    model_id=model["id"],
                    start="n0",
                    goal=f"n{count // 2}",
                    neighbor=dict(k=2, progressive_widening=[]),
                    limits=dict(max_expansions=10000, timeout_seconds=60),
                ),
            )
            response.raise_for_status()
            key = response.json()["search_id"]
            first = client.get("/api/v1/searches/" + key).json()
            first_event_ms = (time.perf_counter() - start) * 1000
            assert first["events"]
            time.sleep(1)
            before = client.get("/api/v1/searches/" + key).json()
            assert before["status"] in {"running", "queued"}, before["status"]
            cancelled_at = time.perf_counter()
            client.delete("/api/v1/searches/" + key).raise_for_status()
            for _ in range(300):
                result = client.get("/api/v1/searches/" + key).json()
                if result["status"] == "cancelled":
                    break
                time.sleep(0.01)
            latency = (time.perf_counter() - cancelled_at) * 1000
            assert result["status"] == "cancelled" and latency < 2000
            expansions = result["result"]["expansions"]
            time.sleep(0.1)
            assert client.get("/api/v1/searches/" + key).json()["result"]["expansions"] == expansions
            record = dict(
                system=platform.platform(),
                cpu=platform.processor(),
                vocabulary_size=count,
                dimensions=dimensions,
                mode="exact",
                model_sha256=model["sha256"],
                first_event_ms=first_event_ms,
                cancellation_ms=latency,
                expansions=expansions,
                result=result["result"]["code"],
                license="CC0-1.0",
                note="Original synthetic smooth ring; one second of active search before cancellation; not a trained language model.",
            )
            Path("docs/performance-search.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
            print(json.dumps(record, indent=2))


if __name__ == "__main__":
    run()
