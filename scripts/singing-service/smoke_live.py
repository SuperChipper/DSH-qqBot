"""Explicit real-GPU acceptance check against the locally running singing service."""
import json
import os
from pathlib import Path
import sys
import time
from urllib.request import Request, urlopen
import uuid

from sing_api import rpc, TERMINAL, SUCCESS


def main():
    import soundfile as sf
    workspace = Path(__file__).resolve().parents[2]
    out = workspace/'tmp/singing-service-live'
    out.mkdir(parents=True, exist_ok=True)
    fixture = workspace/'tmp/rvc-verification/fixture16'
    source = out/'source4'
    source.mkdir(exist_ok=True)
    for name in ('00_src.wav', 'vocals.wav', 'no_vocals.wav'):
        audio, rate = sf.read(fixture/name, start=2*44100, frames=4*44100, always_2d=True, dtype='float32')
        sf.write(source/name, audio, rate, subtype='FLOAT')
    (source/'manifest.json').write_text(json.dumps({'1_sep': {
        'out': str(source/'vocals.wav'), 'params': {'demucs': 'htdemucs_ft', 'shifts': 1}}}), encoding='utf-8')
    url = 'http://127.0.0.1:8766'
    token = os.environ.get('SING_SERVICE_TOKEN', '')
    health = rpc(url+'/health', token=token)
    assert health['ready'], health
    marker = 'smoke-'+uuid.uuid4().hex
    active_cancel = None
    if '--cancel-active' in sys.argv:
        job = rpc(url+'/jobs', {'stems_from': str(source), 'options': {},
                               'idempotency_key': marker+'cancel-active'}, token=token)
        deadline = time.monotonic()+120
        while time.monotonic() < deadline:
            state = rpc(url+f'/jobs/{job["id"]}', token=token)
            if state['stage'] == 'rvc':
                break
            if state['state'] in TERMINAL:
                raise RuntimeError('Job finished before cancellation test: '+repr(state))
            time.sleep(.3)
        else:
            raise RuntimeError('RVC never started for active cancellation test')
        time.sleep(1)
        before = rpc(url+'/health', token=token)
        rpc(url+f'/jobs/{job["id"]}/cancel', {}, token=token)
        deadline = time.monotonic()+20
        while time.monotonic() < deadline:
            state = rpc(url+f'/jobs/{job["id"]}', token=token)
            if state['state'] == 'cancelled':
                break
            time.sleep(.2)
        assert state['state'] == 'cancelled', state
        after = rpc(url+'/health', token=token)
        assert not after['rvc']['ready'], after
        active_cancel = {'job': state, 'before': before, 'after': after}
        print('Active RVC cancellation PASS; worker reclaimed', flush=True)
    ids, latency = [], []
    for i in range(3):
        t = time.monotonic()
        job = rpc(url+'/jobs', {'stems_from': str(source), 'options': {}, 'idempotency_key': marker+str(i)}, token=token)
        latency.append(time.monotonic()-t)
        ids.append(job['id'])
    cancelled = rpc(url+f'/jobs/{ids[2]}/cancel', {}, token=token)
    assert cancelled['state'] == 'cancelled', cancelled
    print('Submitted:', ids, 'POST seconds:', latency, flush=True)
    last = None
    deadline = time.monotonic()+360
    records = {}
    while time.monotonic() < deadline:
        for jobid in ids[:2]:
            records[jobid] = rpc(url+f'/jobs/{jobid}', token=token)
        snapshot = [(j, v['state'], v['stage']) for j, v in records.items()]
        if snapshot != last:
            print(snapshot, flush=True)
            last = snapshot
        if all(v['state'] in TERMINAL for v in records.values()):
            break
        time.sleep(2)
    for jobid, record in records.items():
        if record['state'] not in SUCCESS:
            print(rpc(url+f'/jobs/{jobid}/log', token=token)['log'], flush=True)
            raise RuntimeError(record)
        req = Request(url+f'/jobs/{jobid}/result', headers={'Authorization':'Bearer '+token} if token else {})
        with urlopen(req, timeout=20) as response:
            extension='.mp4' if response.headers.get_content_type()=='video/mp4' else '.mp3'
            audio = response.read()
        assert len(audio) > 1024
        (out/(jobid+extension)).write_bytes(audio)
    warm = rpc(url+'/health', token=token)
    assert warm['rvc']['model_loads'] == 1 and warm['rvc']['inferences'] == 2, warm
    assert records[ids[0]]['finished'] <= records[ids[1]]['started']
    report = {'service': health, 'submitted_ids': ids, 'submit_seconds': latency,
              'jobs': records, 'queued_cancel': cancelled, 'model_reuse': warm, 'active_cancel': active_cancel}
    if (out/'acceptance.json').exists():
        (out/('acceptance-before-'+time.strftime('%Y%m%d-%H%M%S')+'.json')).write_bytes((out/'acceptance.json').read_bytes())
    (out/'acceptance.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('ACCEPTANCE PASS: immediate submission, serial jobs, queued cancellation, music media, one model load / two inferences', flush=True)


if __name__ == '__main__':
    main()
