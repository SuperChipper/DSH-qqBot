from pathlib import Path
import json
import unittest
import uuid
import shutil
import contextlib
import io
from unittest.mock import patch
import numpy as np
import soundfile as sf
import cover
from pitch_check import sample_target,target_compliance


class PitchCheckTests(unittest.TestCase):
    def setUp(self):
        self.root=Path(__file__).parent/('tmp'+uuid.uuid4().hex)
        self.root.mkdir()
        self.addCleanup(shutil.rmtree,self.root,True)

    def test_piecewise_octave_correction_is_not_a_global_transposition(self):
        expected=np.r_[np.full(150,440.),np.full(151,220.)]
        report=target_compliance(expected,expected)
        self.assertEqual(report['status'],'pass')
        self.assertEqual(report['over_one_semitone_percent'],0)

    def test_uniform_error_is_not_removed_by_median_centering(self):
        expected=np.full(300,220.)
        report=target_compliance(expected*2**(2/12),expected)
        self.assertEqual(report['status'],'warn')
        self.assertEqual(report['over_one_semitone_percent'],100)
        report=target_compliance(expected*2,expected)
        self.assertEqual(report['octave_error_frames'],300)

    def test_missing_observations_and_unpitched_targets_are_unverified(self):
        self.assertEqual(target_compliance(np.full(300,np.nan),np.full(300,440.))['status'],'unverified')
        self.assertEqual(target_compliance(np.full(300,440.),np.zeros(300))['status'],'unverified')
        actual=np.full(300,np.nan);actual[:60]=440
        self.assertEqual(target_compliance(actual,np.full(300,440.))['status'],'unverified')

    def test_target_sampling_preserves_rests_and_rejects_wrong_time_axis(self):
        path=self.root/'02_f0.csv'
        np.savetxt(path,[[0,440],[.01,0],[.02,440]],delimiter=',')
        np.testing.assert_array_equal(sample_target(path,[0,.01,.02],.02),[440,0,440])
        with self.assertRaises(ValueError):sample_target(path,[0,.01],3)
        for curve in ([[0,440],[.02,-1]],[[0,440],[0,220]],[[.3,440],[3,440]]):
            np.savetxt(path,curve,delimiter=',')
            with self.assertRaises(ValueError):sample_target(path,[0,.01],3)

    def run_audio_check(self,observed,expected,source,shift=0,write_target=True):
        p,src=self.root/'03_vocal.wav',self.root/'source.wav'
        t=np.arange(3*cover.SR)/cover.SR
        wave=np.sin(2*np.pi*220*t)*.1
        sf.write(p,wave,cover.SR);sf.write(src,wave,cover.SR)
        if write_target:
            np.savetxt(self.root/'02_f0.csv',np.column_stack((np.arange(301)*.01,expected)),delimiter=',')
        onset=np.sin(np.arange(200)*.7)+np.cos(np.arange(200)*.11)
        buf=io.StringIO()
        with patch('librosa.pyin',side_effect=[(observed,None,None),(source,None,None)]), \
             patch('librosa.onset.onset_strength',return_value=onset),contextlib.redirect_stdout(buf):
            result=cover.check(p,src,expect_semis=shift)
        return result,json.loads(p.with_suffix('.issues.json').read_text()),buf.getvalue()

    def test_source_disagreement_does_not_fail_correct_final_target_or_double_apply_pitch(self):
        expected=np.r_[np.full(150,440.),np.full(151,220.)]
        passed,report,log=self.run_audio_check(expected,expected,np.full(301,220.),shift=12)
        self.assertTrue(passed)
        self.assertEqual(report['pitch_compliance']['status'],'pass')
        self.assertEqual(report['source_pitch_diagnostic']['over_one_semitone_percent'],100*151/301)
        self.assertNotIn('OCTAVE?',log)
        self.assertEqual(report['melody_correctness'],'not_verified')

    def test_matching_source_cannot_hide_failure_to_follow_target(self):
        passed,report,_=self.run_audio_check(np.full(301,440.),np.full(301,220.),np.full(301,440.))
        self.assertFalse(passed)
        self.assertEqual(report['source_pitch_diagnostic']['median_semitones'],0)
        self.assertEqual(report['pitch_compliance']['over_one_semitone_percent'],100)
        self.assertTrue(any(x['kind']=='音高跳' for x in report['issues']))

    def test_missing_target_does_not_claim_verified_pitch_from_source_agreement(self):
        f=np.full(301,220.)
        passed,report,_=self.run_audio_check(f,f,f,write_target=False)
        self.assertFalse(passed)
        self.assertEqual(report['pitch_compliance']['status'],'unverified')

    def test_dry_vocal_sidecar_can_be_checked_without_a_source_waveform(self):
        p=self.root/'03_vocal.wav'
        t=np.arange(3*cover.SR)/cover.SR
        sf.write(p,np.sin(2*np.pi*440*t)*.1,cover.SR)
        f=np.full(301,440.)
        np.savetxt(p.with_name('02_f0.csv'),np.column_stack((np.arange(301)*.01,f)),delimiter=',')
        with patch('librosa.pyin',return_value=(f,None,None)),contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(cover.check(p))
        report=json.loads(p.with_suffix('.issues.json').read_text())
        self.assertEqual(report['pitch_compliance']['status'],'pass')
        self.assertEqual(report['scope'],'target_following_and_audio')


if __name__=='__main__':unittest.main()
