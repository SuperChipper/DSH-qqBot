import os
import sys
import traceback
import logging
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[6] / "scripts"))
from cover_support import confident_octaves
from cover_dsp import fill_pitch_gaps
from f0_path import select_pitch_path, describe_path
from breath_pitch import repair_breath_restarts

logger = logging.getLogger(__name__)

from functools import lru_cache
from time import time as ttime

import faiss
import librosa
import numpy as np
import parselmouth
import pyworld
import torch
import torch.nn.functional as F
import torchcrepe
from scipy import signal

now_dir = os.getcwd()
sys.path.append(now_dir)

bh, ah = signal.butter(N=5, Wn=48, btype="high", fs=16000)

input_audio_path2wav = {}


@lru_cache
def cache_harvest_f0(input_audio_path, fs, f0max, f0min, frame_period):
    audio = input_audio_path2wav[input_audio_path]
    f0, t = pyworld.harvest(
        audio,
        fs=fs,
        f0_ceil=f0max,
        f0_floor=f0min,
        frame_period=frame_period,
    )
    f0 = pyworld.stonemask(audio, f0, t, fs)
    return f0


def change_rms(data1, sr1, data2, sr2, rate):  # 1是输入音频，2是输出音频,rate是2的占比
    # print(data1.max(),data2.max())
    rms1 = librosa.feature.rms(
        y=data1, frame_length=sr1 // 2 * 2, hop_length=sr1 // 2
    )  # 每半秒一个点
    rms2 = librosa.feature.rms(y=data2, frame_length=sr2 // 2 * 2, hop_length=sr2 // 2)
    rms1 = torch.from_numpy(rms1)
    rms1 = F.interpolate(
        rms1.unsqueeze(0), size=data2.shape[0], mode="linear"
    ).squeeze()
    rms2 = torch.from_numpy(rms2)
    rms2 = F.interpolate(
        rms2.unsqueeze(0), size=data2.shape[0], mode="linear"
    ).squeeze()
    rms2 = torch.max(rms2, torch.zeros_like(rms2) + 1e-6)
    data2 *= (
        torch.pow(rms1, torch.tensor(1 - rate))
        * torch.pow(rms2, torch.tensor(rate - 1))
    ).numpy()
    return data2


def octave_fix(f0, lo=0.45, hi=0.62, back=(1.60, 2.25), maxgap=70, minrun=4):
    """把 f0 曲线上「整段掉一个八度」的帧翻回来。

    rmvpe 在高音区长音上会突然跳到半频（掉 12 个半音），几百毫秒后又跳回，
    听起来就是「突然降调」。八度错是**阶跃**，真人滑音不是，所以按阶跃找：
    相邻帧比 0.45~0.62（向下跳）→ 之后 <=700 ms 内出现 1.60~2.25（跳回），
    把中间整段乘 2。开关：环境变量 RVC_F0_OCTAVE_FIX=1
    """
    if f0 is None or len(f0) < 16:
        return f0
    x = f0.astype(np.float64).copy()
    n = x.size
    nz = np.maximum(x[:-1], 1e-6)
    ratio = np.ones(n)
    ratio[1:] = x[1:] / nz
    fixed = 0
    i = 1
    while i < n:
        if x[i - 1] > 0 and x[i] > 0 and lo < ratio[i] < hi:
            j = i + 1
            hit = -1
            while j < min(n, i + maxgap):
                if x[j - 1] > 0 and x[j] > 0 and back[0] < x[j] / x[j - 1] < back[1]:
                    hit = j
                    break
                j += 1
            if hit > 0 and hit - i >= minrun:
                x[i:hit] *= 2.0
                fixed += hit - i
                i = hit + 1
                continue
        i += 1
    if fixed:
        logger.info("f0 octave fix: %d frames (%.2fs) doubled" % (fixed, fixed * 0.01))
    return x.astype(f0.dtype)


def octave_reconcile(f0, x, sr=16000, return_reference=False):
    """用 pyin 当第二意见，把 rmvpe 的八度错（半频/倍频）掰回来。

    rmvpe 在高音区长音上会 500/250 Hz 来回抖，阶跃检测救不了。
    这里对每一帧在 {f/2, f, 2f} 里挑离 pyin 最近的那个，且只在
    差距 >4 半音、掰完 <3 半音时才动手（pyin 自己错的时候不牵连）。
    开关：RVC_F0_OCTAVE_FIX=ref
    """
    try:
        import librosa

        ref, voiced, probability = librosa.pyin(
            np.asarray(x, dtype=np.float32),
            fmin=65, fmax=1200, sr=sr, frame_length=1024, hop_length=160,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("octave_reconcile skipped: %s" % e)
        return (f0, None, None) if return_reference else f0
    out, fixed = confident_octaves(f0, ref, probability)
    out, filled = fill_pitch_gaps(out, ref, probability)
    if filled:
        logger.info("f0 short dropout repair: %d frames filled", filled)
    if fixed:
        logger.info("f0 octave reconcile: %d frames (%.2fs) shifted" % (fixed, fixed * 0.01))
    out = out.astype(f0.dtype)
    return (out, ref, probability) if return_reference else out


def sequence_reconcile(f0, x, device, crepe_observation=None, sr=16000):
    if crepe_observation is None:
        with torch.no_grad():
            pitch, confidence = torchcrepe.predict(torch.tensor(np.copy(x))[None].float(),
                sr, 160, 50, 1100, 'full', batch_size=512, device=device, return_periodicity=True)
        c, cp = pitch[0].cpu().numpy(), confidence[0].cpu().numpy()
    else:
        c, cp = crepe_observation
    p, _, pp = librosa.pyin(np.asarray(x, dtype=np.float32), fmin=60, fmax=1200,
                           sr=sr, frame_length=1024, hop_length=160)
    def aligned(values, fill):
        out = np.full(len(f0), fill, dtype=float)
        size = min(len(out), len(values))
        out[:size] = values[:size]
        return out
    out, report, evidence = select_pitch_path(f0, aligned(c, np.nan), aligned(cp, 0),
                                              aligned(p, np.nan), aligned(pp, 0))
    logger.info('f0 sequence: changed=%d filled=%d jumps=%d -> %d', report['changed_frames'],
                report['filled_frames'], report['jumps_before'], report['jumps_after'])
    return out, evidence


def _acf(f0, x, sr=16000, win=1024):
    """逐帧归一化自相关，返回 (acf[帧, lag], 半窗)。用于判八度，不依赖别的估计器。"""
    import librosa

    x = np.asarray(x, dtype=np.float32)
    if len(x) < win * 2:
        return None, 0
    xp = np.pad(x, (win // 2, win), mode="constant")
    frames = librosa.util.frame(xp, frame_length=win, hop_length=160)
    w = np.hanning(win).astype(np.float32)[:, None]
    spec = np.abs(np.fft.rfft(frames * w, n=2 * win, axis=0)) ** 2
    ac = np.fft.irfft(spec, n=2 * win, axis=0)[:win]
    ac = ac / np.maximum(ac[0:1], 1e-9)
    return ac.T, win  # (帧数, win)


def octave_acf(f0, x, sr=16000, ratio=0.75, min_ac=0.30, fmax=1200.0):
    """用自相关判「半频」：如果半个周期的自相关几乎和整周期一样强，
    说明真正的周期是短的那个（经典的去次谐波判据），把 f0 翻倍。

    不依赖任何别的估计器，所以不会出现「两个估计器一起错」。
    只往上修（半频 → 原频）；倍频错误这里不管。
    开关：RVC_F0_OCTAVE_FIX=acf
    """
    ac, win = _acf(f0, x, sr=sr)
    if ac is None:
        logger.warning("octave_acf: 音频太短，跳过")
        return f0
    out = f0.astype(np.float64).copy()
    n = min(len(out), ac.shape[0])
    changed = 0

    def at(a, lag):
        li = int(round(lag))
        if li < 2 or li >= a.shape[0] - 1:
            return -1.0
        return float(a[max(li - 1, 0): li + 2].max())

    for i in range(n):
        f = out[i]
        if f <= 0 or f * 2 > fmax:
            continue
        lag = sr / f
        if lag < 8:
            continue
        r_full = at(ac[i], lag)
        r_half = at(ac[i], lag / 2.0)
        if r_half >= min_ac and r_half >= ratio * max(r_full, 0.0):
            out[i] = f * 2.0
            changed += 1
    if changed:
        logger.info("f0 octave acf: %d frames (%.2fs) doubled" % (changed, changed * 0.01))
    return out.astype(f0.dtype)


class Pipeline(object):
    def __init__(self, tgt_sr, config):
        self.x_pad, self.x_query, self.x_center, self.x_max, self.is_half = (
            config.x_pad,
            config.x_query,
            config.x_center,
            config.x_max,
            config.is_half,
        )
        self.sr = 16000  # hubert输入采样率
        self.window = 160  # 每帧点数
        self.t_pad = self.sr * self.x_pad  # 每条前后pad时间
        self.t_pad_tgt = tgt_sr * self.x_pad
        self.t_pad2 = self.t_pad * 2
        self.t_query = self.sr * self.x_query  # 查询切点前后查询时间
        self.t_center = self.sr * self.x_center  # 查询切点位置
        self.t_max = self.sr * self.x_max  # 免查询时长阈值
        self.device = config.device

    def get_f0(
        self,
        input_audio_path,
        x,
        p_len,
        f0_up_key,
        f0_method,
        filter_radius,
        inp_f0=None,
    ):
        global input_audio_path2wav
        time_step = self.window / self.sr * 1000
        f0_min = 50
        f0_max = 1100
        f0_mel_min = 1127 * np.log(1 + f0_min / 700)
        f0_mel_max = 1127 * np.log(1 + f0_max / 700)
        crepe_observation = None
        sequence_evidence = None
        breath_report = None
        mix_report = None
        mix_evidence = None
        waveform_evidence = None
        breath_evidence = None
        breath_reference = None
        breath_probability = None
        if f0_method == "pm":
            f0 = (
                parselmouth.Sound(x, self.sr)
                .to_pitch_ac(
                    time_step=time_step / 1000,
                    voicing_threshold=0.6,
                    pitch_floor=f0_min,
                    pitch_ceiling=f0_max,
                )
                .selected_array["frequency"]
            )
            pad_size = (p_len - len(f0) + 1) // 2
            if pad_size > 0 or p_len - len(f0) - pad_size > 0:
                f0 = np.pad(
                    f0, [[pad_size, p_len - len(f0) - pad_size]], mode="constant"
                )
        elif f0_method == "harvest":
            input_audio_path2wav[input_audio_path] = x.astype(np.double)
            f0 = cache_harvest_f0(input_audio_path, self.sr, f0_max, f0_min, 10)
            if filter_radius > 2:
                f0 = signal.medfilt(f0, 3)
        elif f0_method == "crepe":
            model = "full"
            # Pick a batch size that doesn't cause memory errors on your gpu
            batch_size = 512
            # Compute pitch using first gpu
            audio = torch.tensor(np.copy(x))[None].float()
            f0, pd = torchcrepe.predict(
                audio,
                self.sr,
                self.window,
                f0_min,
                f0_max,
                model,
                batch_size=batch_size,
                device=self.device,
                return_periodicity=True,
            )
            pd = torchcrepe.filter.median(pd, 3)
            f0 = torchcrepe.filter.mean(f0, 3)
            f0[pd < 0.1] = 0
            f0 = f0[0].cpu().numpy()
            crepe_observation = (f0.copy(), pd[0].cpu().numpy())
        elif f0_method == "rmvpe":
            if not hasattr(self, "model_rmvpe"):
                from infer.lib.rmvpe import RMVPE

                logger.info(
                    "Loading rmvpe model,%s" % "%s/rmvpe.pt" % os.environ["rmvpe_root"]
                )
                self.model_rmvpe = RMVPE(
                    "%s/rmvpe.pt" % os.environ["rmvpe_root"],
                    is_half=self.is_half,
                    device=self.device,
                )
            f0 = self.model_rmvpe.infer_from_audio(x, thred=0.03)

            if "privateuseone" in str(self.device):  # clean ortruntime memory
                del self.model_rmvpe.model
                del self.model_rmvpe
                logger.info("Cleaning ortruntime memory")

        _octmode = os.environ.get("RVC_F0_OCTAVE_FIX", "").lower()
        if inp_f0 is not None:
            pass
        elif _octmode == "sequence":
            f0, sequence_evidence = sequence_reconcile(f0, x, self.device, crepe_observation)
        elif _octmode in ("1", "true", "yes"):
            f0 = octave_fix(f0)
        elif _octmode in ("ref", "breath"):
            if _octmode == 'breath':
                f0, breath_reference, breath_probability = octave_reconcile(f0, x, return_reference=True)
            else:
                f0 = octave_reconcile(f0, x)
        elif _octmode == "acf":
            f0 = octave_acf(f0, x)

        if _octmode == 'breath' and inp_f0 is None:
            pad = self.x_pad * (self.sr // self.window)
            interior = f0[pad:len(f0)-pad] if pad else f0
            before = interior.copy()
            kwargs = {}
            if breath_reference is not None:
                def aligned_interior(values, fill):
                    aligned = np.full(len(f0), fill, dtype=float)
                    size = min(len(aligned), len(values))
                    aligned[:size] = values[:size]
                    return aligned[pad:len(aligned)-pad] if pad else aligned
                kwargs = {'reference': aligned_interior(breath_reference, np.nan),
                          'probability': aligned_interior(breath_probability, 0)}
            repaired, breath_report = repair_breath_restarts(interior, **kwargs)
            if pad:
                f0[pad:len(f0)-pad] = repaired
            else:
                f0 = repaired
            breath_evidence = np.column_stack((before, repaired,
                kwargs.get('reference', np.full(len(before), np.nan)),
                kwargs.get('probability', np.zeros(len(before)))))
            logger.info('f0 breath restarts: %d frames raised; UV preserved', breath_report['raised_frames'])

        reference_path = os.environ.get('RVC_F0_MIX_REFERENCE')
        if reference_path and _octmode == 'breath' and f0_method == 'rmvpe' and inp_f0 is None:
            from infer.lib.audio import load_audio
            from mix_pitch import raise_from_mix
            mixed = load_audio(reference_path, self.sr)
            interior_size = len(x) - 2*self.t_pad
            if abs(len(mixed)-interior_size) > self.window*2:
                raise ValueError('Mix F0 reference differs from vocal duration by more than 20 ms')
            mixed = signal.filtfilt(bh, ah, mixed)
            mixed = np.pad(mixed, (self.t_pad, self.t_pad), mode='reflect')
            mix_f0 = self.model_rmvpe.infer_from_audio(mixed, thred=.03)
            pad = self.x_pad * (self.sr // self.window)
            stop = len(f0)-pad if pad else len(f0)
            before = f0[pad:stop].copy()
            def align_mix(values, fill):
                result = np.full(len(f0), fill, dtype=float)
                count = min(len(f0), len(values))
                result[:count] = values[:count]
                return result[pad:stop]
            mixture = align_mix(mix_f0, 0)
            lead_path = os.environ.get('RVC_F0_LEAD_REFERENCE')
            lead_f0 = np.zeros(len(before))
            if lead_path:
                lead = load_audio(lead_path, self.sr)
                if abs(len(lead)-interior_size) > self.window*2:
                    raise ValueError('Lead pitch reference differs from vocal duration by more than 20 ms')
                lead = signal.filtfilt(bh, ah, lead)
                lead = np.pad(lead,(self.t_pad,self.t_pad),mode='reflect')
                lead_f0 = align_mix(self.model_rmvpe.infer_from_audio(lead,thred=.03),0)
                with np.errstate(divide='ignore',invalid='ignore'):
                    supported = (before>0)&(lead_f0>0)&(np.abs(12*np.log2(lead_f0/(2*before)))<=1)
                mixture[supported] = lead_f0[supported]
            probability = align_mix(breath_probability, 1) if breath_probability is not None else np.ones(len(before))
            source_waveform=x[self.t_pad:len(x)-self.t_pad] if self.t_pad else x
            waveforms=[source_waveform]
            if lead_path:
                waveforms.append(lead[self.t_pad:len(lead)-self.t_pad] if self.t_pad else lead)
            repaired, mix_report = raise_from_mix(before, mixture, probability, waveforms=waveforms)
            waveform_evidence=mix_report.pop('_waveform_evidence',None)
            f0[pad:stop] = repaired
            mix_report['lead_reference_used'] = bool(lead_path)
            mix_evidence = np.column_stack((before, mixture, probability, repaired,lead_f0))
            logger.info('f0 mix reference: %d frames raised; UV preserved', mix_report['raised_frames'])

        f0 *= pow(2, f0_up_key / 12)
        # with open("test.txt","w")as f:f.write("\n".join([str(i)for i in f0.tolist()]))
        tf0 = self.sr // self.window  # 每秒f0点数
        if inp_f0 is not None:
            delta_t = np.round(
                (inp_f0[:, 0].max() - inp_f0[:, 0].min()) * tf0 + 1
            ).astype("int64")
            replace_f0 = np.interp(
                list(range(delta_t)), inp_f0[:, 0] * 100, inp_f0[:, 1]
            )
            shape = f0[self.x_pad * tf0 : self.x_pad * tf0 + len(replace_f0)].shape[0]
            f0[self.x_pad * tf0 : self.x_pad * tf0 + len(replace_f0)] = replace_f0[
                :shape
            ]
        # with open("test_opt.txt","w")as f:f.write("\n".join([str(i)for i in f0.tolist()]))
        if os.environ.get("RVC_F0_DUMP"):
            pad = self.x_pad * tf0
            curve = f0[pad:len(f0)-pad] if pad else f0
            np.savetxt(os.environ["RVC_F0_DUMP"],
                       np.column_stack((np.arange(len(curve)) / tf0, curve)),
                       delimiter=",", fmt="%.6f")
            dump = Path(os.environ['RVC_F0_DUMP'])
            report = {'mode': 'manual' if inp_f0 is not None else _octmode,
                      'pitch_shift_semitones': f0_up_key, 'source_f0_method': f0_method}
            if mix_report is not None:
                report['mix_reference'] = mix_report
                np.savetxt(dump.with_suffix('.mix.csv'),
                    np.column_stack((np.arange(len(mix_evidence))/tf0, mix_evidence)),
                    delimiter=',', fmt='%.6f', header='seconds,before_hz,reference_hz,source_probability,after_hz,lead_reference_hz')
            else:
                dump.with_suffix('.mix.csv').unlink(missing_ok=True)
            if waveform_evidence is not None:
                columns=[np.arange(len(waveform_evidence['before']))/tf0,
                         waveform_evidence['before'],waveform_evidence['after'],
                         waveform_evidence['strong'],waveform_evidence['weak']]
                headers=['seconds','before_hz','after_hz','strong','weak']
                for i,scores in enumerate(waveform_evidence['scores']):
                    columns.extend(scores.T)
                    headers.extend(f'{i}_{name}' for name in ('half_ac','half_full_ratio','even_odd_db','full_ac'))
                np.savetxt(dump.with_suffix('.waveform.csv'),np.column_stack(columns),
                           delimiter=',',fmt='%.6f',header=','.join(headers))
            else:
                dump.with_suffix('.waveform.csv').unlink(missing_ok=True)
            if breath_report is not None:
                report['breath_restarts'] = breath_report
                np.savetxt(dump.with_suffix('.breath.csv'),
                    np.column_stack((np.arange(len(breath_evidence))/tf0, breath_evidence)),
                    delimiter=',', fmt='%.6f', header='seconds,before_hz,after_hz,reference_hz,reference_probability')
            else:
                dump.with_suffix('.breath.csv').unlink(missing_ok=True)
            if sequence_evidence is not None:
                ev = sequence_evidence[pad:len(sequence_evidence)-pad] if pad else sequence_evidence
                report.update(describe_path(ev))
                np.savetxt(dump.with_suffix('.evidence.csv'),
                    np.column_stack((np.arange(len(ev))/tf0, ev)), delimiter=',', fmt='%.6f',
                    header='seconds,primary_hz,crepe_hz,crepe_periodicity,pyin_hz,pyin_probability,selected_hz,candidate,joint_support')
            else:
                dump.with_suffix('.evidence.csv').unlink(missing_ok=True)
            dump.with_suffix('.diagnostics.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        f0bak = f0.copy()
        f0_mel = 1127 * np.log(1 + f0 / 700)
        f0_mel[f0_mel > 0] = (f0_mel[f0_mel > 0] - f0_mel_min) * 254 / (
            f0_mel_max - f0_mel_min
        ) + 1
        f0_mel[f0_mel <= 1] = 1
        f0_mel[f0_mel > 255] = 255
        f0_coarse = np.rint(f0_mel).astype(np.int32)
        return f0_coarse, f0bak  # 1-0

    def vc(
        self,
        model,
        net_g,
        sid,
        audio0,
        pitch,
        pitchf,
        times,
        index,
        big_npy,
        index_rate,
        version,
        protect,
    ):  # ,file_index,file_big_npy
        feats = torch.from_numpy(audio0)
        if self.is_half:
            feats = feats.half()
        else:
            feats = feats.float()
        if feats.dim() == 2:  # double channels
            feats = feats.mean(-1)
        assert feats.dim() == 1, feats.dim()
        feats = feats.view(1, -1)
        padding_mask = torch.BoolTensor(feats.shape).to(self.device).fill_(False)

        inputs = {
            "source": feats.to(self.device),
            "padding_mask": padding_mask,
            "output_layer": 9 if version == "v1" else 12,
        }
        t0 = ttime()
        with torch.no_grad():
            logits = model.extract_features(**inputs)
            feats = model.final_proj(logits[0]) if version == "v1" else logits[0]
        if protect < 0.5 and pitch is not None and pitchf is not None:
            feats0 = feats.clone()
        if (
            not isinstance(index, type(None))
            and not isinstance(big_npy, type(None))
            and index_rate != 0
        ):
            npy = feats[0].cpu().numpy()
            if self.is_half:
                npy = npy.astype("float32")

            # _, I = index.search(npy, 1)
            # npy = big_npy[I.squeeze()]

            score, ix = index.search(npy, k=8)
            weight = np.square(1 / score)
            weight /= weight.sum(axis=1, keepdims=True)
            npy = np.sum(big_npy[ix] * np.expand_dims(weight, axis=2), axis=1)

            if self.is_half:
                npy = npy.astype("float16")
            feats = (
                torch.from_numpy(npy).unsqueeze(0).to(self.device) * index_rate
                + (1 - index_rate) * feats
            )

        feats = F.interpolate(feats.permute(0, 2, 1), scale_factor=2).permute(0, 2, 1)
        if protect < 0.5 and pitch is not None and pitchf is not None:
            feats0 = F.interpolate(feats0.permute(0, 2, 1), scale_factor=2).permute(
                0, 2, 1
            )
        t1 = ttime()
        p_len = audio0.shape[0] // self.window
        if feats.shape[1] < p_len:
            p_len = feats.shape[1]
            if pitch is not None and pitchf is not None:
                pitch = pitch[:, :p_len]
                pitchf = pitchf[:, :p_len]

        if protect < 0.5 and pitch is not None and pitchf is not None:
            pitchff = pitchf.clone()
            pitchff[pitchf > 0] = 1
            pitchff[pitchf < 1] = protect
            pitchff = pitchff.unsqueeze(-1)
            feats = feats * pitchff + feats0 * (1 - pitchff)
            feats = feats.to(feats0.dtype)
        p_len = torch.tensor([p_len], device=self.device).long()
        with torch.no_grad():
            hasp = pitch is not None and pitchf is not None
            arg = (feats, p_len, pitch, pitchf, sid) if hasp else (feats, p_len, sid)
            audio1 = (net_g.infer(*arg)[0][0, 0]).data.cpu().float().numpy()
            del hasp, arg
        del feats, p_len, padding_mask
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        t2 = ttime()
        times[0] += t1 - t0
        times[2] += t2 - t1
        return audio1

    def pipeline(
        self,
        model,
        net_g,
        sid,
        audio,
        input_audio_path,
        times,
        f0_up_key,
        f0_method,
        file_index,
        index_rate,
        if_f0,
        filter_radius,
        tgt_sr,
        resample_sr,
        rms_mix_rate,
        version,
        protect,
        f0_file=None,
    ):
        if (
            file_index != ""
            # and file_big_npy != ""
            # and os.path.exists(file_big_npy) == True
            and os.path.exists(file_index)
            and index_rate != 0
        ):
            try:
                index = faiss.read_index(file_index)
                # big_npy = np.load(file_big_npy)
                big_npy = index.reconstruct_n(0, index.ntotal)
            except:
                traceback.print_exc()
                index = big_npy = None
        else:
            index = big_npy = None
        audio = signal.filtfilt(bh, ah, audio)
        audio_pad = np.pad(audio, (self.window // 2, self.window // 2), mode="reflect")
        opt_ts = []
        if audio_pad.shape[0] > self.t_max:
            audio_sum = np.zeros_like(audio)
            for i in range(self.window):
                audio_sum += np.abs(audio_pad[i : i - self.window])
            for t in range(self.t_center, audio.shape[0], self.t_center):
                opt_ts.append(
                    t
                    - self.t_query
                    + np.where(
                        audio_sum[t - self.t_query : t + self.t_query]
                        == audio_sum[t - self.t_query : t + self.t_query].min()
                    )[0][0]
                )
        s = 0
        audio_opt = []
        t = None
        t1 = ttime()
        audio_pad = np.pad(audio, (self.t_pad, self.t_pad), mode="reflect")
        p_len = audio_pad.shape[0] // self.window
        inp_f0 = None
        if hasattr(f0_file, "name"):
            try:
                with open(f0_file.name, "r") as f:
                    lines = f.read().strip("\n").split("\n")
                inp_f0 = []
                for line in lines:
                    inp_f0.append([float(i) for i in line.split(",")])
                inp_f0 = np.array(inp_f0, dtype="float32")
            except:
                traceback.print_exc()
        sid = torch.tensor(sid, device=self.device).unsqueeze(0).long()
        pitch, pitchf = None, None
        if if_f0 == 1:
            pitch, pitchf = self.get_f0(
                input_audio_path,
                audio_pad,
                p_len,
                f0_up_key,
                f0_method,
                filter_radius,
                inp_f0,
            )
            pitch = pitch[:p_len]
            pitchf = pitchf[:p_len]
            if "mps" not in str(self.device) or "xpu" not in str(self.device):
                pitchf = pitchf.astype(np.float32)
            pitch = torch.tensor(pitch, device=self.device).unsqueeze(0).long()
            pitchf = torch.tensor(pitchf, device=self.device).unsqueeze(0).float()
        t2 = ttime()
        times[1] += t2 - t1
        for t in opt_ts:
            t = t // self.window * self.window
            if if_f0 == 1:
                audio_opt.append(
                    self.vc(
                        model,
                        net_g,
                        sid,
                        audio_pad[s : t + self.t_pad2 + self.window],
                        pitch[:, s // self.window : (t + self.t_pad2) // self.window],
                        pitchf[:, s // self.window : (t + self.t_pad2) // self.window],
                        times,
                        index,
                        big_npy,
                        index_rate,
                        version,
                        protect,
                    )[self.t_pad_tgt : -self.t_pad_tgt]
                )
            else:
                audio_opt.append(
                    self.vc(
                        model,
                        net_g,
                        sid,
                        audio_pad[s : t + self.t_pad2 + self.window],
                        None,
                        None,
                        times,
                        index,
                        big_npy,
                        index_rate,
                        version,
                        protect,
                    )[self.t_pad_tgt : -self.t_pad_tgt]
                )
            s = t
        if if_f0 == 1:
            audio_opt.append(
                self.vc(
                    model,
                    net_g,
                    sid,
                    audio_pad[t:],
                    pitch[:, t // self.window :] if t is not None else pitch,
                    pitchf[:, t // self.window :] if t is not None else pitchf,
                    times,
                    index,
                    big_npy,
                    index_rate,
                    version,
                    protect,
                )[self.t_pad_tgt : -self.t_pad_tgt]
            )
        else:
            audio_opt.append(
                self.vc(
                    model,
                    net_g,
                    sid,
                    audio_pad[t:],
                    None,
                    None,
                    times,
                    index,
                    big_npy,
                    index_rate,
                    version,
                    protect,
                )[self.t_pad_tgt : -self.t_pad_tgt]
            )
        audio_opt = np.concatenate(audio_opt)
        if rms_mix_rate != 1:
            audio_opt = change_rms(audio, 16000, audio_opt, tgt_sr, rms_mix_rate)
        if tgt_sr != resample_sr >= 16000:
            audio_opt = librosa.resample(
                audio_opt, orig_sr=tgt_sr, target_sr=resample_sr
            )
        audio_max = np.abs(audio_opt).max() / 0.99
        max_int16 = 32768
        if audio_max > 1:
            max_int16 /= audio_max
        audio_opt = (audio_opt * max_int16).astype(np.int16)
        del pitch, pitchf, sid
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        return audio_opt
