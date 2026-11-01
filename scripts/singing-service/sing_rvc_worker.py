"""Private loopback RVC backend; models, HuBERT and RMVPE survive between jobs."""
from __future__ import annotations

import argparse
from contextlib import ExitStack
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sing_process import wait_gate
from sing_api import local_path


class Backend:
    def __init__(self, root, data):
        self.root, self.data = root.resolve(), data.resolve()
        self.rvc = self.root/'rvc/pkg/RVC20240604Nvidia50x0'
        os.chdir(self.rvc)
        sys.path.insert(0, str(self.rvc))
        sys.path.insert(0, str(self.root/'scripts'))
        sys.argv = sys.argv[:1]
        from dotenv import load_dotenv
        load_dotenv(self.rvc/'.env')
        os.environ['weight_root'] = str(self.rvc/'assets/weights')
        import cover
        os.environ['PATH'] = str(cover.FFDIR) + os.pathsep + os.environ.get('PATH', '')
        os.environ.setdefault('RVC_F0_OCTAVE_FIX', 'ref')
        os.environ.pop('COVER_GPU_LOCK_HELD', None)
        from configs.config import Config
        self.config = Config()
        self.vc = None
        self.model_key = None
        self.busy = threading.Lock()
        self.loads, self.inferences = 0, 0
        self.model = None

    def status(self):
        return {'service': 'voice-lab-rvc-worker', 'ready': True, 'warmed': self.vc is not None,
                'model': self.model, 'model_loads': self.loads, 'inferences': self.inferences,
                'pid': os.getpid(), 'busy': self.busy.locked()}

    def infer(self, body):
        import numpy as np
        import soundfile as sf
        from cover_support import gpu_guard, identity
        from infer.modules.vc.modules import VC
        from infer.lib.audio import load_audio
        if not isinstance(body, dict) or set(body) - {'input_path', 'opt_path', 'model_name', 'f0up_key',
                'f0method', 'index_path', 'index_rate', 'filter_radius', 'rms_mix_rate', 'protect',
                'f0_file', 'f0_dump', 'octave_fix'}:
            raise ValueError('Invalid inference request')
        sources = [self.root.parent, self.data]
        source = local_path(body['input_path'], sources)
        target = Path(body['opt_path']).resolve()
        dump = Path(body['f0_dump']).resolve()
        jobs = self.data/'jobs'
        if jobs not in target.parents or jobs not in dump.parents:
            raise ValueError('RVC output must be inside the service jobs directory')
        name = body['model_name']
        if not isinstance(name, str) or Path(name).name != name or not name.endswith('.pth'):
            raise ValueError('Invalid model name')
        weight = self.rvc/'assets/weights'/name
        if not weight.is_file():
            raise ValueError('Unknown model')
        method = body.get('f0method', 'rmvpe')
        if method not in ('rmvpe', 'harvest', 'pm', 'crepe'):
            raise ValueError('Unknown f0 method')
        mode = body.get('octave_fix', 'ref')
        if mode not in ('', 'off', 'ref', '1', 'true', 'yes', 'acf'):
            raise ValueError('Unknown octave-fix mode')
        index = ''
        if body.get('index_path'):
            index = local_path(body['index_path'], [self.rvc/'assets'])
        manual = local_path(body['f0_file'], sources) if body.get('f0_file') else ''
        for key, low, high in [('f0up_key', -24, 24), ('index_rate', 0, 1), ('filter_radius', 0, 15),
                               ('rms_mix_rate', 0, 1), ('protect', 0, .5)]:
            value = body[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not np.isfinite(value) or not low <= value <= high:
                raise ValueError(f'Invalid {key}')
        if manual:
            curve = np.loadtxt(manual, delimiter=',', ndmin=2)
            if (curve.shape[1] != 2 or len(curve) < 2 or not np.isfinite(curve).all()
                    or abs(curve[0, 0]) > 1e-6 or (np.diff(curve[:, 0]) <= 0).any()
                    or (curve[:, 1] < 0).any() or (curve[:, 1] > 1200).any()
                    or curve[-1, 0] < len(load_audio(source, 16000))/16000-.02):
                raise ValueError('Invalid or incomplete target F0 CSV')
        target.parent.mkdir(parents=True, exist_ok=True)
        dump.parent.mkdir(parents=True, exist_ok=True)
        start = time.monotonic()
        with gpu_guard(self.root), ExitStack() as stack:
            key = identity(weight)['sha256']
            if self.model_key != key:
                if self.vc is not None:
                    import gc
                    import torch
                    self.vc = None
                    gc.collect()
                    torch.cuda.empty_cache()
                self.vc = VC(self.config)
                self.vc.get_vc(name)
                self.model_key, self.model = key, name
                self.loads += 1
            os.environ['RVC_F0_OCTAVE_FIX'] = mode
            os.environ['RVC_F0_DUMP'] = str(dump)
            handle = stack.enter_context(open(manual, 'r')) if manual else None
            try:
                info, audio = self.vc.vc_single(0, source, int(body['f0up_key']), handle, method,
                    index, None, body['index_rate'], int(body['filter_radius']), 0,
                    body['rms_mix_rate'], body['protect'])
                if audio is None or audio[0] is None or audio[1] is None:
                    raise RuntimeError(info)
                # Write a sibling first so a failed inference never exposes half a WAV.
                temporary = target.with_name(target.stem+'.pending.wav')
                try:
                    sf.write(temporary, audio[1], audio[0], subtype='PCM_16')
                    temporary.replace(target)
                finally:
                    temporary.unlink(missing_ok=True)
                self.inferences += 1
            finally:
                os.environ.pop('RVC_F0_DUMP', None)
        return {'ok': True, 'seconds': time.monotonic()-start, **self.status()}


class Handler(BaseHTTPRequestHandler):
    def send_json(self, code, value):
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def auth(self):
        return not self.headers.get('Origin') and secrets.compare_digest(
            self.headers.get('Authorization', ''), 'Bearer '+self.server.token)

    def do_GET(self):
        if not self.auth():
            return self.send_json(403, {'error': 'Private worker'})
        if self.path == '/health':
            return self.send_json(200, self.server.backend.status())
        self.send_json(404, {'error': 'Unknown endpoint'})

    def do_POST(self):
        if not self.auth():
            return self.send_json(403, {'error': 'Private worker'})
        if self.path != '/infer':
            return self.send_json(404, {'error': 'Unknown endpoint'})
        if not self.server.backend.busy.acquire(blocking=False):
            return self.send_json(429, {'error': 'Worker is busy'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 65536 or self.headers.get_content_type() != 'application/json':
                raise ValueError('Expected JSON under 64 KiB')
            self.connection.settimeout(10)
            result = self.server.backend.infer(json.loads(self.rfile.read(size)))
            self.send_json(200, result)
        except (ValueError, KeyError, TypeError) as exc:
            self.send_json(400, {'error': str(exc)})
        except Exception as exc:
            import traceback
            traceback.print_exc()
            self.send_json(500, {'error': str(exc)})
        finally:
            self.server.backend.busy.release()


def main():
    wait_gate()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--root', type=Path, required=True)
    ap.add_argument('--data-dir', type=Path, required=True)
    ap.add_argument('--port', type=int, default=8767)
    a = ap.parse_args()
    token = os.environ.get('SING_WORKER_TOKEN', '')
    if not token:
        raise RuntimeError('Private worker requires SING_WORKER_TOKEN')
    backend = Backend(a.root, a.data_dir)
    server = ThreadingHTTPServer(('127.0.0.1', a.port), Handler)
    server.daemon_threads = True
    server.backend, server.token = backend, token
    try:
        server.serve_forever(poll_interval=.2)
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
