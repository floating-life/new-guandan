import hashlib
import importlib
import json
from pathlib import Path
import tempfile
import unittest

try:
    trainer = importlib.import_module('train_learning_model')
except ModuleNotFoundError:
    trainer = None


def write_fixture(directory, validation_shift=0.0):
    root = Path(directory)
    groups = [dict(dealGroupId=f'g{i}', baseSeed=3100000000 + i,
                   split='train' if i < 2 else 'validation') for i in range(3)]
    states, rows = [], []
    for i, group in enumerate(groups):
        for turn in range(2):
            state = dict(stateId=f'g{i}-t{turn}', dealGroupId=group['dealGroupId'],
                         split=group['split'], level=2, seat=0, priority=f'{i}{turn}')
            states.append(state)
            for candidate in range(2):
                value = i * .2 + turn * .1 + candidate
                features = [value + (validation_shift if i == 2 else 0)] + [0.0] * 31
                rows.append(dict(schema='guandan-learning-labels-v1', labelKind='teacher_estimate',
                                 stateId=state['stateId'], dealGroupId=group['dealGroupId'],
                                 split=group['split'], level=2, seat=0, candidateId=f'c{candidate}',
                                 features=features, teacherValue=.5 + value, completedSamples=2,
                                 terminalCount=0, truncatedCount=2, legalCandidateCount=2,
                                 eligibleCandidateCount=2, retainedCandidateCount=2, cappedCandidateCount=0))
    selection = dict(schema='guandan-learning-selection-v1', datasetSha256='a' * 64,
                     statesPerLevel=6, statesPerGroupLevel=2, groups=groups, states=states)
    selection_path = root / 'labels-selection.json'
    selection_path.write_text(json.dumps(selection) + '\n', encoding='utf-8')
    header = dict(schema='guandan-learning-labels-v1-header', valueSchema='guandan-candidate-v1',
                  labelKind='teacher_estimate', stateCount=6,
                  dataset=dict(path='synthetic-selfplay.jsonl', sha256='a' * 64,
                               schema='guandan-selfplay-trajectory-v3', groups=groups,
                               seedManifest=dict(schema='guandan-seed-manifest-v1', seeds=[g['baseSeed'] for g in groups])),
                  selection=dict(path=str(selection_path), sha256=hashlib.sha256(selection_path.read_bytes()).hexdigest()),
                  teacher=dict(worlds=2, maxPlies=4, learnedModelUsed=False))
    label_path = root / 'labels.jsonl'
    label_path.write_text('\n'.join(json.dumps(row) for row in [header, *rows]) + '\n', encoding='utf-8')
    return label_path


class LearningTrainingTests(unittest.TestCase):
    def test_context_feature_engine_is_bound_to_model(self):
        self.assertIsNotNone(trainer)
        with tempfile.TemporaryDirectory() as folder:
            labels = write_fixture(folder)
            rows = labels.read_text().splitlines()
            header = json.loads(rows[0]); header['featureEncoder'] = {'engine': 'learned-context-v1'}
            rows[0] = json.dumps(header)
            labels.write_text('\n'.join(rows) + '\n', encoding='utf-8')
            output = Path(folder) / 'context.json'
            trainer.train_model(labels, output, epochs=2)
            model = json.loads(output.read_text())
            self.assertEqual(model['metadata']['featureEngine'], 'learned-context-v1')
            self.assertEqual(model['metadata']['featureEncoder'], header['featureEncoder'])

    def test_context_v2_feature_engine_with_dynamic_dimensions(self):
        self.assertIsNotNone(trainer)
        with tempfile.TemporaryDirectory() as folder:
            labels = write_fixture(folder)
            rows = labels.read_text().splitlines()
            header = json.loads(rows[0])
            header['featureEngine'] = 'learned-context-v2'
            # expand fixture rows from 32 to 38 dimensions
            for i in range(1, len(rows)):
                row = json.loads(rows[i])
                row['features'] = row['features'] + [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]
                rows[i] = json.dumps(row)
            rows[0] = json.dumps(header)
            labels.write_text('\n'.join(rows) + '\n', encoding='utf-8')
            output = Path(folder) / 'context-v2.json'
            trainer.train_model(labels, output, epochs=2)
            model = json.loads(output.read_text())
            self.assertEqual(model['metadata']['featureEngine'], 'learned-context-v2')
            self.assertEqual(len(model['layers'][0]['weights'][0]), 38)
            self.assertTrue(model['id'].endswith('-context-v2'))

    def test_seeded_mlp_is_reproducible(self):
        self.assertIsNotNone(trainer)
        with tempfile.TemporaryDirectory() as folder:
            labels = write_fixture(folder)
            first, second = Path(folder) / 'first.json', Path(folder) / 'second.json'
            trainer.train_model(labels, first, architecture='mlp', epochs=15, seed=1)
            trainer.train_model(labels, second, architecture='mlp', epochs=15, seed=1)
            self.assertEqual(json.loads(first.read_text())['layers'], json.loads(second.read_text())['layers'])

    def test_training_uses_only_train_group_statistics(self):
        self.assertIsNotNone(trainer, 'the group-aware trainer must exist')
        with tempfile.TemporaryDirectory() as folder:
            labels = write_fixture(folder, validation_shift=100)
            output = Path(folder) / 'linear.json'
            report = trainer.train_model(labels, output, architecture='linear', epochs=100, seed=1)
            self.assertAlmostEqual(report['normalization']['mean'][0], .65, places=12)
            self.assertLess(report['metrics']['trainMSE'], report['metrics']['trainMeanBaselineMSE'])
            model = json.loads(output.read_text(encoding='utf-8'))
            self.assertEqual(model['metadata']['trainingSeedManifest']['seeds'], [3100000000, 3100000001, 3100000002])
            self.assertEqual(report['split']['trainGroups'], ['g0', 'g1'])
            self.assertEqual(report['split']['validationGroups'], ['g2'])
            before = output.read_bytes()
            with self.assertRaisesRegex(ValueError, 'exists'):
                trainer.train_model(labels, output, epochs=1)
            self.assertEqual(output.read_bytes(), before)

    def test_duplicate_and_mixed_split_labels_are_rejected(self):
        self.assertIsNotNone(trainer)
        with tempfile.TemporaryDirectory() as folder:
            labels = write_fixture(folder)
            lines = labels.read_text(encoding='utf-8').splitlines()
            labels.write_text('\n'.join([*lines, lines[1]]) + '\n', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'duplicate'):
                trainer.load_labels(labels)
            labels = write_fixture(folder)
            lines = labels.read_text(encoding='utf-8').splitlines()
            row = json.loads(lines[1]); row['split'] = 'validation'; lines[1] = json.dumps(row)
            labels.write_text('\n'.join(lines) + '\n', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'split'):
                trainer.load_labels(labels)

    def test_missing_candidate_and_nonfinite_features_rejected(self):
        self.assertIsNotNone(trainer)
        with tempfile.TemporaryDirectory() as folder:
            labels = write_fixture(folder)
            lines = labels.read_text(encoding='utf-8').splitlines()
            labels.write_text('\n'.join(lines[:-1]) + '\n', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'candidate'):
                trainer.load_labels(labels)
            labels = write_fixture(folder)
            lines = labels.read_text(encoding='utf-8').splitlines()
            row = json.loads(lines[1]); row['features'][0] = True; lines[1] = json.dumps(row)
            labels.write_text('\n'.join(lines) + '\n', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'features'):
                trainer.load_labels(labels)


if __name__ == '__main__':
    unittest.main()
