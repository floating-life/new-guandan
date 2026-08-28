"""Train a small local value model from fair self-play trajectory JSONL.

Usage:
  python tools/train_value_model.py data/selfplay.jsonl models/value.json [epochs]

This intentionally trains only *chosen* actions against the actual trajectory
team utility. It does not fabricate counterfactual labels for unchosen legal
actions and does not upload data. The resulting JSON is compatible with the
guandan-candidate-v1 local model interface, but remains experimental until an
unseen-seed A/B gate passes.
"""

from __future__ import annotations

import json
import hashlib
import math
import sys
from pathlib import Path
from statistics import mean

SCHEMA = "guandan-candidate-v1"
DATASET_SCHEMA = "guandan-selfplay-trajectory-v2"
SEED_MANIFEST_SCHEMA = "guandan-seed-manifest-v1"
FEATURE_COUNT = 32


def load_examples(dataset_path: Path):
    examples = []
    record_count = 0
    header_seen = False
    header = None
    with dataset_path.open(encoding="utf-8") as dataset_file:
        for line_number, line in enumerate(dataset_file, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            if str(row.get("schema", "")).endswith("-header"):
                if header_seen or record_count:
                    raise ValueError(f"line {line_number}: duplicate or misplaced dataset header")
                if (
                    row.get("schema") != f"{DATASET_SCHEMA}-header"
                    or row.get("valueSchema") != SCHEMA
                    or row.get("labelScope") != "trajectory"
                ):
                    raise ValueError(f"line {line_number}: incompatible dataset header")
                header_seen = True
                header = row
                continue
            if not header_seen:
                raise ValueError(f"line {line_number}: strict v2 dataset header missing")
            record_count += 1
            if (
                row.get("schema") != DATASET_SCHEMA
                or row.get("valueSchema") != SCHEMA
                or row.get("labelScope") != "trajectory"
            ):
                raise ValueError(f"line {line_number}: incompatible schema or label scope")
            game = row.get("game")
            if not isinstance(game, int) or isinstance(game, bool) or game <= 0:
                raise ValueError(f"line {line_number}: invalid game id")
            target = float((row.get("outcome") or {}).get("teamUtility"))
            candidates = row.get("candidates")
            if not isinstance(candidates, list) or not candidates:
                raise ValueError(f"line {line_number}: candidates missing")
            selected = [candidate for candidate in candidates if candidate.get("chosen") is True]
            if len(selected) != 1:
                raise ValueError(
                    f"line {line_number}: expected exactly one chosen candidate, got {len(selected)}"
                )
            candidate = selected[0]
            features = [float(value) for value in candidate.get("features") or []]
            if len(features) != FEATURE_COUNT or not all(math.isfinite(value) for value in features):
                raise ValueError(f"line {line_number}: invalid selected candidate feature vector")
            if not math.isfinite(target) or target < -3 or target > 3 or target == 0:
                raise ValueError(f"line {line_number}: invalid team utility")
            examples.append((game, features, target))
    if not examples:
        raise ValueError("no selected trajectory examples found")
    if len(examples) != record_count:
        raise ValueError("each trajectory record must contribute exactly one selected example")
    return examples, header


def training_provenance(dataset_path: Path, header: dict):
    """Return explicit, reproducible dataset identity for model promotion gates."""
    if not isinstance(header, dict):
        raise ValueError("dataset header missing")
    base_seed = header.get("baseSeed")
    rounds = header.get("rounds")
    if not isinstance(base_seed, int) or isinstance(base_seed, bool) or not 0 <= base_seed <= 0xFFFFFFFF:
        raise ValueError("dataset header baseSeed must be a uint32")
    if not isinstance(rounds, int) or isinstance(rounds, bool) or rounds <= 0:
        raise ValueError("dataset header rounds must be a positive integer")
    manifest = header.get("seedManifest")
    if manifest is not None:
        if (
            not isinstance(manifest, dict)
            or manifest.get("schema") != SEED_MANIFEST_SCHEMA
            or not isinstance(manifest.get("seeds"), list)
            or len(manifest["seeds"]) != rounds
        ):
            raise ValueError("dataset header seedManifest is invalid")
        seeds = manifest["seeds"]
    else:
        # Backward-compatible read of old v2 files; newly generated files always
        # carry the explicit manifest and promotion still records this fallback.
        seeds = [(base_seed + index) & 0xFFFFFFFF for index in range(rounds)]
    if any(
        not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed <= 0xFFFFFFFF
        for seed in seeds
    ) or len(set(seeds)) != len(seeds):
        raise ValueError("dataset header seedManifest contains invalid or duplicate seeds")
    expected = [(base_seed + index) & 0xFFFFFFFF for index in range(rounds)]
    if seeds != expected:
        raise ValueError("dataset header seedManifest must match the contiguous baseSeed range")
    digest = hashlib.sha256()
    with dataset_path.open("rb") as dataset_file:
        for chunk in iter(lambda: dataset_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return {
        "schema": DATASET_SCHEMA,
        "sha256": digest.hexdigest(),
        "rounds": rounds,
        "baseSeed": base_seed,
        "seedManifest": {"schema": SEED_MANIFEST_SCHEMA, "seeds": seeds},
    }


def fit_standardizer(examples):
    columns = list(zip(*(features for _, features, _ in examples)))
    means = [mean(column) for column in columns]
    scales = []
    for column, column_mean in zip(columns, means):
        variance = mean((value - column_mean) ** 2 for value in column)
        scales.append(max(math.sqrt(variance), 1e-5))
    return means, scales


def apply_standardizer(examples, means, scales):
    return [
        (game, [(value - means[index]) / scales[index] for index, value in enumerate(features)], target)
        for game, features, target in examples
    ]


def split_by_whole_game(examples):
    game_ids = sorted({game for game, _, _ in examples})
    if len(game_ids) < 2:
        raise ValueError(
            "strict holdout requires at least 2 complete games; generate more self-play rounds"
        )
    # 最后20%的完整牌局作为固定留出；相邻动作不会跨集合，且至少各有一局。
    holdout_count = max(1, math.ceil(len(game_ids) * 0.2))
    holdout_count = min(holdout_count, len(game_ids) - 1)
    holdout_games = set(game_ids[-holdout_count:])
    train_games = set(game_ids) - holdout_games
    train = [item for item in examples if item[0] in train_games]
    holdout = [item for item in examples if item[0] in holdout_games]
    if not train or not holdout:
        raise ValueError("failed to construct non-empty whole-game train/holdout split")
    return train, holdout, sorted(train_games), sorted(holdout_games)


def fit(train, epochs):
    weights = [0.0] * FEATURE_COUNT
    bias = mean(target for _, _, target in train)
    # Full-batch ridge gradient descent: deterministic, dependency-free, and
    # adequate for the first local value-model experiment.
    learning_rate = 0.045
    ridge = 0.003
    for _ in range(epochs):
        grad_w = [0.0] * FEATURE_COUNT
        grad_b = 0.0
        for _, features, target in train:
            error = bias + sum(weight * value for weight, value in zip(weights, features)) - target
            grad_b += error
            for index, value in enumerate(features):
                grad_w[index] += error * value
        count = len(train)
        bias -= learning_rate * grad_b / count
        for index in range(FEATURE_COUNT):
            weights[index] -= learning_rate * (grad_w[index] / count + ridge * weights[index])
    return weights, bias


def regression_metrics(examples, weights, bias, baseline):
    predictions = [
        bias + sum(weight * value for weight, value in zip(weights, features))
        for _, features, _ in examples
    ]
    targets = [target for _, _, target in examples]
    squared = [(prediction - target) ** 2 for prediction, target in zip(predictions, targets)]
    absolute = [abs(prediction - target) for prediction, target in zip(predictions, targets)]
    baseline_squared = [(baseline - target) ** 2 for target in targets]
    model_mse = mean(squared)
    baseline_mse = mean(baseline_squared)
    return {
        "examples": len(examples),
        "mse": model_mse,
        "rmse": math.sqrt(model_mse),
        "mae": mean(absolute),
        "targetMean": mean(targets),
        "predictionMean": mean(predictions),
        "trainMeanBaselineMse": baseline_mse,
        "mseImprovementVsBaseline": baseline_mse - model_mse,
        "beatsTrainMeanBaseline": model_mse < baseline_mse,
    }


def main():
    if len(sys.argv) < 3:
        raise SystemExit("Usage: python tools/train_value_model.py <dataset.jsonl> <model.json> [epochs]")
    dataset_path = Path(sys.argv[1]).resolve()
    model_path = Path(sys.argv[2]).resolve()
    epochs = max(20, min(2000, int(sys.argv[3]) if len(sys.argv) > 3 else 350))
    examples, dataset_header = load_examples(dataset_path)
    training_data = training_provenance(dataset_path, dataset_header)
    # 先按完整牌局切分，再且仅用训练局拟合均值/尺度。留出局从未参与任何
    # 参数或预处理统计，报告才是真正的严格留出结果。
    train_raw, holdout_raw, train_games, holdout_games = split_by_whole_game(examples)
    means, scales = fit_standardizer(train_raw)
    train = apply_standardizer(train_raw, means, scales)
    holdout = apply_standardizer(holdout_raw, means, scales)
    weights_normalized, bias_normalized = fit(train, epochs)
    # Fold standardization into a raw-input linear layer understood by the
    # browser, so inference does not need dataset statistics.
    raw_weights = [weight / scale for weight, scale in zip(weights_normalized, scales)]
    raw_bias = bias_normalized - sum(
        weight * column_mean / scale
        for weight, column_mean, scale in zip(weights_normalized, means, scales)
    )
    train_mean = mean(target for _, _, target in train)
    report = {
        "evaluation": "strict-whole-game-holdout-v1",
        "leakageFreePreprocessing": True,
        "split": {
            "method": "ordered-tail-20-percent-by-whole-game",
            "totalGames": len(train_games) + len(holdout_games),
            "trainGames": len(train_games),
            "holdoutGames": len(holdout_games),
            "trainGameIds": train_games,
            "holdoutGameIds": holdout_games,
        },
        "standardization": {
            "fitOn": "train-games-only",
            "featureCount": FEATURE_COUNT,
            "nearConstantFeatures": sum(1 for scale in scales if scale <= 1e-5),
        },
        "train": regression_metrics(
            train, weights_normalized, bias_normalized, train_mean
        ),
        "holdout": regression_metrics(
            holdout, weights_normalized, bias_normalized, train_mean
        ),
        "epochs": epochs,
    }
    model = {
        "id": f"selfplay-linear-{len(train)}-examples",
        "schema": SCHEMA,
        "layers": [{"weights": [raw_weights], "bias": [raw_bias], "activation": "linear"}],
        "metadata": {
            "source": "fair-selfplay-trajectory-v2",
            "status": "experimental_unvalidated",
            "featureCount": FEATURE_COUNT,
            "trainingData": training_data,
            # Keep a short top-level alias so older gate/report tooling can
            # consume provenance without knowing the nested trainingData shape.
            "trainingSeedManifest": training_data["seedManifest"],
            "report": report,
            "note": "Use only after unseen-seed A/B validation; this is not a DanZero policy network.",
        },
    }
    model_path.parent.mkdir(parents=True, exist_ok=True)
    model_path.write_text(json.dumps(model, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "dataset": str(dataset_path),
        "model": str(model_path),
        "strictHoldout": report,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
