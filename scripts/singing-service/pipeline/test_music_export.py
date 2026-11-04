from pathlib import Path
import json
import shutil
import subprocess
import unittest
import uuid
from unittest.mock import patch
import numpy as np
import soundfile as sf
from PIL import Image
import cover
from music_export import export_music,select_cover


class MusicExportTests(unittest.TestCase):
    def setUp(self):
        self.root=Path(__file__).parent/('tmp'+uuid.uuid4().hex)
        self.root.mkdir()
        self.addCleanup(shutil.rmtree,self.root,True)
        self.stickers=self.root/'stickers';self.stickers.mkdir()
        Image.new('RGB',(12,16),'white').save(self.stickers/'fish_happy.png')
        Image.new('RGB',(16,12),'blue').save(self.stickers/'fish_sad.png')
        (self.stickers/'index.json').write_text(json.dumps([
            {'emotion':'开心','file':'fish_happy.png'},
            {'emotion':'委屈','file':'fish_sad.png'}]),encoding='utf-8')

    def test_cover_comes_from_curated_fish_library_and_respects_emotion(self):
        path,mood=select_cover(self.stickers,'委屈')
        self.assertEqual(path.name,'fish_sad.png');self.assertEqual(mood,'委屈')
        with self.assertRaises(ValueError):select_cover(self.stickers,'不存在')
        outside=self.root/'private.png';Image.new('RGB',(4,4)).save(outside)
        with self.assertRaises(ValueError):select_cover(self.stickers,image=outside)

    def test_real_video_keeps_stereo_and_uses_lossless_master(self):
        sr=44100;t=np.arange(round(1.2*sr))/sr
        audio=np.column_stack((np.sin(2*np.pi*440*t)*.3,np.sin(2*np.pi*880*t)*.2))
        master=self.root/'04_mix.wav';sf.write(master,audio,sr,subtype='PCM_24')
        output=self.root/'song.mp4'
        report=export_music(master,output,cover.FFMPEG,sticker_root=self.stickers,emotion='开心')
        ffprobe=cover.FFMPEG.with_name('ffprobe.exe')
        data=json.loads(subprocess.check_output([str(ffprobe),'-v','error','-show_streams','-show_format','-of','json',str(output)]))
        v=next(x for x in data['streams'] if x['codec_type']=='video')
        a=next(x for x in data['streams'] if x['codec_type']=='audio')
        self.assertEqual((v['codec_name'],v['width'],v['height']),('h264',1920,1080))
        self.assertEqual((a['codec_name'],int(a['sample_rate']),a['channels']),('aac',44100,2))
        self.assertLess(abs(float(data['format']['duration'])-1.2),.1)
        raw=subprocess.check_output([str(cover.FFMPEG),'-v','error','-i',str(output),'-vn','-f','f32le','-ac','2','-ar','44100','pipe:1'])
        decoded=np.frombuffer(raw,dtype='<f4').reshape(-1,2)[:len(audio)]
        self.assertGreater(np.corrcoef(decoded[:,0],audio[:,0])[0,1],.98)
        self.assertGreater(np.corrcoef(decoded[:,1],audio[:,1])[0,1],.98)
        self.assertLess(abs(np.corrcoef(decoded[:,0],decoded[:,1])[0,1]),.1)
        self.assertLess(abs(decoded).max(),.995)
        with patch('music_export.subprocess.run',side_effect=AssertionError('must use cached export')):
            self.assertEqual(export_music(master,output,cover.FFMPEG,sticker_root=self.stickers,emotion='开心'),report)
        with self.assertRaises(ValueError):export_music(output,output,cover.FFMPEG,sticker_root=self.stickers)
