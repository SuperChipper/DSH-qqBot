"""File identities, stereo mixing and sample based repairs for cover.py."""
from __future__ import annotations

import hashlib
import json
import os
import time
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def audio_scratch(parent):
    import uuid
    # tempfile's private directory ACL can prevent sandboxed ffmpeg from writing.
    directory = Path(parent) / ('cover-check-' + uuid.uuid4().hex)
    directory.mkdir()
    try:
        yield directory
    finally:
        (directory / 'check.wav').unlink(missing_ok=True)
        directory.rmdir()


class FileLock:
    """Kernel-owned locks are released even when a worker is killed; no stale PID cleanup."""
    def __init__(self, path, timeout=0):
        self.path, self.timeout = Path(path), timeout
        self.file = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.file = self.path.open('a+b')
        if not self.path.stat().st_size:
            self.file.write(b'0')
            self.file.flush()
        deadline, announced = time.monotonic() + self.timeout, False
        while True:
            try:
                self.file.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except OSError:
                if time.monotonic() >= deadline:
                    self.file.close()
                    self.file = None
                    raise RuntimeError(f'任务忙/锁等待超时: {self.path}') from None
                if not announced:
                    print(f'等待 GPU 空闲: {self.path}', flush=True)
                    announced = True
                time.sleep(0.2)

    def __exit__(self, *exc):
        if self.file is not None:
            try:
                self.file.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self.file.fileno(), fcntl.LOCK_UN)
            finally:
                self.file.close()
                self.file = None


@contextmanager
def gpu_guard(root):
    lock_root = Path(os.environ.get('COVER_LOCK_ROOT') or Path(root) / '.locks').resolve()
    # The parent keeps the OS lock while its child runs, avoiding nested-lock deadlock.
    if os.environ.get('COVER_GPU_LOCK_HELD') == str(lock_root):
        yield lock_root
    else:
        with FileLock(lock_root / 'gpu.lock', timeout=900):
            yield lock_root


def identity(path):
    p = Path(path).resolve()
    if not p.is_file():
        return {"path": str(p), "missing": True}
    h = hashlib.sha256()
    with p.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return {"path": str(p), "size": p.stat().st_size, "sha256": h.hexdigest()}


def atomic_json(path, value):
    p = Path(path)
    tmp = p.with_name(p.name + f".{os.getpid()}.tmp")
    try:
        tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, p)
    finally:
        tmp.unlink(missing_ok=True)


def load_channels(path, sr=44100):
    import librosa
    import numpy as np
    import soundfile as sf
    y, rate = sf.read(str(path), dtype="float32", always_2d=True)
    if not len(y) or not np.isfinite(y).all():
        raise ValueError(f"Empty or non-finite audio: {path}")
    if rate != sr:
        y = librosa.resample(y, orig_sr=rate, target_sr=sr, axis=0)
    if y.shape[1] == 1:
        y = np.repeat(y, 2, axis=1)
    if y.shape[1] != 2:
        raise ValueError(f"Expected mono/stereo audio: {path}")
    return y


def mix_stereo(vocal, accompaniment, vocal_gain=1.0, inst_gain=0.9, backing=None,
               backing_gain=1.0, sr=44100):
    import numpy as np
    v = np.asarray(vocal).reshape(-1, 1)
    i = np.asarray(accompaniment)
    # Silent padding preserves the song tail; a lost chunk must not disappear silently.
    if abs(len(v) - len(i)) > int(0.1 * sr):
        raise ValueError("Vocal/accompaniment length mismatch exceeds 100 ms")
    mix = i.astype(np.float32).copy() * inst_gain
    n = min(len(v), len(mix))
    mix[:n] += v[:n] * vocal_gain
    if backing is not None:
        if abs(len(backing) - len(i)) > int(0.1 * sr):
            raise ValueError("Backing/accompaniment length mismatch exceeds 100 ms")
        n = min(len(backing), len(mix))
        mix[:n] += backing[:n] * backing_gain
    peak = float(np.abs(mix).max())
    if peak > 0.97:
        mix *= 0.97 / peak
    return mix


def splice_patch(base, rendered, start, end, context_start, sr=44100, fade=0.08):
    """Keep the original sample grid and match gain using the surrounding context."""
    import numpy as np
    base, rendered = np.asarray(base), np.asarray(rendered)
    s, e = round(start * sr), round(end * sr)
    offset = s - round(context_start * sr)
    if not (0 <= s < e <= len(base)) or offset < 0:
        raise ValueError("Repair interval is outside the base audio")
    if offset + e - s > len(rendered):
        raise ValueError("RVC repair is too short; refusing to truncate the song")
    # Compare context outside the damaged phrase so damage itself cannot drive the gain.
    pairs = []
    for b0, b1, r0, r1 in (
        (max(0, s - sr // 2), s, max(0, offset - sr // 2), offset),
        (e, min(len(base), e + sr // 2), offset + e - s,
         min(len(rendered), offset + e - s + sr // 2)),
    ):
        n = min(b1 - b0, r1 - r0)
        if n > sr // 20:
            x, y = base[b0:b0+n], rendered[r0:r0+n]
            xr, yr = np.sqrt(np.mean(x*x)), np.sqrt(np.mean(y*y))
            if min(xr, yr) > 1e-4:
                pairs.append(xr / yr)
    gain = float(np.clip(np.median(pairs), 10**(-3/20), 10**(3/20))) if pairs else 1.0
    replacement = rendered[offset:offset + e - s] * gain
    weight = np.ones(e - s, dtype=np.float32)
    k = min(round(fade * sr), len(weight) // 2)
    if k > 1:
        weight[:k] = np.linspace(0, 1, k)
        weight[-k:] = np.linspace(1, 0, k)
    out = base.copy()
    out[s:e] = base[s:e] * (1 - weight) + replacement * weight
    return out, gain


def confident_octaves(f0, reference, probability, min_probability=0.9, min_frames=8):
    """Only change sustained, confident octave disagreements; leave ambiguity audible."""
    import numpy as np
    out = np.asarray(f0).copy()
    n = min(len(out), len(reference), len(probability))
    a, b = out[:n], np.asarray(reference)[:n]
    valid = (a > 0) & np.isfinite(b) & (b > 0) & (np.asarray(probability)[:n] >= min_probability)
    with np.errstate(divide="ignore", invalid="ignore"):
        delta = 12 * np.log2(a / b)
    shift = np.clip(np.rint(-delta / 12), -1, 1)
    mask = valid & (np.abs(shift) == 1) & (np.abs(delta + 12 * shift) <= 1)
    i, fixed = 0, 0
    while i < n:
        if not mask[i]:
            i += 1
            continue
        j = i + 1
        while j < n and mask[j] and shift[j] == shift[i]:
            j += 1
        if j - i >= min_frames:
            out[i:j] *= 2.0 ** shift[i]
            fixed += j - i
        i = j
    return out, fixed
