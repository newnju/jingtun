# FFmpeg 测试素材

这些文件是为了验证 FFmpeg WebAssembly 核心而生成的人工素材，不包含
第三方视频、音乐或受版权保护的内容。

| 文件 | 内容 |
|---|---|
| `test.ts` | 2 秒 H.264 + AAC 的 MPEG-TS |
| `v.mp4` | 从 `test.ts` 复制的视频轨 |
| `a.mp4` | 从 `test.ts` 复制的音频轨 |

生成命令：

```bash
ffmpeg -y -f lavfi -i "testsrc=size=320x240:rate=25" \
  -f lavfi -i "sine=frequency=440:sample_rate=44100" \
  -t 2 -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
  -c:a aac -f mpegts test.ts

ffmpeg -y -i test.ts -map 0:v:0 -c copy -movflags +faststart v.mp4
ffmpeg -y -i test.ts -map 0:a:0 -c copy -movflags +faststart a.mp4
```

测试脚本只使用这些文件，不会访问网络。
