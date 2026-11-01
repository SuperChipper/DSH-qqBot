"""Agent CLI for asynchronous singing: submit, status, logs, wait, cancel and download."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import uuid

from sing_api import rpc, SERVICE, TERMINAL, SUCCESS


def ensure(url, token):
    try:
        value = rpc(url+'/health', token=token, timeout=2)
        if value.get('service') != SERVICE or not value.get('ready'):
            raise RuntimeError('Port is occupied by another or unhealthy service')
        return
    except HTTPError:
        raise
    except OSError:
        pass
    if url != 'http://127.0.0.1:8766':
        raise RuntimeError('--ensure only starts the default local service')
    result = subprocess.run(['pwsh', '-NoProfile', '-File',
                             str(Path(__file__).with_name('start-singing.ps1'))],
                            capture_output=True, text=True, encoding='utf-8', errors='replace',
                            creationflags=0x08000000 if os.name == 'nt' else 0)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    value = rpc(url+'/health', token=token, timeout=5)
    if value.get('service') != SERVICE or not value.get('ready'):
        raise RuntimeError('Singing service did not become ready')


def download(url, token, job, output):
    headers = {'Authorization': 'Bearer '+token} if token else {}
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name+'.'+uuid.uuid4().hex+'.part')
    try:
        with urlopen(Request(url+f'/jobs/{job}/result', headers=headers), timeout=60) as response, temporary.open('wb') as file:
            for block in iter(lambda: response.read(65536), b''):
                file.write(block)
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    return {'path': str(output), 'bytes': output.stat().st_size}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--url', default=os.environ.get('SING_SERVICE_URL', 'http://127.0.0.1:8766'))
    ap.add_argument('--ensure', action='store_true', help='Start the default local service if absent')
    sub = ap.add_subparsers(dest='action', required=True)
    sub.add_parser('health')
    sub.add_parser('list')
    submit = sub.add_parser('submit')
    mode = submit.add_mutually_exclusive_group(required=True)
    mode.add_argument('--song')
    mode.add_argument('--stems-from')
    mode.add_argument('--repair-from')
    submit.add_argument('--options-json', default='{}')
    submit.add_argument('--idempotency-key', default='')
    for name in ('status', 'logs', 'cancel', 'wait', 'result'):
        parser = sub.add_parser(name)
        parser.add_argument('id')
        if name == 'wait':
            parser.add_argument('--timeout', type=float, default=1800)
            parser.add_argument('--interval', type=float, default=2)
        if name == 'result':
            parser.add_argument('--out', required=True)
    a = ap.parse_args()
    url, token = a.url.rstrip('/'), os.environ.get('SING_SERVICE_TOKEN', '')
    if a.ensure:
        ensure(url, token)
    if a.action == 'health':
        value = rpc(url+'/health', token=token)
    elif a.action == 'list':
        value = rpc(url+'/jobs', token=token)
    elif a.action == 'submit':
        payload = {key: getattr(a, key) for key in ('song', 'stems_from', 'repair_from') if getattr(a, key)}
        payload.update(options=json.loads(a.options_json), idempotency_key=a.idempotency_key)
        value = rpc(url+'/jobs', payload, token=token)
    elif a.action == 'status':
        value = rpc(url+f'/jobs/{a.id}', token=token)
    elif a.action == 'logs':
        value = rpc(url+f'/jobs/{a.id}/log', token=token)
    elif a.action == 'cancel':
        value = rpc(url+f'/jobs/{a.id}/cancel', {}, token=token)
    elif a.action == 'result':
        value = download(url, token, a.id, a.out)
    else:
        deadline = time.monotonic()+a.timeout
        while True:
            value = rpc(url+f'/jobs/{a.id}', token=token)
            if value['state'] in TERMINAL:
                break
            if time.monotonic() >= deadline:
                raise TimeoutError('Client wait timed out; server job continues, use status or cancel')
            time.sleep(max(.2, a.interval))
    print(json.dumps(value, ensure_ascii=False, indent=2))
    if a.action == 'wait' and value['state'] not in SUCCESS:
        return 2
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except HTTPError as exc:
        print(exc.read().decode('utf-8', errors='replace'), file=sys.stderr)
        raise SystemExit(1)
    except Exception as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
