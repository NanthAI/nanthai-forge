# SPDX-License-Identifier: Apache-2.0
"""Owner-side Modal SDK bridge. Never forwards host environment or SDK diagnostics."""
import asyncio
import contextlib
import hashlib
import json
import os
from pathlib import Path
import sys
import threading
import time

import modal
from collect import collect_all, stop_all
from cost import allocation_rate, compute_estimate

LOCK = threading.Lock()
NODE_IMAGE = 'node:24.22.1-trixie-slim'


def require_current_node(plan):
    if plan.get('runtime', '').split(';', 1)[0] != NODE_IMAGE:
        raise ValueError('Pinned Node runtime cannot start a new execution')

def exit_summary(code):
    return 'out of memory (137)' if code == 137 else 'exit ' + str(code)


def save(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def emit(kind, **values):
    with LOCK:
        print(json.dumps(dict(kind=kind, **values)), flush=True)


def classify(error):
    # Inspect locally; never print provider exception text (which can contain auth headers).
    name = type(error).__name__.lower()
    message = str(error).lower()
    if any(word in message for word in ['billing', 'spending', 'budget', 'credit', 'payment']):
        return 'billing'
    if 'auth' in name or any(word in message for word in ['unauthenticated', 'token missing', 'token not found', 'not authenticated']):
        return 'auth'
    if any(word in name + ' ' + message for word in ['connection', 'timeout', 'unavailable', 'dns', 'network', 'transport']):
        return 'network'
    return 'execution'


def validate(plan):
    source = Path(plan['source'])
    state_bytes = (Path(plan['output']) / 'modal-state.json').read_bytes()
    if hashlib.sha256(state_bytes).hexdigest() != plan['head']:
        raise ValueError('State mismatch')
    state = json.loads(state_bytes)
    expected = {file['path']: file['blob'] for file in state['files']}
    actual = {}
    for path in source.rglob('*'):
        if path.is_symlink():
            raise ValueError('Unexpected symlink')
        if not path.is_file():
            continue
        relative = path.relative_to(source)
        if any(part in ['.git', '.forge', 'node_modules', '.npmrc', '.modal.toml', '.netrc'] or
               (part.startswith('.env') and part != '.env.example') for part in relative.parts):
            raise ValueError('Local configuration stays local')
        actual[relative.as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    lock_hash = actual.get('package-lock.json', hashlib.sha256(b'').hexdigest())
    if actual != expected or lock_hash != plan['lockfile']:
        raise ValueError('Source mismatch')
    return source


def main():
    if modal.__version__ != '1.6.2':
        raise ValueError('Runtime SDK version changed')
    plan = json.loads(Path(sys.argv[1]).read_text())
    output = Path(plan['output'])
    journal_path = output / 'modal-executions.json'
    journal = json.loads(journal_path.read_text()) if journal_path.exists() else {
        'pin': plan['pin'], 'executions': [], 'creating': False, 'complete': False}
    if journal['pin'] != plan['pin']:
        raise ValueError('Execution pin mismatch')
    new_run = not journal_path.exists()
    sandboxes = []
    lifetime = contextlib.ExitStack()
    try:
        if (output / 'modal-cancel').exists() and not journal_path.exists():
            emit('result', pin=plan['pin'], head=plan['head'], definition=plan['definition'], exitCode=1, estimatedCostUsd=0)
            return
        if journal['creating']:
            # Create may have reached the provider. Never issue another create for this run.
            emit('error', category='unknown', safeFallback=False)
            return
        jobs = plan['groups'] + [None]
        static_resources = ';static-memory:8192;' in plan.get('runtime', '')
        resilient = ';resume:1;' in plan.get('runtime', '')
        flaky_retry = ';flake-retry:1;' in plan.get('runtime', '')
        if not journal_path.exists():
            require_current_node(plan)
            source = validate(plan)
            emit('progress', message='Verified exact source; preparing lockfile runtime')
            # Detached ephemeral App: no deployment, endpoint, secrets, volumes or tunnels.
            app = modal.App('forge-check')
            # A normal context exit stops even detached Apps. Keep it alive through collection.
            lifetime.enter_context(app.run(detach=True))
            image = (modal.Image.from_registry(NODE_IMAGE)
                     .apt_install('git', 'ca-certificates', 'procps', 'time', 'python3')
                     .workdir('/repo'))
            if (source / 'package-lock.json').exists():
                image = (image.add_local_file(source / 'package.json', '/repo/package.json', copy=True)
                     .add_local_file(source / 'package-lock.json', '/repo/package-lock.json', copy=True)
                     .run_commands('npm ci --ignore-scripts'))
            image.build(app)
            image = (image.add_local_dir(source, '/repo', copy=True)
                     .add_local_file(output / 'modal-state.json', '/tmp/forge-state.json', copy=True))
            # Verify every source blob before running any source-provided command.
            import shlex
            verify = "const f=require('fs'),c=require('crypto');const b=f.readFileSync('/tmp/forge-state.json');if(c.createHash('sha256').update(b).digest('hex')!==process.argv[1])throw Error('State mismatch');for(const x of JSON.parse(b).files)if(c.createHash('sha256').update(f.readFileSync(x.path)).digest('hex')!==x.blob)throw Error('Source mismatch');"
            image = image.run_commands('node -e ' + shlex.quote(verify) + ' ' + shlex.quote(plan['head']))
            if plan['standard'] and plan['selection']['scope'] != 'docs':
                image = image.run_commands('npm run build:core && npm run build:web')
            image = (image.add_local_file(Path(__file__).with_name('worker.mjs'), '/tmp/modal-check/worker.mjs', copy=True)
                     .add_local_file(Path(__file__).parent.parent / 'child-env.mjs', '/tmp/child-env.mjs', copy=True))
            image.build(app)
            journal['image'] = image.object_id
            save(journal_path, journal)
        def launch(index, files, memory):
            nonlocal app, image
            require_current_node(plan)
            if (output / 'modal-cancel').exists():
                raise RuntimeError('Cancelled before sandbox creation')

            env = {'HOME': '/tmp/home', 'XDG_CONFIG_HOME': '/tmp/config', 'CI': '1',
                   'FORGE_TEST_WORKERS': '2', 'FORGE_MAX_CONCURRENT_CHECKS': '2',
                   'FORGE_TEST_EVENTS': '1',
                   'FORGE_GIT_TIMEOUT_MS': '240000', 'FORGE_TEST_TIMINGS': '/tmp/times.jsonl'}
            if static_resources and plan['standard'] and files is None and plan['selection']['scope'] != 'docs':
                env['FORGE_STATIC_WORKERS'] = '2'
                env['NODE_OPTIONS'] = '--max-old-space-size=3072'
            if not plan['standard']:
                command = plan['command']
            elif files is None:
                command = ['node', 'scripts/verify.mjs']
                env['FORGE_SELECTED_TESTS'] = json.dumps(dict(plan['selection'], tests=[]))
                if plan['selection']['scope'] == 'docs':
                    command = ['node', '--input-type=module', '-e',
                               "import {execFileSync as x} from 'node:child_process';import {runDocumentationChecks as d} from './scripts/check-documentation.mjs';d({npm:(...a)=>x('npm',a,{stdio:'inherit'}),node:s=>x('node',[s],{stdio:'inherit'}),interaction:" + ('true' if plan['interaction'] else 'false') + "})"]
            else:
                command = ['node', 'scripts/test-files.mjs', *files]
            if plan['standard'] and files is not None and plan['selection']['scope'] == 'full':
                env['FORGE_TEST_COVERAGE_HEAD'] = plan['head']
            env['FORGE_MODAL_COMMAND'] = json.dumps({'command': command, 'artifacts': plan.get('artifacts', []) if files is None else []})
            command = ['node', '/tmp/modal-check/worker.mjs']
            journal['creating'] = True
            save(journal_path, journal)
            while True:
                try:
                    sandbox = modal.Sandbox.create(
                        'sh', '-c', 'mkdir -p /tmp/home /tmp/config; "$@"; s=$?; echo __FORGE_TIMES__; cat /tmp/times.jsonl 2>/dev/null || true; exit "$s"',
                        'sh', *command, app=app, image=image, workdir='/repo', cpu=(2, 2), memory=(memory, memory), timeout=900, env=env)
                    break
                except modal.exception.ResourceExhaustedError as error:
                    # A definite provider capacity rejection can queue. Unknown creates never retry.
                    if classify(error) == 'billing':
                        raise
                    if not any(word in str(error).lower() for word in ['capacity', 'concurrency', 'concurrent']):
                        raise
                    journal['creating'] = False
                    save(journal_path, journal)
                    emit('progress', message='Waiting for Modal sandbox capacity')
                    if (output / 'modal-cancel').exists():
                        raise RuntimeError('Cancelled while queued')
                    time.sleep(1)
                    if (output / 'modal-cancel').exists():
                        raise RuntimeError('Cancelled while queued')
                    journal['creating'] = True
                    save(journal_path, journal)
            sandboxes.append(sandbox)
            previous = [item for item in journal['executions'] if item['index'] == index]
            journal['executions'].append({'id': sandbox.object_id, 'started': time.time(), 'index': index,
                                          'memory': memory, 'cpu': 2, 'attempt': len(previous)})
            journal['creating'] = False
            save(journal_path, journal)
            emit('execution', executionId=sandbox.object_id, image=journal['image'], index=index, attempt=len(previous))
            return sandbox, journal['executions'][-1]

        if new_run:
            for index, files in enumerate(jobs):
                static = static_resources and plan['standard'] and files is None and plan['selection']['scope'] != 'docs'
                launch(index, files, 8192 if static else 4096)
        else:
            # Only observe retained executions. A partial launch never repeats completed work.
            sandboxes = [None if resilient and ('exitCode' in item or 'stopped' in item) else modal.Sandbox.from_id(item['id']) for item in journal['executions']]
            for item in journal['executions']:
                emit('execution', executionId=item['id'], image=journal['image'], index=item['index'],
                     attempt=item.get('attempt', sum(saved['index'] == item['index'] for saved in journal['executions'][:journal['executions'].index(item)])))
        latest = {item['index']: (sandbox, item) for sandbox, item in zip(sandboxes, journal['executions'])}
        missing = set(range(len(jobs))) - set(latest)
        if missing:
            if not resilient or not plan['standard']:
                emit('error', category='unknown', safeFallback=False)
                return
            app = modal.App('forge-check')
            lifetime.enter_context(app.run(detach=True))
            image = modal.Image.from_id(journal['image'])
            for index in sorted(missing):
                static = static_resources and jobs[index] is None and plan['selection']['scope'] != 'docs'
                latest[index] = launch(index, jobs[index], 8192 if static else 4096)


        def persist():
            save(journal_path, journal)

        async def observe(identity):
            return await modal.Sandbox.from_id.aio(identity)

        pairs = list(latest.values())
        while True:
            collecting = [(sandbox, item) for sandbox, item in pairs if 'stopped' not in item]
            stalled_results = asyncio.run(collect_all(collecting, observe=observe, emit=emit, persist=persist,
                cancelled=lambda: (output / 'modal-cancel').exists()))
            stalled_by_id = {id(item): stalled for (_, item), stalled in zip(collecting, stalled_results)}
            stalled = [stalled_by_id.get(id(item), True) for _, item in pairs]
            retries = []
            for (sandbox, item), incomplete in zip(pairs, stalled):
                index = item['index']
                # One shared retry budget per shard, derived from retained executions so
                # older journals without attempt numbers cannot acquire another retry.
                attempts = sum(saved['index'] == index for saved in journal['executions'])
                oom = (static_resources and plan['standard'] and
                       plan['selection']['scope'] != 'docs' and item.get('exitCode') == 137)
                if incomplete:
                    # Adoption only reconnects existing executions. Incomplete work can
                    # repeat only after collect_all has durably confirmed termination.
                    if ((not new_run and not resilient) or not plan['standard'] or attempts > 1 or
                            (jobs[index] is None and plan.get('artifacts'))):
                        raise TimeoutError('Modal shard collection failed after reconnection')
                    retries.append((index, item.get('memory', 4096), 'stall'))
                elif oom and attempts == 1 and not (output / 'modal-cancel').exists():
                    retries.append((index, 16384, 'oom'))
                elif (flaky_retry and plan['standard'] and jobs[index] is not None and
                      item.get('exitCode', 0) != 0 and
                      attempts == 1 and not (output / 'modal-cancel').exists()):
                    retries.append((index, item.get('memory', 4096), 'flake'))
            if not retries:
                break
            if 'app' not in locals():
                app = modal.App('forge-check')
                lifetime.enter_context(app.run(detach=True))
                image = modal.Image.from_id(journal['image'])
            pairs = []
            for index, memory, reason in retries:
                if reason == 'oom':
                    emit('progress', message='Shard out of memory (137); retrying once with 16 GiB; original execution retained')
                else:
                    emit('progress', message=f"Retrying only shard {index} on Modal; completed shards retained")
                pair = launch(index, jobs[index], memory)
                pair[1]['retryReason'] = reason
                persist()
                latest[index] = pair
                pairs.append(pair)
        results = [item for _, item in latest.values()]
        journal['complete'] = True
        save(journal_path, journal)
        emit('result', pin=plan['pin'], head=plan['head'], definition=plan['definition'],
             exitCode=next((item['exitCode'] for item in results if item['exitCode'] != 0), 0),
             executions=[dict(executionId=item['id'], index=item['index'],
                              attempt=item.get('attempt', sum(saved['index'] == item['index'] for saved in journal['executions'][:position])),
                              **({'exitCode': item['exitCode']} if 'exitCode' in item else {}),
                              **({'tests': item['tests']} if 'tests' in item else {}),
                              **({'infrastructure': 'oom'} if item.get('exitCode') == 137 else
                                 {'infrastructure': 'sandbox-stopped'} if 'stopped' in item and 'exitCode' not in item else {}))
                         for position, item in enumerate(journal['executions'])],
             details='; '.join('Shard ' + str(item['index']) + ': ' + (exit_summary(item['exitCode']) if 'exitCode' in item else 'stopped after collection stall') for item in journal['executions']),
             **compute_estimate(journal['executions'], plan.get('costSafetyMargin', 1)))
    except Exception as error:
        category = classify(error)
        rejected = isinstance(error, (modal.exception.AuthError, modal.exception.ResourceExhaustedError)) and category in ['auth', 'billing']
        safe = (not journal.get('creating', False) or rejected) and len(sandboxes) == len(journal['executions'])
        safe = asyncio.run(stop_all([sandbox for sandbox in sandboxes if sandbox is not None])) and safe
        if safe:
            for item in journal['executions']:
                if 'exitCode' not in item:
                    item.setdefault('stopped', time.time())
            if rejected:
                journal['creating'] = False
            save(journal_path, journal)
        # Remote failure is not a successful command. Only confirmed infrastructure failures fall back.
        emit('error', category=category, safeFallback=safe and category in ['auth', 'network', 'billing'],
             details='Modal ' + category + ' failure during ' + ('sandbox creation' if journal.get('creating') else 'preparation or collection') + '; executions: ' + ', '.join(item['id'] for item in journal['executions']),
             **compute_estimate(journal['executions'], plan.get('costSafetyMargin', 1)))

    finally:
        journal['complete'] = True
        lifetime.close()


if __name__ == '__main__':
    try:
        import fcntl
        output = Path(json.loads(Path(sys.argv[1]).read_text())['output'])
        with (output / 'modal-driver.lock').open('w') as controller_lock:
            os.chmod(output / 'modal-driver.lock', 0o600)
            fcntl.flock(controller_lock, fcntl.LOCK_EX)
            main()
    except Exception:
        emit('error', category='execution', safeFallback=False)
