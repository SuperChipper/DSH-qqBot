import unittest
import numpy as np
from pathlib import Path
from breath_pitch import repair_breath_restarts


class BreathPitchTests(unittest.TestCase):
    def test_short_half_frequency_restart_is_raised_with_two_anchors(self):
        f = np.full(200, 480.)
        f[40:50] = 0
        f[50:70] = 240
        out, report = repair_breath_restarts(f)
        expected = f.copy()
        expected[50:70] = 480
        np.testing.assert_array_equal(out, expected)
        self.assertEqual(report['raised_frames'], 20)

    def test_keep_second_breath_inside_repaired_interval(self):
        f = np.full(200, 466.)
        f[40:45] = 0
        f[45:61] = 233
        f[61:71] = 0
        out, report = repair_breath_restarts(f)
        np.testing.assert_array_equal(out[45:61], 466)
        np.testing.assert_array_equal(out[61:71], 0)
        np.testing.assert_array_equal(out == 0, f == 0)

    def test_delayed_onset_drop_is_repaired_without_changing_correct_onset(self):
        f = np.full(200, 520.)
        f[40:50] = 0
        f[55:75] = 260
        out, report = repair_breath_restarts(f)
        np.testing.assert_array_equal(out[50:55], f[50:55])
        np.testing.assert_array_equal(out[55:75], 520)

    def test_sustained_real_lower_phrase_is_not_forced_up(self):
        f = np.full(240, 480.)
        f[40:50] = 0
        f[50:180] = 240
        out, report = repair_breath_restarts(f)
        np.testing.assert_array_equal(out, f)
        self.assertEqual(report['raised_frames'], 0)

    def test_no_return_anchor_means_abstain(self):
        f = np.full(200, 480.)
        f[40:50] = 0
        f[50:] = 240
        out, _ = repair_breath_restarts(f)
        np.testing.assert_array_equal(out, f)

    def test_no_gap_or_different_note_is_not_repaired(self):
        for gap in [False, True]:
            f = np.full(200, 480.)
            f[50:70] = 320 if gap else 240
            if gap:
                f[40:50] = 0
            out, _ = repair_breath_restarts(f)
            np.testing.assert_array_equal(out, f)

    def test_high_soft_voice_vibrato_and_unrelated_frames_unchanged(self):
        f = 600*2**(.2*np.sin(np.arange(200)/5)/12)
        f[40:50] = 0
        out, _ = repair_breath_restarts(f)
        np.testing.assert_array_equal(out, f)

    def test_long_pause_and_unstable_left_anchor_are_not_repaired(self):
        f = np.full(300, 480.)
        f[40:120] = 0
        f[120:140] = 240
        out, _ = repair_breath_restarts(f)
        np.testing.assert_array_equal(out, f)
        f = np.full(200, 480.)
        f[20:40:2] = 320
        f[40:50] = 0
        f[50:70] = 240
        out, _ = repair_breath_restarts(f)
        np.testing.assert_array_equal(out, f)

    def test_changed_note_after_breath_with_upper_source_reference(self):
        f = np.full(200,350.)
        f[40:50]=0
        f[50:70]=520
        f[70:90]=260
        f[90:]=480
        ref=f.copy()
        ref[70:90]=520
        pp=np.full(200,.4)
        out,report=repair_breath_restarts(f,reference=ref,probability=pp)
        np.testing.assert_array_equal(out[70:90],520)
        np.testing.assert_array_equal(out[:70],f[:70])

    def test_sustained_lower_note_is_not_overridden_by_reference(self):
        f=np.full(250,480.)
        f[40:50]=0
        f[50:170]=240
        ref=np.full(250,480.)
        out,_=repair_breath_restarts(f,reference=ref,probability=np.ones(250))
        np.testing.assert_array_equal(out,f)

    def test_wrong_low_reference_cannot_lower_resolved_soft_voice(self):
        f=np.full(200,600.)
        f[40:50]=0
        out,_=repair_breath_restarts(f,reference=np.full(200,300.),probability=np.ones(200))
        np.testing.assert_array_equal(out,f)

    def test_circe_user_reported_sample_6_to_9_seconds(self):
        fixture=np.loadtxt(Path(__file__).with_name('fixtures')/'circe-breath-6-9.csv',delimiter=',')
        times,f,ref,pp=fixture.T
        out,report=repair_breath_restarts(f,reference=ref,probability=pp)
        for t in [7.35,7.7,8.23]:
            i=int(np.argmin(abs(times-t)))
            self.assertGreater(out[i],430,msg=f'Unrepaired half-frequency at sample {t}s')
        self.assertEqual(np.sum(out<f),0)
        np.testing.assert_array_equal(out==0,f==0)


if __name__ == '__main__':
    unittest.main()
