"""Mel-Band RoFormer frontend using the installed GPT-SoVITS implementation."""
from pathlib import Path
import argparse
import json
import time
import sys
import numpy as np
from cover_support import identity, atomic_json, gpu_guard


def asset_paths(root):
    folder = Path(root) / 'models/separation/roformer'
    return folder/'MelBandRoformer.ckpt', folder/'MelBandRoformer.yaml'


def assets_identity(root):
    checkpoint, config = asset_paths(root)
    code = Path(root)/'GPT-SoVITS/tools/uvr5/bs_roformer'
    return {'checkpoint': identity(checkpoint), 'config': identity(config),
            'runner': identity(__file__),
            'implementation': [identity(code/name) for name in ('mel_band_roformer.py', 'attend.py')]}


def overlap_add(mixture, chunk_size, overlap, predict):
    """Reflect context and weighted overlap retain exact length and both channels."""
    mixture = np.asarray(mixture, dtype=np.float32)
    if (mixture.ndim != 2 or mixture.shape[0] != 2 or mixture.shape[1] == 0
            or not np.isfinite(mixture).all()):
        raise ValueError('Expected finite nonempty stereo audio, shaped [2, samples]')
    if not isinstance(overlap, int) or not 2 <= overlap <= 8 or chunk_size < 10:
        raise ValueError('Invalid chunk size or overlap')
    step = chunk_size//overlap
    border = chunk_size-step
    padded = np.pad(mixture, ((0, 0), (border, border)),
                    mode='reflect' if mixture.shape[1] > 1 else 'edge')
    result = np.zeros_like(padded)
    count = np.zeros(padded.shape[1], dtype=np.float32)
    window = np.ones(chunk_size, dtype=np.float32)
    fade = max(2, chunk_size//10)
    window[:fade] = np.linspace(0, 1, fade)
    window[-fade:] = np.linspace(1, 0, fade)
    for start in range(0, padded.shape[1], step):
        length = min(chunk_size, padded.shape[1]-start)
        part = np.pad(padded[:, start:start+length], ((0, 0), (0, chunk_size-length)))
        estimate = np.asarray(predict(part), dtype=np.float32)
        if estimate.shape != part.shape or not np.isfinite(estimate).all():
            raise ValueError('RoFormer returned invalid shape or non-finite audio')
        result[:, start:start+length] += estimate[:, :length]*window[:length]
        count[start:start+length] += window[:length]
    active = slice(border, border+mixture.shape[1])
    if np.any(count[active] <= 0):
        raise ValueError('Uncovered samples in RoFormer overlap-add')
    return result[:, active]/count[active]


def load_config(path):
    import yaml
    class ConfigLoader(yaml.SafeLoader):
        pass
    ConfigLoader.add_constructor('tag:yaml.org,2002:python/tuple',
                                 lambda loader, node: tuple(loader.construct_sequence(node)))
    return yaml.load(Path(path).read_text('utf-8'), Loader=ConfigLoader)


def separate(source, outdir, root, overlap=2):
    import soundfile as sf
    import torch
    from scipy.signal import resample_poly
    from math import gcd
    root, outdir = Path(root).resolve(), Path(outdir).resolve()
    checkpoint, config_path = asset_paths(root)
    if not checkpoint.is_file() or not config_path.is_file():
        raise ValueError('RoFormer checkpoint/config missing in '+str(checkpoint.parent))
    config = load_config(config_path)
    if (config['audio']['sample_rate'] != 44100 or not config['model']['stereo']
            or config['model']['num_stems'] != 1
            or config['training']['target_instrument'] != 'vocals'):
        raise ValueError('Unsupported RoFormer configuration; stereo vocals model required')
    y, sr = sf.read(source, dtype='float32', always_2d=True)
    if y.shape[1] == 1:
        y = np.repeat(y, 2, axis=1)
    if y.shape[1] != 2 or not y.size or not np.isfinite(y).all():
        raise ValueError('Invalid source audio')
    if sr != 44100:
        divisor = gcd(sr, 44100)
        y = resample_poly(y, 44100//divisor, sr//divisor, axis=0).astype('float32')
    sr = 44100
    sys.path.insert(0, str(root/'GPT-SoVITS/tools/uvr5'))
    from bs_roformer.mel_band_roformer import MelBandRoformer
    device = 'cuda:0' if torch.cuda.is_available() else 'cpu'
    model_options = dict(config['model'])
    model_options['match_input_audio_length'] = True
    model = MelBandRoformer(**model_options)
    state = torch.load(checkpoint, map_location='cpu', weights_only=True)
    model.load_state_dict(state, strict=True)
    del state
    model.eval().to(device)
    begin = time.monotonic()
    if device.startswith('cuda'):
        torch.cuda.reset_peak_memory_stats()
    def predict(part):
        tensor = torch.from_numpy(part[None]).to(device)
        with torch.inference_mode(), torch.autocast(device_type='cuda', dtype=torch.float16,
                                                    enabled=device.startswith('cuda')):
            result = model(tensor)
        return result[0].float().cpu().numpy()
    vocals = overlap_add(y.T, int(config['audio']['chunk_size']), overlap, predict).T
    instrumental = y-vocals
    reconstruction = float(np.max(abs(vocals+instrumental-y)))
    if reconstruction > 2e-6:
        raise ValueError('RoFormer stems do not reconstruct the decoded source')
    outdir.mkdir(parents=True, exist_ok=True)
    # Float WAVs preserve separator peaks and additive balance without stem normalization.
    for name, data in [('vocals', vocals), ('no_vocals', instrumental)]:
        temporary = outdir/(name+'.pending.wav')
        sf.write(temporary, data, sr, subtype='FLOAT')
        temporary.replace(outdir/(name+'.wav'))
    report = {'backend': 'roformer', 'model': 'KimberleyJensen Mel-Band RoFormer',
              'input': identity(source), 'assets': assets_identity(root),
              'sample_rate': sr, 'channels': 2, 'samples': len(y),
              'overlap': overlap, 'chunk_size': config['audio']['chunk_size'],
              'batch_size': 1, 'precision': 'cuda autocast fp16' if device.startswith('cuda') else 'fp32',
              'device': device, 'inference_seconds': time.monotonic()-begin,
              'reconstruction_max_error': reconstruction,
              'vocal_peak': float(abs(vocals).max()),
              'instrumental_peak': float(abs(instrumental).max())}
    atomic_json(outdir/'separation.json', report)
    print(json.dumps({k: report[k] for k in ('backend', 'samples', 'inference_seconds',
                                          'reconstruction_max_error')}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True)
    parser.add_argument('--outdir', required=True)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--overlap', type=int, default=2, choices=range(2, 9))
    args = parser.parse_args()
    with gpu_guard(args.root):
        separate(args.input, args.outdir, args.root, args.overlap)


if __name__ == '__main__':
    main()
