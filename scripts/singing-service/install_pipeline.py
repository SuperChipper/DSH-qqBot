"""Deploy reviewed inference code with content guards and a timestamped rollback copy."""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil

SOURCE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get('VOICE_LAB_ROOT') or SOURCE.parents[2]/'voice-lab').resolve()
PLAN = SOURCE/'pipeline-deployment-plan.json'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def files():
    pairs = {SOURCE/'pipeline'/name: ROOT/'scripts'/name for name in
             ('cover.py', 'cover_support.py', 'cover_dsp.py', 'cover_roformer.py', 'setup_roformer.py', 'roformer-kim.yaml', 'test_cover_roformer.py', 'f0_path.py', 'breath_pitch.py', 'mix_pitch.py', 'pitch_check.py','music_export.py',
              'test_cover.py', 'test_cover_dsp.py', 'test_f0_path.py', 'test_breath_pitch.py', 'test_mix_pitch.py', 'test_pitch_check.py','test_music_export.py')}
    pairs[SOURCE/'pipeline/pipeline.py'] = ROOT/'rvc/pkg/RVC20240604Nvidia50x0/infer/modules/vc/pipeline.py'
    pairs[SOURCE/'sing_api.py'] = ROOT/'scripts/sing_api.py'
    pairs[SOURCE/'sing_bridge.py'] = ROOT/'scripts/sing_bridge.py'
    pairs[SOURCE/'sing_rvc_worker.py'] = ROOT/'scripts/sing_rvc_worker.py'
    pairs[SOURCE/'sing_service.py'] = ROOT/'scripts/sing_service.py'
    pairs[SOURCE/'sing_client.py'] = ROOT/'scripts/sing_client.py'
    pairs[SOURCE/'test_sing_service.py'] = ROOT/'scripts/test_sing_service.py'
    pairs[SOURCE/'pipeline/COVER.md'] = ROOT/'COVER.md'
    pairs[SOURCE/'pipeline/fixtures/circe-breath-6-9.csv'] = ROOT/'scripts/fixtures/circe-breath-6-9.csv'
    for name in ('maid-mix.csv', 'male-mix.csv', 'maid-waveform.csv','maid-register.npz'):
        pairs[SOURCE/'pipeline/fixtures'/name] = ROOT/'scripts/fixtures'/name
    return pairs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--prepare', action='store_true')
    parser.add_argument('--install', action='store_true')
    args = parser.parse_args()
    pairs = files()
    for source, target in pairs.items():
        target.resolve().relative_to(ROOT)
        if source.suffix == '.py':
            compile(source.read_text('utf-8'), str(source), 'exec')
    if args.prepare:
        PLAN.write_text(json.dumps({str(p): digest(p) for p in pairs.values()}, indent=2), encoding='utf-8')
        print('Prepared', len(pairs), 'inference files')
        return
    if not args.install:
        parser.error('Specify --prepare or --install')
    expected = json.loads(PLAN.read_text('utf-8'))
    for target in pairs.values():
        if digest(target) != expected[str(target)]:
            raise RuntimeError('Concurrent edit: '+str(target))
    backup = ROOT/'backups'/('breathy-pipeline-'+datetime.now().strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(parents=True, exist_ok=False)
    for source, target in pairs.items():
        if target.exists():
            saved = backup/target.relative_to(ROOT)
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, saved)
        temporary = target.with_name(target.name+'.pipeline.tmp')
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_bytes(source.read_bytes())
        temporary.replace(target)
    report = {'backup': str(backup), 'files': {str(p): digest(p) for p in pairs.values()}}
    (SOURCE/'pipeline-deployment-result.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
