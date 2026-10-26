# SPDX-License-Identifier: Apache-2.0
"""Fixed-code source service; deploy/provision explicitly, never from a repository.

Convex commits a durable reservation BEFORE spawn. Unknown creates retain it;
no second paid create is inferred safe. Signed worker callbacks recover the
execution ID after a lost spawn response. No local dispatch journal is involved.
"""
import hmac
import json
import os
import subprocess
import urllib.request
import urllib.parse
import uuid

import modal

if modal.__version__ != '1.6.2':
    raise ValueError('Modal SDK runtime changed')
if not os.environ['FORGE_SOURCE_IMAGE'].endswith('@sha256:' + os.environ['FORGE_SOURCE_RUNTIME']):
    raise ValueError('Source image must match the pinned runtime digest')

APP = modal.App('forge-source')
IMAGE = modal.Image.from_registry(os.environ['FORGE_SOURCE_IMAGE'])
CONTROL = modal.Secret.from_name('forge-source-worker-control')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def control(action, value):
    # Fixed backend ingress, not a URL from project/source bytes. Its authenticated
    # handler forwards only to projectSourceProviderApi internal functions.
    base = os.environ['FORGE_SOURCE_CONTROL_URL']
    url = urllib.parse.urlparse(base)
    if url.scheme != 'https' or url.username or url.password or url.query or url.fragment:
        raise ValueError('trusted control URL')
    request = urllib.request.Request(
        base.rstrip('/') + '/' + action,
        data=json.dumps(value).encode(), method='POST',
        headers={'Authorization': 'Bearer ' + os.environ['FORGE_SOURCE_CONTROL_TOKEN'],
                 'Content-Type': 'application/json'})
    # No redirects with credentials. Unknown reserve replies never license spawn.
    opener = urllib.request.build_opener(NoRedirect)
    with opener.open(request, timeout=30) as response:
        return json.loads(response.read(128 * 1024 + 1))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


@APP.function(image=IMAGE, secrets=[CONTROL], timeout=86400, retries=0)
def source_worker(value):
    execution = modal.current_function_call_id()
    # A first signed heartbeat binds the original execution even if spawn's SDK
    # reply is lost. All source computation runs in this fixed installed image.
    env = {name: os.environ[name] for name in (
        'FORGE_SOURCE_CONTROL_URL', 'FORGE_SOURCE_CONTROL_TOKEN',
        'FORGE_SOURCE_CALLBACK_KEY', 'FORGE_SOURCE_RUNTIME',
        'FORGE_SOURCE_WORKER', 'FORGE_SOURCE_HEARTBEAT_MS')}
    env['FORGE_SOURCE_EXECUTION_ID'] = execution
    result = subprocess.run(
        ['/usr/local/bin/node', '/opt/forge/scripts/modal-source/worker.mjs'],
        input=json.dumps(value).encode(), cwd='/tmp', env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    return {'exitCode': result.returncode}


def handle(action, value):
    key, bound = value['dispatchKey'], canonical(value)
    reply = {'dispatchKey': key, 'input': bound, 'result': {'status': 'unknown'}}
    if (value['provider'] != 'modal' or value['worker'] != os.environ['FORGE_SOURCE_WORKER'] or
            value['runtime'] != os.environ['FORGE_SOURCE_RUNTIME']):
        return reply
    if action == 'lookup':
        reply['result'] = control('provider-lookup', {'input': value})
        return reply
    if action != 'dispatch':
        return reply
    token = str(uuid.uuid4())
    reserved = control('provider-reserve', {'input': value, 'token': token})
    if not reserved['create']:
        if reserved['executionId']:
            reply['result'] = {'status': 'accepted', 'executionId': reserved['executionId']}
        return reply
    try:
        call = source_worker.spawn(value)
        control('provider-created', {'input': value, 'token': token, 'executionId': call.object_id})
        reply['result'] = {'status': 'accepted', 'executionId': call.object_id}
    except Exception:
        # SDK exceptions can occur after acceptance. Never erase the reservation.
        pass
    return reply


@APP.function(image=IMAGE, secrets=[CONTROL], min_containers=0, retries=0)
@modal.asgi_app()
def bridge():
    async def app(scope, receive, send):
        if scope['type'] != 'http':
            return
        headers = dict(scope['headers'])
        expected = ('Bearer ' + os.environ['FORGE_SOURCE_BRIDGE_TOKEN']).encode()
        status, body = 401, b'{}'
        if scope['method'] == 'POST' and hmac.compare_digest(headers.get(b'authorization', b''), expected):
            raw = bytearray()
            while True:
                event = await receive()
                if event['type'] == 'http.disconnect':
                    return
                raw.extend(event.get('body', b''))
                if len(raw) > 128 * 1024:
                    break
                if not event.get('more_body', False):
                    break
            try:
                if len(raw) > 128 * 1024:
                    raise ValueError('control envelope')
                request = json.loads(raw)
                body = json.dumps(handle(request['action'], request['input'])).encode()
                status = 200
            except Exception:
                status, body = 503, b'{}'
        await send({'type': 'http.response.start', 'status': status,
                    'headers': [(b'content-type', b'application/json')]})
        await send({'type': 'http.response.body', 'body': body})
    return app
