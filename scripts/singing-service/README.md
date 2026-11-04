# 异步唱歌服务

当前默认模型（2026-11-03）：用户已选择辅助唱法 B `feiyu40k_aux70_ab_20261102_e10.pth`。
目标音色 SID 0，沿用原 hi 检索库。普通任务不传 `options.model` 即可；
A `feiyu40k_hi_e150_s2333333.pth` 保留，可显式指定回退。

默认分离前端已改为 Kimberley Jensen Mel-Band RoFormer（2026-11-03），不传 separator 即生效。
`options.separator="demucs"` 可回退。`options.roformer_overlap` 范围 2–8，默认 2；旧分轨复用和局部
repair 不重新分离，显式传这些分离选项会被拒绝，改分离器应从原歌曲新建任务。

部署到 `voice-lab/scripts` 后，服务在 `127.0.0.1:8766` 接收任务，后台单 worker 执行整条翻唱管线。
私有 RVC 后端在 `127.0.0.1:8767`，由主服务启动和回收，模型、HuBERT、RMVPE 在任务间复用。
Demucs / HP5 仍按任务运行。现有 `cover.py` 的独立 CLI 保留，仍共享 GPU 锁。

气音推理修复的源码与部署方法见 [pipeline/README.md](pipeline/README.md)。
新增 options：`breath_mode`（safe/off/legacy，默认 safe）、`noise_reduce`（0–1，默认 0.5）。
`f0_mode` 支持 breath/sequence/ref/off/acf；默认 breath，在 ref 后修复有双侧音区证据的短换气半频。
sequence 保留为实验选项，已发现高八度轻声误降调，暂不默认启用。safe 换气回填也处理已确认无声区的持续低频有声残留。
默认亮化降到 4 dB；保留原调，当前权重采用上述 B，训练脚本不变。

## Agent 调用

在 `voice-lab` 目录执行（与 `dsh-qqbot` 同级）。输入与输出路径可以写相对路径，按**执行命令时的当前目录**解析：

```powershell
# 按需幂等启动，提交后立即返回任务 ID；不要把整首推理绑在一次工具等待里。
.\env\python.exe scripts\sing_client.py --ensure submit --song "..\tmp\song.wav" --options-json '{"lead_back":"hp5"}'
.\env\python.exe scripts\sing_client.py status <id>
.\env\python.exe scripts\sing_client.py logs <id>
.\env\python.exe scripts\sing_client.py cancel <id>
.\env\python.exe scripts\sing_client.py result <id> --out "..\tmp\song_feiyu.mp4"

# 可复用已有分离轨 / 局部修复，分别生成独立任务目录。
.\env\python.exe scripts\sing_client.py --ensure submit --stems-from "..\tmp\singing-service\jobs\<旧任务ID>\work" --options-json '{"lead_back":"hp5"}'
.\env\python.exe scripts\sing_client.py --ensure submit --repair-from "..\tmp\singing-service\jobs\<旧任务ID>\work" --options-json '{"repair_start":88,"repair_dur":12}'
```

`wait <id> --timeout 1800` 可用于终端。Agent 需要自动回传时，使用 pwsh 工具的
`run_in_background: true` 启动这条等待命令，拿到后台 job ID 后结束提交回合；收到完成通知后再取输出和成品。
不要在提交回合前台 `wait`，或用 `job_output(wait=true)` 重新等待后台任务，否则会占着同一聊天的消息队列。
客户端等待超时不会取消服务器任务。
状态中的 `work_dir` 可用于下一单的 `repair_from` / `stems_from`；成功时另返回可供本机文件工具读取的 `result_path`。
重试提交时可指定 `--idempotency-key <稳定键>`，同一请求返回同一任务，避免重复点歌。
`succeeded_with_warnings` 仍可取成品，但应查看自检日志，不能告诉用户“音质已经通过”。

## API

| 方法与路径 | 行为 |
|---|---|
| `GET /health` | 服务就绪、当前任务、模型加载次数和推理次数 |
| `POST /jobs` | 接受 JSON，返回 **202** 和 `id`，独立目录隔离 |
| `GET /jobs` | 最近100个任务 |
| `GET /jobs/{id}` | 状态、当前步骤、排队位置、结果链接 |
| `GET /jobs/{id}/log` | 最近32 KiB日志 |
| `POST /jobs/{id}/cancel` | 取消排队或运行中的任务 |
| `GET /jobs/{id}/result` | 新任务为 MP4，历史 MP3 保持可取；未完成返回409 |
| `POST /shutdown` | 清理执行中的进程树和 RVC worker，再退出 |

请求示例：

```json
{"song":"../tmp/song.wav","options":{"pitch":0,"lead_back":"hp5"},"idempotency_key":"chat-song-001"}
```

也可把 `song` 换成 `stems_from` 或 `repair_from`，三者只能给一个。可选项只接受白名单，不能传任意 CLI
参数、输出路径或工作目录。默认本地文件只允许位于 `Dsh-bot` / 服务数据目录内；URL 支持 HTTP/HTTPS。
直接打 HTTP 接口时路径必须写绝对路径（服务端按自己的 cwd 解析），走 `sing_client.py` 则可以用相对路径。

## 启停与生命周期

```powershell
pwsh -NoProfile -File scripts\start-singing.ps1
pwsh -NoProfile -File scripts\start-singing.ps1 -Status
pwsh -NoProfile -File scripts\start-singing.ps1 -Stop
```

启动器用 Windows 命名互斥量避免并发重复启动，通过健康检查识别服务，通过 WMI 隐藏窗口启动并脱离聊天
进程树。统一 `start-services.ps1` 会同时管理唱歌；`-SingOnly` 可以只管理唱歌，避免碰 TTS / ASR。
它不会自动注册开机启动。agent 的 `--ensure` 就是按需启动入口。

任务和日志在 `Dsh-bot/tmp/singing-service`，SQLite 保存排队、状态与错误。重启保留尚未执行的任务，
执行中的任务标记 `interrupted`，不擅自重跑。主服务对数据目录持单实例锁；多实例必须使用同一个 GPU
锁目录。每个任务的 Windows Job Object 负责清理完整子进程树，取消或超时还会回收 RVC worker，以便释放
显存；下一任务重新启动模型进程。因此“取消后的第一单”仍有冷启动成本。

默认等待队列32单、运行超时1800秒（含本单 worker 冷启动，不含排队），主服务可用 `--max-queue`、`--job-timeout` 调整。RVC worker 为懒启动，
`/health.ready` 表示可接单；`rvc.warmed` 才表示模型已加载。排队位置和步骤不是剩余时间预测。
接口只监听回环地址，拒绝浏览器 Origin。设置 `SING_SERVICE_TOKEN` 可要求主 API Bearer 鉴权，启动器和客户端
会读取同一环境变量；私有 RVC worker 始终使用随机内部令牌。外部 WebUI、旧脚本和 TTS/ASR 不自动加入这个
任务队列，显存仍需留余量。

## 安装与验证

源码保存在 `dsh-qqbot/scripts/singing-service`。`install_singing.py --prepare` 生成目标原文件哈希；
`install_singing.py --install` 检查并备份后安装，会给 `cover.py` 加可选 RPC 接入和进程启动门，不替换其他逻辑。
对现有统一启动器只插入唱歌管理分支，保留 TTS/ASR 行为。

测试：`python -B -m unittest discover -s scripts/singing-service -p test_sing_service.py -v`。
测试覆盖HTTP立即返回、队列串行、运行/排队取消、完整子进程清理、超时、警告成品、幂等提交、重启恢复和输入校验。

SVS（按歌词、乐谱生成歌声）是另一路后端，目前这个服务实现的是 RVC 翻唱，没有把原唱音频自动转成乐谱。

