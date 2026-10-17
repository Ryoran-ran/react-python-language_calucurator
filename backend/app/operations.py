from __future__ import annotations

import numpy as np
from sklearn.decomposition import PCA
from sklearn.manifold import TSNE

from .core import LabError
from .schemas import ProjectionRequest
from .vectors import Context, valid


def compare(ctx: Context, words: list[str]) -> dict:
    words = [w.strip() for w in words]
    errors = []
    for word in words:
        try:
            valid(ctx.word(word))
        except LabError as error:
            errors.append(dict(error.details, word=word, code=error.code))
    if errors:
        raise LabError("INVALID_WORDS", "比較対象に未登録語または無効なベクトルがあります。", words=errors)
    vectors = np.asarray([ctx.word(w) for w in words], dtype=np.float64)
    normalized = vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
    similarity = np.clip(normalized @ normalized.T, -1, 1)
    np.fill_diagonal(similarity, 1)
    matrices = dict(
        cosine_similarity=similarity.tolist(),
        cosine_distance=(1 - similarity).tolist(),
        angular_distance=(np.arccos(similarity) / np.pi).tolist(),
        euclidean=np.linalg.norm(vectors[:, None] - vectors[None, :], axis=2).tolist(),
        normalized_euclidean=np.linalg.norm(normalized[:, None] - normalized[None, :], axis=2).tolist(),
    )
    pairs = [
        dict(source=a, target=b, **{key: matrix[i][j] for key, matrix in matrices.items()})
        for i, a in enumerate(words)
        for j, b in enumerate(words)
        if i < j
    ]
    return dict(
        ctx.meta(),
        words=words,
        matrices=matrices,
        pairs=pairs,
        settings=dict(words=words),
        warning="生のユークリッド距離はノルムの影響を受け、モデル間では直接比較できません。",
    )


def prepare_projection(ctx: Context, request: ProjectionRequest) -> tuple[list[str], np.ndarray]:
    words = list(dict.fromkeys(w.strip() for w in request.words))
    rows = [valid(ctx.word(w)) for w in words]
    for item in request.vectors:
        if item.label in words or len(item.vector) != ctx.kv.vector_size:
            raise LabError("INVALID_PROJECTION", "追加ベクトルのラベルが重複、または次元が不一致です。")
        words.append(item.label)
        rows.append(valid(np.asarray(item.vector, dtype=np.float64)))
    if len(words) < 2:
        raise LabError("INVALID_PROJECTION", "重複を除いて2語以上が必要です。")
    matrix = np.asarray(rows, dtype=np.float64)
    return words, matrix


def calculate_projection(matrix: np.ndarray, request: ProjectionRequest) -> tuple[np.ndarray, dict]:
    parameters = request.parameters.copy()
    dimensions = request.dimensions
    method = request.method
    if method == "pca":
        if parameters:
            raise LabError("INVALID_PARAMETERS", "PCAに追加パラメーターは指定できません。")
        count = min(dimensions, *matrix.shape)
        coordinates = PCA(n_components=count, svd_solver="full").fit_transform(matrix)
        if count < dimensions:
            coordinates = np.pad(coordinates, ((0, 0), (0, dimensions - count)))
    elif method == "tsne":
        if set(parameters) - {"perplexity"}:
            raise LabError("INVALID_PARAMETERS", "t-SNEにはperplexityのみ指定できます。")
        perplexity = parameters.setdefault("perplexity", min(30, max(1, (len(matrix) - 1) / 3)))
        if not 0 < perplexity < len(matrix) or len(matrix) > 2000:
            raise LabError("INVALID_PARAMETERS", "perplexityは点数より小さい正数、点数は2000以下が必要です。")
        coordinates = TSNE(
            n_components=dimensions,
            perplexity=perplexity,
            random_state=request.seed,
            init="random",
            learning_rate="auto",
            max_iter=500,
        ).fit_transform(matrix)
    else:
        raise LabError(
            "UMAP_UNAVAILABLE", "UMAPはこの構成では有効化されていません。PCAまたはt-SNEを選んでください。"
        )
    if not np.all(np.isfinite(coordinates)):
        raise LabError("INVALID_PROJECTION", "射影結果が非有限値です。対象集合を変更してください。")
    return coordinates, parameters


def projection_result(
    ctx: Context, request: ProjectionRequest, words: list[str], coordinates: np.ndarray, parameters: dict
) -> dict:
    return dict(
        ctx.meta(),
        method=request.method,
        dimensions=request.dimensions,
        parameters=parameters,
        seed=request.seed,
        words=words,
        settings=request.model_dump(),
        points=[
            dict(
                id=str(i),
                word=w,
                coordinates=coordinates[i].tolist(),
                edited=w in ctx.edits,
                kind="vector" if w in {v.label for v in request.vectors} else "word",
                role="result" if w in {v.label for v in request.vectors} else request.roles.get(w, "word"),
                input_positions=[j for j, original in enumerate(request.words) if original.strip() == w],
            )
            for i, w in enumerate(words)
        ],
        warning="射影では距離・近傍が歪みます。t-SNEの軸やクラスタ間距離に意味を割り当てず、別の対象集合の座標と直接比較しないでください。",
    )


def project(ctx: Context, request: ProjectionRequest) -> dict:
    words, matrix = prepare_projection(ctx, request)
    coordinates, parameters = calculate_projection(matrix, request)
    return projection_result(ctx, request, words, coordinates, parameters)


def rank_query(ctx: Context, positive: list[str], negative: list[str], vector: list | None) -> np.ndarray:
    if vector is not None:
        result = np.asarray(vector, dtype=np.float32)
        if result.shape != (ctx.kv.vector_size,):
            raise LabError("INVALID_VECTOR", "クエリベクトルの次元がモデルと一致しません。")
    else:
        if not positive:
            raise LabError("INVALID_QUERY", "正の単語またはクエリベクトルを指定してください。")
        result = np.zeros(ctx.kv.vector_size, dtype=np.float32)
    for word in positive:
        result += valid(ctx.word(word))
    for word in negative:
        result -= valid(ctx.word(word))
    return valid(result)
