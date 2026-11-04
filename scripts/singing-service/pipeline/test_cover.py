import argparse
import contextlib
import io
import os
from pathlib import Path
import shutil
import tempfile
import uuid
import subprocess
import sys
import ast
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np
import soundfile as sf
import cover
from cover_support import identity, mix_stereo, splice_patch, confident_octaves, FileLock


def args(work):
    return argparse.Namespace(
        song=str(work / 'source.wav'), slug='test', workdir=str(work / 'job'), out='',
        model='model.pth', index='', pitch=0, f0_method='rmvpe', index_rate=0.6, filter_radius=7,
        protect=0.35, rms_mix=0.15, demucs_model='htdemucs_ft', shifts=1, start=0, dur=0,
        inst_gain=0.9, vocal_gain=1, presence_db=8, air=0, debuzz=0.85, gate_db=-30,
        lowcut=0, low_shelf=0, inst_transpose=0, force_from=99, f0_file='',
        backing_stem='', backing_gain=1, lead_back='off', lead_stem='',
    )


class PipelineTests(unittest.TestCase):
    def setUp(self):
        # 别用 tempfile.TemporaryDirectory：它的目录带 0700 ACE，受限沙箱里
        # 连 cleanup 的 chmod 都会被拒（38 个 error 全炸在这）。普通 mkdir 就没事。
        self.temp = Path(__file__).parent / ('tmp' + uuid.uuid4().hex)
        self.temp.mkdir()
        self.addCleanup(shutil.rmtree, self.temp, True)
        self.root = self.temp
        self.a = args(self.root)
        Path(self.a.song).write_bytes(b'a' * 2048)
        self.job = cover.Job(self.a)
        self.out = self.root / 'out.wav'
        self.out.write_bytes(b'x' * 2048)

    def test_source_content_change_same_size_and_timestamp(self):
        self.job.mark('0_decode', self.out)
        self.assertTrue(self.job.fresh('0_decode', self.out))
        p = Path(self.a.song)
        before = p.stat()
        p.write_bytes(b'b' * 2048)
        os.utime(p, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertFalse(self.job.fresh('0_decode', self.out))

    def test_output_corruption_invalidates_cache(self):
        self.job.mark('0_decode', self.out)
        self.out.write_bytes(b'y' * 2048)
        self.assertFalse(self.job.fresh('0_decode', self.out))

    def test_legacy_manifest_not_trusted(self):
        self.job.man = {'0_decode': {'params': {'start': 0, 'dur': 0}, 'deps': []}}
        self.assertFalse(self.job.fresh('0_decode', self.out))

    def test_f0_environment_and_weights_invalidate_cache(self):
        model = self.root / 'assets/weights/model.pth'
        model.parent.mkdir(parents=True)
        model.write_bytes(b'weights1')
        with patch.object(cover, 'RVC', self.root), patch.dict(os.environ, {'RVC_F0_OCTAVE_FIX': 'ref'}):
            self.job.mark('2_rvc', self.out)
            self.assertTrue(self.job.fresh('2_rvc', self.out))
            with patch.dict(os.environ, {'RVC_F0_OCTAVE_FIX': 'off'}):
                self.assertFalse(self.job.fresh('2_rvc', self.out))
            model.write_bytes(b'weights2')
            self.assertFalse(self.job.fresh('2_rvc', self.out))

    def test_missing_instrumental_restarts_separation(self):
        src = Path(self.a.song)
        voc = self.job.work / '01_sep/htdemucs_ft/source/vocals.wav'
        voc.parent.mkdir(parents=True)
        voc.write_bytes(b'v' * 2048)
        self.job.mark('1_sep', voc, [src])
        self.job.man['1_sep']['instrumental'] = {'old': 'identity'}
        with patch.object(cover, 'sh', side_effect=lambda *a, **k: voc.with_name('no_vocals.wav').write_bytes(b'i'*2048)) as sh:
            self.job.stage1(src)
            self.assertEqual(sh.call_count, 1)

    def test_pitch_mode_invalidates_cached_inference(self):
        with patch.object(cover, 'RVC', self.root):
            self.job.mark('2_rvc', self.out)
            self.job.p['f0_mode'] = 'off'
            self.assertFalse(self.job.fresh('2_rvc', self.out))

    def test_experimental_sequence_is_not_the_implicit_default(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(cover.params_from(self.a)['f0_mode'], 'breath')

    def test_whole_octave_keeps_accompaniment_key(self):
        for pitch in (0,12,-12,24):
            self.assertEqual(cover.default_inst_transpose(pitch),0)
        self.assertEqual(cover.default_inst_transpose(4),4)

    def test_mix_reference_content_and_disabling_invalidate_cache(self):
        reference=self.root/'mix.wav'
        reference.write_bytes(b'a'*2048)
        self.job.pitch_reference=str(reference)
        self.job.mark('2_rvc',self.out)
        reference.write_bytes(b'b'*2048)
        self.assertFalse(self.job.fresh('2_rvc',self.out))
        self.job.mark('2_rvc',self.out)
        self.job.pitch_reference=''
        self.assertFalse(self.job.fresh('2_rvc',self.out))

    def test_automatic_pitch_retry_keeps_original_content_and_respects_manual_f0(self):
        import json
        for manual in ('','manual.csv'):
            with self.subTest(manual=manual):
                self.a.mix_reference='auto'
                self.a.f0_file=manual
                job=cover.Job(self.a)
                calls=[]
                def fake_sh(cmd,**kwargs):
                    if any(Path(str(c)).name=='cover_separate.py' for c in cmd):
                        lead=job.work/'01_pitch_lead/lead.wav'
                        lead.parent.mkdir(exist_ok=True)
                        lead.write_bytes(b'l'*2048)
                    else:
                        calls.append((list(cmd),kwargs))
                        (job.work/'02_rvc_40k.wav').write_bytes(b'v'*2048)
                        (job.work/'02_f0.diagnostics.json').write_text(json.dumps({
                            'mix_reference':{'reference_supported_frames':80}}))
                with patch.dict(sys.modules,{'sing_bridge':SimpleNamespace(infer_remote=lambda *a:False)}), patch.object(cover,'sh',side_effect=fake_sh):
                    job.stage2(Path(self.a.song))
                self.assertEqual(len(calls),1 if manual else 2)
                for cmd,_ in calls:
                    self.assertEqual(cmd[cmd.index('--input_path')+1],self.a.song)
                if not manual:
                    self.assertTrue(calls[-1][1]['env_updates']['RVC_F0_LEAD_REFERENCE'])
                self.assertEqual(Path(self.a.song).read_bytes(),b'a'*2048)
    def test_energy_collapse_detected_without_any_f0(self):
        silent = np.zeros(cover.SR)
        reference = np.ones(cover.SR) * 0.1
        unknown = np.full(101, np.nan)
        issues = cover.locate_issues(silent, reference, unknown, unknown)
        self.assertTrue(any(i[1] == '能量塌' for i in issues))

    def test_absolute_pitch_error_detected(self):
        audio = np.ones(cover.SR) * 0.1
        issues = cover.locate_issues(audio, audio, np.full(101, 440), np.full(101, 220))
        self.assertTrue(any(i[1] == '音高跳' for i in issues))

    def test_energy_scan_beyond_short_f0(self):
        y = np.ones(2*cover.SR) * 0.1
        reference = y.copy()
        y[cover.SR:] = 0
        unknown = np.full(10, np.nan)
        issues = cover.locate_issues(y, reference, unknown, unknown)
        self.assertTrue(any(i[0] >= 1 for i in issues))

    def test_overlapping_pitch_warning_does_not_hide_energy_collapse(self):
        output=np.ones(cover.SR)*.001
        reference=np.ones(cover.SR)*.1
        issues=cover.locate_issues(output,reference,np.full(101,440.),np.full(101,220.))
        self.assertEqual({x[1] for x in issues},{'音高跳','能量塌'})

    def test_stereo_is_preserved(self):
        inst = np.column_stack((np.full(100, 0.1), np.full(100, -0.1)))
        mixed = mix_stereo(np.full(100, 0.05), inst, inst_gain=1)
        np.testing.assert_allclose(mixed[:, 0], 0.15)
        np.testing.assert_allclose(mixed[:, 1], -0.05)

    def test_duration_loss_rejected(self):
        with self.assertRaises(ValueError):
            mix_stereo(np.zeros(100), np.zeros((cover.SR, 2)))

    def test_patch_preserves_samples_outside_interval(self):
        t = np.arange(4*1000) / 1000
        base = np.sin(t*2*np.pi*7).astype('float32') * 0.1
        rendered = base[500:3500] * 0.8
        out, gain = splice_patch(base, rendered, 1, 3, 0.5, sr=1000)
        np.testing.assert_array_equal(out[:1000], base[:1000])
        np.testing.assert_array_equal(out[3000:], base[3000:])
        self.assertAlmostEqual(gain, 1.25, places=5)
        self.assertEqual(out.shape, base.shape)
        self.assertEqual(out[1000], base[1000])
        self.assertEqual(out[2999], base[2999])

    def test_patch_rejects_short_render(self):
        with self.assertRaises(ValueError):
            splice_patch(np.zeros(4000), np.zeros(100), 1, 3, 0.5, sr=1000)

    def test_octave_ignores_weak_or_short_disagreement(self):
        f = np.full(100, 220.0)
        ref = np.full(100, 440.0)
        out, n = confident_octaves(f, ref, np.full(100, 0.5))
        self.assertEqual(n, 0)
        probability = np.zeros(100)
        probability[:7] = 1
        out, n = confident_octaves(f, ref, probability)
        self.assertEqual(n, 0)
        out, n = confident_octaves(f, ref, np.ones(100))
        self.assertEqual(n, 100)
        np.testing.assert_array_equal(out, ref)

    def test_stereo_peak_check_cannot_cancel(self):
        p = self.root / 'antiphase.wav'
        wave = np.sin(np.arange(cover.SR)/cover.SR * 2*np.pi*440) * 1.1
        sf.write(p, np.column_stack((wave, -wave)), cover.SR, subtype='FLOAT')
        self.assertFalse(cover.check(p))

    def test_local_issue_changes_pass_to_warn(self):
        p, ref = self.root / 'test.wav', self.root / 'ref.wav'
        wave = np.sin(np.arange(3*cover.SR)/cover.SR * 2*np.pi*220) * 0.1
        sf.write(p, wave, cover.SR)
        sf.write(ref, wave, cover.SR)
        f = np.full(301, 220.0)
        curve=self.root/'02_f0.csv'
        np.savetxt(curve,np.column_stack((np.arange(301)*.01,f)),delimiter=',')
        with patch('librosa.pyin', return_value=(f, None, None)), \
             patch.object(cover, 'locate_issues', return_value=[(1, '音高跳', 1.0, 'test')]):
            self.assertFalse(cover.check(p, ref,f0_path=curve))
        self.assertTrue(p.with_suffix('.issues.json').exists())

    def test_long_manual_f0_does_not_overflow_32767_frames(self):
        source = Path(__file__).with_name('pipeline.py')
        if not source.exists():
            source = cover.RVC / 'infer/modules/vc/pipeline.py'
        tree = ast.parse(source.read_text('utf-8'))
        method = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == 'get_f0')
        scope = {'np': np, 'os': os}
        exec(compile(ast.Module(body=[method], type_ignores=[]), str(source), 'exec'), scope)
        obj = SimpleNamespace(sr=16000, window=160, x_pad=1, device='cpu',
                              model_rmvpe=SimpleNamespace(infer_from_audio=lambda *a, **k: np.full(40201, 220.0)))
        # Manual target pitch must bypass sequence estimation as well as survive long curves.
        with patch.dict(os.environ, {'RVC_F0_OCTAVE_FIX': 'sequence', 'RVC_F0_DUMP': ''}):
            coarse, f = scope['get_f0'](obj, '', np.zeros(1), 40201, 0, 'rmvpe', 7,
                                        np.array([[0., 440.], [400., 440.]]))
        self.assertEqual(len(f), 40201)
        np.testing.assert_array_equal(f[100:40101], 440.)

    def child(self, code, extra_env=None):
        env = os.environ.copy()
        env.update(extra_env or {})
        return subprocess.Popen([sys.executable, '-B', '-c',
                                 'import sys;sys.path.insert(0,' + repr(str(Path(cover.__file__).parent)) + ');' + code],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)

    def test_same_directory_rejected_across_processes(self):
        lock = self.root / '.cover.lock'
        code = ('from cover_support import FileLock;lock=FileLock(' + repr(str(lock)) + ');'
                '\ntry: lock.__enter__()\nexcept RuntimeError: sys.exit(17)\nelse: sys.exit(9)')
        with FileLock(lock):
            p = self.child(code)
            p.communicate(timeout=5)
            self.assertEqual(p.returncode, 17)
        with FileLock(lock):
            pass

    def test_lock_released_when_worker_is_killed(self):
        lock = self.root / 'gpu.lock'
        code = ('from cover_support import FileLock;import time;lock=FileLock(' + repr(str(lock)) + ');'
                'lock.__enter__();print("locked",flush=True);time.sleep(30)')
        p = self.child(code)
        try:
            self.assertEqual(p.stdout.readline().strip(), 'locked')
            with self.assertRaises(RuntimeError):
                with FileLock(lock):
                    pass
        finally:
            p.kill()
            p.communicate(timeout=5)
        with FileLock(lock):
            pass

    def test_parent_gpu_lock_can_be_inherited_without_deadlock(self):
        root = self.root / 'locks'
        code = ('from cover_support import gpu_guard;guard=gpu_guard(' + repr(str(self.root)) + ');'
                'guard.__enter__();guard.__exit__(None,None,None)')
        with FileLock(root / 'gpu.lock'):
            p = self.child(code, {'COVER_LOCK_ROOT': str(root), 'COVER_GPU_LOCK_HELD': str(root.resolve())})
            p.communicate(timeout=5)
            self.assertEqual(p.returncode, 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
