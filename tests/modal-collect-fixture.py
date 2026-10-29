# SPDX-License-Identifier: Apache-2.0
"""Mock streams/status RPCs: no SDK, credentials, or network."""
import asyncio
import json
from pathlib import Path
import sys
import types
import unittest

sys.path.insert(0, str(Path('scripts/modal-check').resolve()))
import collect


class Sandbox:
    def __init__(self, mode='complete', code=0):
        self.mode, self.code, self.terminations = mode, code, 0
        self.poll = types.SimpleNamespace(aio=self.status)
        self.terminate = types.SimpleNamespace(aio=self.stop)
    @property
    def stdout(self):
        async def lines():
            yield 'synthetic output\n'
            for seconds in getattr(self, 'usage', []):
                yield '__FORGE_USAGE__' + json.dumps(dict(seconds=seconds)) + '\n'
            if self.mode == 'broken': raise ConnectionError('secret provider diagnostics')
            if self.mode in ['silent', 'ended', 'unknown', 'unacknowledged']:
                await asyncio.Event().wait()
        return lines()
    @property
    def stderr(self):
        async def lines():
            if False: yield ''
        return lines()
    async def status(self):
        if self.mode == 'unknown': await asyncio.Event().wait()
        return self.code if self.mode in ['complete', 'ended'] else None
    async def stop(self, *, wait):
        assert wait is True
        self.terminations += 1
        if self.mode == 'unknown': await asyncio.Event().wait()
        return None if self.mode == 'unacknowledged' else 137


class CollectionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.original = collect.POLL_SECONDS, collect.RPC_SECONDS, collect.QUIET_SECONDS
        collect.POLL_SECONDS, collect.RPC_SECONDS, collect.QUIET_SECONDS = .001, .02, .01
        self.addCleanup(self.restore)
        self.events, self.saved, self.observations = [], [], []
        self.item = dict(id='sb-synthetic', index=2, started=0)
    def restore(self):
        collect.POLL_SECONDS, collect.RPC_SECONDS, collect.QUIET_SECONDS = self.original
    def emit(self, kind, **values): self.events.append(dict(kind=kind, **values))
    async def run_collect(self, first, replacement):
        async def observe(identity):
            self.observations.append(identity)
            return replacement
        return await asyncio.wait_for(collect.collect(first, self.item, observe=observe,
            emit=self.emit, persist=lambda: self.saved.append(dict(self.item)), cancelled=lambda: False), 1)

    async def test_completed_shard_persisted_before_siblings_finish(self):
        sandbox = Sandbox(code=7)
        self.assertFalse(await self.run_collect(sandbox, sandbox))
        self.assertEqual(self.saved[-1]['exitCode'], 7)
        self.assertEqual(self.observations, [])
        self.assertEqual(sandbox.terminations, 0)

    async def test_worker_runtime_survives_collection_and_rejects_invalid_quantities(self):
        sandbox = Sandbox()
        sandbox.usage = [12.5, -1, 'invalid', float('nan')]
        self.assertFalse(await self.run_collect(sandbox, sandbox))
        self.assertEqual(self.item['seconds'], 12.5)
        self.assertTrue(any(item.get('seconds') == 12.5 for item in self.saved))

    async def test_broken_stream_reconnects_same_id_without_repeating_command(self):
        self.assertFalse(await self.run_collect(Sandbox('broken'), Sandbox()))
        self.assertEqual(self.observations, ['sb-synthetic'])
        self.assertEqual(sum(e['kind'] == 'log' for e in self.events), 1)
        self.assertEqual(self.item['exitCode'], 0)
        self.assertNotIn('secret', str(self.events))

    async def test_failed_process_with_broken_stream_is_not_retried(self):
        sandbox = Sandbox('broken')
        async def failed(): return 7
        sandbox.poll.aio = failed
        self.assertFalse(await self.run_collect(sandbox, sandbox))
        self.assertEqual(self.item['exitCode'], 7)
        self.assertEqual(sandbox.terminations, 0)

    async def test_natural_failure_racing_with_termination_is_not_retried(self):
        sandbox = Sandbox('silent')
        async def failed(**kwargs): return 7
        sandbox.terminate.aio = failed
        self.assertFalse(await self.run_collect(sandbox, sandbox))
        self.assertEqual(self.item['exitCode'], 7)
        self.assertNotIn('stopped', self.item)

    async def test_silent_running_shard_retries_only_after_confirmed_stop(self):
        sandbox = Sandbox('silent')
        self.assertTrue(await self.run_collect(sandbox, sandbox))
        self.assertEqual(sandbox.terminations, 1)
        self.assertIn('stopped', self.saved[-1])
        self.assertNotIn('exitCode', self.item)

    async def test_process_failure_is_never_retried_when_log_eof_is_missing(self):
        sandbox = Sandbox('ended', code=7)
        self.assertFalse(await self.run_collect(sandbox, sandbox))
        self.assertEqual(self.item['exitCode'], 7)
        self.assertEqual(sandbox.terminations, 0)

    async def test_exit_without_log_eof_is_not_successful_evidence(self):
        sandbox = Sandbox('ended')
        self.assertTrue(await self.run_collect(sandbox, sandbox))
        self.assertNotIn('exitCode', self.item)

    async def test_unconfirmed_termination_never_authorizes_retry(self):
        sandbox = Sandbox('unknown')
        with self.assertRaises((TimeoutError, asyncio.TimeoutError)): await self.run_collect(sandbox, sandbox)
        self.assertNotIn('stopped', self.item)
        self.assertNotIn('exitCode', self.item)

    async def test_termination_without_exit_confirmation_never_authorizes_retry(self):
        sandbox = Sandbox('unacknowledged')
        with self.assertRaises((TimeoutError, asyncio.TimeoutError)): await self.run_collect(sandbox, sandbox)
        self.assertNotIn('stopped', self.item)
        self.assertFalse(await collect.stop_all([sandbox]))

    async def test_completed_execution_adoption_never_recollects(self):
        self.item.update(exitCode=0, ended=1)
        self.assertFalse(await self.run_collect(Sandbox('unknown'), Sandbox('unknown')))
        self.assertEqual(self.observations, [])

    async def test_cancel_never_retries(self):
        sandbox = Sandbox('silent')
        with self.assertRaisesRegex(RuntimeError, 'Cancelled'):
            await collect.collect(sandbox, self.item, observe=None, emit=self.emit,
                persist=lambda: None, cancelled=lambda: True)
        self.assertEqual(sandbox.terminations, 1)
        self.assertNotIn('stopped', self.item)

if __name__ == '__main__': unittest.main()
