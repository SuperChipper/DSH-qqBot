"""Shared local API contract. Requests cannot supply shell arguments or output paths."""
from __future__ import annotations

import json
import math
from pathlib import Path
import re
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

SERVICE = 'voice-lab-singing'
VERSION = 1
TERMINAL = {'succeeded', 'succeeded_with_warnings', 'failed', 'cancelled', 'timed_out', 'interrupted'}
SUCCESS = {'succeeded', 'succeeded_with_warnings'}
ID = re.compile(r'^[a-f0-9]{32}$')
NUMBERS = {
    'pitch': (-24, 24, int), 'index_rate': (0, 1, float), 'protect': (0, .5, float),
    'rms_mix': (0, 1, float), 'filter_radius': (0, 15, int), 'shifts': (0, 10, int),
    'start': (0, 86400, float), 'dur': (0, 3600, float), 'inst_transpose': (-24, 24, float),
    'vocal_gain': (0, 4, float), 'inst_gain': (0, 4, float), 'backing_gain': (0, 4, float),
    'presence_db': (-12, 18, float), 'air': (0, 1, float), 'debuzz': (0, 1, float),
    'gate_db': (-80, 0, float), 'lowcut': (0, 1000, float), 'low_shelf': (-18, 12, float),
    'repair_start': (0, 86400, float), 'repair_dur': (.01, 3600, float),
    'repair_context': (.25, 10, float), 'repair_fade': (0, 2, float), 'check_secs': (0, 3600, float),
}
CHOICES = {'f0_method': {'rmvpe', 'harvest', 'pm', 'crepe'}, 'lead_back': {'off', 'hp5'},
           'preset': {'', 'auto', 'female', 'male-thin', 'low'}}
PATHS = {'f0_file', 'lead_stem', 'backing_stem'}


def local_path(value, allowed, *, directory=False):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('Expected a non-empty local path')
    p = Path(value).resolve()
    if not any(p == root or root in p.parents for root in allowed):
        raise ValueError('Path must be inside an allowed source root')
    if not (p.is_dir() if directory else p.is_file()):
        raise ValueError(f'Input does not exist: {p}')
    return str(p)


def validate(payload, allowed, models):
    if not isinstance(payload, dict) or set(payload) - {'song', 'stems_from', 'repair_from', 'options', 'idempotency_key'}:
        raise ValueError('Unknown request fields')
    modes = [key for key in ('song', 'stems_from', 'repair_from') if payload.get(key)]
    if len(modes) != 1:
        raise ValueError('Supply exactly one of song, stems_from or repair_from')
    mode, value = modes[0], payload[modes[0]]
    if not isinstance(value, str):
        raise ValueError('Input must be a string')
    if mode == 'song' and urlsplit(value).scheme in ('http', 'https'):
        url = urlsplit(value)
        if not url.hostname or url.username or url.password:
            raise ValueError('Invalid source URL')
    else:
        value = local_path(value, allowed, directory=mode != 'song')
        if mode != 'song' and not (Path(value) / 'manifest.json').is_file():
            raise ValueError('Source job needs manifest.json')
    options = payload.get('options', {})
    if not isinstance(options, dict):
        raise ValueError('options must be an object')
    result = {}
    for key, item in options.items():
        if key in NUMBERS:
            low, high, kind = NUMBERS[key]
            if (isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item)
                    or not low <= item <= high or kind is int and int(item) != item):
                raise ValueError(f'{key} must be {kind.__name__} in [{low}, {high}]')
            result[key] = kind(item)
        elif key in CHOICES:
            if not isinstance(item, str) or item not in CHOICES[key]:
                raise ValueError(f'Invalid {key}')
            result[key] = item
        elif key in PATHS:
            result[key] = local_path(item, allowed)
        elif key == 'model':
            if not isinstance(item, str) or item not in models:
                raise ValueError('Unknown installed RVC model')
            result[key] = item
        else:
            raise ValueError(f'Unknown option: {key}')
    if mode == 'repair_from':
        if not result.get('repair_dur'):
            raise ValueError('repair_from requires repair_dur')
        if any(k in result for k in ('start', 'dur', 'preset', 'lead_back', 'lead_stem', 'backing_stem')):
            raise ValueError('Repair does not accept crop, preset or stem overrides')
    elif any(k.startswith('repair_') for k in result):
        raise ValueError('repair_* options require repair_from')
    if mode == 'stems_from' and any(result.get(k) for k in ('start', 'dur')):
        raise ValueError('stems_from uses the source job timeline')
    if 'backing_stem' in result and 'lead_stem' not in result:
        raise ValueError('backing_stem requires lead_stem')
    if result.get('lead_back', 'off') != 'off' and any(k in result for k in ('lead_stem', 'backing_stem')):
        raise ValueError('Automatic and external stem separation cannot be combined')
    key = payload.get('idempotency_key', '')
    if not isinstance(key, str) or len(key) > 128:
        raise ValueError('idempotency_key must be a string of at most 128 characters')
    return {mode: value, 'options': result, 'idempotency_key': key}


def command(request, python, pipeline, work, output):
    args = [str(python), '-B', str(pipeline)]
    if 'song' in request:
        args.append(request['song'])
    else:
        key = 'stems_from' if 'stems_from' in request else 'repair_from'
        args += ['--' + key.replace('_', '-'), request[key]]
    for key, value in request['options'].items():
        args += ['--' + key.replace('_', '-'), str(value)]
    return args + ['--workdir', str(work), '--slug', 'song', '--out', str(output)]


def rpc(url, payload=None, *, token='', timeout=10, method=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    data = json.dumps(payload, allow_nan=False).encode() if payload is not None else None
    with urlopen(Request(url, data=data, headers=headers, method=method), timeout=timeout) as response:
        return json.load(response)
