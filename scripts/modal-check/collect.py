# SPDX-License-Identifier: Apache-2.0
"""Bounded collection of retained Modal executions; never infer a stopped command."""
import asyncio
import json
import math
import time

POLL_SECONDS = 5
RPC_SECONDS = 10
QUIET_SECONDS = 45


async def collect(sandbox, item, *, observe, emit, persist, cancelled):
    """Reconnect silent/broken streams once before requesting a stopped-shard retry."""
    if 'exitCode' in item:
        return False
    seen = {'stdout': -1, 'stderr': -1}
    for connection in range(2):
        last_output = time.monotonic()
        ended = None
        code = None
        reason = 'log stream failure'

        async def stream(reader, channel):
            nonlocal last_output
            timings = False
            number = -1
            async for line in reader:
                number += 1
                # Re-observation replays logs from the same execution. Keep identities stable.
                if channel == 'stdout' and line.strip() == '__FORGE_TIMES__':
                    timings = True
                if number <= seen[channel]:
                    continue
                seen[channel] = number
                last_output = time.monotonic()
                if channel == 'stdout' and line.startswith('__FORGE_USAGE__'):
                    try:
                        seconds = json.loads(line[len('__FORGE_USAGE__'):])['seconds']
                        if not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or seconds < 0:
                            raise ValueError('Invalid runtime')
                        item['seconds'] = seconds
                        persist()
                        continue
                    except (ValueError, KeyError, TypeError):
                        pass
                if channel == 'stdout' and line.startswith('__FORGE_TESTS__'):
                    try:
                        event = json.loads(line[len('__FORGE_TESTS__'):])
                        item.setdefault('tests', {})[event['file']] = event
                        persist()
                        continue
                    except (ValueError, KeyError, TypeError):
                        pass
                if channel == 'stdout' and line.startswith('__FORGE_ARTIFACT__'):
                    try:
                        event = json.loads(line[len('__FORGE_ARTIFACT__'):])
                        kind = event.pop('kind')
                        if kind in ['artifactChunk', 'artifactEnd', 'artifactUnavailable']:
                            emit(kind, **event)
                            continue
                    except (ValueError, KeyError, TypeError):
                        pass
                if channel == 'stdout' and timings:
                    try:
                        timing = json.loads(line)
                        emit('timing', file=timing['file'], seconds=timing['durationMs'] / 1000)
                    except (ValueError, KeyError, TypeError):
                        pass
                emit('log', executionId=item['id'], stream=channel, text=line, line=number)

        streams = [asyncio.create_task(stream(sandbox.stdout, 'stdout')),
                   asyncio.create_task(stream(sandbox.stderr, 'stderr'))]
        try:
            while True:
                await asyncio.sleep(0)
                if cancelled():
                    await asyncio.wait_for(sandbox.terminate.aio(wait=True), RPC_SECONDS)
                    raise RuntimeError('Cancelled during collection')
                # Check stream failures while the process is still running. Waiting for process
                # exit first used to hide transport failures until the 900-second lifetime.
                reason = 'status RPC unavailable'
                code = await asyncio.wait_for(sandbox.poll.aio(), RPC_SECONDS)
                reason = 'log stream failure'
                for task in streams:
                    if task.done():
                        task.result()
                if code is not None:
                    ended = ended or time.monotonic()
                    if all(task.done() for task in streams):
                        item.update(ended=time.time(), exitCode=code)
                        persist()
                        emit('progress', message=f"Completed shard {item['index']} ({'out of memory (137)' if code == 137 else 'exit ' + str(code)})")
                        return False
                reason = 'process running without output' if code is None else 'process exited without log EOF'
                if time.monotonic() - (ended or last_output) >= QUIET_SECONDS:
                    raise TimeoutError('Silent Modal stream')
                await asyncio.sleep(POLL_SECONDS)
        except Exception:
            if cancelled():
                raise
            if code is not None and code != 0:
                item.update(ended=time.time(), exitCode=code)
                persist()
                emit('progress', message=f"Completed shard {item['index']} (exit {code}; log collection incomplete)")
                return False
            if connection == 0:
                emit('progress', message=f"Shard {item['index']} collection stalled ({reason}); reconnecting retained execution {item['id']}")
                sandbox = await asyncio.wait_for(observe(item['id']), RPC_SECONDS)
                continue
            # Termination RPC acknowledgement alone is insufficient: wait=True confirms exit.
            stopped = await asyncio.wait_for(sandbox.terminate.aio(wait=True), RPC_SECONDS)
            if stopped is None:
                raise TimeoutError('Modal termination outcome unavailable')
            if stopped not in [0, 137]:
                item.update(ended=time.time(), exitCode=stopped)
                persist()
                emit('progress', message=f"Completed shard {item['index']} (exit {stopped}; log collection incomplete)")
                return False
            item['stopped'] = time.time()
            persist()
            emit('progress', message=f"Shard {item['index']} collection stalled ({reason}); confirmed execution stopped")
            return True
        finally:
            for task in streams:
                task.cancel()
            await asyncio.gather(*streams, return_exceptions=True)


async def collect_all(pairs, **options):
    tasks = [asyncio.create_task(collect(sandbox, item, **options)) for sandbox, item in pairs]
    try:
        return await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def stop_all(sandboxes):
    async def stop(sandbox):
        try:
            code = await asyncio.wait_for(sandbox.terminate.aio(wait=True), RPC_SECONDS)
            return code is not None
        except Exception:
            return False
    return all(await asyncio.gather(*(stop(sandbox) for sandbox in sandboxes)))
