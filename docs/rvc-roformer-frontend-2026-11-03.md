# RoFormer 分离前端替换与 Blue 对照

**最新试听结论：用户反馈“没啥区别”。** 本次 Blue 200–220 秒对照未获得明确可闻改善，
不能记为沙裂/发抖/电音感修复成功。该反馈只针对当前片段与条件，不证明所有歌曲上两种分离器等效，
也不足以单独认定分离器不是成因或整个 RVC 架构已到极限。
未因此自动回退、继续改参数或训练；默认 B + RoFormer + index 0.6 保持。

用户要求“尝试把 Demucs 换成 RoFormer”。已接入并部署默认 **Kimberley Jensen Mel-Band RoFormer**，
保留 `--separator demucs` / API `options.separator="demucs"` 回退。
模型 B、SID 0、index 0.6、音高修复及润色默认值均未随本轮调整；没有训练。

## 模型与实现

复用本机 `voice-lab/GPT-SoVITS/tools/uvr5/bs_roformer` 中的模型架构和现有 Torch、einops、rotary_embedding_torch，
没有重装或升级 Python 包。新运行器 `cover_roformer.py` 使用严格权重加载、CUDA autocast、batch 1、
8 秒窗口和默认 overlap 2，反射上下文与加权重叠合成保持原长度。
输出是 44.1 kHz 浮点双声道 WAV。人声不独立归一化；伴奏为解码原混音减去分离人声，避免独立缩放破坏平衡。

模型来自 [MSST 上游预训练表](https://github.com/ZFTurbo/Music-Source-Separation-Training/blob/main/docs/pretrained_models.md)
列出的 [KimberleyJSN/melbandroformer](https://huggingface.co/KimberleyJSN/melbandroformer)。
具体下载固定 revision `ac9b0614ab3cd7f77219e18ba494dfd93956c348`：

- 权重 `MelBandRoformer.ckpt`：913,106,900 字节，SHA256 `87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e`。
- 配置来自上游 `configs/KimberleyJensen/config_vocals_mel_band_roformer_kj.yaml`，
  SHA256 `f63f38eb1e6e40a7db0dade714a5ae257555dd8748f4e774eae8679275a81926`。
- GitHub commit 查询因 API 限额失败，配置按下载内容 SHA256 固定，并随源码保存为 `roformer-kim.yaml`，
  不将 `main` 伪称为固定 commit。
- `setup_roformer.py` 可复现安装或校验现有资源，遇到已有文件哈希不匹配会保留并报错。

这只说明所选实现和权重身份，不说明它在所有歌曲上一定优于 Demucs。

## 接口、缓存与兼容

- 新任务默认 `--separator roformer`；`--roformer-overlap 2..8`，默认 2。
- API `options.separator` 为 `demucs` / `roformer`，`roformer_overlap` 为 2–8 整数。
- CLI 旧命令若显式给 `--demucs-model` 且未给 separator，继续使用 Demucs。
- `stems_from`、`repair_from` 复用历史分轨，不会偷偷重新分离；显式传 separator/overlap 会拒绝，
  要改变前端需从原歌曲新建任务。
- 分离缓存包含 backend、对应参数、权重/配置、运行器和架构代码的身份。
  RoFormer 不使用旧 Demucs 路径的分轨；改变 checkpoint 内容，即使 mtime 和大小相同也使缓存失效。
- RoFormer 子进程沿用共享 GPU 锁，不清理其它显卡应用，异常不会静默退回另一分离器。

只修改 Python 流水线及本地服务契约，没有新增 QQ 插件 ConfigSchema 字段或修改设置页。

## Blue 对照

从同一原混音裁 198–222 秒，重新分别运行 Demucs `htdemucs_ft` / shifts 1 与 RoFormer，
没有拿整曲 Demucs 输出对比短片 RoFormer 来混淆上下文。

两路都用 B、原 hi 检索库、index 0.6、相同 SID 0、相同目标 F0 和随机种子 20261103。
实际 F0 dump 哈希一致，后处理设置一致。每路整段人声 RMS 匹配，共用峰值增益，
从无损 WAV 单次编码为 1080p、立体声 AAC 视频。

主试听为原曲 200–220 秒：

- `tmp/rvc-roformer/blue-demucs-B.mp4`
- `tmp/rvc-roformer/blue-roformer-B.mp4`

用户此前的问题仍在试听第 3–5、7–9 秒。
主对照使用各自分出的伴奏，因此反映整个前端替换的效果，不能把所有听感差异都归于转换人声。
另有 `blue-roformer-common-backing-B.mp4` 与 Demucs 版共用 Demucs 伴奏，用于隔离换声声源差异。
两份 `blue-*-B-dry.wav` 保留独立人声。

24 秒 RoFormer 推理用时约 10.31 秒（不含模型初始化/文件加载），输出 1,058,400 个双声道样本，
相加重构最大误差约 5.96e-8。Demucs 控制的相加误差约 0.359。
**RoFormer 的重构近零是其残差伴奏构造方式的结果，不是分离质量或 SDR 的证明；
也不能凭 Demucs 的重构差直接认定它是用户沙裂的原因。**
没有孤立原唱真值，未编造 SDR 或客观“更像肥鱼”的分数，试听尚未验收。

## 验证与部署

- 82 项管线测试通过：新增任意长度/短音频/双声道重叠合成、异常模型输出、
  权重内容与配置/overlap/backend 缓存失效、原混音路由及两条分轨记录。
- 13 项服务测试通过：包括 separator/overlap 合法值、类型与边界拒绝、复用旧分轨时不能假切换。
- 实际 24 秒分离和固定 F0 的两路 B 转换均完成。
- 只备份、部署所改脚本及新运行器/配置，旧 live 哈希经核对；备份：
  `voice-lab/backups/roformer-20261103-042957`。
- 空闲时重载唱歌服务，未重载 QQ 插件或操作训练进程。
- 默认入口新任务 `b8fa573d700741209ee22f6b2143f599` **不带 separator、model、f0_file**，
  从原混音 202–210 秒运行全流程，完成为 `succeeded`。
  manifest 证实默认 RoFormer、B、index 0.6，双声道等长；服务健康检查正常。
  自检范围为音频基础项和目标跟随，不能据 `succeeded` 断言旋律/破音已经过耳通过。

关键记录：`tmp/rvc-roformer/model.json`、`deployment.json`、`activation.json`、
`comparison-result.json`、`comparison-inferences.json`、`pipeline-tests.log`、`service-tests.log`。
默认入口的真实自动 F0 与固定 F0 的对照区分保存，未混为同一实验。
