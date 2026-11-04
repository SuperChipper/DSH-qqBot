"""Conservative inference repairs; never infer a vocal register from pitch alone."""
import numpy as np


def fill_pitch_gaps(f0, reference, probability, max_frames=6):
    """A short dropout is repairable only with trusted evidence and voiced neighbours."""
    out = np.asarray(f0).copy()
    n = min(len(out), len(reference), len(probability))
    ref, prob = np.asarray(reference), np.asarray(probability)
    i, fixed = 0, 0
    while i < n:
        if out[i] != 0:
            i += 1
            continue
        j = i + 1
        while j < n and out[j] == 0:
            j += 1
        if i > 0 and j < n and j-i <= max_frames and out[i-1] > 0 and out[j] > 0:
            expected = np.exp(np.linspace(np.log(out[i-1]), np.log(out[j]), j-i+2)[1:-1])
            candidate = ref[i:j]
            valid = np.isfinite(candidate) & (candidate > 0) & (prob[i:j] >= .9)
            if valid.all() and np.all(np.abs(12*np.log2(candidate/expected)) <= 1):
                out[i:j] = candidate
                fixed += j-i
        i = j
    return out, fixed


def target_pitch(path, times):
    """Nearest-frame sampling preserves UV boundaries rather than interpolating into breaths."""
    curve = np.loadtxt(path, delimiter=',', ndmin=2)
    if curve.shape[1] != 2 or not np.isfinite(curve).all() or np.any(np.diff(curve[:, 0]) <= 0):
        raise ValueError('Invalid target F0 dump')
    pos = np.searchsorted(curve[:, 0], times)
    right = np.clip(pos, 0, len(curve)-1)
    left = np.clip(pos-1, 0, len(curve)-1)
    nearest = np.where(abs(times-curve[left, 0]) <= abs(times-curve[right, 0]), left, right)
    pitch = curve[nearest, 1].copy()
    # Unknown coverage must veto source replacement, not masquerade as silence.
    pitch[(times < curve[0, 0]-.02) | (times > curve[-1, 0]+.02)] = np.nan
    return pitch


def safe_breath_mask(legacy_mask, pitch, source_voiced, sr, output_pitch=None):
    from scipy.ndimage import maximum_filter1d, uniform_filter1d
    # Include a margin so fades cannot eat the onset of a weak sung vowel.
    veto = (~np.isfinite(pitch)) | (pitch > 0) | source_voiced
    veto = maximum_filter1d(veto.astype(float), size=max(1, int(.06*sr))) > 0
    mask = np.asarray(legacy_mask) * (~veto)
    if output_pitch is not None:
        output_pitch = np.asarray(output_pitch)
        hum = (output_pitch > 0) & (output_pitch < 180) & ~veto
        # The old candidate excluded voiced output, so periodic bass in a confirmed
        # source/target UV gap could never be replaced. Ignore short vowel-boundary leaks.
        width = max(1, int(.08*sr))
        core = uniform_filter1d(hum.astype(float), size=width, mode='constant') > .999
        sustained = (maximum_filter1d(core.astype(float), size=width) > 0) & hum
        mask = np.maximum(mask, sustained)
    mask = uniform_filter1d(mask, size=max(1, int(.03*sr)))
    return np.where(veto, 0, mask).astype(np.float32)


def reduce_low_noise(audio, sr, strength=.5, f0_path=None):
    """Attenuate a stationary floor, with bounded gain and explicit harmonic protection."""
    import librosa
    from scipy.ndimage import gaussian_filter
    if strength == 0:
        return np.asarray(audio).copy(), {'strength': 0, 'mean_reduction_db': 0}
    spec = librosa.stft(audio, n_fft=2048, hop_length=512)
    power = abs(spec)**2
    freq = librosa.fft_frequencies(sr=sr, n_fft=2048)
    floor = np.quantile(power, .1, axis=1, keepdims=True)
    ratio = np.clip(floor / np.maximum(power, 1e-12), 0, 1)
    band = np.clip((freq-60)/60, 0, 1) * np.clip((1100-freq)/300, 0, 1)
    reduction = gaussian_filter(ratio, sigma=(1, 2)) * band[:, None] * (6*strength)
    if f0_path:
        pitch = target_pitch(f0_path, np.arange(spec.shape[1])*512/sr)
        voiced = np.isfinite(pitch) & (pitch > 0)
        fundamental = np.maximum(np.nan_to_num(pitch), 1)
        harmonic = np.maximum(1, np.rint(freq[:, None]/fundamental[None, :]))
        distance = abs(freq[:, None]-harmonic*fundamental[None, :])
        protected = (distance <= np.maximum(sr/2048*1.5, fundamental[None, :]*.04)) & voiced
        reduction[protected] *= .1
    out = librosa.istft(spec * 10**(-reduction/20), hop_length=512, length=len(audio))
    return out.astype(np.float32), {'strength': strength, 'mean_reduction_db': float(reduction.mean()),
                                  'max_reduction_db': float(reduction.max())}
