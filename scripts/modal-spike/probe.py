# SPDX-License-Identifier: Apache-2.0
"""Run one diagnostic file in a fresh, already-built spike image."""
import argparse
import concurrent.futures
from pathlib import Path
import modal

p = argparse.ArgumentParser()
p.add_argument('--image', required=True)
p.add_argument('--test', required=True)
p.add_argument('--pattern', default='.')
p.add_argument('--check-slots', default='2')
p.add_argument('--output', type=Path, required=True)
a = p.parse_args()
app = modal.App('forge-modal-spike-probe')
with app.run():
    sb = modal.Sandbox.create('sleep', '180', app=app, image=modal.Image.from_id(a.image),
                              workdir='/repo', cpu=(2, 2), memory=(4096, 4096), timeout=180,
                              env={'HOME': '/tmp/home', 'XDG_CONFIG_HOME': '/tmp/config',
                                   'FORGE_TEST_WORKERS': '2', 'FORGE_MAX_CONCURRENT_CHECKS': a.check_slots, 'FORGE_GIT_TIMEOUT_MS': '240000', 'CI': '1'})
    try:
        child = sb.exec('sh', '-c', 'mkdir -p /tmp/home /tmp/config && exec node --import ./tests/check-runtime.mjs --test --test-reporter=tap --test-name-pattern "$2" "$1"', 'sh', a.test, a.pattern, timeout=150)
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            stdout, stderr = pool.submit(child.stdout.read), pool.submit(child.stderr.read)
            code = child.wait()
            a.output.write_text(stdout.result()+stderr.result())
        print({'exit': code, 'app': app.app_id, 'test': a.test})
    finally:
        sb.terminate()
