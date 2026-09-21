import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).with_name('deploy-router-only.py'))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class CommittedPublicationTests(unittest.TestCase):
    def identity_fixture(self):
        return {'name': 'existing-stack', 'services': {
            'ai-router': {'container_name': 'local-ai-ollama-router',
                'networks': {'shared': {'aliases': ['client-alias'], 'ipv4_address': '172.20.0.10'},
                    'management': None}, 'volumes': ['durable:/app/data']},
            'backend': {'image': 'unchanged'}}}

    def test_identity_override_preserves_project_and_all_controller_dns_names(self):
        config = self.identity_fixture()
        frozen = json.dumps(config)
        identity = publisher.router_identity(config)
        self.assertEqual(json.dumps(config), frozen)
        self.assertEqual(identity['name'], 'existing-stack')
        self.assertEqual(list(identity['services']), ['ai-router'])
        router = identity['services']['ai-router']
        self.assertEqual(router['container_name'], 'llm-router')
        self.assertEqual(set(router), {'container_name', 'networks'})
        for network in ['shared', 'management']:
            self.assertTrue({'ai-router', 'llm-router', 'local-ai-ollama-router'} <=
                set(router['networks'][network]['aliases']))
        self.assertIn('client-alias', router['networks']['shared']['aliases'])

    def test_custom_previous_hostname_is_retained_and_repeated_rename_is_stable(self):
        config = self.identity_fixture()
        config['services']['ai-router']['container_name'] = 'custom-router'
        identity = publisher.router_identity(config)
        self.assertIn('custom-router', identity['services']['ai-router']['networks']['shared']['aliases'])
        self.assertEqual(publisher.router_identity(identity), identity)

    def test_network_modes_without_dns_aliases_are_rejected(self):
        for changes in [{'network_mode': 'host'}, {'networks': None}, {'networks': {}}]:
            config = self.identity_fixture()
            config['services']['ai-router'].update(changes)
            with self.assertRaisesRegex(RuntimeError, 'preserve controller DNS'):
                publisher.router_identity(config)

    def test_existing_name_must_belong_to_same_compose_service_and_project(self):
        for project, service in [('other-stack', 'ai-router'), ('existing-stack', 'other-service')]:
            container = {'Config': {'Labels': {'com.docker.compose.project': project,
                'com.docker.compose.service': service}}}
            with patch.object(publisher.subprocess, 'check_output', side_effect=['id', json.dumps([container])]):
                with self.assertRaisesRegex(RuntimeError, 'another deployment'):
                    publisher.check_router_identity('existing-stack')

    def test_missing_wrong_image_or_stopped_router_cannot_complete_publication(self):
        with patch.object(publisher.subprocess, 'check_output', return_value=''):
            publisher.check_router_identity('existing-stack')
            with self.assertRaisesRegex(RuntimeError, 'missing'):
                publisher.check_router_identity('existing-stack', 'sha256:reviewed')
        for image, running in [('sha256:other', True), ('sha256:reviewed', False)]:
            container = {'Image': image, 'State': {'Running': running}, 'Config': {'Labels': {
                'com.docker.compose.project': 'existing-stack', 'com.docker.compose.service': 'ai-router'}}}
            with patch.object(publisher.subprocess, 'check_output', side_effect=['id', json.dumps([container])]):
                with self.assertRaisesRegex(RuntimeError, 'reviewed image'):
                    publisher.check_router_identity('existing-stack', 'sha256:reviewed')

    def test_publication_persists_identity_and_keeps_backends_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stack, primary = root / 'stack', root / 'primary'
            stack.mkdir(); primary.mkdir()
            (stack / '.env').write_text('ROUTER_CONTAINER_NAME=local-ai-ollama-router\nKEEP=original\n')
            (stack / 'compose.yaml').write_text('services: {}\n')
            (stack / 'compose.runtime.yaml').write_text('services: {}\n')
            for name in ['runtime-owner.json', 'primary.py', 'model-catalog.json', 'active-model.json']:
                (primary / name).write_text('{}\n')
            controller = Mock(NAMES=['day', 'night'], MARKER=primary / 'active-model.json')
            controller.inspect.side_effect = lambda name: {'Id': name + '-unchanged'}
            container = {'Image': 'sha256:reviewed', 'State': {'Running': True}, 'Config': {'Labels': {
                'com.docker.compose.project': 'existing-stack', 'com.docker.compose.service': 'ai-router'}}}
            outputs = [json.dumps(self.identity_fixture()), '', 'id', json.dumps([container])]
            with patch.object(publisher, 'STACK', stack), patch.object(publisher, 'PRIMARY', primary), \
                    patch.object(publisher, 'reviewed_image', return_value=('revision', 'sha256:reviewed')), \
                    patch.object(publisher, 'controller', return_value=controller), \
                    patch.object(publisher.subprocess, 'check_output', side_effect=outputs), \
                    patch.object(publisher.subprocess, 'run') as run, \
                    patch.object(publisher.urllib.request, 'urlopen') as urlopen, patch('builtins.print'):
                urlopen.return_value.__enter__.return_value.status = 200
                publisher.main()
            identity = json.loads((stack / publisher.IDENTITY_FILE).read_text())
            self.assertEqual(identity['services']['ai-router']['container_name'], 'llm-router')
            self.assertIn('ROUTER_CONTAINER_NAME=llm-router\n', (stack / '.env').read_text())
            self.assertIn('KEEP=original\n', (stack / '.env').read_text())
            command = run.call_args_list[-1].args[0]
            self.assertEqual(command[-6:], ['up', '-d', '--no-deps', '--pull', 'never', 'ai-router'])
            self.assertIn(str(stack / publisher.IDENTITY_FILE), command)
            self.assertEqual([call.args[0] for call in controller.drain.call_args_list], [True, False])
            controller.publish_marker.assert_called_once()
            receipt_path = next((primary / 'corrections').glob('*/deployment.json'))
            receipt = json.loads(receipt_path.read_text())
            self.assertEqual(receipt['container_name'], 'llm-router')
            self.assertEqual(receipt['backend_container_ids_unchanged'],
                {'day': 'day-unchanged', 'night': 'night-unchanged'})

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
