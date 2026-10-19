# SPDX-License-Identifier: Apache-2.0
"""Manual Modal spike; no deployment, credentials, or product integration.

Input must be a fresh NativeSource.materialize(head, path, False) export.
Run with the owner's Modal venv; output/logs stay in the supplied local directory.
"""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
import time
import modal


def timed_build(image, app):
    start = time.monotonic()
    image.build(app)
    return time.monotonic() - start


def shard(app, image, files, name, out, static=False):
    start = time.monotonic()
    env = {'HOME': '/tmp/home', 'XDG_CONFIG_HOME': '/tmp/config',
           'FORGE_TEST_WORKERS': '2', 'FORGE_MAX_CONCURRENT_CHECKS': '2',
           'FORGE_GIT_TIMEOUT_MS': '240000', 'CI': '1',
           'FORGE_TEST_TIMINGS': '/tmp/test-times.jsonl'}
    command = ['node', 'scripts/test-files.mjs', *files]
    if static:
        command = ['node', 'scripts/verify.mjs']
        env['FORGE_SELECTED_TESTS'] = json.dumps({
            'scope': 'full', 'reason': 'Static verification; all tests run in sibling shards', 'tests': []})
    # Main-command completion/logs use the control plane, avoiding exec-router waits.
    script = ('mkdir -p /tmp/home /tmp/config; "$@"; status=$?; '
              'echo __SPIKE_TIMINGS_BEGIN__; cat /tmp/test-times.jsonl 2>/dev/null || true; '
              'echo __SPIKE_TIMINGS_END__; exit "$status"')
    sandbox = modal.Sandbox.create(
        'sh', '-c', script, 'sh', *command, app=app, image=image, workdir='/repo',
        cpu=(2, 2), memory=(4096, 4096), timeout=900, env=env)
    created = time.monotonic()
    (out / f'{name}.started.json').write_text(json.dumps({'sandbox': sandbox.object_id, 'files': files}))
    try:
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            stdout, stderr = pool.submit(sandbox.stdout.read), pool.submit(sandbox.stderr.read)
            sandbox.wait(raise_on_termination=False)
            code = sandbox.returncode
            log = stdout.result() + stderr.result()
        done = time.monotonic()
        (out / f'{name}.log').write_text(log)
        timing = re.search(r'__SPIKE_TIMINGS_BEGIN__\n(.*?)__SPIKE_TIMINGS_END__', log, re.S)
        (out / f'{name}.times.jsonl').write_text(timing.group(1) if timing else '')
        counts = {key: int(value) for key, value in re.findall(
            r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$', log, re.M)}
        result = {'name': name, 'sandbox': sandbox.object_id, 'files': files,
                  'queue_boot_s': created-start, 'execution_s': done-created,
                  'exit': code, 'counts': counts,
                  'failures': re.findall(r'^# Failed test file: (.+)$', log, re.M)}
    finally:
        sandbox.terminate()
    result['total_s'] = time.monotonic()-start
    result['allocation_estimate_usd'] = result['total_s'] * (2*0.00003942 + 4*0.00000667)
    (out / f'{name}.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({k:v for k,v in result.items() if k != 'files'}), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--head', required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--tests-file', type=Path, help='Optional retained local selection for parity comparison')
    parser.add_argument('--shards', type=int, choices=[1, 4, 8, 16], required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    source = args.source.resolve()
    # Only the source export is uploaded; never a Lane, owner metadata, or local config.
    paths = sorted(p for p in source.rglob('*') if p.is_file())
    forbidden = [p for p in paths if any(part in ['.git', '.forge', 'node_modules']
                                         or (part.startswith('.env') and part != '.env.example') for part in p.relative_to(source).parts)]
    if forbidden:
        raise ValueError('Input is not a clean source-only export')
    manifest = [{'path': p.relative_to(source).as_posix(),
                 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in paths]
    state_bytes = args.manifest.read_bytes()
    if hashlib.sha256(state_bytes).hexdigest() != args.head:
        raise ValueError('Native State digest does not match head')
    state = json.loads(state_bytes)
    if {f['path']: f['sha256'] for f in manifest} != {f['path']: f['blob'] for f in state['files']}:
        raise ValueError('Export differs from the exact native State')
    identity = {'native_head': args.head, 'files': manifest}
    (args.output / 'source-manifest.json').write_text(json.dumps(identity, indent=2))
    files = sorted('tests/'+p.name for p in (source/'tests').glob('*.test.mjs'))
    if args.tests_file:
        selected = json.loads(args.tests_file.read_text())
        if not isinstance(selected, list) or not selected or len(set(selected)) != len(selected) or any(f not in files for f in selected):
            raise ValueError('Invalid selected test list')
        files = selected
    if args.shards == 1 and not args.tests_file:
        files = ['tests/files.test.mjs', 'tests/check-path-scopes.test.mjs', 'tests/test-impact.test.mjs']
    app = modal.App('forge-modal-spike')
    with modal.enable_output(), app.run():
        start = time.monotonic()
        lock_hash = hashlib.sha256((source/'package-lock.json').read_bytes()).hexdigest()
        image = (modal.Image.from_registry('node:24.19.0-trixie-slim')
                 .apt_install('git', 'ca-certificates', 'procps')
                 .run_commands('node --version && git --version && git --no-lazy-fetch --version')
                 .workdir('/repo')
                 .env({'FORGE_SPIKE_LOCK_SHA256': lock_hash})
                 .add_local_file(source/'package.json', '/repo/package.json', copy=True)
                 .add_local_file(source/'package-lock.json', '/repo/package-lock.json', copy=True)
                 .run_commands('npm ci --ignore-scripts'))
        install_image_s = timed_build(image, app)
        image = image.add_local_dir(source, '/repo', copy=True)
        upload_image_s = timed_build(image, app)
        image = image.add_local_file(args.manifest, '/tmp/spike-state.json', copy=True)
        verify = "const fs=require('fs'),c=require('crypto');const b=fs.readFileSync('/tmp/spike-state.json');if(c.createHash('sha256').update(b).digest('hex')!==process.argv[1])throw Error('State mismatch');for(const f of JSON.parse(b).files){if(c.createHash('sha256').update(fs.readFileSync(f.path)).digest('hex')!==f.blob)throw Error('Source mismatch: '+f.path)}console.log('Exact native State verified')"
        import shlex
        image = image.run_commands('node -e '+shlex.quote(verify)+' '+shlex.quote(args.head),
                                   'npm run build:core && npm run build:web')
        build_image_s = timed_build(image, app)
        # GNU time is required by the suite's native resource-observation test.
        image = image.apt_install('time')
        build_image_s += timed_build(image, app)
        groups = [files[i::args.shards] for i in range(args.shards)]
        run_start = time.monotonic()
        preparation = {'app_id': app.app_id, 'image_id': image.object_id,
                       'head': args.head, 'shards': args.shards, 'check_slots': 2,
                       'install_image_s': install_image_s, 'upload_image_s': upload_image_s,
                       'build_image_s': build_image_s}
        (args.output/'preparation.json').write_text(json.dumps(preparation, indent=2))
        with concurrent.futures.ThreadPoolExecutor(args.shards+1) as pool:
            tasks = [pool.submit(shard, app, image, group, f'{args.shards}-{i}', args.output)
                     for i, group in enumerate(groups)]
            if args.shards > 1:
                tasks.append(pool.submit(shard, app, image, [], f'{args.shards}-static', args.output, True))
            results = [task.result() for task in tasks]
        record = {'app_id': app.app_id, 'image_id': image.object_id, 'head': args.head, 'lock_sha256': lock_hash, 'shards': args.shards, 'check_slots': 2, 'test_files': len(files), 'selection': bool(args.tests_file),
                  'install_image_s': install_image_s, 'upload_image_s': upload_image_s,
                  'build_image_s': build_image_s, 'sharded_wall_s': time.monotonic()-run_start,
                  'total_s': time.monotonic()-start, 'results': results}
        (args.output/'summary.json').write_text(json.dumps(record, indent=2))
        print('SUMMARY '+json.dumps({k:v for k,v in record.items() if k != 'results'}), flush=True)

    if any(r['exit'] != 0 for r in record['results']):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
