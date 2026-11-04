# 歌曲改为视频交付

用户反馈失真出现在 QQ 语音播放，并明确选择歌曲发视频、保留立体声；封面从肥鱼表情库按
歌曲情绪挑选。普通 TTS/说话仍走原语音消息。

检查本机 qqbot-nodejs 1.0.5：当前 sendVoice→sendMedia→上传分支直接读取 MP3 字节，
没有在插件侧再次编码 SILK。QQ 客户端/平台实际接收的语音编码未抓取，不能据此量化平台
损失。视频发送走已有 .mp4→sendVideo→file_type=2 分支，避开语音消息通道。
SDK 的媒体接口见[官方使用说明](https://github.com/tencent-connect/qqbot-nodejs/blob/main/USAGE.md)。

## 新默认

- cover.py 默认输出 MP4；显式 --out *.mp3 或 output_format=mp3 保留旧导出。
- 04_mix.wav 新任务保存 24-bit PCM，直接编码 AAC 320 kbps / 44.1 kHz / 双声道，不经过 MP3。
- H.264 / yuv420p、1920×1080、12 fps 静态表情封面、faststart。
- 按原始峰值施加必要的恒定衰减，峰值上限 .84，给有损编码留余量，不做动态压缩或自动增益。
- 服务新结果是 result.mp4，HTTP Content-Type=video/mp4，status.result_format=mp4。
  旧 MP3 任务仍可下载。客户端拒绝把视频下载成 .mp3，也不会覆盖已有同名旧文件。

点歌机器人在提交前读取 Dsh-bot/stickers/index.json，结合歌曲情绪选最接近的 fish_*，
传 options.cover_emotion 或已注册表情的绝对路径 options.cover_image。没有参数时开心只是
兜底，不声称已完成情绪分析。未知情绪或库外图片报错，避免选到其他私人图片。
本次《魔法女仆》选 fish_开心.jpg，已目视核对原图。

已有成品只改交付格式：

```powershell
env/python.exe scripts/music_export.py --input <work/04_mix.wav> --out <song.mp4> --cover-emotion 开心
```

封面、母带和导出代码身份参与导出缓存；使用临时文件完成后替换，避免下载半个视频。
操作说明、异步服务笔记和 RVC 共享笔记均已备份更新；QQ 插件本身不需要新构建或重载。

## 验证

同一 22 秒混音母带导出 tmp/rvc-maid/maid-hq-video.mp4，约 1.63 MB：H.264 1080p，AAC
平均约 328.5 kbps、44.1 kHz、2 声道；解码峰值约 .842，无削波。相对母带补偿恒定增益后，
本地样本 SNR：原 MP3 约 27.5 dB、新 AAC 约 38.2 dB。SNR 不等于听感，也不是 QQ 端测量。
数据在 tmp/rvc-maid/delivery-quality.json。

真实导出测试用左右声道不同频率的母带验证声道未合并，并验证封面选择、缓存、时长和峰值。
服务测试覆盖默认 MP4 MIME、旧 MP3 兼容及扩展名错误时不覆盖旧文件。
