import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).with_name('deploy-router-only.py'))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class CommittedPublicationTests(unittest.TestCase):
    def test_managed_runtime_source_is_never_reinstalled(self):
        with patch.object(publisher.shutil, 'copy2') as copy, patch.object(publisher.os, 'replace') as replace:
            publisher.install_runtime_source(Path('/old/controller'), Path('/new/controller'), managed=True)
            copy.assert_not_called()
            replace.assert_not_called()

    def test_managed_router_release_uses_runtime_reservation_and_publication(self):
        with patch.object(publisher.subprocess, 'run') as run:
            controller = publisher.ManagedController()
            controller.drain(True)
            controller.wait_idle()
            controller.publish_marker()
            controller.drain(False)
            self.assertEqual([call.args[0][-1] for call in run.call_args_list],
                ['router-maintenance-begin', 'publish', 'router-maintenance-end'])

    def test_matching_clean_source_and_image_are_required(self):
        revision = 'a' * 40
        image = [{'Id': 'sha256:tested', 'Config': {'Labels': {'org.opencontainers.image.revision': revision}}}]
        with patch.object(publisher.subprocess, 'check_output', side_effect=[revision, '', json.dumps(image)]):
            self.assertEqual(publisher.reviewed_image(), (revision, 'sha256:tested'))

    def test_dirty_source_stops_before_image_or_runtime_work(self):
        with patch.object(publisher.subprocess, 'check_output', side_effect=['a' * 40, ' M src/server.js']) as run:
            with self.assertRaisesRegex(RuntimeError, 'clean checkout'):
                publisher.reviewed_image()
            self.assertEqual(run.call_count, 2)

    def test_mismatched_or_missing_image_revision_is_rejected(self):
        for labels in [None, {}, {'org.opencontainers.image.revision': 'b' * 40}]:
            image = [{'Id': 'sha256:other', 'Config': {'Labels': labels}}]
            with patch.object(publisher.subprocess, 'check_output', side_effect=['a' * 40, '', json.dumps(image)]):
                with self.assertRaisesRegex(RuntimeError, 'image revision'):
                    publisher.reviewed_image()


if __name__ == '__main__':
    unittest.main()
