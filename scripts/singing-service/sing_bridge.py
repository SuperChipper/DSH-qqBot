"""Optional cover.py transport to the supervisor-owned, reusable RVC worker."""
import os
from pathlib import Path
from urllib.parse import urlsplit
from sing_api import rpc


def infer_remote(job, source, target):
    url = os.environ.get('COVER_RVC_URL', '').rstrip('/')
    if not url:
        return False
    parts = urlsplit(url)
    if parts.scheme != 'http' or parts.hostname != '127.0.0.1' or parts.path or parts.query or parts.fragment:
        raise ValueError('COVER_RVC_URL must be a private loopback HTTP endpoint')
    import cover
    p = job.p
    result = rpc(url+'/infer', {
        'input_path': str(Path(source).resolve()), 'opt_path': str(Path(target).resolve()),
        'model_name': p['model'], 'f0up_key': p['pitch'], 'f0method': p['f0method'],
        'index_path': str(cover.INDEX) if cover.INDEX.exists() and p['index_rate'] > 0 else '',
        'index_rate': p['index_rate'], 'filter_radius': p['filter_radius'],
        'rms_mix_rate': p['rms_mix'], 'protect': p['protect'],
        'f0_file': str(Path(job.a.f0_file).resolve()) if job.a.f0_file else '',
        'f0_dump': str(job.work/'02_f0.csv'),
        'octave_fix': os.environ.get('RVC_F0_OCTAVE_FIX', 'ref'),
    }, token=os.environ.get('SING_WORKER_TOKEN', ''), timeout=900)
    print(f"RVC service: model_loads={result['model_loads']} inferences={result['inferences']} "
          f"seconds={result['seconds']:.2f}", flush=True)
    return True
