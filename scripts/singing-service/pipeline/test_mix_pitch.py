from pathlib import Path
import unittest
import numpy as np
from mix_pitch import raise_from_mix, waveform_octave_scores
from f0_path import pitch_jumps


class MixPitchTests(unittest.TestCase):
    def test_sustained_half_frequency_with_weak_source_evidence(self):
        f=np.full(300,260.)
        f[100:120]=0
        out,report=raise_from_mix(f,np.full(300,520.),np.full(300,.3))
        np.testing.assert_array_equal(out[f>0],520.)
        np.testing.assert_array_equal(out==0,f==0)
        self.assertEqual(report['lowered_frames'],0)

    def test_confident_true_low_note_and_isolated_instrument(self):
        f=np.full(300,130.)
        out,_=raise_from_mix(f,np.full(300,260.),np.full(300,.9))
        np.testing.assert_array_equal(out,f)
        mix=f.copy(); mix[40:65]*=2
        out,_=raise_from_mix(f,mix,np.full(300,.3))
        np.testing.assert_array_equal(out,f)

    def test_lower_reference_never_lowers_soft_high_voice(self):
        f=np.full(300,580.)
        out,_=raise_from_mix(f,f/2,np.full(300,.3))
        np.testing.assert_array_equal(out,f)

    def test_unrelated_notes_and_short_disagreements_are_ignored(self):
        f=np.full(300,260.)
        mix=np.full(300,600.)
        mix[40:47]=520
        out,_=raise_from_mix(f,mix,np.full(300,.1))
        np.testing.assert_array_equal(out,f)

    def test_missing_source_evidence_is_not_permission_to_raise(self):
        f=np.full(300,260.)
        out,_=raise_from_mix(f,f*2,np.full(300,np.nan))
        np.testing.assert_array_equal(out,f)
        with self.assertRaises(ValueError):
            raise_from_mix(f,f[:-1],np.ones(300))

    def test_register_continuity_does_not_double_existing_high_notes(self):
        f=np.full(400,300.)
        f[180:200]=600
        mix=np.full(400,600.)
        mix[140:150]=300
        out,_=raise_from_mix(f,mix,np.full(400,.3))
        np.testing.assert_array_equal(out,600.)
        self.assertEqual(pitch_jumps(out),0)

    def test_register_evidence_cannot_extend_indefinitely_into_a_low_phrase(self):
        f=np.full(500,260.)
        mix=f.copy();mix[:100]*=2
        out,_=raise_from_mix(f,mix,np.full(500,.3))
        np.testing.assert_array_equal(out[200:],f[200:])

    def test_candidate_that_creates_new_octave_switches_is_rejected(self):
        f=np.full(500,260.)
        mix=f.copy(); mix[200:300]*=2
        out,report=raise_from_mix(f,mix,np.full(500,.3))
        np.testing.assert_array_equal(out,f)
        self.assertTrue(report['rejected_new_octave_jumps'])

    def test_real_maid_and_male_regressions(self):
        root=Path(__file__).with_name('fixtures')
        maid=np.loadtxt(root/'maid-mix.csv',delimiter=',')
        out,report=raise_from_mix(maid[:,1],maid[:,2],maid[:,3])
        self.assertGreater(report['raised_frames'],500)
        self.assertLessEqual(pitch_jumps(out),pitch_jumps(maid[:,1]))
        self.assertTrue(np.all(out>=maid[:,1]))
        for original in (41.3,41.7,42.3,46.5):
            i=round((original-28)*100)
            self.assertGreater(out[i],430)
        np.testing.assert_array_equal(out==0,maid[:,1]==0)
        male=np.loadtxt(root/'male-mix.csv',delimiter=',')
        out,report=raise_from_mix(male[:,1],male[:,2],male[:,3])
        np.testing.assert_array_equal(out,male[:,1])
        self.assertEqual(report['raised_frames'],0)

    def test_waveform_scores_distinguish_even_harmonics_from_true_low_fundamental(self):
        t=np.arange(32000)/16000
        f=np.full(201,260.)
        low=np.sin(2*np.pi*260*t)+.15*np.sin(2*np.pi*520*t)
        upper=np.sin(2*np.pi*520*t)+.05*np.sin(2*np.pi*260*t)
        a=waveform_octave_scores(f,low)[5:-5]
        b=waveform_octave_scores(f,upper)[5:-5]
        self.assertLess(np.median(a[:,0]),0)
        self.assertGreater(np.median(b[:,0]),.9)
        self.assertGreater(np.median(b[:,2]),15)

    def test_waveform_needs_external_register_anchors_and_preserves_true_low_voice(self):
        f=np.full(400,260.)
        t=np.arange(64000)/16000
        upper=np.sin(2*np.pi*520*t)+.05*np.sin(2*np.pi*260*t)
        out,_=raise_from_mix(f,f,np.full(400,.2),waveforms=[upper])
        np.testing.assert_array_equal(out,f)
        reference=f.copy();reference[:100]*=2
        true_low=np.sin(2*np.pi*260*t)+.15*np.sin(2*np.pi*520*t)
        out,_=raise_from_mix(f,reference,np.full(400,.3),waveforms=[true_low])
        np.testing.assert_array_equal(out,f)

    def test_waveform_refinement_preserves_existing_high_notes_and_rests(self):
        f=np.full(400,260.);f[180:200]=520;f[250:260]=0
        reference=f.copy();reference[:120]=520
        probability=np.full(400,.95);probability[:120]=.3
        t=np.arange(64000)/16000
        upper=np.sin(2*np.pi*520*t)+.05*np.sin(2*np.pi*260*t)
        out,report=raise_from_mix(f,reference,probability,waveforms=[upper])
        np.testing.assert_array_equal(out[f>0],520.)
        np.testing.assert_array_equal(out==0,f==0)
        self.assertEqual(report['lowered_frames'],0)

    def test_real_reported_7_to_11_and_20_to_22_seconds(self):
        a=np.loadtxt(Path(__file__).with_name('fixtures')/'maid-waveform.csv',delimiter=',')
        out,report=raise_from_mix(a[:,1],a[:,2],a[:,3],waveform_scores=[a[:,5:9],a[:,9:13]])
        self.assertTrue(np.all(out>=a[:,4]-.00001))
        np.testing.assert_array_equal(out==0,a[:,4]==0)
        already_high=a[:,4]>a[:,1]+.00001
        np.testing.assert_allclose(out[already_high],a[already_high,4],atol=.000002)
        for t in (7.,7.1,9.3,9.7,10.,20.2,20.6,20.9,21.1,21.8,21.9):
            self.assertGreater(out[round(t*100)],430,msg=f'Unrepaired at sample {t}s')
        self.assertLessEqual(pitch_jumps(out),pitch_jumps(a[:,4]))
        self.assertGreater(report['waveform_refinement']['raised_frames'],500)

    def test_real_upper_turns_are_not_cut_off_by_the_usual_register(self):
        with np.load(Path(__file__).with_name('fixtures')/'maid-register.npz') as fixture:
            m,w,previous=fixture['mixed'],fixture['waveform'],fixture['previous']
        out,report=raise_from_mix(m[:,1],m[:,2],m[:,3],waveform_scores=[w[:,5:9],w[:,9:13]])
        self.assertGreater(report['waveform_excursion_frames'],0)
        self.assertLess(report['waveform_register_hz'][1],740)
        for seconds in (28.94,28.99,29.05,29.10,45.36,45.40,45.45,45.48):
            self.assertGreater(out[round(seconds*100)],735,msg=f'Upper turn lost at {seconds}s')
        self.assertTrue(np.all(out>=previous-.00001))
        np.testing.assert_array_equal(out==0,previous==0)
        np.testing.assert_allclose(out[previous>m[:,1]+.00001],previous[previous>m[:,1]+.00001],atol=.000002,rtol=0)
        self.assertLess(pitch_jumps(out),pitch_jumps(previous))
        # The same excursion cannot be inferred from one contaminated source.
        single,report=raise_from_mix(m[:,1],m[:,2],m[:,3],waveform_scores=[w[:,5:9]])
        self.assertEqual(report['waveform_excursion_frames'],0)
        self.assertLess(single[4540],500)


if __name__=='__main__':
    unittest.main()
