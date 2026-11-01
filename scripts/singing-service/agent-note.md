# 异步唱歌服务（voice-lab，2026-10-31）

RVC 翻唱现在有异步服务，端口 `127.0.0.1:8766`。点歌优先使用此入口，旧笔记中的直接运行 cover.py 仍可用，
但不会复用服务里的常驻 RVC 模型。

从 `voice-lab` 目录执行（与 `dsh-qqbot` 同级）：

```powershell
.\env\python.exe scripts\sing_client.py --ensure submit --song "..\tmp\song.wav"
.\env\python.exe scripts\sing_client.py status <id>
.\env\python.exe scripts\sing_client.py logs <id>
.\env\python.exe scripts\sing_client.py cancel <id>
.\env\python.exe scripts\sing_client.py result <id> --out "..\tmp\song_feiyu.mp3"
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
取消运行任务会清理进程树并回收 RVC worker，下一单有冷启动。不要自行强杀 TTS、ASR 或其他 GPU 程序。

详细文档：`voice-lab\SINGING_SERVICE.md`。当前是 RVC 翻唱，不是按歌词＋音符直接合成的 SVS；
SVS 调研在 `dsh-qqbot\docs\svs-research-2026-10-31.md`，尚未安装 DiffSinger / ACE Studio / Synthesizer V。
