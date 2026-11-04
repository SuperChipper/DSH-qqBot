# 异步唱歌服务（voice-lab，2026-10-31）

## 2026-11-03：默认分离器 RoFormer

普通点歌默认 Mel-Band RoFormer，模型 B、index 0.6 不变；可传 `options.separator="demucs"` 回退。
要尝试另一分离器必须从原歌曲新建任务，不能拿 `stems_from` 旧分轨再传 separator；该组合会报错。

## 2026-11-03：默认模型为辅助唱法 B

用户已要求将 B `feiyu40k_aux70_ab_20261102_e10.pth` 替换为默认，仍用目标音色 SID 0 和原 hi 检索库。
普通点歌省略 `options.model` 即可使用 B，不要从历史笔记显式带回 A 或更早模型。
需要用户指定回退时，可用 `options.model="feiyu40k_hi_e150_s2333333.pth"`；A 权重保留。

## 2026-11-02：歌曲发高清视频

用户偏好：歌曲通过 MP4 视频发送，保留立体声；普通说话/TTS 仍发语音。
不要把歌曲 MP3 发成 QQ 语音气泡。当前默认结果是 MP4，直接用 qqbot_send_file 发送返回的 .mp4 路径。
音轨从混音 WAV 直接编码为 AAC 320 kbps，视频为 1080p 静态封面，不从 MP3 再编码。

提交点歌前读取 `Dsh-bot/stickers/index.json`，结合歌曲情绪挑肥鱼 `fish_*` 表情里最接近的一张，
将条目的 emotion 放进 `options.cover_emotion`，或把其绝对路径放进 `options.cover_image`。
例如轻快的《魔法女仆》选 `开心`；其他歌曲按各自情绪选择，不统一使用同一张。
缺少情绪参数时脚本仅作开心封面兜底，不表示已分析歌曲情绪。

RVC 翻唱现在有异步服务，端口 `127.0.0.1:8766`。点歌优先使用此入口，旧笔记中的直接运行 cover.py 仍可用，
但不会复用服务里的常驻 RVC 模型。

从 `voice-lab` 目录执行（与 `dsh-qqbot` 同级）：

```powershell
.\env\python.exe scripts\sing_client.py --ensure submit --song "..\tmp\song.wav" --options-json '{"cover_emotion":"开心"}'
.\env\python.exe scripts\sing_client.py status <id>
.\env\python.exe scripts\sing_client.py logs <id>
.\env\python.exe scripts\sing_client.py cancel <id>
.\env\python.exe scripts\sing_client.py result <id> --out "..\tmp\song_feiyu.mp4"
```

`submit` 立即返回 ID；不要等待整首推理才确认收到点歌。`--ensure` 会在服务没起时调用启动器，重复调用不会再开一份。
选项用 `--options-json '{"lead_back":"hp5"}'`，也支持 `--stems-from <旧任务目录>` 和 `--repair-from <旧任务目录>`。
本地输入文件需位于 Dsh-bot 内；URL 可直接作为 song。相对路径按执行命令时的当前目录解析，服务自动为每单分配独立目录并排队。

要在唱完后自动发回：把 `sing_client.py wait <id> --timeout 1800` 放到 **pwsh 工具的
`run_in_background: true`** 调用中，拿到后台 job ID 后结束当前回合，继续接聊天。
完成通知到达后再 `job_output` 取状态、发成品。不要在前台等 `wait`，也不要在提交回合里
`job_output(wait=true)` 把这个后台任务重新等回来；排队不影响闲聊，没必要为等歌持续占着回合。

取成品前先看状态：`succeeded` / `succeeded_with_warnings` 可下载；后者仍有自检告警，不能报成“音质完全通过”。
`failed` / `timed_out` / `interrupted` 看日志，不循环重复提交；重试可给稳定 `--idempotency-key` 防止重复任务。
历史任务可能仍是 MP3：先看 status 的 result_format，勿只改扩展名。已有歌曲仅改格式或封面时，
使用 `scripts/music_export.py --input <work/04_mix.wav> --out <song.mp4> --cover-emotion <情绪>`，无需重唱。
取消运行任务会清理进程树并回收 RVC worker，下一单有冷启动。不要自行强杀 TTS、ASR 或其他 GPU 程序。

详细文档：`voice-lab\SINGING_SERVICE.md`。当前是 RVC 翻唱，不是按歌词＋音符直接合成的 SVS；
SVS 调研在 `dsh-qqbot\docs\svs-research-2026-10-31.md`，尚未安装 DiffSinger / ACE Studio / Synthesizer V。
