import unittest
import numpy as np
from f0_path import select_pitch_path, pitch_jumps


class PathTests(unittest.TestCase):
    def run_path(self, r, c, p=None, cp=None, pp=None):
        r, c = np.asarray(r, dtype=float), np.asarray(c, dtype=float)
        n = len(r)
        return select_pitch_path(r, c, np.full(n, .9) if cp is None else cp,
                                 c if p is None else p, np.full(n, .6) if pp is None else pp)

    def test_repair_octave_island_without_confidence_threshold_toggling(self):
        t = np.arange(200)
        voice = 220*2**(.15*np.sin(t/8)/12)
        r = voice.copy()
        r[65:120] *= 2
        pp = np.full(200, .4)
        pp[70:120:3] = .01
        out, report, _ = self.run_path(r, voice, pp=pp)
        np.testing.assert_allclose(out, voice, rtol=.001)
        self.assertEqual(report['jumps_before'], 2)
        self.assertEqual(report['jumps_after'], 0)

    def test_preserve_supported_real_octave_and_vibrato(self):
        f = np.full(200, 220.)
        f[80:140] = 440
        f *= 2**(.2*np.sin(np.arange(200)/5)/12)
        out, report, _ = self.run_path(f, f)
        np.testing.assert_allclose(out, f)
        self.assertEqual(report['jumps_after'], 2)

    def test_weak_conflicting_estimator_cannot_flatten_a_note(self):
        f = np.full(200, 220.)
        f[80:140] = 440
        c = np.full(200, 220.)
        out, _, _ = self.run_path(f, c, p=f, cp=np.full(200, .1), pp=np.full(200, .9))
        np.testing.assert_allclose(out, f)

    def test_bridge_only_short_internal_jointly_supported_dropout(self):
        r = np.full(240, 600.)
        r[:10] = 0
        r[40:60] = 0
        r[100:140] = 0
        r[180:190] = 0
        cp = np.full(240, .9)
        cp[180:190] = .1
        out, report, _ = self.run_path(r, np.full(240, 600.), cp=cp)
        np.testing.assert_allclose(out[40:60], 600)
        for a, b in [(0, 10), (100, 140), (180, 190)]:
            np.testing.assert_array_equal(out[a:b], 0)
        self.assertEqual(report['filled_frames'], 20)

    def test_one_reference_cannot_fill_a_breath(self):
        r = np.full(100, 440.)
        r[40:55] = 0
        p = np.full(100, np.nan)
        out, _, _ = self.run_path(r, np.full(100, 440.), p=p)
        np.testing.assert_array_equal(out[40:55], 0)

    def test_fill_supported_vowel_but_keep_trailing_consonant_unvoiced(self):
        r = np.full(100, 580.)
        r[40:53] = 0
        c = np.full(100, 580.)
        cp = np.full(100, .9)
        cp[50:53] = .01
        pp = np.full(100, .4)
        pp[40:43] = .02
        out, report, _ = self.run_path(r, c, cp=cp, pp=pp)
        np.testing.assert_allclose(out[40:50], 580)
        np.testing.assert_array_equal(out[50:53], 0)
        self.assertEqual(report['filled_frames'], 10)

    def test_short_estimator_glitch_does_not_create_a_register_flip(self):
        r = np.full(200, 440.)
        c = r.copy()
        c[80:82] = 220
        out, _, _ = self.run_path(r, c)
        self.assertEqual(pitch_jumps(out), 0)

    def test_reject_misaligned_arrays(self):
        with self.assertRaises(ValueError):
            select_pitch_path(np.ones(5), np.ones(4), np.ones(5), np.ones(5), np.ones(5))


if __name__ == '__main__':
    unittest.main()
