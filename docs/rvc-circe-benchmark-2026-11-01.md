# CIRCE 第二回归基准

来源：https://www.bilibili.com/video/BV14Y496eEBx/
标题：[4K/RTX HDR]闪光的哈萨维2装修神曲-「CIRCE」SennaRin。
用户指定原曲 00:30–01:00，作为轻声、高音与八度保真的补充参考。

已下载音频并截取 30 秒，跑完当前 ref 管线。未改模型、训练数据、默认纠错策略或移调。
固定项：feiyu40k_hi_e150_s2333333.pth、对应 index、RMVPE/ref、index_rate .6、pitch 0、
protect .35、rms_mix .15、presence 4、breath_mode safe、noise_reduce .5。

解码、源人声、伴奏、权重及 index 的 SHA256 保存于
scripts/singing-service/pipeline/fixtures/circe-song.json；原先 mid-song.json 保持独立。
benchmark_rvc.py 现在可用 --fixture 选择参考，未完成其他组时可用 --cases A 查看当前基线。

```powershell
& ../voice-lab/env/python.exe -B scripts/singing-service/pipeline/benchmark_rvc.py summary --fixture scripts/singing-service/pipeline/fixtures/circe-song.json --cases A
& ../voice-lab/env/python.exe -B scripts/singing-service/pipeline/benchmark_rvc.py run --fixture scripts/singing-service/pipeline/fixtures/circe-song.json --case B
```

原始基线存于仓库忽略的 tmp/rvc-circe/circe-baseline/。各步骤音频、02_f0.csv、
02_f0.diagnostics.json、03_processing.json 和 manifest.json 保留。当前结果：

- 混音 30.000 秒，输出人声 29.980 秒；混音基础检查 PASS，人声检查 WARN。
- 目标曲线相邻有声帧 >8 半音跳变 52 次，仅为曲线统计，不能直接等同于 52 次错误。
- 输出/源 pYIN 重合有声帧 2012 个，偏差 >1 半音约 11.4%；不是独立音准真值。
- 定位器合并得到 9 个候选窗口，输出前 5 个，映射原曲时间为 00:37.5、00:48、00:49、
  00:52.5、00:56.5，供试听核对。尚未人工确认这些位置的正确音符和音区。

供试听的源/输出干声分别为 tmp/rvc-circe/circe-source-vocal.mp3 和 circe-rvc-vocal.mp3，
各自整段对齐至 -20 dBFS RMS，保留局部动态。circe-baseline.mp3 为当前管线的伴奏混音。
详细元数据和原曲时间定位在 reference-report.json。音频未加入版本控制。

两个估计器的一致性、较少突跳、对 pYIN 更一致，都不能单独证明正确八度；尤其不能再次
把正确的高八度轻声自动压低。CIRCE 尚未标注具体期望音符，只作为新增参考和当前输出基线。
