import copy
import importlib.util
from pathlib import Path
import unittest
from test_nighttime_context import CapacityTests, c

spec = importlib.util.spec_from_file_location('probe', Path(__file__).with_name('probe-nighttime-context.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def test_probes_preserve_daytime_engine_weights_and_all_noncontext_arguments(self):
        baseline = c.proposal(*CapacityTests().fixture())
        saved = copy.deepcopy(baseline)
        for target in [65536, 98304, 131072, 163840, 262144]:
            m, compose, catalog = probe.proposal(*baseline, target)
            self.assertEqual(m['services'][0], baseline[0]['services'][0])
            self.assertEqual(compose['services']['coding'], baseline[1]['services']['coding'])
            self.assertEqual(catalog['models'][0], baseline[2]['models'][0])
            self.assertEqual(m['services'][1]['fallback'], baseline[0]['services'][1]['fallback'])
            restored = probe.proposal(m, compose, catalog, 65536)
            self.assertEqual(restored, baseline)
        self.assertEqual(baseline, saved)

    def test_rejects_unbounded_or_misaligned_probe(self):
        baseline = c.proposal(*CapacityTests().fixture())
        for target in [0, 32768, 65537, 300000, '131072', True]:
            with self.assertRaises(ValueError):
                probe.proposal(*baseline, target)


if __name__ == '__main__':
    unittest.main()
