# SPDX-License-Identifier: Apache-2.0
"""Synthetic Modal transport contract. No credentials or network."""
import asyncio
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest

class AuthError(Exception): pass
class ResourceExhaustedError(Exception): pass
class ConnectionError(Exception): pass

class Image:
    object_id = 'im-fixture'
    def __getattr__(self, _):
        return lambda *args, **kwargs: self

class App:
    active = False
    def __init__(self, *_): pass
    @contextlib.contextmanager
    def run(self, **kwargs):
        assert kwargs == {'detach': True}
        App.active = True
        try: yield self
        finally: App.active = False

class Dual:
    def __init__(self, function): self.function = function
    def __call__(self, *args, **kwargs): return self.function(*args, **kwargs)
    async def aio(self, *args, **kwargs): return self.function(*args, **kwargs)


class Sandbox:
    created = 0
    observed = 0
    fail = None
    failures = []
    exit_code = 0
    exit_codes = []
    options = []
    collected = 0
    object_id = 'sb-fixture'
    returncode = 0
    @property
    def stdout(self):
        async def lines():
            yield 'synthetic output\n'
        return lines()
    @property
    def stderr(self):
        async def lines():
            if False: yield ''
        return lines()
    @classmethod
    def create(cls, *args, **kwargs):
        cls.created += 1
        cls.options.append(kwargs)
        assert 'secrets' not in kwargs and 'volumes' not in kwargs
        assert 'MODAL_TOKEN_SECRET' not in kwargs['env']
        if cls.failures: raise cls.failures.pop(0)
        if cls.fail: raise cls.fail
        sandbox = cls()
        sandbox.new = True
        sandbox.exit_code = cls.exit_codes.pop(0) if cls.exit_codes else cls.exit_code
        return sandbox
    @classmethod
    def from_id(cls, identity):
        cls.observed += 1
        assert identity == 'sb-fixture'
        return cls()
    def wait(self, **_):
        if getattr(self, 'new', False):
            assert App.active, 'App closed before test process completed'
        self.returncode = self.exit_code
        Sandbox.collected += 1
    @property
    def poll(self):
        def poll():
            if not getattr(self, 'polled', False): self.wait()
            self.polled = True
            return self.returncode
        return Dual(poll)
    @property
    def terminate(self): return Dual(lambda **kwargs: 137)

Sandbox.from_id = Dual(Sandbox.from_id)

sdk = types.SimpleNamespace(__version__='1.6.2', App=App, Sandbox=Sandbox,
    Image=types.SimpleNamespace(from_registry=lambda *_: Image(), from_id=lambda *_: Image()),
    exception=types.SimpleNamespace(AuthError=AuthError, ResourceExhaustedError=ResourceExhaustedError))
sys.modules['modal'] = sdk
sys.path.insert(0, str(Path('scripts/modal-check').resolve()))
spec = importlib.util.spec_from_file_location('bridge', 'scripts/modal-check/runner.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name)
        self.source = self.output / 'source'
        self.source.mkdir()
        (self.source / 'fixture.txt').write_text('synthetic\n')
        state = json.dumps({'files': [{'path': 'fixture.txt', 'blob': hashlib.sha256(b'synthetic\n').hexdigest()}]}).encode()
        (self.output / 'modal-state.json').write_bytes(state)
        self.plan = dict(source=str(self.source), output=str(self.output), pin='pin-fixture',
            head=hashlib.sha256(state).hexdigest(), definition='definition-fixture',
            lockfile=hashlib.sha256(b'').hexdigest(), groups=[], standard=False, interaction=False,
            runtime='fixture;static-memory:8192;static-oom-retry:16384;',
            selection={'scope': 'full', 'tests': []}, command=['node', '-e', 'console.log(1)'])
        self.plan_file = self.output / 'modal-plan.json'
        self.plan_file.write_text(json.dumps(self.plan))
        Sandbox.created = Sandbox.observed = 0
        Sandbox.fail = None
        Sandbox.failures = []
        Sandbox.exit_code = Sandbox.collected = 0
        Sandbox.exit_codes = []
        Sandbox.options = []

    def run_bridge(self):
        sys.argv = ['runner.py', str(self.plan_file)]
        output = io.StringIO()
        with contextlib.redirect_stdout(output): bridge.main()
        return [json.loads(line) for line in output.getvalue().splitlines()]

    def test_exact_export_and_remote_id_adoption(self):
        events = self.run_bridge()
        self.assertEqual(events[-1]['kind'], 'result')
        self.assertEqual(events[-1]['head'], self.plan['head'])
        self.assertEqual(Sandbox.created, 1)
        cost = events[-1]['estimatedCostUsd']
        events = self.run_bridge()
        self.assertEqual(Sandbox.created, 1)
        self.assertEqual(Sandbox.observed, 1)
        self.assertEqual(events[-1]['estimatedCostUsd'], cost)

    def test_app_lifetime_covers_all_shards_and_preserves_process_failure(self):
        self.plan['groups'] = [['synthetic-a'], ['synthetic-b']]
        self.plan_file.write_text(json.dumps(self.plan))
        Sandbox.exit_code = 7
        events = self.run_bridge()
        self.assertEqual(Sandbox.collected, 3)
        self.assertFalse(App.active)
        self.assertEqual(events[-1]['exitCode'], 7)
        self.assertIn('Shard 2: exit 7', events[-1]['details'])
        self.assertEqual([(e['index'], e['attempt']) for e in events if e['kind'] == 'execution'],
                         [(0, 0), (1, 0), (2, 0)])
        self.assertEqual([(e['index'], e['exitCode']) for e in events[-1]['executions']],
                         [(0, 7), (1, 7), (2, 7)])
        journal = json.loads((self.output / 'modal-executions.json').read_text())
        self.assertTrue(all(item['exitCode'] == 7 for item in journal['executions']))

    def test_retry_retains_completed_shards_and_only_recreates_missing_standard_job(self):
        self.plan.update(standard=True, groups=[['synthetic-a'], ['synthetic-b']])
        self.plan['selection']['scope'] = 'docs'
        self.plan_file.write_text(json.dumps(self.plan))
        original = bridge.collect_all
        rounds = []
        async def collect(pairs, **options):
            rounds.append([item['index'] for _, item in pairs])
            if len(rounds) == 1:
                for _, item in pairs:
                    if item['index'] == 1: item['stopped'] = item['started'] + 1
                    else: item.update(ended=item['started'] + 1, exitCode=0)
                options['persist']()
                return [False, True, False]
            self.assertEqual(Sandbox.created, 4)
            self.assertEqual(len(pairs), 1)
            item = pairs[0][1]
            self.assertEqual(item['attempt'], 1)
            item.update(ended=item['started'] + 1, exitCode=0)
            options['persist']()
            return [False]
        bridge.collect_all = collect
        try: events = self.run_bridge()
        finally: bridge.collect_all = original
        self.assertEqual(rounds, [[0, 1, 2], [1]])
        self.assertEqual(events[-1]['kind'], 'result')
        self.assertEqual(events[-1]['exitCode'], 0)
        self.assertEqual(events[-1]['estimatedCostUsd'], 4 * bridge.allocation_rate({}))
        journal = json.loads((self.output / 'modal-executions.json').read_text())
        self.assertEqual([item['index'] for item in journal['executions']], [0, 1, 2, 1])
        self.assertEqual(sum('Retrying only shard 1' in e.get('message', '') for e in events), 1)

    def test_repeated_collection_stall_falls_back_after_one_modal_shard_retry(self):
        self.plan.update(standard=True)
        self.plan['selection']['scope'] = 'docs'
        self.plan_file.write_text(json.dumps(self.plan))
        original = bridge.collect_all
        async def collect(pairs, **options):
            for _, item in pairs: item['stopped'] = item['started'] + 1
            options['persist']()
            return [True for _ in pairs]
        bridge.collect_all = collect
        try: events = self.run_bridge()
        finally: bridge.collect_all = original
        self.assertEqual(Sandbox.created, 2)
        self.assertEqual(events[-1]['category'], 'network')
        self.assertTrue(events[-1]['safeFallback'])

    def test_unknown_replacement_creation_never_repeats_or_falls_back(self):
        self.plan.update(standard=True)
        self.plan['selection']['scope'] = 'docs'
        self.plan_file.write_text(json.dumps(self.plan))
        original = bridge.collect_all
        async def collect(pairs, **options):
            for _, item in pairs: item['stopped'] = item['started'] + 1
            options['persist']()
            Sandbox.fail = ConnectionError('secret network response lost')
            return [True for _ in pairs]
        bridge.collect_all = collect
        try: events = self.run_bridge()
        finally: bridge.collect_all = original
        self.assertEqual(Sandbox.created, 2)
        self.assertEqual(events[-1]['category'], 'network')
        self.assertFalse(events[-1]['safeFallback'])
        self.assertNotIn('secret', str(events))

    def standard(self, groups=None, scope='full'):
        self.plan.update(standard=True, groups=groups or [], interaction=False)
        self.plan['selection']['scope'] = scope
        self.plan_file.write_text(json.dumps(self.plan))

    def test_static_allocation_heap_and_cost(self):
        self.standard([['synthetic']])
        events = self.run_bridge()
        self.assertEqual([x['memory'] for x in Sandbox.options], [(4096, 4096), (8192, 8192)])
        self.assertNotIn('NODE_OPTIONS', Sandbox.options[0]['env'])
        self.assertEqual(Sandbox.options[1]['env']['NODE_OPTIONS'], '--max-old-space-size=3072')
        self.assertEqual(Sandbox.options[1]['env']['FORGE_STATIC_WORKERS'], '2')
        journal = json.loads((self.output / 'modal-executions.json').read_text())
        expected = sum((x['ended'] - x['started']) * bridge.allocation_rate(x) for x in journal['executions'])
        self.assertEqual(events[-1]['estimatedCostUsd'], expected)
        self.assertAlmostEqual(bridge.allocation_rate({'memory': 8192}) - bridge.allocation_rate({}), 0.00002668)

    def test_static_oom_retries_once_and_adopts_both_attempts(self):
        self.standard()
        Sandbox.exit_codes = [137, 0]
        events = self.run_bridge()
        self.assertEqual(events[-1]['exitCode'], 0)
        self.assertIn('out of memory (137)', events[-1]['details'])
        self.assertEqual([x['memory'] for x in Sandbox.options], [(8192, 8192), (16384, 16384)])
        cost = events[-1]['estimatedCostUsd']
        events = self.run_bridge()
        self.assertEqual(Sandbox.created, 2)
        self.assertEqual(events[-1]['exitCode'], 0)
        self.assertEqual(events[-1]['estimatedCostUsd'], cost)

    def test_repeated_static_oom_remains_failed(self):
        self.standard()
        Sandbox.exit_code = 137
        events = self.run_bridge()
        self.assertEqual(events[-1]['exitCode'], 137)
        self.assertEqual(Sandbox.created, 2)
        self.assertIn('out of memory (137)', events[-1]['details'])

    def test_test_shard_failure_is_not_masked_by_static_retry(self):
        self.standard([['synthetic']])
        Sandbox.exit_codes = [7, 137, 0]
        events = self.run_bridge()
        self.assertEqual(events[-1]['exitCode'], 7)
        self.assertEqual(Sandbox.created, 3)
        self.assertEqual([(e['index'], e['attempt'], e['exitCode']) for e in events[-1]['executions']],
                         [(0, 0, 7), (1, 0, 137), (1, 1, 0)])

    def test_docs_and_arbitrary_commands_do_not_retry_oom(self):
        for standard in [False, True]:
            if standard:
                (self.output / 'modal-executions.json').unlink()
                self.standard(scope='docs')
            Sandbox.exit_code = 137
            events = self.run_bridge()
            self.assertEqual(events[-1]['exitCode'], 137)
            self.assertEqual(Sandbox.options[-1]['memory'], (4096, 4096))
        self.assertEqual(Sandbox.created, 2)

    def test_cancelled_retained_oom_does_not_launch_retry(self):
        self.standard()
        self.run_bridge()
        path = self.output / 'modal-executions.json'
        journal = json.loads(path.read_text())
        journal['executions'][0]['exitCode'] = 137
        path.write_text(json.dumps(journal))
        (self.output / 'modal-cancel').write_text('cancel')
        events = self.run_bridge()
        self.assertEqual(Sandbox.created, 1)
        self.assertEqual(events[-1]['exitCode'], 137)

    def test_old_runtime_keeps_pinned_allocation_without_new_retry(self):
        self.standard()
        self.plan['runtime'] = 'fixture;memory:4096;timeout:900'
        self.plan_file.write_text(json.dumps(self.plan))
        Sandbox.exit_code = 137
        events = self.run_bridge()
        self.assertEqual(Sandbox.created, 1)
        self.assertEqual(Sandbox.options[0]['memory'], (4096, 4096))
        self.assertNotIn('NODE_OPTIONS', Sandbox.options[0]['env'])
        self.assertEqual(events[-1]['exitCode'], 137)

    def test_unknown_retry_create_never_repeats(self):
        self.standard()
        Sandbox.exit_code = 137
        original_create = Sandbox.create
        def create(*args, **kwargs):
            if Sandbox.created == 1:
                raise ConnectionError('unknown retry creation')
            return original_create(*args, **kwargs)
        Sandbox.create = create
        try: events = self.run_bridge()
        finally: Sandbox.create = original_create
        self.assertFalse(events[-1]['safeFallback'])
        events = self.run_bridge()
        self.assertEqual(events[-1]['category'], 'unknown')
        self.assertEqual(Sandbox.created, 1)

    def test_completed_oom_can_resume_before_retry_without_repeating_original(self):
        self.standard()
        self.run_bridge()
        path = self.output / 'modal-executions.json'
        journal = json.loads(path.read_text())
        journal['executions'][0]['exitCode'] = 137
        path.write_text(json.dumps(journal))
        events = self.run_bridge()
        self.assertEqual(events[-1]['exitCode'], 0)
        self.assertEqual(Sandbox.created, 2)
        self.assertEqual(Sandbox.observed, 1)

    def test_stall_then_oom_uses_one_retry_and_retains_allocation_and_cost(self):
        self.standard()
        original = bridge.collect_all
        rounds = []
        async def collect(pairs, **options):
            rounds.append(pairs)
            item = pairs[0][1]
            if len(rounds) == 1:
                item['stopped'] = item['started'] + 1
            else:
                item.update(ended=item['started'] + 2, exitCode=137)
            options['persist']()
            return [len(rounds) == 1]
        bridge.collect_all = collect
        try: events = self.run_bridge()
        finally: bridge.collect_all = original
        self.assertEqual(events[-1]['exitCode'], 137)
        self.assertEqual([x['memory'] for x in Sandbox.options], [(8192, 8192)] * 2)
        journal = json.loads((self.output / 'modal-executions.json').read_text())
        self.assertEqual([x['attempt'] for x in journal['executions']], [0, 1])
        self.assertEqual(journal['executions'][1]['retryReason'], 'stall')
        cost = 3 * bridge.allocation_rate({'memory': 8192})
        self.assertEqual(events[-1]['estimatedCostUsd'], cost)
        # Old journals omitted attempt numbers. Retained execution count still
        # consumes the budget on adoption, without recollecting or inflating cost.
        for item in journal['executions']: item.pop('attempt')
        (self.output / 'modal-executions.json').write_text(json.dumps(journal))
        events = self.run_bridge()
        self.assertEqual(Sandbox.created, 2)
        self.assertEqual(events[-1]['exitCode'], 137)
        self.assertEqual(events[-1]['estimatedCostUsd'], cost)

    def test_oom_then_stall_cannot_create_third_attempt(self):
        self.standard()
        original = bridge.collect_all
        rounds = []
        async def collect(pairs, **options):
            rounds.append(pairs)
            item = pairs[0][1]
            if len(rounds) == 1: item.update(ended=item['started'] + 1, exitCode=137)
            else: item['stopped'] = item['started'] + 2
            options['persist']()
            return [len(rounds) == 2]
        bridge.collect_all = collect
        try: events = self.run_bridge()
        finally: bridge.collect_all = original
        self.assertEqual(Sandbox.created, 2)
        self.assertEqual(events[-1]['category'], 'network')
        self.assertTrue(events[-1]['safeFallback'])
        journal = json.loads((self.output / 'modal-executions.json').read_text())
        self.assertEqual(journal['executions'][1]['retryReason'], 'oom')
        expected = bridge.allocation_rate({'memory': 8192}) + 2 * bridge.allocation_rate({'memory': 16384})
        self.assertEqual(events[-1]['estimatedCostUsd'], expected)

    def test_different_shards_can_recover_stall_and_oom_together(self):
        self.standard([['synthetic']])
        original = bridge.collect_all
        rounds = []
        async def collect(pairs, **options):
            rounds.append([item['index'] for _, item in pairs])
            for _, item in pairs:
                if len(rounds) == 1 and item['index'] == 0:
                    item['stopped'] = item['started'] + 1
                else:
                    item.update(ended=item['started'] + 1, exitCode=137 if len(rounds) == 1 else 0)
            options['persist']()
            return [True, False] if len(rounds) == 1 else [False, False]
        bridge.collect_all = collect
        try: events = self.run_bridge()
        finally: bridge.collect_all = original
        self.assertEqual(rounds, [[0, 1], [0, 1]])
        self.assertEqual(events[-1]['exitCode'], 0)
        self.assertEqual([x['memory'] for x in Sandbox.options], [(4096, 4096), (8192, 8192), (4096, 4096), (16384, 16384)])
        journal = json.loads((self.output / 'modal-executions.json').read_text())
        self.assertEqual([x['attempt'] for x in journal['executions']], [0, 0, 1, 1])
        expected = sum(bridge.allocation_rate(x) for x in journal['executions'])
        self.assertEqual(events[-1]['estimatedCostUsd'], expected)

    def test_failed_test_shard_retries_once_same_image_and_keeps_completed_sibling(self):
        self.standard([['synthetic']])
        self.plan['runtime'] += 'flake-retry:1;resume:1;'
        self.plan_file.write_text(json.dumps(self.plan))
        Sandbox.exit_codes = [7, 0, 0]
        events = self.run_bridge()
        self.assertEqual(events[-1]['exitCode'], 0)
        self.assertEqual(Sandbox.created, 3)
        journal = json.loads((self.output / 'modal-executions.json').read_text())
        self.assertEqual([(item['index'], item['attempt']) for item in journal['executions']], [(0, 0), (1, 0), (0, 1)])
        self.assertEqual(journal['executions'][-1]['retryReason'], 'flake')
        self.assertTrue(all(options['image'].object_id == journal['image'] for options in Sandbox.options))
        self.run_bridge()
        self.assertEqual(Sandbox.created, 3)

    def test_repeated_test_failure_does_not_retry_forever(self):
        self.standard([['synthetic']])
        self.plan['runtime'] += 'flake-retry:1;resume:1;'
        self.plan_file.write_text(json.dumps(self.plan))
        Sandbox.exit_codes = [7, 0, 7]
        events = self.run_bridge()
        self.assertEqual(events[-1]['exitCode'], 7)
        self.assertEqual(Sandbox.created, 3)
        self.run_bridge()
        self.assertEqual(Sandbox.created, 3)

    def test_test_oom_retry_is_infrastructure_and_cannot_stack_with_flake_retry(self):
        self.standard([['synthetic']])
        self.plan['runtime'] += 'flake-retry:1;resume:1;'
        self.plan_file.write_text(json.dumps(self.plan))
        Sandbox.exit_codes = [137, 0, 137]
        events = self.run_bridge()
        self.assertEqual(events[-1]['exitCode'], 137)
        self.assertIn('out of memory (137)', events[-1]['details'])
        self.assertEqual(Sandbox.created, 3)
        self.assertEqual(Sandbox.options[-1]['memory'], (16384, 16384))
        self.assertEqual(events[-1]['executions'][0]['infrastructure'], 'oom')
        journal = json.loads((self.output / 'modal-executions.json').read_text())
        self.assertEqual(journal['executions'][-1]['retryReason'], 'oom')
        self.run_bridge()
        self.assertEqual(Sandbox.created, 3)

    def test_flake_retry_then_oom_cannot_stack(self):
        self.standard([['synthetic']])
        self.plan['runtime'] += 'flake-retry:1;resume:1;'
        self.plan_file.write_text(json.dumps(self.plan))
        Sandbox.exit_codes = [1, 0, 137]
        events = self.run_bridge()
        self.assertEqual(events[-1]['exitCode'], 137)
        self.assertEqual(Sandbox.created, 3)
        self.run_bridge()
        self.assertEqual(Sandbox.created, 3)

    def test_network_resume_reuses_completed_exit_without_observing_or_reexecuting_it(self):
        self.standard([['synthetic-a'], ['synthetic-b']])
        self.plan['runtime'] += 'resume:1;'
        self.plan_file.write_text(json.dumps(self.plan))
        self.run_bridge()
        path = self.output / 'modal-executions.json'
        journal = json.loads(path.read_text())
        completed = dict(journal['executions'][0])
        journal['executions'][1].pop('exitCode')
        journal['executions'][1]['stopped'] = journal['executions'][1]['started'] + 1
        path.write_text(json.dumps(journal))
        events = self.run_bridge()
        self.assertEqual(events[-1]['exitCode'], 0)
        self.assertEqual(Sandbox.created, 4)
        self.assertEqual(Sandbox.observed, 0)
        journal = json.loads(path.read_text())
        self.assertEqual(journal['executions'][0], completed)
        self.assertEqual(journal['executions'][-1]['index'], 1)
        # A different plan cannot use those completed exits.
        journal['pin'] = 'different-view-plan'
        path.write_text(json.dumps(journal))
        with self.assertRaisesRegex(ValueError, 'pin mismatch'):
            self.run_bridge()
        self.assertEqual(Sandbox.created, 4)

    def test_capacity_rejections_queue_without_fallback_or_lost_execution(self):
        Sandbox.failures = [ResourceExhaustedError('concurrency limit reached'),
                            ResourceExhaustedError('Insufficient capacity to create sandbox.')]
        original_sleep = bridge.time.sleep
        bridge.time.sleep = lambda seconds: None if seconds == 1 else original_sleep(seconds)
        try: events = self.run_bridge()
        finally: bridge.time.sleep = original_sleep
        self.assertEqual(Sandbox.created, 3)
        self.assertEqual(Sandbox.collected, 1)
        self.assertEqual(events[-1]['exitCode'], 0)
        self.assertEqual(sum(event.get('message') == 'Waiting for Modal sandbox capacity' for event in events), 2)

    def test_unrecognized_resource_error_is_not_retried(self):
        Sandbox.fail = ResourceExhaustedError('unknown resource response')
        events = self.run_bridge()
        self.assertEqual(Sandbox.created, 1)
        self.assertEqual(events[-1]['category'], 'execution')
        self.assertFalse(events[-1]['safeFallback'])
        self.assertIn('sandbox creation', events[-1]['details'])

    def test_capacity_wait_observes_cancellation(self):
        Sandbox.fail = ResourceExhaustedError('concurrency limit reached')
        original_sleep = bridge.time.sleep
        def cancel(seconds):
            if seconds == 1: (self.output / 'modal-cancel').write_text('cancel')
            else: original_sleep(seconds)
        bridge.time.sleep = cancel
        try: events = self.run_bridge()
        finally: bridge.time.sleep = original_sleep
        self.assertEqual(Sandbox.created, 1)
        self.assertEqual(events[-1]['kind'], 'error')
        self.assertFalse(events[-1]['safeFallback'])

    def test_recorded_shard_runtime_quantities_ignore_controller_reconnection_and_keep_retries(self):
        executions = [
            dict(id='sb-first', started=0, ended=7200, seconds=30, memory=4096, index=0, attempt=0),
            dict(id='sb-retry', started=7200, ended=14400, seconds=10, memory=16384, index=0, attempt=1),
            dict(id='sb-static', started=0, ended=600, seconds=20, memory=8192, index=1, attempt=0),
        ]
        estimate = bridge.compute_estimate(executions)
        self.assertAlmostEqual(estimate['estimatedCostUsd'],
                               30 * bridge.allocation_rate(executions[0]) +
                               10 * bridge.allocation_rate(executions[1]) +
                               20 * bridge.allocation_rate(executions[2]))
        self.assertEqual([e['cpuCoreSeconds'] for e in estimate['costUsage']], [60, 20, 40])
        self.assertEqual([e['memoryGiBSeconds'] for e in estimate['costUsage']], [120, 160, 160])
        self.assertTrue(all(e['basis'] == 'worker-runtime' for e in estimate['costUsage']))
        self.assertEqual(bridge.compute_estimate(executions), estimate, 'adoption does not add wall time')

    def test_legacy_controller_time_is_bounded_by_sandbox_lifetime_and_labeled(self):
        estimate = bridge.compute_estimate([dict(id='sb-old', started=0, ended=86400)])
        self.assertEqual(estimate['costUsage'][0]['seconds'], 900)
        self.assertEqual(estimate['costUsage'][0]['basis'], 'controller-time')
        self.assertAlmostEqual(estimate['estimatedCostUsd'], 900 * bridge.allocation_rate({}))
        self.assertAlmostEqual(bridge.allocation_rate(dict(cpu=0, memory=0)),
                               0.125 * 0.00003942 + 0.125 * 0.00000667)

    def test_changed_source_is_rejected_before_upload(self):
        (self.source / 'fixture.txt').write_text('changed')
        events = self.run_bridge()
        self.assertEqual(events[-1]['category'], 'execution')
        self.assertFalse(events[-1]['safeFallback'])
        self.assertEqual(Sandbox.created, 0)

    def test_unknown_creation_never_repeats(self):
        (self.output / 'modal-executions.json').write_text(json.dumps(dict(pin='pin-fixture', executions=[], creating=True, complete=False)))
        events = self.run_bridge()
        self.assertEqual(events[-1]['category'], 'unknown')
        self.assertEqual(Sandbox.created, 0)

    def test_auth_network_and_billing_errors_are_redacted(self):
        for error, category in [(AuthError('secret auth'), 'auth'),
                                (ConnectionError('secret network'), 'network'),
                                (ResourceExhaustedError('secret billing exhausted'), 'billing')]:
            journal = self.output / 'modal-executions.json'
            if journal.exists(): journal.unlink()
            Sandbox.fail = error
            events = self.run_bridge()
            terminal = events[-1]
            self.assertEqual(terminal['category'], category)
            self.assertNotIn('secret', json.dumps(events))
            self.assertEqual(terminal['safeFallback'], category != 'network')

if __name__ == '__main__': unittest.main()
