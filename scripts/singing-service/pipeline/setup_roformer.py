"""Install the pinned Mel-Band RoFormer checkpoint without changing Python packages."""
from pathlib import Path
import argparse
import hashlib
import shutil
import requests
from cover_support import atomic_json

REVISION='ac9b0614ab3cd7f77219e18ba494dfd93956c348'
MODEL_SHA='87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e'
CONFIG_SHA='f63f38eb1e6e40a7db0dade714a5ae257555dd8748f4e774eae8679275a81926'
URL=f'https://huggingface.co/KimberleyJSN/melbandroformer/resolve/{REVISION}/MelBandRoformer.ckpt?download=true'


def sha(path):
    digest=hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda:source.read(1024*1024),b''):digest.update(chunk)
    return digest.hexdigest()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parent.parent)
    args=parser.parse_args();folder=args.root/'models/separation/roformer';folder.mkdir(parents=True,exist_ok=True)
    source_config=Path(__file__).with_name('roformer-kim.yaml')
    if sha(source_config)!=CONFIG_SHA:raise ValueError('Bundled RoFormer config integrity failure')
    checkpoint=folder/'MelBandRoformer.ckpt';config=folder/'MelBandRoformer.yaml'
    if checkpoint.exists():
        if sha(checkpoint)!=MODEL_SHA:raise ValueError('Existing RoFormer checkpoint differs; preserved without overwrite')
    else:
        temporary=folder/'MelBandRoformer.ckpt.download';digest=hashlib.sha256()
        with requests.get(URL,stream=True,timeout=(30,120)) as response:
            response.raise_for_status()
            with temporary.open('wb') as output:
                for chunk in response.iter_content(1024*1024):
                    if chunk:output.write(chunk);digest.update(chunk)
        if digest.hexdigest()!=MODEL_SHA:raise ValueError('Downloaded RoFormer checkpoint integrity failure')
        temporary.replace(checkpoint)
    if config.exists():
        if sha(config)!=CONFIG_SHA:raise ValueError('Existing RoFormer config differs; preserved without overwrite')
    else:shutil.copyfile(source_config,config)
    atomic_json(folder/'model.json',{'model':'KimberleyJensen Mel-Band RoFormer','model_revision':REVISION,
        'weight_url':URL,'weight_sha256':MODEL_SHA,'config_sha256':CONFIG_SHA,
        'config_source':'https://github.com/ZFTurbo/Music-Source-Separation-Training/blob/main/configs/KimberleyJensen/config_vocals_mel_band_roformer_kj.yaml',
        'source_code':'GPT-SoVITS/tools/uvr5/bs_roformer'})
    print('RoFormer checkpoint and config verified:',folder,flush=True)


if __name__=='__main__':main()
