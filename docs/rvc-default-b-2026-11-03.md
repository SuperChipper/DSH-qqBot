# 默认模型切换为辅助唱法 B

2026-11-03，用户明确要求“用 b 替换”。已完成部署、服务重载和默认入口实际推理验证。
这次不训练，不修改 B 权重内容，不改音高/检索/后处理默认策略。

后续用户反馈 B 肥鱼音色较弱，选择继续保留 B，先做[0.6/0.8/0.9 检索强度短对照](rvc-b-index-comparison-2026-11-03.md)。
该试听尚未选定新默认；当前仍为 B + index 0.6。

- 当前默认：`feiyu40k_aux70_ab_20261102_e10.pth`，SID 0。
- B SHA256：`0177a751553282a8c0c8441f8c609a9fbe5ca5891e2a0876f6d25c6337da478c`，55,228,486 字节。
- 保留 A：`feiyu40k_hi_e150_s2333333.pth`，原文件与哈希未改变。
- 检索库：仍为 `feiyu40k_hi_IVF1480_Flat_nprobe_1_feiyu40k_hi.index`，仅原目标 SID 0 库，哈希未改变。
- 仓库与线上 `cover.py` 同步修改 `MODEL` 默认值，未将 B 覆盖到 A 的旧文件名下。
- 更新流水线文档和服务 agent-note，普通点歌省略 `options.model` 即使用 B。
  历史回归 fixture 仍保留其当时使用的 A 权重身份，未伪改为 B。

新点歌默认 B；已有音频不会自动重唱。显式选择模型的任务继续遵从显式选项，
旧任务局部 repair 默认沿用其历史 manifest；若需要 B 修旧任务，应显式提供 B 的 model 选项。
单次回退可用 `--model feiyu40k_hi_e150_s2333333.pth` 或 API `options.model` 指定 A。

## 验证

安装前核对 B、A、检索库哈希及线上 `cover.py` 旧哈希。安装 B 为独立文件，原源码有时间戳备份：
`voice-lab/backups/default-b-20261103-021859`。
确认无运行/排队任务后重启唱歌服务，未操作 QQ 插件、TTS、ASR 或训练进程。

提交了一条**不带 model 参数**的 8 秒 Blue 短验证任务，使用 202–210 秒原分轨与既有目标 F0：
`746a454afb5d4cdd9b58d81d6ec97dd2`。
任务完成为 `succeeded_with_warnings`；manifest 的实际模型为 B，服务健康状态显示 B 已加载、完成一次推理。
这验证默认选择和模型可用，不表示 Blue 的沙裂或旋律已经通过过耳验收。

唱歌服务 PID 4512，RVC worker PID 79616，检查时均健康空闲。
现有 `test_cover.py` 25 项测试通过。没有以更换权重为由重启或重建 QQ 插件。

完整记录：`tmp/rvc-default-b/installation.json`、`activation.json`、`smoke-job.json`、`tests.log`。
B 的训练素材来源和 A/B/C 实验边界仍见原报告；本次用户选择默认 B，不改写旧试听结果。
