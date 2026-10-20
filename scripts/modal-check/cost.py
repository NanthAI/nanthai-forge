# SPDX-License-Identifier: Apache-2.0
"""Gross Sandbox compute estimate, not a workspace billing receipt.

https://modal.com/pricing (Sandbox rates); resources are billed at
max(request, actual): https://modal.com/docs/guide/sandbox-resources.
Requests and limits are identical in this runner, so reserved core/GiB seconds
are the billable quantities. Worker elapsed time excludes controller queuing,
reconnection and log draining. Startup/teardown, builds, egress, credits and
workspace adjustments are not available here.
"""
import math
import time

CPU_USD_PER_SECOND = 0.00003942
MEMORY_GIB_USD_PER_SECOND = 0.00000667


def allocation_rate(item):
    return max(0.125, item.get('cpu', 2)) * CPU_USD_PER_SECOND + max(128, item.get('memory', 4096)) / 1024 * MEMORY_GIB_USD_PER_SECOND


def compute_estimate(executions):
    estimates = []
    for item in executions:
        seconds = item.get('seconds')
        measured = isinstance(seconds, (int, float)) and math.isfinite(seconds) and seconds >= 0
        if not measured:
            # Older journals have only controller timestamps. A disconnected
            # controller can observe exit days after the 900-second Sandbox died.
            seconds = min(900, max(0, item.get('ended', item.get('stopped', time.time())) - item['started']))
        estimates.append(dict(executionId=item['id'], seconds=seconds,
                              cpuCoreSeconds=max(0.125, item.get('cpu', 2)) * seconds,
                              memoryGiBSeconds=max(128, item.get('memory', 4096)) / 1024 * seconds,
                              basis='worker-runtime' if measured else 'controller-time'))
    return dict(estimatedCostUsd=sum(e['seconds'] * allocation_rate(item) for e, item in zip(estimates, executions)),
                costUsage=estimates)
