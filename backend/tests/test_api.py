import io
import json
import time
import zipfile

import numpy as np
import pytest

from backend.app.core import ROOT

API = "/api/v1"


def post(client, path, body):
    return client.post(API + path, json=body)


def wait_job(client, key):
    for _ in range(200):
        response = client.get(API + f"/searches/{key}").json()
        if response["status"] in {"succeeded", "failed", "cancelled"}:
            return response
        time.sleep(0.01)
    pytest.fail("job did not terminate")


def test_model_and_inspect(client):
    assert client.get(API + "/health").json()["status"] == "ok"
    model = client.get(API + "/models").json()["models"][0]
    assert model["license_spdx"] == "CC0-1.0" and len(model["sha256"]) == 64
    assert post(client, "/words/inspect", {"word": "猫"}).json()["count"] is None
    assert post(client, "/words/inspect", {"word": "a/b"}).status_code == 200
    assert client.get(API + "/words/猫?offset=2&limit=2").json()["page"] == {
        "offset": 2,
        "limit": 2,
        "total": 8,
    }
    assert post(client, "/words/inspect", {"word": "cat"}).json()["error"]["code"] == "OOV"
    assert client.get(API + "/vocabulary/suggest?q=猫").json()["words"] == ["猫"]


def test_similarity_can_rank_farthest_words(client):
    result = post(
        client,
        "/similarity/rank",
        {"positive": ["猫"], "order": "farthest", "top_n": 10},
    ).json()
    scores = [row["cosine_similarity"] for row in result["ranking"]]
    assert result["settings"]["order"] == "farthest"
    assert len(scores) == 10 and scores == sorted(scores)
    assert "猫" not in {row["word"] for row in result["ranking"]}
    exported = post(
        client,
        "/exports",
        {"kind": "similarity", "format": "json", "payload": result["settings"]},
    ).json()
    assert exported["settings"]["order"] == "farthest"
    assert [row["word"] for row in exported["ranking"]] == [row["word"] for row in result["ranking"]]
    assert post(client, "/similarity/rank", {"positive": ["猫"], "order": "invalid"}).status_code == 422


def test_search_sse_reconnection_and_export(client):
    response = post(client, "/searches", {"start": "猫", "goal": "宇宙"})
    assert response.status_code == 202
    key = response.json()["search_id"]
    completed = wait_job(client, key)
    assert completed["result"]["optimal_within_fixed_graph"]
    all_events = client.get(API + f"/searches/{key}/events").text
    after = client.get(API + f"/searches/{key}/events", headers={"Last-Event-ID": "3"}).text
    events = [json.loads(line[6:]) for line in all_events.splitlines() if line.startswith("data: ")]
    recovered = [json.loads(line[6:]) for line in after.splitlines() if line.startswith("data: ")]
    assert recovered == events[3:]
    assert [e["sequence"] for e in events] == list(range(1, len(events) + 1))
    snapshot = client.get(API + f"/searches/{key}?after_sequence=3").json()
    assert snapshot["events"] == recovered
    archive = post(client, "/exports", {"kind": "search", "format": "zip", "search_id": key})
    with zipfile.ZipFile(io.BytesIO(archive.content)) as z:
        assert set(z.namelist()) == {"nodes.csv", "edges.csv", "path.csv", "events.csv", "metadata.json"}
        metadata = json.loads(z.read("metadata.json"))
        assert metadata["model_sha256"] == completed["result"]["model_sha256"]
        assert metadata["settings"]["cost"]["lambda"] == 0.15


@pytest.mark.parametrize(
    "body,code",
    [
        ({"start": "未登録", "goal": "猫"}, "START_OOV"),
        ({"start": "猫", "goal": "未登録"}, "GOAL_OOV"),
        ({"start": "猫", "goal": "ゼロ"}, "INVALID_VECTOR"),
        ({"start": "猫", "goal": "犬", "filters": {"exclude": ["猫"]}}, "FILTERED_ENDPOINT"),
        ({"start": "猫", "goal": "犬", "neighbor": {"mode": "ann"}}, "ANN_UNAVAILABLE"),
        ({"start": "猫", "goal": "犬", "filters": {"regex": "["}}, "INVALID_FILTER"),
    ],
)
def test_search_validation(client, body, code):
    response = post(client, "/searches", body)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == code


def test_pause_step_cancel_and_limits(client):
    key = post(client, "/searches", {"start": "猫", "goal": "宇宙", "start_paused": True}).json()["search_id"]
    time.sleep(0.03)
    assert client.get(API + f"/searches/{key}").json()["status"] == "paused"
    post(client, f"/searches/{key}/step", {})
    time.sleep(0.05)
    events = client.get(API + f"/searches/{key}").json()["events"]
    assert sum(e["type"] == "node_expanded" for e in events) == 1
    client.delete(API + f"/searches/{key}")
    cancelled = wait_job(client, key)
    expanded = sum(e["type"] == "node_expanded" for e in cancelled["events"])
    time.sleep(0.03)
    assert (
        sum(e["type"] == "node_expanded" for e in client.get(API + f"/searches/{key}").json()["events"])
        == expanded
    )
    assert cancelled["result"]["code"] == "CANCELLED"
    for limits, code in [
        ({"max_expansions": 1}, "MAX_EXPANSIONS"),
        ({"timeout_seconds": 0.000001}, "TIMEOUT"),
    ]:
        key = post(client, "/searches", {"start": "猫", "goal": "宇宙", "limits": limits}).json()["search_id"]
        result = wait_job(client, key)["result"]
        assert result["code"] == code and not result["optimal_within_fixed_graph"]
        assert result["provisional_path"]


def test_experiment_atomic_isolated_and_frozen_search(client):
    base = post(client, "/words/inspect", {"word": "猫"}).json()
    exp = post(client, "/experiments", {}).json()
    other = post(client, "/experiments", {}).json()
    key = exp["id"]
    search = post(
        client, "/searches", {"start": "猫", "goal": "宇宙", "experiment_id": key, "start_paused": True}
    ).json()["search_id"]
    before = client.app.state.registry.get().kv.vectors.copy()
    operations = [{"op": "set_component", "dimension": 1, "value": 2.0}]
    preview = client.patch(
        API + f"/experiments/{key}/words/猫",
        json={"expected_revision": 0, "operations": operations, "preview": True},
    )
    assert preview.status_code == 200
    assert client.get(API + f"/experiments/{key}").json()["revision"] == 0
    response = client.patch(
        API + f"/experiments/{key}/words/猫", json={"expected_revision": 0, "operations": operations}
    )
    assert response.json()["revision"] == 1
    frozen = post(client, f"/searches/{search}/words/inspect", {"word": "猫"}).json()
    assert frozen["experiment_revision"] == 0 and frozen["components"] == base["components"]
    conflict = client.patch(
        API + f"/experiments/{key}/words/猫", json={"expected_revision": 0, "operations": operations}
    )
    assert conflict.status_code == 409
    invalid = client.patch(
        API + f"/experiments/{key}/words/猫",
        json={"expected_revision": 1, "operations": operations + [{"op": "scale", "value": 0}]},
    )
    assert invalid.status_code == 422
    assert client.get(API + f"/experiments/{key}").json()["revision"] == 1
    assert (
        post(client, "/words/inspect", {"word": "猫", "experiment_id": other["id"]}).json()["components"]
        == base["components"]
    )
    assert np.array_equal(client.app.state.registry.get().kv.vectors, before)
    for path, body in [
        ("/similarity/rank", {"positive": ["猫"]}),
        ("/distances/compare", {"words": ["猫", "犬"]}),
        ("/projections", {"words": ["猫", "犬"]}),
        ("/arithmetic/evaluate", {"expression": {"type": "word", "value": "猫"}}),
    ]:
        result = post(client, path, dict(body, experiment_id=key)).json()
        assert result["experiment_revision"] == 1
    post(client, f"/searches/{search}/resume", {})
    assert wait_job(client, search)["result"]["experiment_revision"] == 0
    assert client.delete(API + f"/experiments/{key}/words/猫?expected_revision=1").status_code == 200
    assert (
        post(client, "/words/inspect", {"word": "猫", "experiment_id": key}).json()["components"]
        == base["components"]
    )
    client.delete(API + f"/experiments/{key}")
    assert client.get(API + f"/experiments/{key}").status_code == 404


def test_projection_distance_and_oov(client):
    body = {"words": ["猫", "犬", "宇宙", "猫"], "dimensions": 3}
    a, b = post(client, "/projections", body).json(), post(client, "/projections", body).json()
    assert a["points"] == b["points"] and a["points"][0]["input_positions"] == [0, 3]
    assert all(len(p["coordinates"]) == 3 for p in a["points"])
    mixed = post(
        client,
        "/projections",
        {"words": ["猫", "犬"], "vectors": [{"label": "演算結果", "vector": [1, 1, 0, 0, 0, 0, 0, 0]}]},
    ).json()
    assert mixed["points"][-1]["kind"] == "vector" and mixed["points"][-1]["role"] == "result"
    tsne_settings = {
        "words": ["猫", "犬", "宇宙"],
        "method": "tsne",
        "seed": 42,
        "parameters": {"perplexity": 1},
    }
    tsne_a = post(client, "/projections", tsne_settings).json()
    tsne_b = post(client, "/projections", tsne_settings).json()
    assert tsne_a["points"] == tsne_b["points"]
    assert (
        post(
            client, "/projections", {"words": ["猫", "犬"], "method": "tsne", "parameters": {"perplexity": 2}}
        ).status_code
        == 422
    )
    assert post(client, "/projections", {"words": ["猫", "猫"]}).status_code == 422
    response = post(client, "/distances/compare", {"words": ["猫", "未登録", "ゼロ"]})
    assert response.status_code == 422
    assert len(response.json()["error"]["details"]["words"]) == 2
    result = post(client, "/distances/compare", {"words": ["猫", "犬"]}).json()
    assert result["matrices"]["angular_distance"][0][0] == 0


def test_models_reject_unsafe_and_persist(client, tmp_path, monkeypatch):
    for filename, content in [
        ("test.kv", b"x"),
        ("test.txt", b"2 3\ncat 1 2 nan\ncat 1 2 3\n"),
        ("test.txt", b"2 3\ncat 1 2 3\n"),
    ]:
        response = client.post(API + "/models", files={"file": (filename, content)}, data={"metadata": "{}"})
        assert response.status_code == 422
        assert "Traceback" not in response.text and str(tmp_path) not in response.text
    assert not list(tmp_path.glob("*.upload"))
    uploaded = client.post(
        API + "/models",
        files={"file": ("vectors.txt", (ROOT / "fixtures/tiny_vectors.txt").read_bytes())},
        data={"metadata": '{"display_name":"持ち込み"}'},
    ).json()
    assert uploaded["license_spdx"] == "UNKNOWN"
    model_id = uploaded["id"]
    assert post(client, f"/models/{model_id}/unload", {}).status_code == 200
    assert post(client, f"/models/{model_id}/load", {}).status_code == 200
    assert post(client, f"/models/{model_id}/activate", {}).status_code == 200
    from backend.app.registry import ModelRegistry

    restored = ModelRegistry(tmp_path)
    assert restored.default_id == model_id
    assert restored.get().meta["vocabulary_size"] == uploaded["vocabulary_size"]
    assert client.delete(API + f"/models/{model_id}").status_code == 409
    monkeypatch.setenv("LAB_MAX_UPLOAD_MB", "0")
    assert client.post(API + "/models", files={"file": ("big.txt", b"1 1\na 1\n")}).status_code == 413


def test_export_csv_safety_and_provenance(client):
    response = post(client, "/exports", {"kind": "vector", "format": "csv", "payload": {"word": "=安全確認"}})
    assert response.status_code == 200 and response.content.startswith(b"\xef\xbb\xbf")
    assert "model_sha256" in response.text and "CC0-1.0" in response.text
    from backend.app.exports import csv_bytes

    csv = csv_bytes([{"word": "=1+1", "number": -2}], bom=False).decode()
    assert "'=1+1" in csv and ",-2" in csv


def test_security_and_bad_ast(client):
    assert client.get(API + "/health", headers={"Host": "evil.example"}).status_code == 403
    assert (
        post(client, "/arithmetic/evaluate", {"expression": {"type": "scalar", "value": 3}}).status_code
        == 422
    )
    word = {"type": "word", "value": "猫"}
    ast = word
    for _ in range(18):
        ast = {"op": "add", "left": ast, "right": word}
    assert post(client, "/arithmetic/evaluate", {"expression": ast}).status_code == 422
    for scalar in [0, 1e-15]:
        response = post(
            client,
            "/arithmetic/evaluate",
            {"expression": {"op": "divide", "left": word, "right": {"type": "scalar", "value": scalar}}},
        )
        assert response.json()["error"]["code"] == "DIVISION_BY_ZERO"


def test_ttl_expiry(client, monkeypatch):
    e = post(client, "/experiments", {}).json()
    monkeypatch.setenv("LAB_EXPERIMENT_TTL_SECONDS", "0")
    assert client.get(API + f"/experiments/{e['id']}").status_code == 404
    assert client.app.state.registry.get().users == 0


def test_projection_job_process_and_cancellation(client):
    job = post(client, "/projection-jobs", {"words": ["猫", "犬", "宇宙"], "dimensions": 3}).json()
    key = job["projection_id"]
    for _ in range(400):
        job = client.get(API + f"/projection-jobs/{key}").json()
        if job["status"] in {"succeeded", "failed"}:
            break
        time.sleep(0.03)
    assert job["status"] == "succeeded", job
    assert job["result"]["dimensions"] == 3
    exported = post(client, "/exports", {"kind": "projection", "projection_id": key, "format": "json"})
    assert exported.status_code == 200 and exported.json()["points"] == job["result"]["points"]
    second = post(client, "/projection-jobs", {"words": ["猫", "犬", "宇宙"], "method": "tsne"}).json()
    client.delete(API + f"/projection-jobs/{second['projection_id']}")
    for _ in range(200):
        response = client.get(API + f"/projection-jobs/{second['projection_id']}").json()
        if response["status"] == "cancelled":
            break
        time.sleep(0.01)
    assert response["status"] == "cancelled" and response["error"]["error"]["code"] == "CANCELLED"


def test_background_model_import_and_metadata_validation(client):
    response = client.post(
        API + "/models?background=true",
        files={"file": ("vectors.txt", (ROOT / "fixtures/tiny_vectors.txt").read_bytes())},
    )
    assert response.status_code == 202
    key = response.json()["import_id"]
    for _ in range(100):
        job = client.get(API + f"/model-imports/{key}").json()
        if job["status"] in {"succeeded", "failed"}:
            break
        time.sleep(0.01)
    assert job["status"] == "succeeded" and job["progress"] == 1
    model_id = job["result"]["id"]
    post(client, f"/models/{model_id}/unload", {}).raise_for_status()
    reload_response = post(client, f"/models/{model_id}/load?background=true", {})
    assert reload_response.status_code == 202
    reload_key = reload_response.json()["import_id"]
    for _ in range(100):
        reloaded = client.get(API + f"/model-imports/{reload_key}").json()
        if reloaded["status"] in {"succeeded", "failed"}:
            break
        time.sleep(0.01)
    assert reloaded["status"] == "succeeded"
    assert post(client, "/words/inspect", {"model_id": model_id, "word": "猫"}).status_code == 200
    with client.app.state.registry.lock:
        cancelled = client.post(
            API + "/models?background=true",
            files={"file": ("vectors.txt", (ROOT / "fixtures/tiny_vectors.txt").read_bytes())},
        ).json()
        client.delete(API + f"/model-imports/{cancelled['import_id']}")
    for _ in range(100):
        cancelled = client.get(API + f"/model-imports/{cancelled['import_id']}").json()
        if cancelled["status"] == "cancelled":
            break
        time.sleep(0.01)
    assert cancelled["status"] == "cancelled"
    response = client.post(
        API + "/models",
        files={"file": ("vectors.txt", b"1 1\na 1\n")},
        data={"metadata": '{"display_name": {"bad": "type"}}'},
    )
    assert response.status_code == 422


def test_compacted_history_keeps_every_sequence_and_reconnects(client, monkeypatch):
    monkeypatch.setenv("LAB_MAX_EVENTS", "12")
    key = post(client, "/searches", {"start": "猫", "goal": "宇宙"}).json()["search_id"]
    completed = wait_job(client, key)
    assert completed["status"] == "succeeded"
    assert completed["archived_ranges"] and completed["missing_ranges"] == []
    assert [e["sequence"] for e in completed["events"]] == list(range(1, completed["last_sequence"] + 1))
    after = client.get(API + f"/searches/{key}?after_sequence=5").json()
    assert after["events"] == completed["events"][5:]
    snapshot = client.get(API + f"/searches/{key}/snapshot").json()
    assert snapshot["snapshot"]["nodes"] and snapshot["archived_through"] > 0
    assert len(client.app.state.searches.get(key).events.hot) <= 12
