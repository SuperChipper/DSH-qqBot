import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import sys

from sing_api import rpc, validate
from sing_service import Manager, Server, Handler, Full, Conflict


class FakeEngine:
    def __init__(self):
        self.status = {'ready': False, 'warmed': False}
        self.resets = 0

    def ensure(self, cancelled):
        self.status = {'ready': True, 'warmed': True}

    def environment(self):
        return {}

    def refresh(self):
        pass

    def reset(self):
        self.resets += 1
        self.status = {'ready': False, 'warmed': False}


FAKE = '''
import sys,os,time,argparse,subprocess
from pathlib import Path
sys.path.insert(0, SERVICE_SOURCE)
from sing_process import wait_gate
wait_gate()
ap=argparse.ArgumentParser()
ap.add_argument('song',nargs='?')
ap.add_argument('--out',required=True)
ap.add_argument('--workdir',required=True)
ap.add_argument('--dur',type=float,default=.1)
a,rest=ap.parse_known_args()
Path(a.workdir).mkdir(parents=True,exist_ok=True)
if 'child' in a.song:
    child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'])
    Path(a.workdir,'child.pid').write_text(str(child.pid))
print('[   0.0s] 0/4 decode',flush=True)
time.sleep(a.dur)
if 'fail' in a.song:sys.exit(7)
Path(a.out).write_bytes(b'ID3fake-result')
print('[   0.1s] DONE '+a.out,flush=True)
sys.exit(2 if 'warn' in a.song else 0)
'''


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root/'song.wav'
        self.source.write_bytes(b'test')
        self.pipeline = self.root/'fake.py'
        self.pipeline.write_text('SERVICE_SOURCE='+repr(str(Path(__file__).parent.resolve()))+'\n'+FAKE, encoding='utf-8')
        self.manager = self.make_manager()
        self.addCleanup(self.manager.close)

    def make_manager(self, **kw):
        return Manager(self.root, self.root/'data', allowed=[self.root], python=sys.executable,
                       pipeline=self.pipeline, engine=FakeEngine(), **kw)

    def start_http(self):
        self.manager.start()
        server = Server(('127.0.0.1', 0), Handler)
        server.manager, server.token = self.manager, 'unit-token'
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f'http://127.0.0.1:{server.server_port}'

    def request(self, delay=.1, source=None, **options):
        return {'song': str(source or self.source), 'options': {'dur': delay, **options}}

    def wait(self, job, states=None):
        states = states or {'succeeded', 'succeeded_with_warnings', 'failed', 'cancelled', 'timed_out'}
        deadline = time.monotonic()+10
        while time.monotonic() < deadline:
            value = self.manager.get(job)
            if value['state'] in states:
                return value
            time.sleep(.03)
        self.fail('Timed out: '+repr(self.manager.get(job)))

    def test_http_returns_202_before_audio_finishes(self):
        url = self.start_http()
        start = time.monotonic()
        req = Request(url+'/jobs', data=json.dumps(self.request(1)).encode(),
                      headers={'Content-Type': 'application/json', 'Authorization': 'Bearer unit-token'})
        with urlopen(req, timeout=3) as response:
            self.assertEqual(response.status, 202)
            job = json.load(response)
        self.assertLess(time.monotonic()-start, .7)
        self.assertNotIn(job['state'], {'succeeded', 'failed'})
        self.assertTrue(rpc(url+'/health', token='unit-token')['ready'])
        self.assertEqual(self.wait(job['id'])['state'], 'succeeded')
        req = Request(url+f'/jobs/{job["id"]}/result', headers={'Authorization':'Bearer unit-token'})
        with urlopen(req) as response:
            self.assertEqual(response.read(), b'ID3fake-result')

    def test_queue_is_single_consumer(self):
        one, _ = self.manager.submit(self.request(.7))
        two, _ = self.manager.submit(self.request(.1))
        self.manager.start()
        self.wait(one['id'], {'running'})
        self.assertEqual(self.manager.get(two['id'])['state'], 'queued')
        self.assertEqual(self.wait(two['id'])['state'], 'succeeded')
        self.assertLessEqual(self.manager.get(one['id'])['finished'], self.manager.get(two['id'])['started'])

    def test_queued_cancel_never_executes(self):
        job, _ = self.manager.submit(self.request())
        self.assertEqual(self.manager.cancel(job['id'])['state'], 'cancelled')
        self.manager.start()
        time.sleep(.2)
        self.assertFalse((self.manager.data/'jobs'/job['id']/'run.log').exists())

    def test_active_cancel_stops_child_tree(self):
        source = self.root/'child.wav'
        source.touch()
        job, _ = self.manager.submit(self.request(30, source))
        self.manager.start()
        pidfile = self.manager.data/'jobs'/job['id']/'work/child.pid'
        deadline = time.monotonic()+5
        while not pidfile.exists() and time.monotonic() < deadline:
            time.sleep(.03)
        self.assertTrue(pidfile.exists(), self.manager.logs(job['id']))
        child = int(pidfile.read_text())
        self.manager.cancel(job['id'])
        self.assertEqual(self.wait(job['id'])['state'], 'cancelled')
        if os.name == 'nt':
            import ctypes as c
            from ctypes import wintypes as w
            kernel = c.WinDLL('kernel32',use_last_error=True)
            kernel.OpenProcess.argtypes = [w.DWORD,w.BOOL,w.DWORD]
            kernel.OpenProcess.restype = w.HANDLE
            handle = kernel.OpenProcess(0x1000,False,child)
            if handle:
                code = w.DWORD()
                kernel.GetExitCodeProcess.argtypes = [w.HANDLE,c.POINTER(w.DWORD)]
                kernel.GetExitCodeProcess(handle,c.byref(code))
                kernel.CloseHandle.argtypes=[w.HANDLE]
                kernel.CloseHandle(handle)
                self.assertNotEqual(code.value,259,'Child still running after cancellation')
        else:
            import signal
            try:
                os.kill(child,0)
                state=Path(f'/proc/{child}/stat').read_text().split()[2]
                self.assertEqual(state,'Z')
            except ProcessLookupError:
                pass

    def test_timeout_and_warnings_are_distinct(self):
        self.manager.timeout = .2
        slow, _ = self.manager.submit(self.request(3))
        self.manager.start()
        self.assertEqual(self.wait(slow['id'])['state'], 'timed_out')
        self.manager.timeout = 5
        source = self.root/'warn.wav'
        source.touch()
        warn, _ = self.manager.submit(self.request(.01, source))
        self.assertEqual(self.wait(warn['id'])['state'], 'succeeded_with_warnings')

    def test_idempotency_and_queue_limit(self):
        req = {**self.request(), 'idempotency_key': 'same'}
        one, created = self.manager.submit(req)
        two, created = self.manager.submit(req)
        self.assertFalse(created)
        self.assertEqual(one['id'], two['id'])
        with self.assertRaises(Conflict):
            self.manager.submit({**req, 'options': {'dur': 2}})
        self.manager.max_queue = 1
        with self.assertRaises(Full):
            self.manager.submit(self.request())

    def test_restart_keeps_queue_and_marks_running_interrupted(self):
        first, _ = self.manager.submit(self.request())
        second, _ = self.manager.submit(self.request())
        self.manager.claim()
        replacement = self.make_manager()
        self.addCleanup(replacement.close)
        self.assertEqual(replacement.get(first['id'])['state'], 'interrupted')
        self.assertEqual(replacement.get(second['id'])['state'], 'queued')

    def test_rejects_arbitrary_cli_and_path_escape(self):
        for options in ({'out': 'elsewhere.mp3'}, {'protect': True}, {'air': float('nan')},
                        {'model': '../other.pth'}, {'pitch': 1.2}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.manager.submit(self.request(**options))
        with self.assertRaises(ValueError):
            self.manager.submit({'song': str(Path(__file__).resolve())})

    def test_http_auth_origin_and_result_not_ready(self):
        url = self.start_http()
        with self.assertRaises(HTTPError) as e:
            rpc(url+'/health')
        self.assertEqual(e.exception.code,403)
        req=Request(url+'/health',headers={'Authorization':'Bearer unit-token','Origin':'https://example.org'})
        with self.assertRaises(HTTPError) as e:
            urlopen(req)
        self.assertEqual(e.exception.code,403)
        job=rpc(url+'/jobs',self.request(1),token='unit-token')
        with self.assertRaises(HTTPError) as e:
            rpc(url+f'/jobs/{job["id"]}/result',token='unit-token')
        self.assertEqual(e.exception.code,409)


if __name__ == '__main__':
    unittest.main(verbosity=2)
