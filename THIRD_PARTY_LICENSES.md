# Third-party licenses

The project's own source code is licensed under the MIT License. See
[`LICENSE`](LICENSE). Bundled third-party components keep their own licenses;
the full texts are in [`LICENSES/`](LICENSES/).

## Runtime libraries

| Component | Version | License | Files | License text |
|---|---|---|---|---|
| [hls.js](https://github.com/video-dev/hls.js) | 1.5.17 | Apache-2.0 | `lib/hls.min.js` | `LICENSES/hls.js-LICENSE.txt`, `LICENSES/Apache-2.0.txt` |
| [MQTT.js](https://github.com/mqttjs/MQTT.js) | 5.10.1 | MIT | `lib/mqtt.min.js` | `LICENSES/mqtt.js-LICENSE.txt`, `LICENSES/MIT.txt` |
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | 1.4.4 | MIT | `lib/qrcode.js` | `LICENSES/qrcode-generator-LICENSE.txt`, `LICENSES/MIT.txt` |
| [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) core | 0.12.10 bindings | LGPL-2.1-or-later | `lib/ffmpeg/ffmpeg-core.js`, `lib/ffmpeg/ffmpeg-core.wasm` | `lib/ffmpeg/README.md`, `LICENSES/FFmpeg-LICENSE.md`, `LICENSES/LGPL-2.1.txt` |

Copyright notices:

- hls.js: Copyright (c) 2017 Dailymotion. Portions derived from videojs-contrib-hls are Copyright (c) 2013-2015 Brightcove.
- MQTT.js: Copyright (c) 2015-2016 MQTT.js contributors.
- qrcode-generator: Copyright (c) 2009 Kazuhiko Arase. "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.
- ffmpeg.wasm bindings: Copyright (c) 2019 Jerome Wu. MIT licensed; see `LICENSES/ffmpeg.wasm-LICENSE.txt`.
- Emscripten runtime: Copyright (c) 2010-2014 Emscripten authors. MIT/NCSA licensed; see `LICENSES/Emscripten-LICENSE.txt`.

`lib/hls.min.js` and `lib/mqtt.min.js` are minified upstream builds. Their
license headers were restored without changing the code. `lib/qrcode.js`
retains its upstream header.

## FFmpeg core components

The WebAssembly core is built from FFmpeg n5.1.4 with the libraries below.
The configure flags are recorded in
[`lib/ffmpeg/ffmpeg-configure-flags.txt`](lib/ffmpeg/ffmpeg-configure-flags.txt).
The exact source revisions and archive URLs are in
[`lib/ffmpeg/source-versions.json`](lib/ffmpeg/source-versions.json).

| Component | Version | License | Copyright notice |
|---|---|---|---|
| FFmpeg | n5.1.4 | LGPL-2.1-or-later | Copyright (c) 2000-2024 the FFmpeg developers |
| libvpx | 1.13.1 | BSD-3-Clause | Copyright (c) 2010, The WebM Project authors |
| LAME | commit `2badea1` | LGPL-2.0-or-later | Copyright (c) 1999 Mark Taylor and The LAME Project |
| libogg | 1.3.4 | BSD-3-Clause | Copyright (c) 2002, Xiph.org Foundation |
| libtheora | 1.1.1 | BSD-3-Clause | Copyright (C) 2002-2009 Xiph.org Foundation |
| libvorbis | 1.3.3 | BSD-3-Clause | Copyright (c) 2002-2008 Xiph.org Foundation |
| libopus | 1.3.1 | BSD-3-Clause | Copyright 2001-2011 Xiph.Org, Skype Limited, Octasic, Jean-Marc Valin, Timothy B. Terriberry, CSIRO, Gregory Maxwell, Mark Borgerding, Erik de Castro Lopo |
| zlib | 1.2.11 | Zlib | Copyright (C) 1995-2017 Jean-loup Gailly and Mark Adler |
| libwebp | 1.3.2 | BSD-3-Clause | Copyright (c) 2010, Google Inc. |
| FreeType | 2.10.4 | FTL | Copyright 1996-2002, 2006 by David Turner, Robert Wilhelm, and Werner Lemberg |
| FriBidi | 1.0.9 | LGPL-2.1-or-later | Copyright (C) 2004 Sharif FarsiWeb, Inc.; Copyright (C) 2001,2002 Behdad Esfahbod; Copyright (C) 1999,2000 Dov Grobgeld |
| HarfBuzz | 5.2.0 | MIT | Copyright (c) 2010-2020 Google, Inc. and other HarfBuzz contributors |
| libass | 0.15.0 | ISC | Copyright (C) 2006-2016 libass contributors |
| zimg | 3.0.5 | WTFPL | Copyright (C) 2004 Sam Hocevar; zimg copyright (c) 2012-2020 Sekai Kyoutou |

The FFmpeg core is a separate, replaceable library. The application code that
loads it remains MIT licensed. The core is distributed under
LGPL-2.1-or-later; the full text is in
[`LICENSES/LGPL-2.1.txt`](LICENSES/LGPL-2.1.txt), and FFmpeg's own license
notes are in [`LICENSES/FFmpeg-LICENSE.md`](LICENSES/FFmpeg-LICENSE.md).

## Source availability

The complete corresponding source for the FFmpeg core is available from the
upstream archives listed in `lib/ffmpeg/source-versions.json`, built with the
recorded configure flags and the provider's build scripts. See
[`lib/ffmpeg/README.md`](lib/ffmpeg/README.md) for links and checksums.

If an upstream archive or build script becomes unavailable, open an issue in
this repository and the maintainers will provide the corresponding source.

## Reference project

The functional design references ideas from
[cat-catch](https://github.com/xifangczy/cat-catch), which is GPL-3.0
licensed. No cat-catch source code is included in this project. See
[`NOTICE.md`](NOTICE.md) for details.
