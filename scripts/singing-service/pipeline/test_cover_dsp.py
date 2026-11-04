import unittest
from pathlib import Path
import tempfile
import contextlib
import shutil
import uuid
import numpy as np
from cover_dsp import fill_pitch_gaps, safe_breath_mask, reduce_low_noise, target_pitch


@contextlib.contextmanager
def scratch():
    path = Path(__file__).parent / ('tmp' + uuid.uuid4().hex)
    path.mkdir()
    try:
        yield path
    finally:
        shutil.rmtree(path)


class DspTests(unittest.TestCase):
    def test_fill_only_short_trusted_internal_gaps(self):
        f0 = np.full(80, 440.)
        f0[:2] = 0
        f0[10:14] = 0
        f0[20:30] = 0
        f0[40:44] = 0
        f0[50:54] = 0
        ref, prob = np.full(80, 440.), np.ones(80)
        prob[40:44] = .3
        ref[50:54] = 220
        out, fixed = fill_pitch_gaps(f0, ref, prob)
        self.assertEqual(fixed, 4)
        np.testing.assert_array_equal(out[10:14], 440)
        for a, b in [(0, 2), (20, 30), (40, 44), (50, 54)]:
            np.testing.assert_array_equal(out[a:b], 0)

    def test_weak_falsetto_and_unknown_pitch_veto_replacement(self):
        pitch = np.zeros(1000)
        pitch[200:400] = 600
        pitch[800:] = np.nan
        source_voiced = np.zeros(1000, dtype=bool)
        source_voiced[500:600] = True
        mask = safe_breath_mask(np.ones(1000), pitch, source_voiced, 1000)
        np.testing.assert_array_equal(mask[200:400], 0)
        np.testing.assert_array_equal(mask[500:600], 0)
        np.testing.assert_array_equal(mask[800:], 0)
        self.assertGreater(mask[50:100].mean(), .9)

    def test_sustained_low_tone_in_confirmed_breath_is_replaced(self):
        pitch=np.zeros(1000)
        source=np.zeros(1000,dtype=bool)
        output=np.zeros(1000)
        output[300:550]=81
        mask=safe_breath_mask(np.zeros(1000),pitch,source,1000,output_pitch=output)
        self.assertGreater(mask[350:500].mean(),.99)
        self.assertEqual(mask[:250].sum(),0)

    def test_bass_replacement_cannot_touch_light_voice_or_real_low_note(self):
        output=np.full(1000,81.)
        for pitch in [np.full(1000,600.),np.full(1000,81.)]:
            mask=safe_breath_mask(np.zeros(1000),pitch,np.zeros(1000,dtype=bool),1000,output)
            self.assertEqual(mask.sum(),0)
        mask=safe_breath_mask(np.zeros(1000),np.zeros(1000),np.ones(1000,dtype=bool),1000,output)
        self.assertEqual(mask.sum(),0)

    def test_short_pitched_vowel_boundary_leak_is_not_replaced(self):
        output=np.zeros(1000)
        output[300:350]=81
        mask=safe_breath_mask(np.zeros(1000),np.zeros(1000),np.zeros(1000,dtype=bool),1000,output)
        self.assertEqual(mask.sum(),0)

    def test_nearest_pitch_and_missing_coverage(self):
        with scratch() as folder:
            path = Path(folder)/'pitch.csv'
            path.write_text('0,440\n0.01,0\n0.02,440\n')
            out = target_pitch(path, np.array([0, .01, .02, 1]))
            np.testing.assert_array_equal(out[:3], [440, 0, 440])
            self.assertTrue(np.isnan(out[-1]))

    def test_noise_reduction_protects_sung_fundamental(self):
        import librosa
        sr = 16000
        t = np.arange(sr*2)/sr
        rng = np.random.default_rng(7)
        wave = .1*np.sin(2*np.pi*250*t) + .02*rng.normal(size=len(t))
        with scratch() as folder:
            path = Path(folder)/'pitch.csv'
            path.write_text('0,250\n2,250\n')
            out, stats = reduce_low_noise(wave, sr, 1, path)
        self.assertEqual(out.shape, wave.shape)
        self.assertTrue(np.isfinite(out).all())
        gain = np.dot(out, np.sin(2*np.pi*250*t))/np.dot(wave, np.sin(2*np.pi*250*t))
        self.assertGreater(gain, .92)
        before = abs(librosa.stft(wave, n_fft=2048, hop_length=512))**2
        after = abs(librosa.stft(out, n_fft=2048, hop_length=512))**2
        freq = librosa.fft_frequencies(sr=sr, n_fft=2048)
        noise_band = (freq > 330) & (freq < 420)
        self.assertLess(after[noise_band].mean(), before[noise_band].mean())
        self.assertLessEqual(stats['max_reduction_db'], 6)
        bypass, _ = reduce_low_noise(wave, sr, 0)
        np.testing.assert_array_equal(bypass, wave)

    def test_breath_off_and_safe_without_evidence_are_exact_bypass(self):
        import cover
        wave = np.linspace(-.1, .1, 1000).astype('float32')
        for mode in ['off', 'safe']:
            out, mask = cover.breath_splice(wave, wave*2, mode=mode)
            np.testing.assert_array_equal(out, wave)
            self.assertEqual(mask.sum(), 0)


if __name__ == '__main__':
    unittest.main()
