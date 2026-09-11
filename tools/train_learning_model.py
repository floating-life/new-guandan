"""CPU value regression from public-world teacher labels, grouped by base deal."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path

import torch
from torch import nn

LABEL_SCHEMA = 'guandan-learning-labels-v1'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def load_labels(label_path):
    path = Path(label_path)
    hasher = hashlib.sha256()
    header, rows = None, []
    with path.open('rb') as stream:
        for raw in stream:
            hasher.update(raw)
            if not raw.strip():
                continue
            item = json.loads(raw)
            if header is None:
                header = item
            else:
                rows.append(item)
    if not isinstance(header, dict) or header.get('schema') != LABEL_SCHEMA + '-header' \
            or header.get('valueSchema') != 'guandan-candidate-v1' \
            or header.get('labelKind') != 'teacher_estimate':
        raise ValueError('invalid learning label header')
    dataset = header.get('dataset', {})
    groups = {g['dealGroupId']: g for g in dataset.get('groups', [])}
    if not groups or len(groups) != len(dataset.get('groups', [])):
        raise ValueError('invalid/duplicate groups')
    if {g.get('split') for g in groups.values()} != {'train', 'validation'}:
        raise ValueError('both train and validation splits are required')
    seeds = dataset.get('seedManifest', {}).get('seeds', [])
    if dataset.get('seedManifest', {}).get('schema') != 'guandan-seed-manifest-v1' \
            or len(set(seeds)) != len(groups) or set(seeds) != {g['baseSeed'] for g in groups.values()}:
        raise ValueError('invalid source seed manifest')
    if any(not isinstance(seed, int) or isinstance(seed, bool) or not 0 < seed <= 0xFFFFFFFF for seed in seeds):
        raise ValueError('invalid source seed')
    selection_info = header.get('selection', {})
    selection_path = Path(selection_info['path'])
    if not selection_path.is_absolute():
        selection_path = path.parent / selection_path
    selection_bytes = selection_path.read_bytes()
    if digest(selection_bytes) != selection_info.get('sha256'):
        raise ValueError('selection hash mismatch')
    selection = json.loads(selection_bytes)
    if selection.get('schema') != 'guandan-learning-selection-v1' \
            or selection.get('datasetSha256') != dataset.get('sha256') \
            or {g['dealGroupId']: g for g in selection.get('groups', [])} != groups:
        raise ValueError('selection/source group mismatch')
    states = {s['stateId']: s for s in selection.get('states', [])}
    if not states or len(states) != len(selection.get('states', [])) or len(states) != header.get('stateCount'):
        raise ValueError('invalid/duplicate selected states')
    quota = selection.get('statesPerGroupLevel')
    if not isinstance(quota, int) or isinstance(quota, bool) or quota < 1:
        raise ValueError('invalid selection quota')
    bucket_counts = Counter()
    for state in states.values():
        group = groups.get(state.get('dealGroupId'))
        if not group or state.get('split') != group['split']:
            raise ValueError('state split mismatch')
        bucket_counts[(state['dealGroupId'], state['level'])] += 1
    levels = {s['level'] for s in states.values()}
    if selection.get('statesPerLevel') != quota * len(groups) \
            or any(bucket_counts[(group, level)] != quota for group in groups for level in levels):
        raise ValueError('incomplete selection quota')
    worlds = header.get('teacher', {}).get('worlds')
    if not isinstance(worlds, int) or isinstance(worlds, bool) or not 1 <= worlds <= 32 \
            or header.get('teacher', {}).get('learnedModelUsed') is not False:
        raise ValueError('invalid teacher contract')
    feature_engine = header.get('featureEngine') or header.get('featureEncoder', {}).get('engine', 'learned-value-v1')
    expected_dim = 38 if feature_engine == 'learned-context-v2' else 32
    keys, counts, retained = set(), Counter(), {}
    for row in rows:
        state = states.get(row.get('stateId'))
        if row.get('schema') != LABEL_SCHEMA or row.get('labelKind') != 'teacher_estimate' or state is None:
            raise ValueError('invalid label/state')
        if any(row.get(field) != state.get(field) for field in ['dealGroupId', 'split', 'level', 'seat']):
            raise ValueError('label group/split differs from selection')
        key = (row['stateId'], row.get('candidateId'))
        if not isinstance(key[1], str) or not key[1] or key in keys:
            raise ValueError('duplicate/invalid candidate label')
        keys.add(key)
        features = row.get('features')
        if not isinstance(features, list) or len(features) != expected_dim or not all(finite(v) for v in features):
            raise ValueError('invalid label features')
        target = row.get('teacherValue')
        if not finite(target) or not -3 <= target <= 3:
            raise ValueError('invalid teacherValue')
        fields = ['completedSamples', 'terminalCount', 'truncatedCount', 'legalCandidateCount',
                  'eligibleCandidateCount', 'retainedCandidateCount', 'cappedCandidateCount']
        if any(not isinstance(row.get(f), int) or isinstance(row[f], bool) or row[f] < 0 for f in fields):
            raise ValueError('invalid candidate/teacher coverage')
        n = row['retainedCandidateCount']
        if not 2 <= n <= 8 or row['completedSamples'] != worlds \
                or row['terminalCount'] + row['truncatedCount'] != worlds \
                or not row['legalCandidateCount'] >= row['eligibleCandidateCount'] >= n \
                or row['cappedCandidateCount'] != row['eligibleCandidateCount'] - n:
            raise ValueError('inconsistent candidate/teacher coverage')
        if row['stateId'] in retained and retained[row['stateId']] != n:
            raise ValueError('inconsistent retained candidate count')
        retained[row['stateId']] = n
        counts[row['stateId']] += 1
    if set(counts) != set(states) or any(counts[s] != retained[s] for s in states):
        raise ValueError('missing candidate labels')
    return dict(header=header, rows=rows, groups=groups, selection=selection, sha256=hasher.hexdigest())


def ranking_metrics(rows, predictions):
    states = defaultdict(list)
    for row, score in zip(rows, predictions):
        states[row['stateId']].append((float(score), row['teacherValue']))
    regrets = []
    for candidates in states.values():
        chosen = max(range(len(candidates)), key=lambda i: candidates[i][0])
        regrets.append(max(target for _, target in candidates) - candidates[chosen][1])
    return dict(states=len(states), meanTeacherRegret=sum(regrets) / len(regrets),
                teacherTopChoiceRate=sum(r <= 1e-8 for r in regrets) / len(regrets))


def train_model(labels, output, architecture='mlp', epochs=100, seed=1, device='cpu'):
    output = Path(output)
    if output.exists():
        raise ValueError(f'output exists: {output}')
    if architecture not in {'linear', 'mlp'} or device != 'cpu':
        raise ValueError('only linear/mlp on cpu are supported')
    if not isinstance(epochs, int) or isinstance(epochs, bool) or not 1 <= epochs <= 10000:
        raise ValueError('invalid epochs')
    if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed <= 0xFFFFFFFF:
        raise ValueError('invalid training seed')
    data = load_labels(labels)
    feature_engine = data['header'].get('featureEngine') or data['header'].get('featureEncoder', {}).get('engine', 'learned-value-v1')
    if feature_engine not in {'learned-value-v1', 'learned-context-v1', 'learned-context-v2'}:
        raise ValueError('unknown feature engine')
    train_rows = [r for r in data['rows'] if r['split'] == 'train']
    val_rows = [r for r in data['rows'] if r['split'] == 'validation']
    if not train_rows or not val_rows:
        raise ValueError('empty training/validation split')
    torch.set_num_threads(1)
    torch.manual_seed(seed)
    torch.use_deterministic_algorithms(True)
    x_train = torch.tensor([r['features'] for r in train_rows], dtype=torch.float64)
    y_train = torch.tensor([r['teacherValue'] for r in train_rows], dtype=torch.float64).reshape(-1, 1)
    x_val = torch.tensor([r['features'] for r in val_rows], dtype=torch.float64)
    y_val = torch.tensor([r['teacherValue'] for r in val_rows], dtype=torch.float64).reshape(-1, 1)
    input_dim = x_train.shape[1]
    means = x_train.mean(dim=0)
    scales = x_train.std(dim=0, correction=0)
    scales = torch.where(scales < 1e-8, torch.ones_like(scales), scales)
    normalized_train, normalized_val = (x_train - means) / scales, (x_val - means) / scales
    model = nn.Sequential(nn.Linear(input_dim, 1)) if architecture == 'linear' else nn.Sequential(
        nn.Linear(input_dim, 64), nn.ReLU(), nn.Linear(64, 1))
    model = model.double()
    with torch.no_grad():
        model[-1].bias.fill_(float(y_train.mean()))
    optimizer = torch.optim.Adam(model.parameters(), lr=.01, weight_decay=.001)
    best_loss, best_epoch, best_state = math.inf, 0, None
    for epoch in range(1, epochs + 1):
        optimizer.zero_grad()
        loss = torch.mean((model(normalized_train) - y_train) ** 2)
        if not torch.isfinite(loss):
            raise ValueError('nonfinite training loss')
        loss.backward()
        optimizer.step()
        with torch.no_grad():
            validation_loss = float(torch.mean((model(normalized_val) - y_val) ** 2))
        if not math.isfinite(validation_loss):
            raise ValueError('nonfinite validation loss')
        if validation_loss < best_loss:
            best_loss, best_epoch = validation_loss, epoch
            best_state = {name: value.detach().clone() for name, value in model.state_dict().items()}
    model.load_state_dict(best_state)
    with torch.no_grad():
        train_predictions = model(normalized_train).flatten()
        val_predictions = model(normalized_val).flatten()
        train_mse = float(torch.mean((train_predictions - y_train.flatten()) ** 2))
        val_mse = float(torch.mean((val_predictions - y_val.flatten()) ** 2))
    metrics = dict(trainMSE=train_mse, validationMSE=val_mse,
                   trainMeanBaselineMSE=float(torch.mean((y_train - y_train.mean()) ** 2)),
                   validationMeanBaselineMSE=float(torch.mean((y_val - y_train.mean()) ** 2)),
                   trainRanking=ranking_metrics(train_rows, train_predictions.tolist()),
                   validationRanking=ranking_metrics(val_rows, val_predictions.tolist()))
    layers = []
    linear_layers = [module for module in model if isinstance(module, nn.Linear)]
    for index, module in enumerate(linear_layers):
        weights, bias = module.weight.detach().clone(), module.bias.detach().clone()
        if index == 0:
            weights = weights / scales
            bias = bias - weights @ means
        layers.append(dict(weights=weights.tolist(), bias=bias.tolist(),
                           activation='relu' if index < len(linear_layers) - 1 else 'linear'))
    cases = [[0.0] * input_dim, [1.0] * input_dim, [-1.0] * input_dim, [(i % 3 - 1) * .5 for i in range(input_dim)],
             *[r['features'] for r in train_rows[:2]], *[r['features'] for r in val_rows[:2]]]
    with torch.no_grad():
        expected = model((torch.tensor(cases, dtype=torch.float64) - means) / scales).flatten().tolist()
    split = dict(trainGroups=sorted(g for g, v in data['groups'].items() if v['split'] == 'train'),
                 validationGroups=sorted(g for g, v in data['groups'].items() if v['split'] == 'validation'),
                 trainLabels=len(train_rows), validationLabels=len(val_rows))
    report = dict(architecture=architecture, epochs=epochs, selectedEpoch=best_epoch, seed=seed, device=device,
                  optimizer=dict(name='Adam', learningRate=.01, weightDecay=.001), metrics=metrics, split=split,
                  normalization=dict(fitOn='train-deal-groups-only', mean=means.tolist(), scale=scales.tolist()))
    engine_suffix = '-context-v2' if feature_engine == 'learned-context-v2' else ('-context' if feature_engine == 'learned-context-v1' else '')
    model_id = f'learning-{architecture}-{len(data["rows"])}-{seed}' + engine_suffix
    payload = dict(schema='guandan-candidate-v1', id=model_id, layers=layers,
                   metadata=dict(status='experimental_unvalidated', labelKind='teacher_estimate',
                                 featureEngine=feature_engine, featureEncoder=data['header'].get('featureEncoder'),
                                 generatedAt=datetime.now(timezone.utc).isoformat(), torchVersion=torch.__version__,
                                 trainingSeedManifest=data['header']['dataset']['seedManifest'],
                                 trainingData=dict(path=str(Path(labels).resolve()), sha256=data['sha256'],
                                                   schema=LABEL_SCHEMA, seedManifest=data['header']['dataset']['seedManifest']),
                                 sourceDataset=data['header']['dataset'], teacher=data['header']['teacher'],
                                 trainingReport=report,
                                 parityCases=[dict(features=features, expected=value) for features, value in zip(cases, expected)]))
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(payload, stream, ensure_ascii=False, allow_nan=False, indent=2)
        stream.write('\n')
    return dict(ok=True, output=str(output.resolve()), modelSha256=digest(output.read_bytes()), **report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--labels', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--architecture', choices=['linear', 'mlp'], default='mlp')
    parser.add_argument('--epochs', type=int, default=100)
    parser.add_argument('--seed', type=int, default=1)
    parser.add_argument('--device', choices=['cpu'], default='cpu')
    args = parser.parse_args()
    print(json.dumps(train_model(**vars(args)), ensure_ascii=False, allow_nan=False, indent=2))


if __name__ == '__main__':
    main()
