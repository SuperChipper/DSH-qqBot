"""Guarded deployment into the existing voice-lab checkout, preserving local edits."""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil

SOURCE = Path(__file__).resolve().parent
# voice-lab 与 dsh-qqbot 同级，按脚本位置推导，仓库整体搬家也不用改；目标不在该位置时用 VOICE_LAB_ROOT 覆盖。
ROOT = Path(os.environ.get('VOICE_LAB_ROOT') or SOURCE.parents[2] / 'voice-lab')
FILES = ['sing_service.py', 'sing_rvc_worker.py', 'sing_bridge.py', 'sing_api.py',
         'sing_process.py', 'sing_client.py', 'start-singing.ps1']
MANIFEST = SOURCE/'deployment-plan.json'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def replace_one(text, before, after):
    if text.count(before) != 1:
        raise RuntimeError('Source changed; patch anchor is not unique: '+before[:90])
    return text.replace(before, after, 1)


def prepare_files():
    cover = (ROOT/'scripts/cover.py').read_text('utf-8')
    if 'from sing_bridge import infer_remote' not in cover:
        cover = replace_one(cover, '        sh(cmd, cwd=RVC, capture=False)\n        if not out40.exists():',
        '        from sing_bridge import infer_remote\n'
        '        if not infer_remote(self, voc, out40):\n'
        '            sh(cmd, cwd=RVC, capture=False)\n        if not out40.exists():')
    if 'from sing_process import wait_gate' not in cover:
        cover = replace_one(cover, 'def main():\n    with ExitStack() as locks:',
        'def main():\n    from sing_process import wait_gate\n    wait_gate()\n    with ExitStack() as locks:')
    if 'sg["rvc_backend"]' not in cover:
        cover = replace_one(cover, '            sg["octave_fix"] = os.environ.get("RVC_F0_OCTAVE_FIX", "ref")',
        '            sg["octave_fix"] = os.environ.get("RVC_F0_OCTAVE_FIX", "ref")\n'
        '            sg["rvc_backend"] = "service" if os.environ.get("COVER_RVC_URL") else "cli"\n'
        '            sg["backend_code"] = [identity(Path(__file__).with_name(name)) for name in\n'
        '                ("sing_bridge.py", "sing_rvc_worker.py")]')
    startup = (ROOT/'scripts/start-services.ps1').read_text('utf-8')
    if '[switch]$SingOnly' not in startup:
        startup = replace_one(startup, '    [switch]$Stop\n)', '    [switch]$Stop,\n    [switch]$SingOnly\n)')
        startup = replace_one(startup, "if ($Stop) {", '''$singing = Join-Path $VoiceLab 'scripts\\start-singing.ps1'
if ($SingOnly) {
    if ($Stop) { & $singing -Stop }
    elseif ($Status) { & $singing -Status }
    else { & $singing }
    return
}

if ($Stop) {
    & $singing -Stop''')
        startup = replace_one(startup, 'if ($Status) {\n', 'if ($Status) {\n    & $singing -Status\n')
        startup += '\n# Singing owns its asynchronous queue and reusable RVC worker.\n& $singing\n'
    existing_doc = (ROOT/'COVER.md').read_text('utf-8')
    doc = '''## 2026-10-31：异步唱歌服务已落地

Agent 点歌优先调用 `env\\python.exe scripts\\sing_client.py --ensure submit --song <音频路径或URL>`，
立即获得任务 ID；用 `status <id>` 查状态，`cancel <id>` 取消，`result <id> --out <路径>` 取成品。
可用 `--stems-from <旧任务>` / `--repair-from <旧任务>`，参数放 `--options-json` JSON 对象。
服务入口 `127.0.0.1:8766`，RVC 模型由私有常驻 worker 复用；每单隔离目录、单任务队列、取消清理进程树。
`scripts/start-singing.ps1` 可启停；统一启动器支持 `-SingOnly`。详细 API 与生命周期见 [SINGING_SERVICE.md](SINGING_SERVICE.md)。
CLI `cover.py` 仍可独立调用。以下历史记录里“尚未服务化”的描述已过时。

'''
    if '## 2026-10-31：异步唱歌服务已落地' not in existing_doc:
        existing_doc = replace_one(existing_doc, '# 翻唱流水线（cover.py）\n', '# 翻唱流水线（cover.py）\n\n'+doc)
    result = {ROOT/'scripts'/name: (SOURCE/name).read_bytes() for name in FILES}
    result.update({ROOT/'scripts/cover.py': cover.encode('utf-8'),
                   ROOT/'scripts/start-services.ps1': startup.encode('utf-8'),
                   ROOT/'COVER.md': existing_doc.encode('utf-8'),
                   ROOT/'SINGING_SERVICE.md': (SOURCE/'README.md').read_bytes()})
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--prepare', action='store_true')
    parser.add_argument('--install', action='store_true')
    a = parser.parse_args()
    files = prepare_files()
    if a.prepare:
        MANIFEST.write_text(json.dumps({str(p):digest(p) for p in files}, indent=2), encoding='utf-8')
        print('Prepared guarded deployment for', len(files), 'files')
        return
    if not a.install:
        parser.error('Specify --prepare or --install')
    expected = json.loads(MANIFEST.read_text('utf-8'))
    for p in files:
        p.resolve().relative_to(ROOT.resolve())
        if digest(p) != expected[str(p)]:
            raise RuntimeError(f'Concurrent edit detected: {p}')
    backup = ROOT/'backups'/('sing-service-'+datetime.now().strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(parents=True, exist_ok=False)
    for p in files:
        if p.exists():
            copy = backup/p.relative_to(ROOT)
            copy.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, copy)
    for p, content in files.items():
        temporary = p.with_name(p.name+'.sing-install.tmp')
        temporary.write_bytes(content)
        temporary.replace(p)
    report = {'backup': str(backup), 'files': {str(p):digest(p) for p in files}}
    (SOURCE/'deployment-result.json').write_text(json.dumps(report,indent=2), encoding='utf-8')
    (backup/'deployment.json').write_text(json.dumps(report,indent=2), encoding='utf-8')
    print(json.dumps(report,indent=2))


if __name__ == '__main__':
    main()
