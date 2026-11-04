"""Music delivery video: one AAC encode from a lossless master, with a fish sticker."""
from pathlib import Path
import argparse
import json
import subprocess
import uuid
from cover_support import identity,atomic_json,FileLock

DEFAULT_STICKERS=Path(__file__).resolve().parents[2]/'stickers'


def select_cover(root,emotion='',image=''):
    root=Path(root).resolve()
    entries=json.loads((root/'index.json').read_text('utf-8'))
    choices=[]
    for item in entries:
        name=item.get('file','')
        path=(root/name).resolve()
        if Path(name).name==name and name.startswith('fish_') and root in path.parents and path.is_file():
            choices.append((item,path))
    if image:
        wanted=Path(image).resolve()
        for item,path in choices:
            if path==wanted:return path,item.get('emotion','')
        raise ValueError('歌曲封面必须选自肥鱼表情库 index.json')
    wanted=emotion.strip() or '开心'
    for item,path in choices:
        if item.get('emotion')==wanted:return path,wanted
    raise ValueError(f'肥鱼表情库没有情绪 {wanted!r}；请先查看 index.json 选择对应 emotion')


def export_music(master,output,ffmpeg,*,sticker_root=None,emotion='',image=''):
    import numpy as np
    import soundfile as sf
    from PIL import Image,ImageOps
    master,output=Path(master).resolve(),Path(output).resolve()
    if master==output or master.suffix.lower() not in ('.wav','.flac') or output.suffix.lower()!='.mp4':
        raise ValueError('音乐视频必须从独立 WAV/FLAC 母带导出为 .mp4')
    cover,selected=select_cover(sticker_root or DEFAULT_STICKERS,emotion,image)
    settings={'version':1,'source':identity(master),'cover':identity(cover),'emotion':selected,
              'video':'h264','size':[1920,1080],'fps':12,'audio':'aac','bitrate':320000,
              'sample_rate':44100,'channels':2,'pcm_peak_ceiling':.84,'code':identity(__file__)}
    output.parent.mkdir(parents=True,exist_ok=True)
    metadata=output.with_suffix('.export.json')
    with FileLock(output.with_suffix('.export.lock'),timeout=30):
        if metadata.is_file() and output.is_file():
            old=json.loads(metadata.read_text('utf-8'))
            if old.get('settings')==settings and old.get('output')==identity(output):return old
        audio,sr=sf.read(master,dtype='float32',always_2d=True)
        if not len(audio) or audio.shape[1] not in (1,2) or not np.isfinite(audio).all():
            raise ValueError('无效的音乐母带')
        peak=float(np.max(abs(audio)))
        gain=min(1.,.84/max(peak,1e-12))
        duration=len(audio)/sr
        poster=output.with_suffix('.cover.png')
        with Image.open(cover) as source:
            source.seek(0)
            art=ImageOps.exif_transpose(source).convert('RGBA')
            art.thumbnail((1920,1080),Image.Resampling.LANCZOS)
            canvas=Image.new('RGB',(1920,1080),(19,27,43))
            canvas.paste(art,((1920-art.width)//2,(1080-art.height)//2),art)
            canvas.save(poster)
        temporary=output.with_name(output.stem+'.'+uuid.uuid4().hex+'.pending.mp4')
        try:
            subprocess.run([str(ffmpeg),'-hide_banner','-loglevel','error','-y',
                '-loop','1','-framerate','12','-i',str(poster),'-i',str(master),
                '-map','0:v:0','-map','1:a:0','-t',f'{duration:.6f}',
                '-c:v','libx264','-preset','medium','-tune','stillimage','-crf','18',
                '-pix_fmt','yuv420p','-c:a','aac','-b:a','320k','-ar','44100','-ac','2',
                '-af',f'volume={gain:.10f}','-movflags','+faststart',str(temporary)],check=True)
            temporary.replace(output)
        finally:
            temporary.unlink(missing_ok=True)
        report={'settings':settings,'duration':duration,'input_channels':audio.shape[1],
                'gain':gain,'output':identity(output)}
        atomic_json(metadata,report)
        return report


def main():
    import cover
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',required=True,help='现有 04_mix.wav，无需重唱')
    parser.add_argument('--out',required=True)
    parser.add_argument('--cover-emotion',default='')
    parser.add_argument('--cover-image',default='')
    parser.add_argument('--sticker-root',default=str(DEFAULT_STICKERS))
    args=parser.parse_args()
    result=export_music(args.input,args.out,cover.FFMPEG,sticker_root=args.sticker_root,
                        emotion=args.cover_emotion,image=args.cover_image)
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=='__main__':main()
