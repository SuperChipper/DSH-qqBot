"""Freeze local benchmark identities, reproduce A/B/C/D, and compare target curves."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import numpy as np
from cover_support import identity
from f0_path import pitch_jumps

REPO = Path(__file__).resolve().parents[3]
LAB = REPO.parent/'voice-lab'
BASE = REPO/'tmp/rvc-breathy/mid-baseline'
FIXTURE = Path(__file__).with_name('fixtures')/'mid-song.json'
CASES = {'A': ('rmvpe', 'ref', .6), 'B': ('crepe', 'ref', .6),
         'C': ('crepe', 'ref', 0), 'D': ('rmvpe', 'sequence', .6)}
FOLDERS = {'A': 'mid-baseline', 'B': 'mid-crepe-index06',
           'C': 'mid-crepe-index0', 'D': 'mid-sequence'}


def freeze(base=BASE, fixture=FIXTURE, source_url='https://b23.tv/QhBsxpt'):
    manifest = json.loads((base/'manifest.json').read_text('utf-8'))
    params = manifest['2_rvc']['params']
    inputs = {'decoded': base/'00_src.wav', 'lead': Path(manifest['inputs']['lead']),
              'instrumental': Path(manifest['inputs']['instrumental']),
              'weights': LAB/'rvc/pkg/RVC20240604Nvidia50x0/assets/weights'/params['model'],
              'index': Path(params['index']['path'] if isinstance(params['index'], dict) else params['index'])}
    decode = manifest['0_decode']['params']
    start, duration = decode['start'], decode['dur']
    prefix = base.name.removesuffix('-baseline')
    folders = {'A': base.name, 'B': prefix+'-crepe-index06',
               'C': prefix+'-crepe-index0', 'D': prefix+'-sequence'}
    row = {'url': source_url, 'original_seconds': [start, start+duration],
           'baseline_relative_to_parent': str(base.relative_to(REPO.parent)).replace('\\', '/'),
           'folders': folders,
           'inputs': {key: {'relative_to_parent': str(path.relative_to(REPO.parent)).replace('\\', '/'),
                            'sha256': identity(path)['sha256']} for key, path in inputs.items()},
           'common_options': {'pitch': 0, 'protect': .35, 'rms_mix': .15, 'presence_db': 4,
                              'air': 0, 'debuzz': .85, 'breath_mode': 'safe', 'noise_reduce': .5,
                              'lowcut': 0, 'low_shelf': 0, 'vocal_gain': 1, 'inst_gain': .9},
           'cases': {key: dict(zip(('f0_method', 'f0_mode', 'index_rate'), value))
                     for key, value in CASES.items()}}
    fixture.parent.mkdir(parents=True, exist_ok=True)
    fixture.write_text(json.dumps(row, indent=2), encoding='utf-8')
    return row


def verified_fixture(fixture=FIXTURE):
    row = json.loads(fixture.read_text('utf-8'))
    for name, rec in row['inputs'].items():
        if identity(REPO.parent/rec['relative_to_parent']).get('sha256') != rec['sha256']:
            raise RuntimeError('Benchmark input changed: '+name)
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['freeze', 'run', 'summary'])
    parser.add_argument('--case', choices=list(CASES), default='A')
    parser.add_argument('--cases', nargs='+', choices=list(CASES), default=list(CASES),
                        help='Summary subset; use A when registering a baseline before other renders')
    parser.add_argument('--fixture', type=Path, default=FIXTURE)
    parser.add_argument('--baseline', type=Path)
    parser.add_argument('--source-url', default='https://b23.tv/QhBsxpt')
    args = parser.parse_args()
    if args.action == 'freeze':
        base = args.baseline.resolve() if args.baseline else BASE
        if base != BASE and args.fixture.resolve() == FIXTURE:
            parser.error('A new baseline needs its own --fixture; preserve the existing reference')
        print(json.dumps(freeze(base, args.fixture, args.source_url), indent=2))
        return 0
    row = verified_fixture(args.fixture)
    base = REPO.parent/row['baseline_relative_to_parent'] if 'baseline_relative_to_parent' in row else BASE
    folders = row.get('folders', FOLDERS)
    if args.action == 'run':
        key = args.case
        folder = base.parent/folders[key]
        # Preserve the originally recorded baseline; reruns use their own directory.
        if key == 'A':
            folder = base.parent/(base.name.removesuffix('-baseline')+'-rmvpe-rerun')
        cmd = [str(LAB/'env/python.exe'), '-B', str(LAB/'scripts/cover.py'),
               '--stems-from', str(base), '--workdir', str(folder), '--slug', folder.name,
               '--out', str(folder.with_suffix('.mp3'))]
        options = {**row['common_options'], **row['cases'][key]}
        options['model'] = Path(row['inputs']['weights']['relative_to_parent']).name
        options['index'] = str(REPO.parent/row['inputs']['index']['relative_to_parent'])
        for name, value in options.items():
            cmd += ['--'+name.replace('_', '-'), str(value)]
        return subprocess.call(cmd)
    curves = {key: np.loadtxt(base.parent/folders[key]/'02_f0.csv', delimiter=',')[:, 1]
              for key in args.cases}
    if len(set(map(len, curves.values()))) != 1:
        raise ValueError('Target curves differ in duration')
    rows = []
    for key, f in curves.items():
        folder = base.parent/folders[key]
        diag = folder/'02_f0.diagnostics.json'
        diagnostics = json.loads(diag.read_text()) if diag.exists() else None
        if row['cases'][key]['f0_mode'] == 'sequence':
            if not diagnostics or diagnostics['frames'] != len(f) or diagnostics['mode'] != 'sequence':
                raise ValueError('Missing or misaligned sequence diagnostics')
            evidence = np.loadtxt(folder/'02_f0.evidence.csv', delimiter=',')
            if len(evidence) != len(f) or abs(evidence[0, 0]) > 1e-6:
                raise ValueError('Evidence time axis does not match the target curve')
            if diagnostics['jumps_after'] != pitch_jumps(f):
                raise ValueError('Diagnostic jump count does not match the target curve')
        rows.append({'case': key, **row['cases'][key], 'target_jumps_over_8_semitones': pitch_jumps(f),
                     'voiced_frames': int((f > 0).sum()),
                     'diagnostics': diagnostics})
    # These are target-curve measurements, not an assertion of perceptual quality.
    annotation = Path(__file__).with_name('fixtures')/'mid-register-annotation.json'
    report = {'original_seconds': row['original_seconds'], 'cases': rows,
              'fixture': args.fixture.stem, 'common_options': row['common_options'],
              'human_register_annotation': json.loads(annotation.read_text()) if base == BASE and annotation.exists() else None,
              'quality_note': 'Curve continuity and estimator agreement are not pitch ground truth; sequence default was withdrawn after a human-reported octave regression.',
              'verified_inputs': row['inputs']}
    summary_name = 'benchmark-summary.json' if args.fixture.stem in ('mid-song', 'circe-song') else args.fixture.stem+'-summary.json'
    (base.parent/summary_name).write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps([{k:v for k,v in r.items() if k!='diagnostics'} for r in rows], indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
