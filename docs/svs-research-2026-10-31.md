# SVS 调研：给大肥鱼从乐谱生成歌声

调研日期：2026-10-31。依据项目源码、厂商说明和官方手册；以下三种 SVS 尚未在本机安装或试听，
音质和速度不作实测排名。已经落地的是 RVC 异步翻唱服务，不能把它说成已经支持乐谱输入。

**建议把 OpenVPI DiffSinger 作为本地 agent 自动化的首个 SVS 候选；ACE Studio、Synthesizer V
适合作为编辑制作与听感对照。** 三者都能围绕歌词、音符、音高工作，自动化入口和自定义音色路线差异很大。

| 方案 | 歌词与音符 | 自定义音高曲线 | 自动化与部署 | 专属声线 |
|---|---|---|---|---|
| OpenVPI DiffSinger | 前端将歌词转音素，处理音素/音符时值及映射 | 声学推理明确读取 `f0_seq`、`f0_timestep` | Python CLI、DS 文件、ONNX 导出，适合本地 worker | 可自训，但要准备匹配的歌唱数据及标注 |
| ACE Studio | 编辑器使用 MIDI 和歌词 | User Pitch 覆盖 AI Pitch | 有本地 Turbo 加速；官网 FAQ 当前仍称未公开 API，不能直接按公共 HTTP 后端设计 | 支持上传歌唱样本定制 |
| Synthesizer V Studio 2 Pro | 乐谱/歌词驱动，带 AI 表现控制 | Smart Pitch Controls、Pitch Deviation；脚本可操纵曲线 | 官方支持编辑器内 JS/Lua 脚本；本次未确认官方无界面批量渲染 API | 主要使用授权声库；未确认面向普通用户的自助训练入口 |

DiffSinger 的 CLI 和 DS 输入由[官方入门文档](https://github.com/openvpi/DiffSinger/blob/main/docs/GettingStarted.md)
及[推理脚本](https://github.com/openvpi/DiffSinger/blob/main/scripts/infer.py)确认；ACE 输入能力见
[产品文档](https://docs.acestudio.ai/)、[音高编辑](https://docs.acestudio.ai/ai-vocal-synth/creating-ai-vocals/editing-pitch)，
API 状态见[厂商 FAQ](https://acestudio.ai/custom-voice/)；Synthesizer V 的控制能力见
[音高手册](https://sv2.docs.dreamtonics.com/en/pitch)和[脚本手册](https://resource.dreamtonics.com/scripting/)。

## 这条路线能解决哪些现有问题

RVC 从源人声抽内容和音高再换嗓。SVS 从乐谱、发音和时值生成干声，因此拿到正确的乐谱后，
可以避开源音频的主唱/和声串扰、分离损伤，以及源 f0 估计掉八度的那条依赖。
这是对两类输入机制的推论，不是“SVS 从此不会破音”的承诺：高音外推、音素覆盖、唱法与训练质量仍会影响结果。

多声部应按声部分轨生成，再混音；并不是给一个单声部模型塞多个同时发音的音符就会自动组成五人团。
ACE 的 FAQ 也明确区分“提供各声部 MIDI 后演唱”和“自动生成和声”。
[来源](https://acestudio.ai/custom-voice/)

关键前提是**有准确旋律与歌词对齐**。只有歌曲名、歌词和混音，并不能省去扒谱、区分和声、修正漏字与连音。
ACE 的 Vocal-to-MIDI 能转换现有演唱，但这仍属于转录，需要检查结果；其文档还提醒改歌词后旧音高曲线可能
与新发音不匹配。[来源](https://docs.acestudio.ai/ai-tools/vocal-to-midi)

## DiffSinger：最适合先接 agent 的候选

这里建议看 [OpenVPI 维护版](https://github.com/openvpi/DiffSinger)，而不是只照抄早期论文仓库环境。
仓库提供训练、推理与部署路径，代码为 Apache-2.0；使用哪个音源/检查点仍需看该音源自己的说明。

它的声学模型并非直接接收任意汉字文本：基础输入为音素序列、音素时长与 F0。
DS 是 JSON 容器。音符参与时值/音高预测等前端步骤；源码中的 variance 推理读取 `ph_seq`、`ph_num`、
`note_seq`、`note_dur` 等，声学推理读取 `ph_dur` 与以 Hz 为单位的 `f0_seq`，按 `f0_timestep` 重采样。
[基础概念](https://github.com/openvpi/DiffSinger/blob/main/docs/BestPractices.md)、
[variance 源码](https://github.com/openvpi/DiffSinger/blob/main/inference/ds_variance.py)、
[acoustic 源码](https://github.com/openvpi/DiffSinger/blob/main/inference/ds_acoustic.py)

因此接入层至少要处理：歌词发音与多音字、音符/歌词/音素对应、休止与连音、时长总和、曲线时间轴。
现有 RVC 的 `02_f0.csv` 可以作为转换素材，不能原样冒充完整 DS 输入。

官方 CLI 示例：

```text
python scripts/infer.py variance my_song.ds --exp <variance模型>
python scripts/infer.py acoustic my_song.ds --exp <acoustic模型>
```

有完整音素时值与目标 F0 时，声学步骤可直接使用这些输入；缺失的部分要由适配前端或相应模型补齐。
GUI 制作方面，项目推荐 OpenUTAU，并支持导出 DS；部署方面提供 ONNX 导出。
[官方入门](https://github.com/openvpi/DiffSinger/blob/main/docs/GettingStarted.md)

对“大肥鱼自己的嗓子”，现有 `feiyu40k*.pth` 是 RVC 权重，不能直接加载成 DiffSinger 声学模型。
从现有 TTS 语料转向 SVS，需要重做适合歌唱的音域、音素、时值及唱法覆盖；本次没有实测能否仅靠当前语料达到目标。
先用一个可用音源跑通 15–30 秒固定乐谱，比立刻启动整套自训更能区分“接口没通”与“音色没训好”。

## ACE Studio：音色定制入口明确，公共服务接口尚需确认

官方文档确认可用 MIDI＋歌词生成歌声，User Pitch 覆盖 AI Pitch。定制音色文档建议提供 **30–100 分钟**
干净歌唱样本，避免混响、伴奏、和声和叠唱；这个建议属于 ACE，不能套成所有 SVS 的统一最低门槛。
定制后可像内置音色一样使用 MIDI＋歌词。[定制音色说明](https://docs.acestudio.ai/voice-cloning/cloning-a-voice-for-vocal-synth)

它并非简单的“全云端”产品：官方说明 Turbo Mode 把 Verse25 的重合成步骤卸载到本机 CPU/GPU，降低云延迟。
但“有本地加速”不能推导为完全离线、无账号、无界面可自托管。
[本地渲染说明](https://docs.acestudio.ai/ai-rendering/local-rendering)

截至本次核对，厂商 FAQ 仍写公共 API 未发布，可就集成逐案沟通。不能先把购买软件等同于获得可调用的服务端 SDK。
因此它适合先做人工编辑的对照样本；若要无人值守接 agent，应先确认厂商提供的集成方式。
[API FAQ](https://acestudio.ai/custom-voice/)

## Synthesizer V：曲线和编辑器脚本强，不能混淆“脚本异步”与“服务 API”

Studio 2 Pro 的音高由 AI 生成，Smart Pitch Controls 和 Pitch Deviation 可调整；要固定已有曲线，可以将其
追踪为控制点。官方也说明可用 Rigid 表现设置形成更平直的曲线，再添加控制点。
[音高手册](https://sv2.docs.dreamtonics.com/en/pitch)

编辑器支持 JavaScript / Lua；2.1.1 的官方更新扩展了音高控制点/曲线和辅音时值等脚本能力。
`PitchControlCurve` 类提供 `setPoints` 等方法。脚本能在编辑器里异步回调，并不意味着它本身是一个
可部署的 HTTP 推理服务。本次未找到足够官方依据承诺“生成工程后可无界面自动渲染 WAV”；应做编辑器插件/
工程导入与导出流程的单独验证。[脚本手册](https://resource.dreamtonics.com/scripting/)、
[2.1.1 更新](https://dreamtonics.com/synthesizer-v-studio-2-1-1-final-update/)、
[曲线 API](https://resource.dreamtonics.com/scripting/PitchControlCurve.html)

也不要默认可用商品音源生成自己的训练集：Dreamtonics 的音源使用摘要明确限制用生成音频训练机器学习系统；
合作方音源又可能有不同条款。这里不据此推断全部换声用法，而是要求选定音源后再确认具体路线。
[厂商音源条款摘要](https://dreamtonics.com/terms/)

## 建议的下一次实验

1. 固定一段 15–30 秒单声部旋律，准备人工确认的 MIDI / 音符、歌词及目标 F0。先不从复杂合唱自动扒谱。
2. 建一个独立 DiffSinger 环境，选可用且适配目标语言的音源，跑通 DS→干声；不更改现有 RVC/GPT-SoVITS 依赖。
3. 用同一段乐谱检查辅音清晰度、音符起止、滑音、长音、高音音色，再决定是否自训“大肥鱼”的 SVS 音色。
4. 确认声学与乐谱输入稳定后，再给现有异步队列增加 `engine=diffsinger` 分支。保留同样的任务 ID、状态、取消、
   GPU 锁和结果下载机制；**当前 `/jobs` 不接受这些 SVS 字段**。

未来内部乐谱协议可统一为每个声部的 `notes[{onset_sec,duration_sec,midi,lyric}]`、语言、音色 ID、
可选音素/音素时长和带明确采样间隔的 F0（Hz）曲线。秒、MIDI 半音、Hz 不混用；各声部分别渲染后混音。
这是后续接口设计建议，不是本次已经上线的功能。
