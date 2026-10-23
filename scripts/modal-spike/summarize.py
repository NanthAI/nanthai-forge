# SPDX-License-Identifier: Apache-2.0
"""Aggregate local spike receipts without copying raw logs or source manifests."""
import argparse
from collections import defaultdict
from decimal import Decimal
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--billing', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('runs', type=Path, nargs='+')
args = parser.parse_args()
costs = defaultdict(Decimal)
for row in json.loads(args.billing.read_text()):
    if not row.get('description', '').startswith('forge-modal-spike'):
        continue
    costs[row['object_id']] += Decimal(row['cost'])
records = []
for path in args.runs:
    run = json.loads((path/'summary.json').read_text())
    counts = defaultdict(int)
    failures = []
    for result in run['results']:
        for name, count in result['counts'].items():
            counts[name] += count
        failures.extend(result['failures'])
    tests = [r for r in run['results'] if not r['name'].endswith('static')]
    static = next((r for r in run['results'] if r['name'].endswith('static')), None)
    expected_files = [f for r in tests for f in r['files']]
    timed_files = [json.loads(line)['file'] for f in path.glob('*.times.jsonl')
                   for line in f.read_text().splitlines() if line]
    coverage_matches = (len(expected_files) == len(set(expected_files)) == run['test_files']
                        and sorted(expected_files) == sorted(timed_files))
    records.append({
        **{k:v for k,v in run.items() if k != 'results'},
        'counts': dict(counts), 'failed_files': failures,
        'timed_test_files': len(timed_files), 'coverage_matches': coverage_matches,
        'all_exits_zero': all(r['exit'] == 0 for r in run['results']),
        'tests_s': max(r['execution_s'] for r in tests),
        'create_api_max_s': max(r['queue_boot_s'] for r in run['results']),
        'static_s': static['execution_s'] if static else None,
        'static_exit': static['exit'] if static else None,
        'allocation_estimate_usd': sum(r['allocation_estimate_usd'] for r in run['results']),
        'billing_api_observed_usd': str(costs[run['app_id']]) if run.get('app_id') in costs else None,
    })
args.output.write_text(json.dumps({
    'runs': records, 'observed_spike_billing_usd': str(sum(costs.values())),
    'billing_note': 'Read-only Modal usage report, gross metered cost; may lag. Includes pilot, aborted incompatible image and diagnostics.'
}, indent=2)+'\n')
print(args.output.read_text())
