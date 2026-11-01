"""Persistent local singing jobs API with one queue consumer and a reusable RVC process."""
from __future__ import annotations

import argparse
from collections import deque
from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import sys
import threading
import time
from urllib.parse import urlsplit
import uuid

from sing_api import SERVICE, VERSION, TERMINAL, SUCCESS, ID, validate, command, rpc
from sing_process import ProcessTree

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA = ROOT.parent / 'tmp' / 'singing-service'


class Conflict(Exception):
    pass


class Full(Exception):
    pass


class Cancelled(Exception):
    pass


class JobTimeout(Exception):
    pass


class RvcEngine:
    def __init__(self, root, data, port):
        self.root, self.data, self.port = root, data, port
        self.token = secrets.token_urlsafe(32)
        self.tree = None
        self.log = None
        self.status = {'ready': False, 'warmed': False}

    def ensure(self, cancelled):
        if self.tree and self.tree.poll() is None:
            return
        self.reset()
        # Reject a foreign listener before spawning; never commandeer an existing worker.
        import socket
        with socket.socket() as probe:
            probe.settimeout(.5)
            if probe.connect_ex(('127.0.0.1', self.port)) == 0:
                raise RuntimeError(f'RVC worker port {self.port} is already occupied')
        rvc = self.root / 'rvc/pkg/RVC20240604Nvidia50x0'
        env = os.environ.copy()
        env.update(SING_WORKER_TOKEN=self.token, PYTHONUTF8='1', PYTHONIOENCODING='utf-8',
                   PYTHONUNBUFFERED='1', PYTHONDONTWRITEBYTECODE='1')
        env.pop('COVER_GPU_LOCK_HELD', None)
        self.log = (self.data / 'rvc-worker.log').open('ab', buffering=0)
        self.tree = ProcessTree(
            [str(rvc/'runtime/python.exe'), '-B', str(self.root/'scripts/sing_rvc_worker.py'),
             '--port', str(self.port), '--root', str(self.root), '--data-dir', str(self.data)],
            cwd=rvc, env=env, log=self.log, control=self.data/'control')
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if cancelled():
                self.reset()
                raise Cancelled()
            if self.tree.poll() is not None:
                self.reset()
                raise RuntimeError('RVC worker exited during startup; see rvc-worker.log')
            try:
                status = rpc(self.url + '/health', token=self.token, timeout=.5)
                if status.get('service') == 'voice-lab-rvc-worker':
                    self.status = status
                    return
            except Exception:
                pass
            time.sleep(.2)
        self.reset()
        raise RuntimeError('RVC worker startup timed out')

    @property
    def url(self):
        return f'http://127.0.0.1:{self.port}'

    def environment(self):
        return {'COVER_RVC_URL': self.url, 'SING_WORKER_TOKEN': self.token}

    def refresh(self):
        if self.tree and self.tree.poll() is None:
            try:
                self.status = rpc(self.url+'/health', token=self.token, timeout=1)
            except Exception:
                pass

    def reset(self):
        if self.tree:
            self.tree.close()
            self.tree = None
        if self.log:
            self.log.close()
            self.log = None
        self.status = {'ready': False, 'warmed': False}


class Manager:
    def __init__(self, root, data, *, worker_port=8767, max_queue=32, timeout=1800,
                 allowed=None, python=None, pipeline=None, engine=None):
        self.root, self.data = Path(root).resolve(), Path(data).resolve()
        self.data.mkdir(parents=True, exist_ok=True)
        (self.data/'jobs').mkdir(exist_ok=True)
        self.allowed = [Path(p).resolve() for p in (allowed or [self.root.parent, self.data])]
        self.models = {p.name for p in (self.root/'rvc/pkg/RVC20240604Nvidia50x0/assets/weights').glob('*.pth')}
        self.python = python or self.root/'env/python.exe'
        self.pipeline = pipeline or self.root/'scripts/cover.py'
        self.max_queue, self.timeout = max_queue, timeout
        self.engine = engine or RvcEngine(self.root, self.data, worker_port)
        self.stop = threading.Event()
        self.wake = threading.Event()
        self.active = None
        self.thread = None
        with self.db() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('''CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, state TEXT NOT NULL, created REAL NOT NULL, started REAL,
                finished REAL, request TEXT NOT NULL, idem TEXT UNIQUE, stage TEXT NOT NULL,
                exit_code INTEGER, error TEXT, cancel INTEGER NOT NULL DEFAULT 0)''')
            db.execute("UPDATE jobs SET state='interrupted',finished=?,error='Service restarted during execution' "
                       "WHERE state IN ('running','cancelling')", (time.time(),))

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.data/'jobs.sqlite3', timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def start(self):
        self.thread = threading.Thread(target=self.loop, name='sing-queue', daemon=True)
        self.thread.start()

    def submit(self, payload):
        request = validate(payload, self.allowed, self.models)
        serialized = json.dumps(request, sort_keys=True, ensure_ascii=False, allow_nan=False)
        key = request['idempotency_key'] or None
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if key:
                row = db.execute('SELECT * FROM jobs WHERE idem=?', (key,)).fetchone()
                if row:
                    if row['request'] != serialized:
                        raise Conflict('idempotency_key already used for another request')
                    return self.public(dict(row)), False
            if db.execute("SELECT count(*) FROM jobs WHERE state='queued'").fetchone()[0] >= self.max_queue:
                raise Full('Singing queue is full')
            job = uuid.uuid4().hex
            folder = self.data/'jobs'/job
            folder.mkdir()
            db.execute('INSERT INTO jobs(id,state,created,request,idem,stage) VALUES(?,?,?,?,?,?)',
                       (job, 'queued', time.time(), serialized, key, 'queued'))
        self.wake.set()
        return self.get(job), True

    def public(self, row):
        request = json.loads(row.pop('request'))
        row.pop('idem', None)
        row.pop('cancel', None)
        row['input'] = request
        row['work_dir'] = str(self.data/'jobs'/row['id']/'work')
        row['result_path'] = str(self.data/'jobs'/row['id']/'result.mp3') if row['state'] in SUCCESS else None
        row['result_url'] = f"/jobs/{row['id']}/result" if row['state'] in SUCCESS else None
        row['log_url'] = f"/jobs/{row['id']}/log"
        if row['state'] == 'queued':
            with self.db() as db:
                row['queue_position'] = db.execute(
                    "SELECT count(*) FROM jobs WHERE state='queued' AND (created<? OR (created=? AND id<=?))",
                    (row['created'], row['created'], row['id'])).fetchone()[0]
        return row

    def get(self, job):
        if not ID.fullmatch(job):
            raise KeyError(job)
        with self.db() as db:
            row = db.execute('SELECT * FROM jobs WHERE id=?', (job,)).fetchone()
        if row is None:
            raise KeyError(job)
        return self.public(dict(row))

    def list(self):
        with self.db() as db:
            rows = db.execute('SELECT * FROM jobs ORDER BY created DESC LIMIT 100').fetchall()
        return [self.public(dict(row)) for row in rows]

    def update(self, job, **fields):
        with self.db() as db:
            db.execute('UPDATE jobs SET '+','.join(key+'=?' for key in fields)+' WHERE id=?',
                       (*fields.values(), job))

    def cancel(self, job):
        self.get(job)
        with self.db() as db:
            db.execute("UPDATE jobs SET state='cancelled',cancel=1,finished=? WHERE id=? AND state='queued'",
                       (time.time(), job))
            db.execute("UPDATE jobs SET state='cancelling',cancel=1 WHERE id=? AND state='running'", (job,))
        self.wake.set()
        return self.get(job)

    def cancelled(self, job):
        if self.stop.is_set():
            return True
        with self.db() as db:
            return bool(db.execute('SELECT cancel FROM jobs WHERE id=?', (job,)).fetchone()[0])

    def claim(self):
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute("SELECT * FROM jobs WHERE state='queued' ORDER BY created,id LIMIT 1").fetchone()
            if row:
                db.execute("UPDATE jobs SET state='running',started=?,stage='starting' WHERE id=?",
                           (time.time(), row['id']))
                return dict(row)

    def loop(self):
        while not self.stop.is_set():
            row = self.claim()
            if row is None:
                self.wake.wait(.5)
                self.wake.clear()
                continue
            self.active = row['id']
            try:
                self.run(row)
            except Cancelled:
                self.engine.reset()
                state = 'interrupted' if self.stop.is_set() else 'cancelled'
                self.update(row['id'], state=state, finished=time.time(), stage=state)
            except JobTimeout:
                self.engine.reset()
                self.update(row['id'], state='timed_out', stage='timed_out', finished=time.time(),
                            error=f'Job exceeded {self.timeout:g} seconds, including worker startup')
            except Exception as exc:
                self.engine.reset()
                self.update(row['id'], state='failed', finished=time.time(), error=str(exc), stage='failed')
            finally:
                self.active = None

    def run(self, row):
        job = row['id']
        folder = self.data/'jobs'/job
        request = json.loads(row['request'])
        started = time.monotonic()

        def interrupted():
            if self.cancelled(job):
                raise Cancelled()
            if time.monotonic()-started >= self.timeout:
                raise JobTimeout()
            return False

        self.update(job, stage='starting_rvc_worker')
        self.engine.ensure(interrupted)
        interrupted()
        env = os.environ.copy()
        env.pop('COVER_GPU_LOCK_HELD', None)
        env.update(self.engine.environment())
        env.update(PYTHONUTF8='1', PYTHONIOENCODING='utf-8', PYTHONUNBUFFERED='1',
                   PYTHONDONTWRITEBYTECODE='1', SING_JOB_ID=job)
        result, log_path = folder/'result.mp3', folder/'run.log'
        with log_path.open('ab', buffering=0) as log:
            tree = ProcessTree(command(request, self.python, self.pipeline, folder/'work', result),
                               cwd=self.root, env=env, log=log, control=self.data/'control')
            try:
                while tree.poll() is None:
                    interrupted()
                    self.progress(job, log_path)
                    time.sleep(.2)
                code = tree.poll()
                self.progress(job, log_path)
                if self.cancelled(job):
                    raise Cancelled()
            finally:
                tree.close()
        if code in (0, 2) and result.is_file() and result.stat().st_size > 0:
            state = 'succeeded' if code == 0 else 'succeeded_with_warnings'
            self.update(job, state=state, stage='finished', exit_code=code, finished=time.time())
        else:
            self.update(job, state='failed', stage='failed', exit_code=code, finished=time.time(),
                        error=f'Pipeline exited {code}; see log')
            # A failed client may have abandoned an RPC that is still consuming the GPU.
            self.engine.reset()
        self.engine.refresh()

    def progress(self, job, path):
        tail = self.logs(job)
        matches = re.findall(r'\]\s+([0-4])/4\s+([^\r\n]+)', tail)
        if 'DONE ' in tail:
            stage = 'quality_check'
        elif matches:
            number, detail = matches[-1]
            stage = ['decode', 'separate', 'rvc', 'polish', 'mix'][int(number)]
        else:
            stage = 'running'
        self.update(job, stage=stage)

    def logs(self, job):
        self.get(job)
        path = self.data/'jobs'/job/'run.log'
        if not path.exists():
            return ''
        with path.open('rb') as f:
            f.seek(max(0, path.stat().st_size - 32768))
            return f.read().decode('utf-8', errors='replace')

    def close(self):
        self.stop.set()
        self.wake.set()
        if self.thread:
            self.thread.join(timeout=25)
        self.engine.reset()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class Handler(BaseHTTPRequestHandler):
    server_version = 'VoiceLabSinging/1'

    @property
    def manager(self):
        return self.server.manager

    def log_message(self, fmt, *args):
        print(time.strftime('%Y-%m-%d %H:%M:%S'), fmt % args, file=sys.stderr, flush=True)

    def send_json(self, code, value):
        data = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def authenticated(self):
        token = self.server.token
        if self.headers.get('Origin') or token and not secrets.compare_digest(
                self.headers.get('Authorization', ''), 'Bearer '+token):
            self.send_json(403, {'error': 'Local API authorization required; browser origins are rejected'})
            return False
        return True

    def body(self):
        if self.headers.get_content_type() != 'application/json':
            raise ValueError('Content-Type must be application/json')
        size = int(self.headers.get('Content-Length', '0'))
        if not 0 <= size <= 65536:
            raise ValueError('JSON request exceeds 64 KiB')
        self.connection.settimeout(10)
        return json.loads(self.rfile.read(size) or b'{}')

    def do_GET(self):
        if not self.authenticated():
            return
        parts = urlsplit(self.path).path.strip('/').split('/')
        try:
            if parts == ['health']:
                return self.send_json(200, {'service': SERVICE, 'api_version': VERSION,
                    'ready': bool(self.manager.thread and self.manager.thread.is_alive()),
                    'pid': os.getpid(), 'active_job': self.manager.active,
                    'rvc': self.manager.engine.status})
            if parts == ['jobs']:
                return self.send_json(200, {'jobs': self.manager.list()})
            if len(parts) in (2, 3) and parts[0] == 'jobs':
                job = self.manager.get(parts[1])
                if len(parts) == 2:
                    return self.send_json(200, job)
                if parts[2] == 'log':
                    return self.send_json(200, {'id': job['id'], 'log': self.manager.logs(job['id'])})
                if parts[2] == 'result':
                    if job['state'] not in SUCCESS:
                        return self.send_json(409, {'error': 'Result is not ready', 'state': job['state']})
                    path = self.manager.data/'jobs'/job['id']/'result.mp3'
                    with path.open('rb') as f:
                        self.send_response(200)
                        self.send_header('Content-Type', 'audio/mpeg')
                        self.send_header('Content-Length', str(path.stat().st_size))
                        self.send_header('Content-Disposition', f'attachment; filename="{job["id"]}.mp3"')
                        self.end_headers()
                        while True:
                            data = f.read(65536)
                            if not data:
                                return
                            self.wfile.write(data)
            self.send_json(404, {'error': 'Unknown endpoint'})
        except (KeyError, FileNotFoundError):
            self.send_json(404, {'error': 'Job or result not found'})
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        if not self.authenticated():
            return
        parts = urlsplit(self.path).path.strip('/').split('/')
        try:
            payload = self.body()
            if parts == ['jobs']:
                job, created = self.manager.submit(payload)
                return self.send_json(202 if created else 200, job)
            if len(parts) == 3 and parts[0] == 'jobs' and parts[2] == 'cancel':
                return self.send_json(202, self.manager.cancel(parts[1]))
            if parts == ['shutdown']:
                self.send_json(202, {'stopping': True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            self.send_json(404, {'error': 'Unknown endpoint'})
        except (ValueError, TypeError) as exc:
            self.send_json(400, {'error': str(exc)})
        except KeyError:
            self.send_json(404, {'error': 'Unknown job'})
        except Conflict as exc:
            self.send_json(409, {'error': str(exc)})
        except Full as exc:
            self.send_json(429, {'error': str(exc)})


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--root', type=Path, default=ROOT)
    ap.add_argument('--data-dir', type=Path, default=DEFAULT_DATA)
    ap.add_argument('--port', type=int, default=8766)
    ap.add_argument('--worker-port', type=int, default=8767)
    ap.add_argument('--job-timeout', type=float, default=1800)
    ap.add_argument('--max-queue', type=int, default=32)
    ap.add_argument('--log', type=Path)
    ap.add_argument('--token-file', type=Path)
    a = ap.parse_args()
    if a.log:
        a.log.parent.mkdir(parents=True, exist_ok=True)
        sys.stdout = sys.stderr = a.log.open('a', encoding='utf-8', buffering=1)
    from cover_support import FileLock
    a.data_dir.mkdir(parents=True, exist_ok=True)
    with FileLock(a.data_dir/'server.lock'):
        manager = Manager(a.root, a.data_dir, worker_port=a.worker_port,
                          max_queue=a.max_queue, timeout=a.job_timeout)
        server = Server(('127.0.0.1', a.port), Handler)
        token = a.token_file.read_text('utf-8').strip() if a.token_file else os.environ.get('SING_SERVICE_TOKEN', '')
        server.manager, server.token = manager, token
        manager.start()
        print(f'{SERVICE} listening on 127.0.0.1:{a.port}; data={a.data_dir}', flush=True)
        try:
            server.serve_forever(poll_interval=.2)
        except KeyboardInterrupt:
            pass
        finally:
            manager.close()
            server.server_close()


if __name__ == '__main__':
    main()
