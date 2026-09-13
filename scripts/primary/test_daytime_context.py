"""Guard service isolation, default discovery, and the owner-selected fallback."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('daytime', Path(__file__).with_name('deploy-daytime-context.py'))
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


class DaytimeTests(unittest.TestCase):
    def fixture(self):
        argv = ['--ctx-size', '131072', '--kv-unified-per-slot', '131072',
                '--parallel', '1', '--spec-type', 'draft-mtp', '--spec-draft-n-max', '3',
                '--spec-draft-device', 'CUDA1', '--cache-type-k', 'q8_0',
                '--n-predict', '-1', '--reasoning-budget', '-1', '--reasoning-effort', 'default']
        day = {'role': 'coding', 'model_alias': d.MODEL, 'context_tokens': 131072,
               'parallel_slots': 1, 'recommended_argv': copy.deepcopy(argv)}
        night = {'role': 'everyday', 'context_tokens': 131072, 'accepted_reserve': None}
        manifest = {'engine': 'pinned', 'services': [day, night]}
        compose = {'services': {'coding': {'container_name': 'qwen38-daytime',
            'image': 'pinned', 'command': argv, 'volumes': ['weights', 'mtp', 'projector'],
            'gpu_ids': ['3090', '4080S']}, 'everyday': {'sentinel': 'unchanged'}}}
        row = {'model': d.MODEL, 'context_length': 131072, 'total_context_length': 131072,
               'display_name': 'Daytime (128K)', 'mtp': {'enabled': True}, 'max_output_tokens': None}
        catalog = copy.deepcopy(row) | {'default_model': d.MODEL, 'schema_version': 3,
            'models': [row, {'model': 'night', 'context_length': 131072, 'sentinel': 'unchanged'}]}
        return manifest, compose, catalog

    def test_only_context_and_daytime_label_change(self):
        original = self.fixture()
        frozen = copy.deepcopy(original)
        for target in d.TARGETS:
            m, spec, catalog = d.proposal(*original, target)
            self.assertEqual(m['services'][1], original[0]['services'][1])
            self.assertEqual(spec['services']['everyday'], original[1]['services']['everyday'])
            self.assertEqual(catalog['models'][1], original[2]['models'][1])
            self.assertEqual(catalog['context_length'], target)
            self.assertEqual(catalog['models'][0]['context_length'], target)
            self.assertEqual(catalog['display_name'], f'Daytime ({target // 1024}K)')
            for flag in ['--ctx-size', '--kv-unified-per-slot']:
                argv = spec['services']['coding']['command']
                argv[argv.index(flag) + 1] = '131072'
            self.assertEqual(spec, original[1])
        self.assertEqual(original, frozen)
        self.assertEqual(d.TARGETS, (163840, 147456))

    def test_unapproved_targets_and_policy_drift_rejected(self):
        for target in [155648, 131072, 262144, True, '163840']:
            with self.assertRaises(ValueError):
                d.proposal(*self.fixture(), target)
        for flag in ['--ctx-size', '--kv-unified-per-slot', '--spec-draft-n-max', '--n-predict']:
            m, cfg, catalog = self.fixture()
            cfg['services']['coding']['command'].extend([flag, '1'])
            m['services'][0]['recommended_argv'] = copy.deepcopy(cfg['services']['coding']['command'])
            with self.assertRaises(ValueError):
                d.proposal(m, cfg, catalog, 163840)

    def test_daytime_busy_rejected_nighttime_busy_allowed(self):
        p = Mock()
        state = {'draining': False, 'active_by_model': {'night': 1}, 'queued_by_model': {}}
        p.admin.return_value = {'runtime': state}
        p.http.return_value = [{'is_processing': False}]
        d.require_idle(p)
        for key in ['active_by_model', 'queued_by_model']:
            state[key][d.MODEL] = 1
            with self.assertRaises(RuntimeError):
                d.require_idle(p, backend=False)
            del state[key][d.MODEL]
        p.http.return_value = [{'is_processing': True}]
        with self.assertRaises(RuntimeError):
            d.require_idle(p)
        p.compose.assert_not_called()

    def test_publication_preserves_night_and_updates_root_attestation(self):
        m, cfg, catalog = d.proposal(*self.fixture(), 163840)
        marker = self.fixture()[2]
        night = copy.deepcopy(marker['models'][1])
        p = Mock()
        p.MARKER, p.MANIFEST = 'marker', 'manifest'
        p.read.side_effect = lambda path: marker if path == 'marker' else {'engine': {'revision': 'pinned'}}
        p.now.return_value = 'now'
        p.inspect.return_value = {'Id': 'new-day', 'State': {'StartedAt': 'now'},
                                  'Config': {'Cmd': cfg['services']['coding']['command']}}
        d.publish_daytime(p, catalog)
        actual = p.write.call_args.args[1]
        self.assertEqual(actual['models'][1], night)
        self.assertEqual(actual['context_length'], 163840)
        self.assertEqual(actual['runtime_output_policy']['container_id'], 'new-day')
        self.assertEqual(actual['models'][0]['runtime_output_policy'], actual['runtime_output_policy'])
        p.admin.assert_called_once_with('reload-config', {})

    def test_long_fixture_uses_requested_backend_and_exceeds_previous_context(self):
        p = Mock()
        def http(url, body):
            self.assertTrue(url.startswith(d.BACKEND))
            if url.endswith('/apply-template'):
                self.assertEqual(body['model'], d.MODEL)
                return {'prompt': body['messages'][0]['content']}
            # A deterministic token proxy checks fixture sizing without inference.
            return {'tokens': [0] * (len(body['content']) // 4)}
        p.http.side_effect = http
        for target in d.TARGETS:
            body, expected, count = d.c.long_request(p, target, d.MODEL, d.BACKEND)
            self.assertGreater(count, 131072)
            self.assertLess(count, target * .95)
            self.assertEqual(set(expected), {'ALPHA', 'BRAVO', 'CHARLIE'})
            self.assertNotIn('max_tokens', body)


if __name__ == '__main__':
    unittest.main()
