"""Guard service isolation, capacity truth and busy-request refusal."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
import primary

spec = importlib.util.spec_from_file_location('capacity', Path(__file__).with_name('deploy-nighttime-context.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class CapacityTests(unittest.TestCase):
    def fixture(self):
        argv = ['--ctx-size', '32768', '--parallel', '1', '--kv-unified-per-slot', '32768',
                '--n-predict', '-1', '--reasoning-budget', '-1', '--cache-type-k', 'q8_0']
        night = {'role': 'everyday', 'model_alias': c.MODEL, 'context_tokens': 32768,
            'parallel_slots': 1, 'recommended_argv': copy.deepcopy(argv),
            'fallback': {'context': 32768}, 'qualification_contract': {'runtime': 'One 32768-token slot',
                'capacity': {'allocated_context_tokens': {'coding': 131072, 'everyday': 32768}}}}
        manifest = {'engine': 'pinned', 'services': [{'role': 'coding', 'context_tokens': 131072}, night]}
        compose = {'services': {'coding': {'image': 'day', 'command': ['unchanged']},
            'everyday': {'container_name': 'qwen38-nighttime', 'image': 'night', 'command': argv,
                'volumes': ['weights-ro', 'projector-ro'], 'devices': ['4080', '3080ti']}}}
        catalog = {'model': 'day', 'context_length': 131072, 'models': [{'model': 'day', 'context_length': 131072},
            {'model': c.MODEL, 'context_length': 32768, 'total_context_length': 32768,
                'display_name': 'Nighttime (32K)', 'output_policy': 'unrestricted', 'vision': True}]}
        return manifest, compose, catalog

    def test_capacity_proposal_preserves_daytime_weights_policy_and_fallback(self):
        original = self.fixture()
        frozen = copy.deepcopy(original)
        manifest, compose, catalog = c.proposal(*original)
        self.assertEqual(original, frozen)
        self.assertEqual(manifest['services'][0], original[0]['services'][0])
        self.assertEqual(compose['services']['coding'], original[1]['services']['coding'])
        self.assertEqual(catalog['models'][0], original[2]['models'][0])
        self.assertEqual(catalog['context_length'], 131072)
        self.assertEqual(manifest['services'][1]['fallback'], original[0]['services'][1]['fallback'])
        after = copy.deepcopy(compose['services']['everyday'])
        for flag in ['--ctx-size', '--kv-unified-per-slot']:
            self.assertEqual(after['command'][after['command'].index(flag) + 1], '65536')
            after['command'][after['command'].index(flag) + 1] = '32768'
        self.assertEqual(after, original[1]['services']['everyday'])

    def test_unreviewed_or_ambiguous_capacity_refused(self):
        for flag in ['--ctx-size', '--kv-unified-per-slot']:
            m, cfg, catalog = self.fixture()
            cfg['services']['everyday']['command'].extend([flag, '32768'])
            m['services'][1]['recommended_argv'] = copy.deepcopy(cfg['services']['everyday']['command'])
            with self.assertRaises(ValueError):
                c.proposal(m, cfg, catalog)

    def test_controller_accepts_both_capacities_but_rejects_declared_or_slot_drift(self):
        for capacity in [32768, 65536]:
            m, cfg, catalog = self.fixture()
            if capacity == 65536:
                m, cfg, catalog = c.proposal(m, cfg, catalog)
            with patch.object(primary, 'read', return_value=m):
                self.assertEqual(primary.configured_context('everyday', cfg['services']['everyday']), capacity)
                cfg['services']['everyday']['command'][1] = str(capacity * 2)
                with self.assertRaises(RuntimeError):
                    primary.configured_context('everyday', cfg['services']['everyday'])

    def test_daytime_busy_is_allowed_nighttime_active_queued_or_direct_is_refused(self):
        state = {'draining': False, 'active_by_model': {'day': 1}, 'queued_by_model': {}}
        p = Mock()
        p.admin.return_value = {'runtime': state}
        p.http.return_value = [{'is_processing': False}]
        c.require_idle(p)
        for field in ['active_by_model', 'queued_by_model']:
            state[field][c.MODEL] = 1
            with self.assertRaisesRegex(RuntimeError, 'busy'):
                c.require_idle(p)
            del state[field][c.MODEL]
        p.http.return_value = [{'is_processing': True}]
        with self.assertRaisesRegex(RuntimeError, 'busy'):
            c.require_idle(p)
        p.compose.assert_not_called()
        p.drain.assert_not_called()

    def test_cancelled_slot_exception_requires_exact_task_cancellation_and_zero_output(self):
        slot = {'id_task': 42, 'params': {'n_predict': 0},
                'next_token': [{'n_decoded': 0, 'has_next_token': False}]}
        log = 'timestamp W srv stop: cancel task, id_task = 42\n'
        self.assertTrue(c.cancelled_zero_output_slot(slot, 42, log))
        self.assertFalse(c.cancelled_zero_output_slot(slot, None, log))
        self.assertFalse(c.cancelled_zero_output_slot(slot, 41, log))
        self.assertFalse(c.cancelled_zero_output_slot(slot, 42, log.replace('42', '420')))
        self.assertFalse(c.cancelled_zero_output_slot(slot, 42, ''))
        slot['next_token'][0]['n_decoded'] = 1
        self.assertFalse(c.cancelled_zero_output_slot(slot, 42, log))


if __name__ == '__main__':
    unittest.main()
