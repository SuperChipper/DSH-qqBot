from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
import cover
from cover_roformer import overlap_add
from test_cover import args


class OverlapTests(unittest.TestCase):
    def test_identity_keeps_stereo_samples_and_arbitrary_lengths(self):
        for length in (1, 17, 320, 401, 1579):
            for overlap in (2, 4):
                with self.subTest(length=length, overlap=overlap):
                    t=np.arange(length)/1000
                    y=np.stack((np.sin(t*91),np.cos(t*37))).astype('float32')
                    actual=overlap_add(y,320,overlap,lambda x:x*.7)
                    self.assertEqual(actual.shape,y.shape)
                    np.testing.assert_allclose(actual,y*.7,atol=3e-7)
                    np.testing.assert_allclose(actual+(y-actual),y,atol=2e-7)

    def test_rejects_invalid_input_or_model_output(self):
        for y in (np.zeros((2,0)),np.zeros((1,100)),np.full((2,100),np.nan)):
            with self.assertRaises(ValueError):overlap_add(y,320,2,lambda x:x)
        for predict in (lambda x:x[:,:-1],lambda x:np.full_like(x,np.inf)):
            with self.assertRaises(ValueError):overlap_add(np.zeros((2,100)),320,2,predict)


class SeparationCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.a=args(self.root);self.a.separator='roformer'
        assets=self.root/'models/separation/roformer';assets.mkdir(parents=True)
        self.weight=assets/'MelBandRoformer.ckpt';self.weight.write_bytes(b'weights1')
        self.config=assets/'MelBandRoformer.yaml';self.config.write_text('config1')
        self.output=self.root/'out.wav';self.output.write_bytes(b'x'*2048)
        self.job=cover.Job(self.a)

    def test_checkpoint_content_change_invalidates_cache_without_mtime_change(self):
        with patch.object(cover,'ROOT',self.root):
            self.job.mark('1_sep',self.output);self.assertTrue(self.job.fresh('1_sep',self.output))
            stat=self.weight.stat();self.weight.write_bytes(b'weights2');os.utime(self.weight,ns=(stat.st_atime_ns,stat.st_mtime_ns))
            self.assertFalse(self.job.fresh('1_sep',self.output))

    def test_config_overlap_and_backend_each_invalidate_separation(self):
        with patch.object(cover,'ROOT',self.root):
            self.job.mark('1_sep',self.output);self.config.write_text('config2')
            self.assertFalse(self.job.fresh('1_sep',self.output))
            self.job.mark('1_sep',self.output);self.job.p['roformer_overlap']=4
            self.assertFalse(self.job.fresh('1_sep',self.output))
            self.job.mark('1_sep',self.output);self.job.p['separator']='demucs'
            self.assertFalse(self.job.fresh('1_sep',self.output))

    def test_roformer_routes_original_mix_to_runner_and_keeps_two_stems(self):
        source=self.root/'original.wav';source.write_bytes(b'source')
        commands=[]
        def fake_sh(cmd,**kw):
            commands.append(cmd);folder=Path(cmd[cmd.index('--outdir')+1]);folder.mkdir(parents=True)
            for name in ('vocals.wav','no_vocals.wav'):(folder/name).write_bytes(b'x'*2048)
        with patch.object(cover,'ROOT',self.root),patch.object(cover,'sh',side_effect=fake_sh):
            vocal,inst=self.job.stage1(source)
            self.assertIn('cover_roformer.py',[Path(str(x)).name for x in commands[0]])
            self.assertEqual(commands[0][commands[0].index('--input')+1],source)
            self.assertEqual(vocal.parent,inst.parent)
            self.assertEqual(self.job.man['1_sep']['params']['separator'],'roformer')
            self.assertEqual(self.job.man['1_sep']['instrumental']['sha256'],cover.identity(inst)['sha256'])


if __name__=='__main__':unittest.main()
