# SPDX-License-Identifier: Apache-2.0
"""Offline SDK stub: never imports Modal or discovers account configuration."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
import sys
import threading
import types

runtime = 'a' * 64
os.environ.update({
    'FORGE_SOURCE_IMAGE': 'synthetic@sha256:' + runtime,
    'FORGE_SOURCE_RUNTIME': runtime,
    'FORGE_SOURCE_WORKER': 'forge-source-state-v1',
    'FORGE_SOURCE_BRIDGE_TOKEN': 'synthetic-token',
})
counts = {'reserves': 0, 'lookups': 0, 'spawns': 0}
lock = threading.Lock()
records = {}


class App:
    def __init__(self, *args):
        pass

    def function(self, **kwargs):
        assert kwargs.get('retries') == 0
        assert kwargs.get('min_containers', 0) == 0
        return lambda function: function


sys.modules['modal'] = types.SimpleNamespace(
    __version__='1.6.2', App=App,
    Image=types.SimpleNamespace(from_registry=lambda image: image),
    Secret=types.SimpleNamespace(from_name=lambda name: name),
    asgi_app=lambda: lambda function: function,
    current_function_call_id=lambda: 'fc-worker')
spec = importlib.util.spec_from_file_location('source_bridge', sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
sys.dont_write_bytecode = True
spec.loader.exec_module(bridge)


def control(action, request):
    value = request['input']
    key, bound = value['dispatchKey'], bridge.canonical(value)
    with lock:
        saved = records.get(key)
        if saved and saved['input'] != bound:
            raise ValueError('pins changed')
        if action == 'provider-reserve':
            counts['reserves'] += 1
            if saved:
                return {'create': False, 'executionId': saved.get('executionId')}
            records[key] = {'input': bound, 'token': request['token']}
            return {'create': True, 'executionId': None}
        if action == 'provider-created':
            assert saved['token'] == request['token']
            saved['executionId'] = request['executionId']
            return request['executionId']
        assert action == 'provider-lookup'
        counts['lookups'] += 1
        if not saved:
            return {'status': 'empty', 'authoritative': True}
        if saved.get('executionId'):
            return {'status': 'found', 'executionId': saved['executionId']}
        return {'status': 'unknown'}


bridge.control = control
value = {'dispatchKey': 'b' * 64, 'provider': 'modal',
         'worker': 'forge-source-state-v1', 'runtime': runtime,
         'projectId': 'synthetic', 'inputDigest': 'c' * 64}


def spawn(argument):
    with lock:
        counts['spawns'] += 1
        assert argument['dispatchKey'] in records
    return types.SimpleNamespace(object_id='fc-original')


bridge.source_worker.spawn = spawn
assert bridge.handle('lookup', value)['result'] == {'status': 'empty', 'authoritative': True}
with ThreadPoolExecutor(max_workers=4) as pool:
    replies = list(pool.map(lambda _: bridge.handle('dispatch', value), range(8)))
assert any(reply['result'].get('executionId') == 'fc-original' for reply in replies)
assert bridge.handle('lookup', value)['result'] == {'status': 'found', 'executionId': 'fc-original'}
assert counts['spawns'] == 1
try:
    bridge.handle('dispatch', dict(value, inputDigest='d' * 64))
    raise AssertionError('changed pins accepted')
except ValueError:
    pass
assert counts['spawns'] == 1

# Ambiguous paid create: reservation persists, then signed callback binds ID.
uncertain = dict(value, dispatchKey='e' * 64)


def lost(argument):
    spawn(argument)
    raise RuntimeError('lost paid-create reply')


bridge.source_worker.spawn = lost
assert bridge.handle('dispatch', uncertain)['result']['status'] == 'unknown'
assert bridge.handle('lookup', uncertain)['result']['status'] == 'unknown'
assert bridge.handle('dispatch', uncertain)['result']['status'] == 'unknown'
assert counts['spawns'] == 2
records[uncertain['dispatchKey']]['executionId'] = 'fc-recovered'
assert bridge.handle('lookup', uncertain)['result']['executionId'] == 'fc-recovered'
assert counts['spawns'] == 2

# Crash after reserve and before spawn stays unknown, never inferred empty.
before_spawn = dict(value, dispatchKey='f' * 64)
control('provider-reserve', {'input': before_spawn, 'token': 'synthetic'})
assert bridge.handle('dispatch', before_spawn)['result']['status'] == 'unknown'
assert bridge.handle('lookup', before_spawn)['result']['status'] == 'unknown'
assert counts['spawns'] == 2


async def unauthorized():
    sent = []
    async def receive():
        raise AssertionError('must not read unauthorized input')
    async def send(event):
        sent.append(event)
    await bridge.bridge()({'type': 'http', 'method': 'POST', 'headers': []}, receive, send)
    assert sent[0]['status'] == 401


asyncio.run(unauthorized())

# Fixed process receives only selected control configuration.
for name in ('FORGE_SOURCE_CONTROL_URL', 'FORGE_SOURCE_CONTROL_TOKEN',
             'FORGE_SOURCE_CALLBACK_KEY', 'FORGE_SOURCE_HEARTBEAT_MS'):
    os.environ[name] = 'synthetic'
os.environ['UNRELATED_SECRET'] = 'never-forward'
called = []


def run(command, **kwargs):
    called.append(command)
    assert command == ['/usr/local/bin/node', '/opt/forge/scripts/modal-source/worker.mjs']
    assert kwargs['cwd'] == '/tmp'
    assert 'UNRELATED_SECRET' not in kwargs['env']
    assert 'FORGE_SOURCE_BRIDGE_TOKEN' not in kwargs['env']
    assert kwargs['env']['FORGE_SOURCE_EXECUTION_ID'] == 'fc-worker'
    return types.SimpleNamespace(returncode=0)


bridge.subprocess.run = run
bridge.source_worker(value)
assert len(called) == 1
print(json.dumps(counts))
