"""Own process trees so cancellation cannot leave ffmpeg or CUDA children running."""
from __future__ import annotations

import os
from pathlib import Path
import signal
import subprocess
import time
import uuid


def wait_gate():
    value = os.environ.pop('SING_START_GATE', '')
    if not value:
        return
    gate = Path(value)
    deadline = time.monotonic() + 15
    while not gate.exists():
        if time.monotonic() > deadline:
            raise RuntimeError('Supervisor did not release the process startup gate')
        time.sleep(0.02)
    gate.unlink(missing_ok=True)


class ProcessTree:
    def __init__(self, command, *, cwd, env, log, control):
        self.process = None
        self.handle = None
        control = Path(control)
        control.mkdir(parents=True, exist_ok=True)
        gate = control / (uuid.uuid4().hex + '.gate')
        child_env = {**env, 'SING_START_GATE': str(gate)}
        try:
            self.process = subprocess.Popen(command, cwd=cwd, env=child_env, stdout=log,
                                            stderr=subprocess.STDOUT,
                                            creationflags=0x08000000 if os.name == 'nt' else 0,
                                            start_new_session=os.name != 'nt')
            if os.name == 'nt':
                self._attach_job()
            # Children wait here before creating descendants, closing the assignment race.
            gate.touch()
        except BaseException:
            self.stop()
            gate.unlink(missing_ok=True)
            raise

    def _attach_job(self):
        import ctypes as c
        from ctypes import wintypes as w

        class Basic(c.Structure):
            _fields_ = [('process_time', c.c_int64), ('job_time', c.c_int64), ('flags', w.DWORD),
                        ('min_ws', c.c_size_t), ('max_ws', c.c_size_t), ('process_limit', w.DWORD),
                        ('affinity', c.c_size_t), ('priority', w.DWORD), ('scheduling', w.DWORD)]

        class IO(c.Structure):
            _fields_ = [(name, c.c_uint64) for name in ('r', 'w', 'o', 'rb', 'wb', 'ob')]

        class Extended(c.Structure):
            _fields_ = [('basic', Basic), ('io', IO), ('process_memory', c.c_size_t),
                        ('job_memory', c.c_size_t), ('peak_process', c.c_size_t), ('peak_job', c.c_size_t)]

        self.kernel = c.WinDLL('kernel32', use_last_error=True)
        self.kernel.CreateJobObjectW.argtypes = [w.LPVOID, w.LPCWSTR]
        self.kernel.CreateJobObjectW.restype = w.HANDLE
        self.kernel.SetInformationJobObject.argtypes = [w.HANDLE, c.c_int, w.LPVOID, w.DWORD]
        self.kernel.SetInformationJobObject.restype = w.BOOL
        self.kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        self.kernel.AssignProcessToJobObject.restype = w.BOOL
        self.kernel.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]
        self.kernel.TerminateJobObject.restype = w.BOOL
        self.kernel.CloseHandle.argtypes = [w.HANDLE]
        self.kernel.CloseHandle.restype = w.BOOL
        self.handle = self.kernel.CreateJobObjectW(None, None)
        if not self.handle:
            raise c.WinError(c.get_last_error())
        info = Extended()
        info.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.kernel.SetInformationJobObject(self.handle, 9, c.byref(info), c.sizeof(info)):
            raise c.WinError(c.get_last_error())
        if not self.kernel.AssignProcessToJobObject(self.handle, int(self.process._handle)):
            raise c.WinError(c.get_last_error())

    def poll(self):
        return self.process.poll()

    def stop(self):
        if self.handle:
            self.kernel.TerminateJobObject(self.handle, 1)
            self.kernel.CloseHandle(self.handle)
            self.handle = None
        elif self.process and self.process.poll() is None:
            if os.name == 'nt':
                self.process.kill()
            else:
                os.killpg(self.process.pid, signal.SIGKILL)
        if self.process:
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)

    def close(self):
        # Closing also removes stray descendants after an apparently successful parent exit.
        self.stop()
