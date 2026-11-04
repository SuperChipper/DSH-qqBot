"""大肥鱼翻唱流水线 —— 一首歌进，一个 mix 出。

把《人は猫》那一轮踩出来的东西固化成一条能重跑的路：下载/解码 → 分离人声 →
RVC 换嗓 → 换气+润色 → 混音导出 → 自检。参数是那一轮扫出来的最优组合，别乱改。

用法（必须用 voice-lab\\env 的 python，脚本会自己切）：
    env\\python.exe scripts\\cover.py <歌曲文件或B站链接> [选项]
    env\\python.exe scripts\\cover.py tmp\\sing\\renshimao.wav --slug renshimao
    env\\python.exe scripts\\cover.py song.wav --dur 30 --force       # 只试前 30 秒
    env\\python.exe scripts\\cover.py --check <mix 或 mp3>            # 只做自检

产物在 tmp\\cover\\<slug>\\ 下，每一步都有中间文件，改参数只会重跑受影响的那几步
（参数变了会提示加 --force）。最终文件 default: tmp\\cover\\<slug>\\<slug>_feiyu.mp3

分步：
    --only 0,1,2     只跑到第 N 步（0=解码 1=分离 2=RVC 3=润色 4=混音）
"""
from __future__ import annotations

import argparse
import copy
import hashlib
from contextlib import ExitStack
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from cover_support import identity, atomic_json, load_channels, mix_stereo, splice_patch, FileLock, gpu_guard, audio_scratch

ROOT = Path(__file__).resolve().parent.parent
RVC = ROOT / "rvc" / "pkg" / "RVC20240604Nvidia50x0"
ENVPY = ROOT / "env" / "python.exe"
RVCPY = RVC / "runtime" / "python.exe"
# COVER_FFMPEG_DIR 优先，否则用 winget 装的位置；都没有就靠 PATH
FFDIR = Path(os.environ.get("COVER_FFMPEG_DIR") or (
    Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Packages"
    / "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe" / "ffmpeg-9.0.2-full_build" / "bin"))
FFMPEG = FFDIR / "ffmpeg.exe" if (FFDIR / "ffmpeg.exe").exists() else Path("ffmpeg")
TMP = ROOT.parent / "tmp" / "cover"

SR = 44100
MODEL = "feiyu40k_aux70_ab_20261102_e10.pth"
INDEX = RVC / "assets" / "indices" / "feiyu40k_hi_IVF1480_Flat_nprobe_1_feiyu40k_hi.index"

# 策略按「源人声中位音高」分档，不按原唱性别。尺子是模型实测音域：
# p05 207 / p50 300 / p90 373 / p99 462 Hz，0% 的帧低于 150 Hz。
PRESETS = {
    # ≥260 Hz：默认那套，什么都别改
    "female": {},
    # 200~260 Hz：不升调，靠参数把人声磨薄（Lemon 244 / 七百年后 227）
    "male-thin": {
        "index_rate": 0.8, "protect": 0.4,
        "presence_db": 5.0, "lowcut": 90.0, "low_shelf": -2.0,
    },
    # <200 Hz：真男中音/低音，升 4 个半音，伴奏同步（--inst-transpose 自动跟）
    "low": {
        "pitch": 4,
        "index_rate": 0.7, "protect": 0.45,
        "presence_db": 4.0, "lowcut": 70.0, "low_shelf": -2.0,
    },
}
AUTO_BANDS = ((260.0, "female"), (200.0, "male-thin"), (0.0, "low"))

T0 = time.time()


def log(msg: str) -> None:
    print(f"[{time.time() - T0:6.1f}s] {msg}", flush=True)


def sh(cmd, cwd=None, capture=True, env_updates=None):
    env = os.environ.copy()
    env["PATH"] = str(FFDIR) + os.pathsep + env.get("PATH", "")
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env.setdefault("TORCH_HOME", str(ROOT / "models"))
    # rmvpe 在高音区会整体掉一个八度；ref = 拿 pyin 做第二意见，只在八度级分歧上改
    env.setdefault("RVC_F0_OCTAVE_FIX", "ref")
    env.update(env_updates or {})
    gpu = any(str(c) in ("demucs", "tools/infer_cli.py") or
              Path(str(c)).name in ("cover_separate.py", "cover_roformer.py") for c in cmd)
    with ExitStack() as locks:
        if gpu:
            root = locks.enter_context(gpu_guard(ROOT))
            env["COVER_GPU_LOCK_HELD"] = str(root)
        p = subprocess.run([str(c) for c in cmd], cwd=str(cwd) if cwd else None, env=env,
                           capture_output=capture, text=True,
                           encoding="utf-8", errors="replace")
    if p.returncode != 0:
        out = ((p.stdout or "") + "\n" + (p.stderr or "")).strip().splitlines()
        raise SystemExit("[fail] " + " ".join(Path(str(c)).name for c in cmd[:4])
                         + "\n" + "\n".join(out[-25:]))
    return p


def slugify(s: str) -> str:
    keep = [c if (c.isalnum() or c in "-_") else "_" for c in s]
    return "".join(keep).strip("_")[:40] or "song"


# ---------------------------------------------------------------- audio utils

def load_mono(path, sr=SR):
    import librosa, numpy as np, soundfile as sf
    y, s = sf.read(str(path), always_2d=True, dtype="float32")
    y = y.mean(axis=1)
    if s != sr:
        y = librosa.resample(y, orig_sr=s, target_sr=sr)
    return np.ascontiguousarray(y, dtype=np.float32)


def rms_db(y) -> float:
    import numpy as np
    return 20 * float(np.log10(np.sqrt((np.asarray(y, dtype=np.float64) ** 2).mean()) + 1e-12))


def stamp(p) -> dict:
    """Hash content as well as the path; same-size edits must invalidate downstream stages."""
    return identity(p)


def breath_splice(voc, src, sr=SR, gate_db=-30.0, win=2.0, mode="safe", f0_path=None):
    """弱假声也可能无可靠输出F0；safe 模式必须用目标曲线和源有声证据否决回填。"""
    import librosa
    import numpy as np
    from scipy.ndimage import maximum_filter1d
    from scipy.signal import butter, sosfilt

    n = min(voc.size, src.size)
    v = voc[:n].copy()
    if mode == "off" or (mode == "safe" and not f0_path):
        return v, np.zeros(n, dtype=np.float32)
    y16 = librosa.resample(v, orig_sr=sr, target_sr=16000)
    f0 = librosa.pyin(y16, fmin=60, fmax=1200, sr=16000,
                      hop_length=160, frame_length=1024)[0]
    voiced = (~np.isnan(f0)).astype(np.float32)
    idx = np.clip((np.arange(n) / sr * 100).astype(int), 0, voiced.size - 1)
    mask = 1.0 - voiced[idx]

    e = librosa.feature.rms(y=v, frame_length=1024, hop_length=441)[0]
    edb = 20 * np.log10(np.maximum(e, 1e-9))
    ref = maximum_filter1d(edb, size=max(1, int(win * sr / 441)), mode="nearest")
    loud = np.interp(np.arange(n), np.arange(edb.size) * 441,
                     (edb > ref + gate_db).astype(np.float64))
    mask = mask * (1.0 - loud)

    k = max(1, int(0.03 * sr))
    mask = np.convolve(mask, np.ones(k) / k, mode="same").astype(np.float32)
    if mode == "safe":
        from cover_dsp import target_pitch, safe_breath_mask
        source16 = librosa.resample(src[:n], orig_sr=sr, target_sr=16000)
        source_f0 = librosa.pyin(source16, fmin=60, fmax=1200, sr=16000,
                               hop_length=160, frame_length=1024)[0]
        source_idx = np.clip((np.arange(n)/sr*100).astype(int), 0, len(source_f0)-1)
        mask = safe_breath_mask(mask, target_pitch(f0_path, np.arange(n)/sr),
                                np.isfinite(source_f0[source_idx]), sr,
                                output_pitch=np.nan_to_num(f0[idx]))
    breath = sosfilt(butter(4, 200 / (sr / 2), btype="highpass", output="sos"),
                     src[:n]).astype(np.float32)
    if mode == "safe":
        # Quiet input must not inject a louder source noise floor into a pause.
        from scipy.ndimage import uniform_filter1d
        size = max(1, int(.05*sr))
        vrms = np.sqrt(np.maximum(uniform_filter1d(v*v, size=size), 0))
        brms = np.sqrt(np.maximum(uniform_filter1d(breath*breath, size=size), 0))
        breath *= np.minimum(1, vrms*1.4/np.maximum(brms, 1e-8))
    v[:] = v * (1 - mask) + breath * mask
    return v, mask


def polish(sw, src, sr=SR, presence_db=8.0, air=0.35, debuzz=0.85,
           lowcut=0.0, low_shelf_db=0.0):
    """亮一点（1k 往上爬）、去 650 Hz 嗡、用源的高频补空气感。

    lowcut / low_shelf_db 是给男声源用的：男中音的胸腔共鸣堆在 150~350 Hz，
    换声后变成「闷、粗」，高切一刀 + 低架压一点就细回来了。
    """
    import librosa
    import numpy as np

    N, Hh = 2048, 512
    Ss = librosa.stft(sw, n_fft=N, hop_length=Hh)
    Sr = librosa.stft(src, n_fft=N, hop_length=Hh)
    m = min(Ss.shape[1], Sr.shape[1])
    Ss, Sr = Ss[:, :m], Sr[:, :m]
    freqs = librosa.fft_frequencies(sr=sr, n_fft=N)

    g = np.clip((freqs - 1000) / 800, 0, 1) * presence_db
    g = np.minimum(g, np.clip((9000 - freqs) / 2000, 0.55, 1.0) * presence_db)
    Ss = Ss * (10 ** (g / 20))[:, None]

    bell = np.exp(-0.5 * ((np.log2(np.maximum(freqs, 1) / 650)) / 0.6) ** 2)
    Ss = Ss * (1 - (1 - debuzz) * bell)[:, None]

    if low_shelf_db:
        # 300 Hz 以下平滑压，压的都是「粗」的那部分
        shelf = 1.0 / (1.0 + (np.maximum(freqs, 1) / 300.0) ** 2)
        Ss = Ss * (10 ** (low_shelf_db * shelf / 20))[:, None]

    if lowcut > 0:
        Ss = Ss * np.clip((freqs - lowcut * 0.5) / max(lowcut * 0.5, 1), 0, 1)[:, None]

    if air > 0:
        hp = (freqs > 5500).astype(np.float32)
        Ss = Ss + air * (Sr * hp[:, None])
    return librosa.istft(Ss, hop_length=Hh, length=sw.size)


# ---------------------------------------------------------------- presets

def _given(flag: str, argv) -> bool:
    """命令行里有没有显式给这个开关（`--x` 或 `--x=值`）。"""
    return any(a == flag or a.startswith(flag + "=") for a in argv)


def preset_keys(name: str, argv) -> dict:
    """预设里没被命令行覆盖的那几项。"""
    return {k: v for k, v in PRESETS[name].items()
            if not _given("--" + k.replace("_", "-"), argv)}


def pick_band(hz: float) -> str:
    for lo, name in AUTO_BANDS:
        if hz >= lo:
            return name
    return "low"


def default_inst_transpose(pitch):
    # Whole octaves retain the song's key; the accompaniment need not change register.
    return 0.0 if pitch % 12 == 0 else float(pitch)


def src_median_hz(path, sr: int = SR) -> float:
    """源人声的中位音高（只算可信的 voiced 帧），用来挑档位。

    前奏/间奏那段的「人声」是分离残留，pyin 会在上面报满量程的假音高，
    所以按能量门（相对最大 RMS −40 dB）和 voiced 概率过一遍，再去掉贴着 fmax 的帧。
    """
    import librosa
    import numpy as np
    y = load_mono(path, sr)
    f0, vflag, vprob = librosa.pyin(y, fmin=65, fmax=1000, sr=sr,
                                    frame_length=2048, hop_length=512)
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
    n = min(len(f0), len(rms))
    f0, vflag, vprob, rms = f0[:n], vflag[:n], vprob[:n], rms[:n]
    ok = (vflag & np.isfinite(f0) & (vprob > 0.25)
          & (rms > rms.max() * 10 ** (-40 / 20)) & (f0 < 950))
    v = f0[ok]
    return float(np.median(v)) if v.size else 0.0


def params_from(a) -> dict:
    return {
        "model": a.model, "index": a.index, "pitch": a.pitch, "f0method": a.f0_method,
        "f0_mode": getattr(a, "f0_mode", os.environ.get("RVC_F0_OCTAVE_FIX", "breath")),
        "index_rate": a.index_rate, "filter_radius": a.filter_radius,
        "protect": a.protect, "rms_mix": a.rms_mix,
        "demucs": a.demucs_model, "shifts": a.shifts,
        "separator": getattr(a, "separator", "demucs"),
        "roformer_overlap": getattr(a, "roformer_overlap", 2),
        "start": a.start, "dur": a.dur,
        "inst_gain": a.inst_gain, "vocal_gain": a.vocal_gain,
        "presence_db": a.presence_db, "air": a.air, "debuzz": a.debuzz,
        "gate_db": a.gate_db, "lowcut": a.lowcut, "low_shelf_db": a.low_shelf,
        "breath_mode": getattr(a, "breath_mode", "safe"),
        "noise_reduce": getattr(a, "noise_reduce", .5),
        "inst_transpose": a.inst_transpose,
        "lead_back": a.lead_back,
        "mix_reference": getattr(a, "mix_reference", "auto"),
        "output_format": getattr(a,'output_format',None) or (Path(a.out).suffix[1:].lower() if a.out else 'mp4'),
        "cover_emotion": getattr(a,'cover_emotion',''),
        "cover_image": getattr(a,'cover_image',''),
    }


# ---------------------------------------------------------------- pipeline

class Job:
    def __init__(self, a):
        self.a = a
        self.song = a.song
        self.is_url = a.song.lower().startswith(("http://", "https://"))
        self.slug = a.slug or (Path(a.song).stem if not self.is_url else "url")
        self.slug = slugify(self.slug)
        self.work = Path(a.workdir) if a.workdir else TMP / self.slug
        self.work.mkdir(parents=True, exist_ok=True)
        self.p = params_from(a)
        self.man_path = self.work / "manifest.json"
        self.man = json.loads(self.man_path.read_text("utf-8")) if self.man_path.exists() else {}

    def sync(self) -> None:
        """a 被改过（--preset auto 测完才知道档位）之后重新读一遍参数。"""
        self.p = params_from(self.a)

    # -- caching
    SIG = {
        "0_decode": ("start", "dur"),
        "1_sep": ("start", "dur", "separator"),
        "1_lead": ("lead_back",),
        "1_pitch_lead": ("mix_reference",),
        "2_rvc": ("model", "pitch", "f0method", "f0_mode", "index_rate",
                  "filter_radius", "protect", "rms_mix"),
        "3_polish": ("presence_db", "air", "debuzz", "gate_db",
                     "lowcut", "low_shelf_db", "breath_mode", "noise_reduce"),
        "4_mix": ("vocal_gain", "inst_gain", "inst_transpose",'output_format','cover_emotion','cover_image'),
    }

    def sig(self, stage: str) -> dict:
        sg = {k: self.p[k] for k in self.SIG[stage]}
        sg["cache_version"] = 2
        sg["code"] = [identity(Path(__file__)), identity(Path(__file__).with_name("cover_support.py"))]
        sg["code"].append(identity(Path(__file__).with_name("cover_dsp.py")))
        sg["code"].append(identity(Path(__file__).with_name("f0_path.py")))
        sg["code"].append(identity(Path(__file__).with_name("breath_pitch.py")))
        sg["code"].append(identity(Path(__file__).with_name("mix_pitch.py")))
        if stage == '1_sep':
            if self.p['separator'] == 'roformer':
                from cover_roformer import assets_identity
                sg['roformer_overlap'] = self.p['roformer_overlap']
                sg['roformer'] = assets_identity(ROOT)
            else:
                sg.update(demucs=self.p['demucs'], shifts=self.p['shifts'])
        if stage == "0_decode":
            sg["source"] = self.song if self.is_url else identity(self.song)
        if stage == "2_rvc":
            sg["pitch_reference"] = identity(self.pitch_reference) if getattr(self, 'pitch_reference', '') else None
            if self.p['mix_reference'] == 'auto':
                sg['pitch_lead_model'] = identity(RVC/'assets/uvr5_weights/HP5_only_main_vocal.pth')
                sg['pitch_lead_runner'] = identity(Path(__file__).with_name('cover_separate.py'))
            sg["weights"] = identity(RVC / "assets" / "weights" / self.p["model"])
            sg["index"] = identity(self.p["index"]) if self.p["index_rate"] > 0 else None
            sg["f0_file"] = identity(self.a.f0_file) if self.a.f0_file else None
            sg["octave_fix"] = os.environ.get("RVC_F0_OCTAVE_FIX", "ref")
            sg["rvc_backend"] = "service" if os.environ.get("COVER_RVC_URL") else "cli"
            sg["backend_code"] = [identity(Path(__file__).with_name(name)) for name in
                ("sing_bridge.py", "sing_rvc_worker.py")]
            sg["rvc_code"] = [identity(RVC / p) for p in (
                "tools/infer_cli.py", "infer/modules/vc/pipeline.py", "infer/modules/vc/modules.py")]
        if stage in ("1_lead", "1_pitch_lead"):
            sg["model"] = identity(RVC / "assets/uvr5_weights/HP5_only_main_vocal.pth")
            sg["runner"] = identity(Path(__file__).with_name("cover_separate.py"))
        if stage == "3_polish":
            sg["f0"] = identity(self.work / "02_f0.csv")
        if stage=='4_mix' and self.p['output_format']=='mp4':
            from music_export import select_cover
            poster,_=select_cover(ROOT.parent/'stickers',self.p['cover_emotion'],self.p['cover_image'])
            sg['cover']=identity(poster)
            sg['export_code']=identity(Path(__file__).with_name('music_export.py'))
        return sg

    def fresh(self, stage: str, out: Path, deps=()) -> bool:
        if self.a.force_from <= stage_num(stage):
            return False
        if not out.exists() or out.stat().st_size < 1024:
            return False
        rec = self.man.get(stage, {})
        old = rec.get("params") or {}
        sg = self.sig(stage)
        if old != sg:
            diff = [k for k in sg if old.get(k) != sg[k]]
            print(f"     {stage}: {', '.join(diff)} 变了 -> 重跑（--force 可静音）")
            return False
        # 上游产物变了（换参数/重跑），下游必须跟着重跑
        want = [stamp(d) for d in deps]
        if rec.get("deps") != want:
            print(f"     {stage}: 上游变了 -> 重跑")
            return False
        return rec.get("outputs") == [identity(out)]

    def mark(self, stage: str, out: Path, deps=()) -> None:
        self.man[stage] = {"params": self.sig(stage), "out": str(out),
                           "deps": [stamp(d) for d in deps],
                           "outputs": [identity(out)],
                           "at": time.strftime("%F %T")}
        atomic_json(self.man_path, self.man)

    # -- 0 decode
    def stage0(self) -> Path:
        out = self.work / "00_src.wav"
        if self.fresh("0_decode", out):
            log("0/4 decode: cached")
            return out
        log("0/4 decode -> 44.1k stereo wav")
        src = self.song
        if self.is_url:
            source_id = hashlib.sha256(self.song.encode()).hexdigest()[:16]
            d = self.work / "src" / source_id
            d.mkdir(parents=True, exist_ok=True)
            sh([ENVPY, "-m", "yt_dlp", "--no-playlist", "-f", "bestaudio/best", "-x",
                "--audio-format", "wav", "-o", str(d / "source.%(ext)s"), self.song])
            src = d / "source.wav"
            if not src.exists():
                raise SystemExit("[fail] yt-dlp 没下到 wav")
        cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error"]
        if self.a.start:
            cmd += ["-ss", str(self.a.start)]
        cmd += ["-i", str(src)]
        if self.a.dur:
            cmd += ["-t", str(self.a.dur)]
        sh(cmd + ["-ar", str(SR), "-ac", "2", str(out)])
        self.mark("0_decode", out)
        return out

    # -- 1 separate
    def stage1(self, src: Path):
        dm = self.p["demucs"]
        backend = self.p['separator']
        d = self.work / "01_sep" / ('roformer_kim' if backend == 'roformer' else dm) / src.stem
        voc, inst = d / "vocals.wav", d / "no_vocals.wav"
        if self.fresh("1_sep", voc, [src]) and self.man["1_sep"].get("instrumental") == identity(inst):
            log(f"1/4 {backend}: cached")
            return voc, inst
        if backend == 'roformer':
            log('1/4 roformer KimberleyJensen Mel-Band, overlap '+str(self.p['roformer_overlap']))
            sh([ENVPY, Path(__file__).with_name('cover_roformer.py'), '--input', src,
                '--outdir', d, '--root', ROOT, '--overlap', self.p['roformer_overlap']])
        else:
            log(f"1/4 demucs {dm} --two-stems=vocals --shifts {self.p['shifts']}")
            sh([ENVPY, "-m", "demucs", "-n", dm, "--two-stems=vocals",
                "--shifts", str(self.p["shifts"]), "-d", "cuda",
                "-o", str(self.work / "01_sep"), str(src)])
        if not voc.exists() or not inst.exists():
            raise SystemExit(f"[fail] 没拿到人声轨：{d}")
        self.mark("1_sep", voc, [src])
        self.man["1_sep"]["instrumental"] = identity(inst)
        if backend == 'roformer':
            self.man['1_sep']['separation_report'] = identity(d/'separation.json')
        atomic_json(self.man_path, self.man)
        return voc, inst

    # -- 2 RVC
    def stage2(self, voc: Path) -> Path:
        out40 = self.work / "02_rvc_40k.wav"
        if (self.fresh("2_rvc", out40, [voc])
                and (not self.man['2_rvc'].get('pitch_lead_reference') or
                     self.man['2_rvc']['pitch_lead_reference'] == identity(self.work/'01_pitch_lead/lead.wav'))
                and self.man["2_rvc"].get("f0") == identity(self.work / "02_f0.csv")
                and self.man["2_rvc"].get("f0_diagnostics") == identity(self.work / "02_f0.diagnostics.json")
                and self.man['2_rvc'].get('f0_waveform_evidence') == identity(self.work/'02_f0.waveform.csv')
                and (self.p['f0_mode'] != 'sequence' or self.a.f0_file or
                     self.man['2_rvc'].get('f0_evidence') == identity(self.work / '02_f0.evidence.csv'))
                and (self.p['f0_mode'] != 'breath' or self.a.f0_file or
                     self.man['2_rvc'].get('f0_breath_evidence') == identity(self.work / '02_f0.breath.csv'))):
            log("2/4 rvc: cached")
            return out40
        log(f"2/4 rvc {self.p['model']} pitch {self.p['pitch']:+d} "
            f"index {self.p['index_rate']} protect {self.p['protect']}")
        cmd = [RVCPY, "tools/infer_cli.py",
               "--input_path", str(voc), "--opt_path", str(out40),
               "--model_name", self.p["model"], "--f0method", self.p["f0method"],
               "--device", "cuda:0", "--is_half", "True",
               "--index_rate", str(self.p["index_rate"]),
               "--f0up_key", str(self.p["pitch"]),
               "--filter_radius", str(self.p["filter_radius"]),
               "--protect", str(self.p["protect"]),
               "--rms_mix_rate", str(self.p["rms_mix"])]
        idxp = Path(self.p["index"])
        if idxp.exists() and self.p["index_rate"] > 0:
            cmd += ["--index_path", str(idxp)]
        if self.a.f0_file:
            cmd += ["--f0_file", str(Path(self.a.f0_file).resolve())]
        cmd += ["--f0_dump", str(self.work / "02_f0.csv")]
        from sing_bridge import infer_remote
        def infer():
            if not infer_remote(self, voc, out40):
                sh(cmd, cwd=RVC, capture=False, env_updates={"RVC_F0_OCTAVE_FIX": self.p["f0_mode"],
                    "RVC_F0_MIX_REFERENCE": str(getattr(self, 'pitch_reference', '')),
                    "RVC_F0_LEAD_REFERENCE": str(getattr(self, 'pitch_lead_reference', ''))})
        infer()
        diagnostics = self.work/'02_f0.diagnostics.json'
        report = json.loads(diagnostics.read_text('utf-8')) if diagnostics.is_file() else {}
        # Only ambiguous jobs pay for HP5. It supplies pitch evidence, while RVC
        # continues to receive the unchanged original vocal for content/timbre.
        if (self.p['mix_reference'] == 'auto' and not self.a.f0_file and self.a.lead_back == 'off'
                and not self.a.lead_stem and report.get('mix_reference', {}).get('reference_supported_frames', 0) >= 60):
            lead = self.work/'01_pitch_lead/lead.wav'
            if not self.fresh('1_pitch_lead', lead, [voc]):
                sh([RVCPY, Path(__file__).with_name('cover_separate.py'), '--rvc-root', RVC,
                    '--input', voc, '--outdir', lead.parent], cwd=RVC, capture=False)
                self.mark('1_pitch_lead',lead,[voc])
            self.pitch_lead_reference = str(lead.resolve())
            log('2/4 ambiguous octaves: retry with HP5 pitch reference; content vocal unchanged')
            infer()
        if not out40.exists():
            raise SystemExit("[fail] RVC 没产出")
        self.mark("2_rvc", out40, [voc])
        self.man["2_rvc"]["f0"] = identity(self.work / "02_f0.csv")
        self.man["2_rvc"]["f0_diagnostics"] = identity(self.work / "02_f0.diagnostics.json")
        self.man["2_rvc"]["f0_evidence"] = identity(self.work / "02_f0.evidence.csv")
        self.man["2_rvc"]["f0_breath_evidence"] = identity(self.work / "02_f0.breath.csv")
        self.man['2_rvc']['f0_waveform_evidence'] = identity(self.work/'02_f0.waveform.csv')
        self.man['2_rvc']['pitch_lead_reference'] = (identity(self.pitch_lead_reference)
            if getattr(self, 'pitch_lead_reference', '') else None)
        atomic_json(self.man_path, self.man)
        return out40

    # -- 3 polish
    def stage3(self, voc: Path, src_voc: Path) -> Path:
        import numpy as np
        import soundfile as sf

        out = self.work / "03_vocal.wav"
        if self.fresh("3_polish", out, [voc, src_voc]):
            log("3/4 polish: cached")
            return out
        log("3/4 breath splice + polish")
        sw = load_mono(voc)
        src = load_mono(src_voc)
        n = min(sw.size, src.size)
        sw, src = sw[:n], src[:n]
        f0_path = self.work / "02_f0.csv"
        f0_path = f0_path if f0_path.exists() else None
        sw, mask = breath_splice(sw, src, gate_db=self.p["gate_db"],
                                mode=self.p["breath_mode"], f0_path=f0_path)
        print(f"     breath/pad replaced: {100 * mask.mean():.1f}%")
        from cover_dsp import reduce_low_noise
        sw, noise_stats = reduce_low_noise(sw, SR, self.p["noise_reduce"], f0_path)
        sf.write(str(self.work / "03_breath_mask.wav"), mask, SR)
        atomic_json(self.work / "03_processing.json", {
            "breath_mode": self.p["breath_mode"], "replacement_fraction": float(mask.mean()),
            "noise": noise_stats, "presence_db": self.p["presence_db"],
        })
        sw = polish(sw, src, presence_db=self.p["presence_db"],
                    air=self.p["air"], debuzz=self.p["debuzz"],
                    lowcut=self.p["lowcut"], low_shelf_db=self.p["low_shelf_db"])
        pk = float(np.abs(sw).max())
        if pk > 0.98:
            sw *= np.float32(0.98 / pk)
        sf.write(str(out), sw, SR)
        self.mark("3_polish", out, [voc, src_voc])
        return out

    # -- 4 mix
    def stage4(self, voc: Path, inst: Path) -> Path:
        import numpy as np
        import soundfile as sf

        mp3 = Path(self.a.out) if self.a.out else self.work / f"{self.slug}_feiyu.{self.p['output_format']}"
        wav = self.work / "04_mix.wav"
        backing = Path(self.a.backing_stem).resolve() if self.a.backing_stem else None
        deps = [voc, inst] + ([backing] if backing else [])
        if (self.fresh("4_mix", wav, deps)
                and self.man["4_mix"].get("export") == identity(mp3)
                and self.man["4_mix"].get("backing_gain") == self.a.backing_gain):
            log("4/4 mix: cached")
            return mp3
        log("4/4 mix + encode")
        if self.p["inst_transpose"]:
            # 人声升了非八度就必须把伴奏一起挪，否则整首打架
            tag = f"{self.p['inst_transpose']:+.1f}".replace("+", "p").replace(".", "_")
            shifted = self.work / f"inst_s{tag}.wav"
            shift_meta = shifted.with_suffix(".json")
            wanted = {"source": identity(inst), "semitones": self.p["inst_transpose"]}
            if not (shifted.exists() and shift_meta.exists()
                    and json.loads(shift_meta.read_text("utf-8")) == {**wanted, "output": identity(shifted)}):
                ratio = 2 ** (self.p["inst_transpose"] / 12.0)
                log(f"     伴奏移调 {self.p['inst_transpose']:+g} 半音（rubberband ×{ratio:.4f}）")
                sh([FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
                    "-i", str(inst),
                    "-af", f"rubberband=pitch={ratio:.6f}:pitchq=quality",
                    str(shifted)])
                atomic_json(shift_meta, {**wanted, "output": identity(shifted)})
            inst = shifted
        if backing and self.p["inst_transpose"]:
            raise ValueError("Backing stem must be transposed with the song; use pitch 0 for separate backing")
        mix = mix_stereo(load_mono(voc), load_channels(inst), self.p["vocal_gain"],
                         self.p["inst_gain"], load_channels(backing) if backing else None,
                         self.a.backing_gain)
        sf.write(str(wav), mix, SR,subtype='PCM_24')
        mp3.parent.mkdir(parents=True, exist_ok=True)
        if self.p['output_format']=='mp4':
            from music_export import export_music
            export_music(wav,mp3,FFMPEG,sticker_root=ROOT.parent/'stickers',
                         emotion=self.p['cover_emotion'],image=self.p['cover_image'])
        else:
            sh([FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
                "-i", str(wav), "-b:a", "192k", str(mp3)])
        self.mark("4_mix", wav, deps)
        self.man["4_mix"].update(export=identity(mp3), backing_gain=self.a.backing_gain)
        atomic_json(self.man_path, self.man)
        return mp3


def stage_num(s: str) -> int:
    return {"0_decode": 0, "1_sep": 1, "1_lead": 1, "2_rvc": 2, "3_polish": 3, "4_mix": 4}.get(s, -1)


# ---------------------------------------------------------------- self-check

def locate_issues(y, ref, fa, fb, expect_semis: float = 0.0,
                  sr=SR, hop=160, sr16=16000, win_s=0.5, top=5, pitch_basis='参考音高'):
    """把整体统计拆成 0.5 s 窗口，指出「破音」最可能落在哪几秒。

    两类判据（Dear Moments 那声破音暴露出来的两个盲区）：
      音高跳  窗口里 >25% 的有音高帧偏离指定参考超过 1 个半音
              —— 八度掰错、换声点没接上，听感就是一声「哇」
      能量塌  输出比源同窗口低 12 dB 以上，而源本身有声
              —— RVC 整段吞字、拼接断点
    相邻窗口合并成一处，按严重度排序，只报前 top 处。
    """
    import numpy as np

    m = min(fa.size, fb.size)
    fa, fb = fa[:m], fb[:m]
    both = np.isfinite(fa) & np.isfinite(fb) & (fa > 0) & (fb > 0)
    with np.errstate(divide="ignore", invalid="ignore"):
        semis = 12 * np.log2(fa / fb) - expect_semis
    med = float(np.median(semis[both])) if both.any() else 0.0
    dev = np.abs(semis)

    total = min(y.size, ref.size)
    per = max(1, int(round(win_s * sr16 / hop)))
    nwin = int(np.ceil(total / sr / win_s))
    cand = []
    for w in range(nwin):
        s, e = w * per, min((w + 1) * per, m)
        t0 = w * win_s
        vb = both[s:e]
        if int(vb.sum()) >= 6:
            d = dev[s:e][vb]
            frac = float(np.mean(d > 1.0))
            if frac >= 0.25:
                cand.append((t0, "音高跳", min(1.0, frac),
                             f"{frac * 100:.0f}% 的有音高帧偏离{pitch_basis}超 1 半音"))
        i0, i1 = int(t0 * sr), int(min(t0 + win_s, total / sr) * sr)
        if i1 - i0 > sr // 10:
            o, r = rms_db(y[i0:i1]), rms_db(ref[i0:i1])
            if r > -40.0 and o - r <= -12.0:
                cand.append((t0, "能量塌", min(1.0, (r - o) / 24.0),
                             f"比源低 {o - r:+.0f} dB"))

    if not cand:
        print("异常候选   没找到明显异常窗口")
        return []

    merged=[]
    # Pitch and energy are independent findings; an overlapping pitch warning
    # must not swallow a simultaneous volume collapse.
    for kind in dict.fromkeys(c[1] for c in cand):
        group=sorted((c for c in cand if c[1]==kind),key=lambda c:c[0])
        current=list(group[0]);previous=group[0][0]
        for c in group[1:]:
            if c[0]-previous<=win_s+1e-6:
                if c[2]>current[2]:current=list(c)
            else:
                merged.append(current);current=list(c)
            previous=c[0]
        merged.append(current)
    merged.sort(key=lambda c: -c[2])
    print(f"异常候选   {len(merged)} 处（窗口 {win_s:g} s，按严重度排，"
          f"全曲中位 {med:+.2f} 半音）")
    for t0, kind, _sev, why in merged[:top]:
        print(f"  {int(t0) // 60:02d}:{t0 % 60:05.2f}  {kind}  {why}")
    return merged


def check(target: Path, src_stem: Path | None = None, secs: float = 0.0,
          label: str = "", expect_semis: float = 0.0, f0_path: Path | None = None) -> bool:
    """把那一轮事后排查的套路做成常规自检：时长、峰值、八度、对拍、断点。

    音高/对拍只对「人声轨 vs 源人声轨」有意义（混音里有鼓和贝斯，pyin 会乱追），
    所以混音只查时长/峰值/断点，人声轨才查音高和对拍。
    """
    import librosa
    import numpy as np
    from pitch_check import sample_target, target_compliance, pitch_relation

    if not target.exists():
        raise SystemExit(f"[fail] 找不到 {target}")
    if label:
        print(f"--- {label} ---")
    # 统一解码成 wav 再读
    # Inspect each channel so opposite-phase clipping cannot cancel in a mono sum.
    import soundfile as sf
    with audio_scratch(target.parent) as td:
        tmp = Path(td) / "check.wav"
        sh([FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(target), "-ar", str(SR), "-acodec", "pcm_f32le", str(tmp)])
        channels, _ = sf.read(str(tmp), always_2d=True, dtype="float32")
    if channels.size < 2 or not np.isfinite(channels).all():
        print("自检 WARN: empty/non-finite audio")
        return False
    y = channels.mean(axis=1)

    ok = True
    dur = y.size / SR
    pk = float(np.abs(channels).max())
    print(f"时长       {dur:8.3f} s")
    print(f"峰值       {pk:8.3f}   {'OK' if pk <= 0.995 else 'CLIP?'}")
    print(f"响度 RMS   {rms_db(y):8.1f} dBFS")
    if pk > 0.995:
        ok = False

    d = np.abs(np.diff(channels, axis=0))
    p999 = float(np.percentile(d, 99.9))
    print(f"采样跳变   p99.9 {p999:.4f}  max {d.max():.4f}"
          f"   {'OK' if d.max() < 8 * p999 + 1e-3 else 'CLICK?'}")
    if d.max() >= 8 * p999 + 1e-3:
        ok = False

    if src_stem and not src_stem.exists():
        print(f"自检 WARN: missing reference {src_stem}")
        return False
    if f0_path is None and target.name in ('03_vocal.wav','02_rvc_40k.wav'):
        sidecar=target.with_name('02_f0.csv')
        if sidecar.is_file():
            f0_path=sidecar
    pitch_report=None
    source_report=None
    issues=[]
    n=min(y.size,int(secs*SR)) if secs>0 else y.size
    if src_stem:
        ref = load_mono(src_stem)
        if abs(len(y) - len(ref)) > int(0.1 * SR):
            print("时长 WARN: 人声与参考相差超过 100 ms")
            ok = False
        n = min(y.size, ref.size, int(secs * SR)) if secs > 0 else min(y.size, ref.size)
    if src_stem or f0_path:
        a = librosa.resample(y[:n], orig_sr=SR, target_sr=16000)
        fa = librosa.pyin(a, fmin=60, fmax=1200, sr=16000, hop_length=160, frame_length=1024)[0]
        expected=np.full(len(fa),np.nan)
        if f0_path:
            try:
                expected=sample_target(f0_path,np.arange(len(fa))*.01,dur)
                pitch_report=target_compliance(fa,expected)
                if pitch_report['compared_frames']:
                    print(f"音高对目标 {pitch_report['compared_frames']:5d} frame "
                          f"中位差 {pitch_report['median_semitones']:+.2f} 半音  "
                          f"绝对偏差>1半音 {pitch_report['over_one_semitone_percent']:.1f}%  "
                          f"有声覆盖 {100*(pitch_report['voiced_coverage'] or 0):.1f}%  "
                          f"{pitch_report['status'].upper()}")
                else:
                    print('音高对目标 UNVERIFIED：'+pitch_report['reason'])
                print('音高校验范围：只验证输出跟随最终目标，不证明目标旋律/音区正确；不再扣 --pitch')
                ok=(pitch_report['status']=='pass') and ok
            except (ValueError,OSError) as exc:
                pitch_report={'status':'invalid','reason':str(exc)}
                print(f'音高对目标 WARN：{exc}')
                ok=False
        else:
            pitch_report={'status':'unverified','reason':'缺少最终目标 F0，源音高只能用于诊断'}
            print('音高校验 UNVERIFIED：缺少最终目标 F0；源轨相符不代表旋律正确')
            ok=False
    if src_stem:
        b = librosa.resample(ref[:n], orig_sr=SR, target_sr=16000)
        fb = librosa.pyin(b, fmin=60, fmax=1200, sr=16000, hop_length=160, frame_length=1024)[0]
        source_report=pitch_relation(fa,fb,expect_semis)
        if source_report['compared_frames']:
            extra = f"（已扣掉 --pitch {expect_semis:+g}）" if expect_semis else ""
            print(f"源音区诊断 {source_report['compared_frames']:5d} frame "
                  f"中位差 {source_report['median_semitones']:+.2f} 半音  "
                  f"绝对偏差>1半音 {source_report['over_one_semitone_percent']:.1f}% {extra}")
        else:
            print('源音区诊断 可比帧不足')
        print('源音区仅供诊断：源估计也可能半频，不能据此判错或自动关闭 mix-reference')

        ea = librosa.onset.onset_strength(y=a, sr=16000, hop_length=256)
        eb = librosa.onset.onset_strength(y=b, sr=16000, hop_length=256)
        nn = min(ea.size, eb.size)
        ea, eb = ea[:nn] - ea[:nn].mean(), eb[:nn] - eb[:nn].mean()
        maxlag = int(0.25 * 16000 / 256)
        best, bl = -1.0, 0
        for lag in range(-maxlag, maxlag + 1):
            if lag >= 0:
                x, z = ea[lag:], eb[:nn - lag]
            else:
                x, z = ea[:nn + lag], eb[-lag:]
            if x.size < 100:
                continue
            c = float(np.corrcoef(x, z)[0, 1])
            if c > best:
                best, bl = c, lag
        print(f"对拍       best lag {bl * 256 / 16000 * 1000:+6.1f} ms  corr {best:.3f}"
              f"   {'OK' if abs(bl) * 256 / 16000 < 0.08 else 'DRIFT?'}")
        if not np.isfinite(best) or best < 0.2 or abs(bl) * 256 / 16000 >= 0.08:
            ok = False

    if src_stem or f0_path:
        try:
            issues = locate_issues(y[:n], ref[:n] if src_stem else y[:n], fa, expected,
                                   pitch_basis='最终目标F0')
            if issues:
                ok = False
        except Exception as exc:  # 定位只是辅助信息，不该把整轮自检拖崩
            print(f"破音定位   跳过（{exc}）")
            ok = False

    atomic_json(target.with_suffix('.issues.json'),{
        'target':str(target),'reference':str(src_stem) if src_stem else None,
        'target_f0':str(f0_path) if f0_path else None,'checked_seconds':n/SR,
        'scope':'target_following_and_audio' if f0_path else ('audio_with_unverified_pitch' if src_stem else 'audio_basic'),
        'pitch_compliance':pitch_report,'source_pitch_diagnostic':source_report,
        'melody_correctness':'not_verified','passed':bool(ok),
        'issues':[{'seconds':t,'kind':kind,'severity':severity,'reason':reason}
                  for t,kind,severity,reason in issues]})
    print("自检", "PASS" if ok else "WARN",
          '（仅音频基础项，未验证音高）' if not (src_stem or f0_path) else '')
    return ok


# ---------------------------------------------------------------- main

def lock_output(locks, a):
    if a.out:
        lock_root = Path(os.environ.get("COVER_LOCK_ROOT") or ROOT / ".locks")
        key = hashlib.sha256(os.path.normcase(str(Path(a.out).resolve())).encode()).hexdigest()
        locks.enter_context(FileLock(lock_root / ("output-" + key + ".lock")))


def repair(a, locks) -> int:
    import numpy as np
    import soundfile as sf
    base = Path(a.repair_from).resolve()
    locks.enter_context(FileLock(base / ".cover.lock"))
    manifest = json.loads((base / "manifest.json").read_text("utf-8"))
    base_pitch = manifest["2_rvc"]["params"]["pitch"]
    if _given("--pitch", sys.argv) and a.pitch != base_pitch:
        raise ValueError("局部修复必须保持原任务调性；降调请另建整首任务")
    # Keep processing outside the patch consistent with the original job.
    mapping = {"f0method": "f0_method", "low_shelf_db": "low_shelf"}
    for stage in ("2_rvc", "3_polish", "4_mix"):
        for key, value in manifest[stage]["params"].items():
            attr = mapping.get(key, key)
            if hasattr(a, attr) and not _given("--" + attr.replace("_", "-"), sys.argv):
                setattr(a, attr, value)
    if a.inst_transpose != manifest["4_mix"]["params"]["inst_transpose"]:
        raise ValueError("局部修复不能更改伴奏调性")
    original = Path(manifest["2_rvc"]["out"])
    voc = Path(manifest.get("inputs", {}).get("lead") or manifest["1_sep"]["out"])
    inst = Path(manifest.get("inputs", {}).get("instrumental") or
                Path(manifest["1_sep"]["out"]).with_name("no_vocals.wav"))
    a.backing_stem = manifest.get("inputs", {}).get("backing", "")
    a.backing_gain = manifest["4_mix"].get("backing_gain", 1.0)
    raw, source = load_mono(original), load_mono(voc)
    start, end = a.repair_start, a.repair_start + a.repair_dur
    if a.repair_dur <= 0 or end > min(len(raw), len(source)) / SR:
        raise ValueError("修复区间必须位于已有音频内，--repair-dur 必须大于0")
    if a.repair_context < 0.25 or a.repair_fade * 2 >= a.repair_dur:
        raise ValueError("上下文至少0.25秒，交叉淡化必须小于修复段一半")
    a.song = str(voc)
    a.slug = a.slug or f"repair_{start:g}_{end:g}"
    a.workdir = a.workdir or str(base / "repairs" / (a.slug + "_" + time.strftime("%Y%m%d_%H%M%S")))
    if Path(a.workdir).resolve() == base:
        raise ValueError("修复必须另存目录，不能覆盖原任务")
    if a.out and Path(a.out).resolve().parent == base:
        raise ValueError("修复成品不能写入原任务目录")
    j = Job(a)
    locks.enter_context(FileLock(j.work / ".cover.lock"))
    lock_output(locks, a)
    t0, t1 = max(0, start-a.repair_context), min(len(source)/SR, end+a.repair_context)
    segment_args = copy.deepcopy(a)
    segment_args.workdir = str(j.work / "segment")
    segment_args.backing_stem = ""
    segment = Job(segment_args)
    clip = segment.work / "01_clip.wav"
    sf.write(str(clip), source[round(t0*SR):round(t1*SR)], SR, subtype="FLOAT")
    log(f"局部重唱 {start:.3f}–{end:.3f}s，上下文 {t0:.3f}–{t1:.3f}s；复用已有 stem")
    rendered = load_mono(segment.stage2(clip))
    if abs(len(rendered) - round((t1-t0)*SR)) > int(0.1*SR):
        raise ValueError("RVC 片段时长偏差超过100ms，拒绝拼接")
    merged, gain = splice_patch(raw, rendered, start, end, t0, fade=a.repair_fade)
    combined = j.work / "02_rvc_repaired.wav"
    sf.write(str(combined), merged, SR, subtype="FLOAT")
    j.man["1_sep"] = manifest["1_sep"]
    j.man["inputs"] = {"lead": str(voc), "instrumental": str(inst), "backing": a.backing_stem}
    j.mark("2_rvc", combined, [original, clip, segment.work / "02_rvc_40k.wav"])
    atomic_json(j.work / "repair.json", {
        "base": str(base), "original": identity(original), "start": start, "end": end,
        "context_start": t0, "context_end": t1, "fade": a.repair_fade,
        "gain": gain, "pitch": a.pitch, "outside_interval_unchanged": bool(
            np.array_equal(merged[:round(start*SR)], raw[:round(start*SR)]) and
            np.array_equal(merged[round(end*SR):], raw[round(end*SR):]))})
    pv = j.stage3(combined, voc)
    mp3 = j.stage4(pv, inst)
    log(f"DONE {mp3}")
    ok = check(mp3, label="成品（立体声）")
    return 0 if check(pv, voc, secs=a.check_secs, expect_semis=a.pitch) and ok else 2


def run_main(locks) -> int:
    ap = argparse.ArgumentParser(description="大肥鱼翻唱流水线")
    ap.add_argument("song", nargs="?", help="音频文件或 B 站/YouTube 链接")
    ap.add_argument("--slug", default="", help="工作目录名，默认取文件名")
    ap.add_argument("--workdir", default="")
    ap.add_argument("--out", default="", help="最终 mp4 路径；显式 .mp3 保留旧导出")
    ap.add_argument('--output-format',choices=['mp4','mp3'],default=None)
    ap.add_argument('--cover-emotion',default='',help='按歌曲情绪选肥鱼表情库 emotion；未提供时默认开心')
    ap.add_argument('--cover-image',default='',help='从肥鱼表情库 index.json 选定的封面路径')
    ap.add_argument("--model", default=MODEL)
    ap.add_argument("--index", default=str(INDEX), help="RVC 索引文件，换模型时要一起换")
    ap.add_argument("--f0-file", default="", help="CSV: 秒,目标Hz；从0起覆盖当前输入，0Hz=清音；覆盖 --pitch")
    ap.add_argument("--stems-from", default="", help="复用已有工作目录的分离轨，不重新分离")
    ap.add_argument("--lead-stem", default="", help="与当前任务时间轴对齐的独立主唱 WAV")
    ap.add_argument("--lead-back", choices=["off", "hp5"], default="off", help="可选主唱分离；hp5复用本机权重")
    ap.add_argument("--mix-reference", choices=["auto", "off"], default="auto",
                    help="auto 在RMVPE/breath中用原混音复核持续半频；不降音区、不填换气；off用于对照")
    ap.add_argument("--backing-stem", default="", help="独立和声 WAV，保留原声混回；需同时指定 --lead-stem")
    ap.add_argument("--backing-gain", type=float, default=1.0)
    ap.add_argument("--repair-from", default="", help="基于已有任务，只重唱指定片段，另存到新目录")
    ap.add_argument("--repair-start", type=float, default=0.0, help="相对已有任务音频的秒数")
    ap.add_argument("--repair-dur", type=float, default=0.0)
    ap.add_argument("--repair-context", type=float, default=2.0)
    ap.add_argument("--repair-fade", type=float, default=0.08)
    ap.add_argument("--pitch", type=int, default=0,
                    help="升调半音数；先看 --preset，别按歌手性别拍脑袋")
    ap.add_argument("--f0-method", default="rmvpe")
    ap.add_argument("--f0-mode", choices=["breath", "sequence", "ref", "off", "acf", "1", "true", "yes"],
                    default=os.environ.get("RVC_F0_OCTAVE_FIX", "breath"),
                    help="breath 在ref后修复有双侧音区证据的短换气半频；sequence 为实验模式；off关闭纠错")
    ap.add_argument("--index-rate", type=float, default=0.6)
    ap.add_argument("--filter-radius", type=int, default=7, help="旧版 harvest 专用；rmvpe 下不生效")
    ap.add_argument("--protect", type=float, default=0.35, help="清音检索保护：越小越强，0.5关闭；不直接修音高")
    ap.add_argument("--rms-mix", type=float, default=0.15)
    ap.add_argument('--separator', choices=['demucs', 'roformer'], default='roformer',
                    help='前端人声分离；demucs 用于显式回退')
    ap.add_argument('--roformer-overlap', type=int, choices=range(2, 9), default=2)
    ap.add_argument("--demucs-model", default="htdemucs_ft")
    ap.add_argument("--shifts", type=int, default=1, help="demucs shift trick，1=关")
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--dur", type=float, default=0.0, help="0=整首")
    ap.add_argument("--vocal-gain", type=float, default=1.0)
    ap.add_argument("--inst-gain", type=float, default=0.9)
    ap.add_argument("--inst-transpose", type=float, default=0.0,
                    help="伴奏移调半音数；人声是非八度升调时必须跟它同值")
    ap.add_argument("--presence-db", type=float, default=4.0)
    ap.add_argument("--breath-mode", choices=["safe", "off", "legacy"], default="safe",
                    help="safe 用目标F0和源有声段保护弱假声；off 禁止回填；legacy 仅供对照")
    ap.add_argument("--noise-reduce", type=float, default=.5,
                    help="低频稳态噪声衰减强度0~1；最大6dB，保护目标音高谐波；0关闭")
    ap.add_argument("--air", type=float, default=0.0, help="源高频回填；默认关闭，避免带回和声与分离残留")
    ap.add_argument("--debuzz", type=float, default=0.85)
    ap.add_argument("--gate-db", type=float, default=-30.0)
    ap.add_argument("--lowcut", type=float, default=0.0,
                    help="低频高通，Hz；男声源 100~140 能去掉胸腔的「粗」")
    ap.add_argument("--low-shelf", type=float, default=0.0,
                    help="300 Hz 以下低架增益，dB（负值=变细）")
    ap.add_argument("--only", default="", help="只跑到第 N 步，逗号分隔，如 2")
    ap.add_argument("--force", action="store_true", help="全部重跑")
    ap.add_argument("--force-from", default="", help="从第 N 步重跑，如 3")
    ap.add_argument("--check", default="", help="只自检给定文件")
    ap.add_argument("--check-src", default="", help="自检时用来比对的源人声轨")
    ap.add_argument("--check-f0", default="", help="人声自检的最终02_f0.csv；已含移调，源音区仅作诊断")
    ap.add_argument("--check-secs", type=float, default=0.0,
                    help="自检只比对前 N 秒，0=整首")
    ap.add_argument("--preset", default="",
                    choices=["", "auto", "female", "male-thin", "low"],
                    help="按源人声中位音高选策略：female(≥260Hz) / male-thin(200~260Hz，"
                         "不升调只磨薄) / low(<200Hz，升 4 半音且伴奏同步) / auto(分离后实测再选)")
    # 预设只改默认值：命令行显式给过的参数一律优先
    _pre, _ = ap.parse_known_args()
    if _pre.preset and _pre.preset != "auto":
        _d = preset_keys(_pre.preset, sys.argv)
        if _d:
            ap.set_defaults(**_d)
    a = ap.parse_args()
    if (a.stems_from or a.repair_from) and any(_given(flag, sys.argv) for flag in
            ('--separator', '--roformer-overlap', '--demucs-model')):
        ap.error('复用已有分离轨时不应用分离器选项；更换分离器请从原歌曲创建任务')
    if _given('--demucs-model', sys.argv) and not _given('--separator', sys.argv):
        a.separator = 'demucs'
    suffix=Path(a.out).suffix.lower() if a.out else ''
    if a.out and suffix not in ('.mp4','.mp3'):
        ap.error('--out 必须是 .mp4 或 .mp3')
    if a.output_format and suffix and suffix!='.'+a.output_format:
        ap.error('--output-format 与 --out 扩展名不一致')
    a.output_format=a.output_format or (suffix[1:] if suffix else 'mp4')
    # 非八度移调需要伴奏跟随；整八度只改变人声音区。
    if a.pitch and not _given("--inst-transpose", sys.argv):
        a.inst_transpose = default_inst_transpose(a.pitch)

    if a.check:
        return 0 if check(Path(a.check), Path(a.check_src) if a.check_src else None,
                          secs=a.check_secs, expect_semis=a.pitch,
                          f0_path=Path(a.check_f0) if a.check_f0 else None) else 1
    if not (a.song or a.stems_from or a.repair_from):
        ap.error("给歌曲、--stems-from、--repair-from 或 --check")
    if a.backing_stem and not a.lead_stem:
        ap.error("--backing-stem 必须配合 --lead-stem，避免重复混入和声")
    if a.lead_back != "off" and (a.lead_stem or a.backing_stem or a.repair_from):
        ap.error("--lead-back 不与外部 stem 或局部修复同用；先建主唱分离任务")
    for name in ("start", "dur", "repair_start", "repair_dur", "repair_context", "repair_fade"):
        import math
        if not math.isfinite(getattr(a, name)) or getattr(a, name) < 0:
            ap.error(f"--{name.replace('_', '-')} 必须是有限非负数")
    if not 0 <= a.protect <= 0.5 or not 0 <= a.index_rate <= 1:
        ap.error("protect 范围 0~0.5，index-rate 范围 0~1")
    if not 0 <= a.noise_reduce <= 1:
        ap.error("noise-reduce 范围 0~1")

    # 切到 env 的 python（librosa/torch 都装在那儿）
    if Path(sys.executable).resolve() != ENVPY.resolve() and not os.environ.get("COVER_PY"):
        env = os.environ.copy()
        env["COVER_PY"] = "1"
        return subprocess.call([str(ENVPY), str(Path(__file__).resolve()), *sys.argv[1:]], env=env)

    a.force_from = int(a.force_from) if a.force_from else 99
    if a.force:
        a.force_from = -1
    if a.repair_from:
        if a.song or a.stems_from or a.start or a.dur or a.lead_stem or a.backing_stem or a.preset:
            ap.error("局部修复不与歌曲、裁剪、预设或外部 stem 同时使用；先建独立 stem 任务")
        return repair(a, locks)
    only = {int(x) for x in a.only.split(",") if x.strip().isdigit()}

    if a.stems_from:
        if a.song or a.start or a.dur:
            ap.error("--stems-from 直接复用原任务时间轴，不与歌曲或 --start/--dur 同用")
        a.song = str(Path(a.stems_from).resolve() / "00_src.wav")
    j = Job(a)
    if a.stems_from and j.work.resolve() == Path(a.stems_from).resolve():
        ap.error("--stems-from 必须指定不同的 --slug/--workdir，保留原任务")
    locks.enter_context(FileLock(j.work / ".cover.lock"))
    lock_output(locks, a)
    if a.stems_from:
        locks.enter_context(FileLock(Path(a.stems_from) / ".cover.lock"))
    log(f"workdir {j.work}")
    print("     " + "  ".join(f"{k}={v}" for k, v in j.p.items()), flush=True)

    if a.stems_from:
        base = Path(a.stems_from).resolve()
        manifest = json.loads((base / "manifest.json").read_text("utf-8"))
        voc = Path(manifest["1_sep"]["out"])
        inst = voc.with_name("no_vocals.wav")
        j.man["1_sep"] = {"out": str(voc), "params": manifest["1_sep"]["params"]}
        atomic_json(j.man_path, j.man)
    else:
        src = j.stage0()
        voc, inst = j.stage1(src)
    reference = (Path(a.stems_from).resolve() if a.stems_from else j.work) / '00_src.wav'
    if a.stems_from and not reference.is_file():
        inherited = manifest.get('inputs', {}).get('pitch_reference')
        if inherited:
            reference = Path(inherited)
    j.pitch_reference = (str(reference.resolve()) if a.mix_reference == 'auto'
                         and reference.is_file() and not a.f0_file else '')
    if a.lead_back == "hp5":
        folder = j.work / "01_lead"
        lead, backing = folder / "lead.wav", folder / "backing.wav"
        if not (j.fresh("1_lead", lead, [voc])
                and j.man["1_lead"].get("backing") == identity(backing)):
            sh([RVCPY, Path(__file__).with_name("cover_separate.py"), "--rvc-root", RVC,
                "--input", voc, "--outdir", folder], cwd=RVC, capture=False)
            j.mark("1_lead", lead, [voc])
            j.man["1_lead"]["backing"] = identity(backing)
            atomic_json(j.man_path, j.man)
        voc = lead
        a.backing_stem = str(backing)
    import soundfile as sf
    duration = sf.info(str(inst)).duration
    if a.lead_stem:
        lead = Path(a.lead_stem).resolve()
        if abs(sf.info(str(lead)).duration - duration) > 0.1:
            ap.error("lead stem 与伴奏时长相差超过100ms，必须对齐当前任务时间轴")
        voc = lead
    if a.backing_stem and abs(sf.info(a.backing_stem).duration - duration) > 0.1:
        ap.error("backing stem 与伴奏时长相差超过100ms")
    if a.f0_file and a.pitch:
        log("注意：f0-file 是目标音高，覆盖自动 --pitch；请确保与伴奏调性一致")
    j.man["inputs"] = {"lead": str(voc.resolve()), "instrumental": str(inst.resolve()),
                       "pitch_reference": j.pitch_reference,
                       "backing": str(Path(a.backing_stem).resolve()) if a.backing_stem else ""}
    atomic_json(j.man_path, j.man)
    if a.preset == "auto":
        hz = src_median_hz(voc)
        if hz <= 0:
            raise ValueError("没有足够可信的人声音高，无法自动选档；请手动指定预设")
        name = pick_band(hz)
        log(f"auto: 源人声中位音高 {hz:.0f} Hz -> preset {name}")
        for k, v in preset_keys(name, sys.argv).items():
            setattr(a, k, v)
        if a.pitch and not _given("--inst-transpose", sys.argv):
            a.inst_transpose = default_inst_transpose(a.pitch)
        j.sync()
        print("     " + "  ".join(f"{k}={v}" for k, v in j.p.items()), flush=True)
    if only and 2 not in only:
        log("停在第 2 步（--only），人声轨见 " + str(voc))
        return 0
    rvc = j.stage2(voc)
    if only and 3 not in only:
        log("停在第 3 步（--only）")
        return 0
    pv = j.stage3(rvc, voc)
    if only and 4 not in only:
        log("停在第 4 步（--only）")
        return 0
    mp3 = j.stage4(pv, inst)

    log(f"DONE {mp3}  ({mp3.stat().st_size / 1024:.0f} KB)")
    print()
    ok = check(mp3, None, label="成品（混音）")
    print()
    ok = check(pv, voc, label="人声轨对最终目标F0；源音区仅作诊断", expect_semis=a.pitch,
               secs=a.check_secs, f0_path=j.work/'02_f0.csv') and ok
    return 0 if ok else 2


def main():
    from sing_process import wait_gate
    wait_gate()
    with ExitStack() as locks:
        return run_main(locks)


if __name__ == "__main__":
    raise SystemExit(main())
