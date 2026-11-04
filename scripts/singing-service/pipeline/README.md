# 气音和弱假声推理修复

这里保存 voice-lab 当前推理脚本的可审查源码；不修改训练脚本、权重或训练数据。

2026-11-03：默认分离前端改为 **Kimberley Jensen Mel-Band RoFormer**，B 和 index=0.6 保持。
`--separator demucs` 可回退；API `options.separator` 同名。`roformer_overlap` / `--roformer-overlap`
为 2–8 整数，默认 2。分轨保留双声道、44.1k 和原长度；伴奏按原混音减去人声得到，不独立归一化。
模型/配置、运行器和架构代码哈希参与分离缓存。旧 Demucs 缓存不会冒充 RoFormer 的结果。
`stems_from` / `repair_from` 仍复用旧分轨，显式传分离器参数会被拒绝；更换前端必须从原歌曲创建任务。
模型资源首次安装：`env/python.exe scripts/setup_roformer.py`，校验固定版本与 SHA256。
架构和依赖复用现有 `GPT-SoVITS/tools/uvr5/bs_roformer`、Torch、einops、rotary_embedding_torch。
原预训练模型由 [MSST 上游模型表](https://github.com/ZFTurbo/Music-Source-Separation-Training/blob/main/docs/pretrained_models.md)
列出；不把分轨可重构或自检通过当成分离听感已更好的证据。

2026-11-03：用户明确要求默认改用辅助唱法小批 **B**：`feiyu40k_aux70_ab_20261102_e10.pth`，
推理仍为目标音色 SID 0，沿用原 hi 的 SID 0 检索库。A 权重保留；需要单独回退时显式使用
`--model feiyu40k_hi_e150_s2333333.pth`。历史回归 fixture 中的 A 权重身份不改写成 B。

2026-11-03：**撤回长音 CREPE 上音区补偿实验。** 用户确认 Blue 短试听第 2–3 秒
（原曲约 169–170 秒）是肥鱼误升，原唱没有该上行。稳定高参考、少量上音区锚点及
输出估计器一致仍不足以证明应升八度；本次恢复该实验前的 `f0_path.py`、RVC `pipeline.py`
及对应测试，保留既有 breath / mix_reference 规则。新增长音规则不在线上运行。
`blue-sustains.npz` 仅为历史观测数据，其中手工候选不等于正确旋律标签。
home 尾音包络候选也已撤回；未更改 `rms_mix` 默认值、权重和训练脚本。

- 默认 `breath_mode=safe`：低能量且无输出音高才成为候选，目标 F0 有声、源轨 pYIN 有声及边界
  前后约 30 ms 都禁止原唱回填。没有目标 F0 文件时不回填。回填音量不超过输出局部 RMS 约
  +3 dB。`off` 完全禁止回填，`legacy` 仅供旧效果对照。
- 默认 `noise_reduce=0.5`：约 60–1100 Hz 稳态频谱底噪有界衰减，默认上限 3 dB，参数 1 上限
  为 6 dB；目标 F0 谐波附近减少处理。0 关闭。不能识别所有沙声或分离伪影。
- 默认 `presence_db` 从 8 降至 4；male-thin/low 预设分别降至 5/4，并减轻固定低切。
- **当前默认 `f0_mode=breath`：保留 ref，再增加保守的短换气半频修复。sequence 仍为实验选项。**
- breath 只上调满足双侧条件的短暂低八度：30–600 ms 的无声间隔前有稳定音区，重新起声后
  250 ms 内短暂落到半频，并在 600 ms 内稳定返回相近音区。只把对应有声帧翻倍，不填换气，
  不延长前一句音区到整个下一句；缺少恢复证据、持续低音或不同音符时不改。
- breath v2 额外支持换气后换音：复用已经提取的源 pYIN 曲线，在短暂停顿附近用该新音符
  的前后有声锚点和持续高八度参考佐证短半频段；不要求新音符等于换气前的旧音符。
  CIRCE 样例第 6–9 秒的真实曲线已保存为回归数据，只上调，不填无声，不向下改音区。
- safe 换气回填补充处理：源轨和目标曲线均无声时，持续至少 80 ms 的 <180 Hz 输出有声
  残留可用源高通气声替换。继续保留源/目标有声否决及约 30 ms 边界保护，不改已确认轻声。
- 实验 `f0_mode=sequence`：RMVPE 主曲线、CREPE 周期性与 pYIN 证据构成候选，在每个有声
  乐句内用 Viterbi 选择连续路径。保留候选原始细节，避免逐帧投票在阈值附近切换八度。
  对不超过 300 ms 的内部 F0 空洞，只补两种参考持续支持、且接近相邻有声段的部分；
  元音后的低周期性辅音、长换气和曲线边界仍保持无声。真实持续跳音由观测证据保留。
- `f0_mode=ref` 保留旧的 pYIN 八度复核及最长 60 ms 的可信短空洞修复，`off` 关闭纠错。
  手工目标 F0 CSV 始终优先，sequence 不重新改写人工曲线。

润色输出 `03_breath_mask.wav`（0–1 回填权重，非试听音轨）和 `03_processing.json`。
新参数、目标 F0 和 DSP 代码进入缓存指纹。局部修复没有完整 F0 时 safe 回填自动关闭；
无 F0 时降噪没有谐波保护，建议显式设 `noise_reduce=0`。

CLI：`--breath-mode safe|off|legacy --noise-reduce 0..1 --f0-mode breath|sequence|ref|off|acf`。
API `options`：`breath_mode` / `noise_reduce` / `f0_mode`，校验与 CLI 一致。
未显式提供 f0_mode 时，现有 `RVC_F0_OCTAVE_FIX` 环境变量仍可覆盖默认策略。
两个参考同时给出低八度，不等于这个低八度正确。突跳减少或对参与纠错的 pYIN 更一致，
都不能替代正确音区的人工核验。新版中段示例第 1–10 秒已加入高八度轻声的回归注记。

默认 `mix_reference=auto` 为 RMVPE/breath 增加对齐的原混音参考，复用当前 RMVPE 模型。
仅在相差一个八度（容差 1 半音）、单段至少 80 ms、源 pYIN 平均概率 <0.65，且局部六秒内
至少有 600 ms 持续分歧时上调。只乘二，不向下改、不填清音、不把整句锁在同一音区。
该规则减少分离后半频，不能从理论上排除伴奏/高八度乐器的误导；需继续用歌曲回归和试听验收。
第二版在证据附近最多 400 ms 用音高连续性选择上移候选，减少逐小段补丁造成的新跳变；
如果候选增加八度跳变数量则退回原曲线。检测到至少 600 ms 持续分歧后，普通 Demucs 输入
自动增加 HP5 主唱音高参考再推理，RVC 内容轨仍用原人声。无需按歌手动开启，但这类任务
会多花一次主唱参考提取和 RVC 推理的时间。已有独立主唱和人工 F0 不触发此自动回退。
第三版补充波形周期/奇偶谐波证据：仅在已由其他参考确认的上音区附近复核共同半频，
弱证据继续受源置信度限制，强波形证据可复核高置信度次谐波。不对已有上调帧重复升调。
最多连接 30 ms 的证据空洞；允许窗口距弱句尾不超过 150 ms 时，可延续到句尾。
原有清音保持，新增路径仍受八度跳变不增加的约束。输出 `02_f0.waveform.csv` 保存证据。
`--mix-reference off` 或 API `options.mix_reference=off` 关闭。人工 F0、非 RMVPE、非 breath
以及没有原混音的局部修复不启用。输出 `02_f0.mix.csv` 和 diagnostics 中 `mix_reference` 事件。
原混音身份进入推理缓存；复用已转换任务时继承其原混音路径。HP5 仍不全局启用。

整八度 `--pitch 12/-12/24` 默认保持伴奏原调；非整八度仍同步移调，显式 `--inst-transpose`
始终优先。男声音色优先的试听配方是 `--pitch 12 --inst-transpose 0`，提高检索率不等于音色改善。

CLI/API 的 f0_mode 也支持默认 breath；ref 可对照关闭新起声修复，breath_mode=off 可完全
关闭换气回填。breath 输出 `02_f0.breath.csv`（输入相对秒、ref 后原 F0、修复 F0、源参考音高及其置信指标）以及
diagnostics.json 内的 breath_restarts 事件。人工 F0 CSV 优先，不经过自动修复。
短促的真实低八度装饰音和半频误检可能有相同的曲线形状，尚需按正确旋律试听验收，不能
用此规则代替乐谱真值。

sequence 输出 `02_f0.evidence.csv` 与 `02_f0.diagnostics.json`：输入时间、候选 F0、各估计器
自己的置信指标、选择结果、修复区间、补帧及突跳计数。证据曲线为移调前源音高，
`02_f0.csv` 始终是移调后最终目标曲线；诊断的时间已去掉 RVC 的反射 padding。
置信指标不是统一校准过的概率；它们和自检都不能证明听感无误。

在 dsh-qqbot 根目录，用 voice-lab/env/python.exe 运行
`scripts/singing-service/install_pipeline.py --prepare`，再运行 `--install`。
安装校验目标文件原内容哈希，备份到 voice-lab/backups/breathy-pipeline-* 后替换推理文件。
常驻服务需空闲时重启，才能加载新参数和 RVC worker 代码。

验证：用 voice-lab/env/python.exe 执行 `-B -m unittest discover -s scripts/singing-service/pipeline -v`
和 `-B -m unittest discover -s scripts/singing-service -p test_sing_service.py -v`。
Windows 沙箱可能阻止 ffmpeg、HTTP 回环及进程锁测试，需在正常运行权限下执行。

实测素材：https://b23.tv/QhBsxpt （BV1aUaY6hE95），开头 0–40 秒，保持原调、同一分轨、同一
feiyu40k_hi 权重及 index；对照文件放在仓库忽略的 tmp/rvc-breathy/。
音高候选异常仅供定位，自检不代表试听音质通过。

## 自检的参照

完整流水线用最终 `02_f0.csv` 检查输出的逐帧绝对音高偏差，不减全曲中位误差，也不再次
扣除 `--pitch`。源轨音区差异只作诊断，不能据其接近零判正确或接近 +12 判错误。
标准干声 `03_vocal.wav` / `02_rvc_40k.wav` 自动发现同目录目标；其他文件可显式使用
`--check <干声> --check-f0 <最终02_f0.csv> --check-src <源人声>`。混音仅查基础项。
缺少目标或观测覆盖不足为 UNVERIFIED；目标跟随通过不证明目标旋律/音区正确。
`.issues.json` 分别保存 pitch_compliance、source_pitch_diagnostic、检查 scope 和
melody_correctness=not_verified。能量、断点、时长和对拍检查独立保留；结构化报告保存
全部异常候选，终端展示最严重的前五处。音高候选不会吞掉同窗口的能量塌陷。

## 固定中段回归

`fixtures/mid-song.json` 固定 00:40–01:30 解码、分轨、模型和 index 的 SHA256。
用 voice-lab/env/python.exe 执行 `benchmark_rvc.py run --case A|B|C|D`，可复现 RMVPE/ref、
CREPE/ref、CREPE/ref 无检索和 RMVPE/sequence；`summary` 校验输入指纹并输出对照。
A 的重新运行另存 mid-rmvpe-rerun，不覆盖最初基线；summary 继续使用最初基线。
音频保存在本地 tmp，不随源码分发。RVC 合成含随机采样，细小听感或响度差异不能直接归因于参数。

第二参考 CIRCE 原曲 00:30–01:00 保存为 `fixtures/circe-song.json`。
使用 `benchmark_rvc.py summary --fixture <该文件> --cases A` 校验当前基线，
或 `run --fixture <该文件> --case B` 复现指定对照。新建基准时用独立的 `--fixture`、
`--baseline` 和 `--source-url`，工具从原任务读取实际截取起点和时长，避免覆盖其他参考。
原曲正确音区未标注时不以估计器一致性代替验收。

CIRCE 第 14–17 秒在原混合人声上有多估计器共同低八度的问题。已有 `--lead-back hp5`
主唱分离可让目标及输出恢复高音区，验证配方保存于 `fixtures/circe-lead-song.json`。
该对照 `backing_gain=0`，只用于清楚比较主唱；不将 HP5 改为所有歌曲的全局默认。
