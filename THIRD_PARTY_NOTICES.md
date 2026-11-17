# Third-party runtime notices

The selected Windows package includes the unmodified full Python runtime text
in `PYTHON_LICENSE.txt`, the selected Node distribution text in `NODE_LICENSE.txt`,
and reviewed Python dependency/SDK texts under
`runtime/licenses/python-dependencies/`. Its `INDEX.json` identifies versions,
original locations and file hashes. FFmpeg and the native helper have their own
notice directories under `runtime/`.

The source-built Windows audio variant includes the exact FFmpeg and zlib
source archives, build recipe/lock/configuration and original FFmpeg, zlib,
LLVM and MinGW runtime texts under `runtime/licenses/ffmpeg/`. FFmpeg is built
as shared libraries with LGPL 2.1-or-later declarations, zlib linked statically,
and GPL/nonfree/network/autodetected external-library features disabled. The
included GPL texts belong to the complete unmodified upstream source archive;
their presence does not identify the configuration of the compiled runtime.
NASM and GNU make are build tools and are not included in the application.
The historical supplier runtime has an unresolved FFTW dependency discrepancy;
its LGPL self-declaration alone is insufficient for release clearance.

For `proxy_tools` 0.1.0, package metadata says MIT while the author's repository
provides a BSD text for byte-identical source. The original upstream text and
the discrepancy are preserved in the dependency index; no license text has
been synthesized from that metadata.

Inclusion of these texts is a packaging requirement, not a declaration that all
redistribution or corresponding-source obligations have been completed.

MONO's portable bundles are composed of independent runtimes:

- **Node.js** — https://nodejs.org/ — Node.js project licensing and bundled third-party licenses; see https://github.com/nodejs/node/blob/main/LICENSE .
- **FFmpeg / FFprobe** — https://ffmpeg.org/ — LGPL or GPL depending on the exact build configuration. Review https://ffmpeg.org/legal.html and the configuration of the binary in use.
- **Python** — https://www.python.org/psf/license/ — included by PyInstaller.
- **PyInstaller** — https://pyinstaller.org/ — licensed under GPL with special exception for distribution.
- **pywebview** (where used) — https://pywebview.flowrl.com/ and its package license.
- **Browser WebView / Chromium** — platform/browser vendor distribution policies apply.

`launcher/fetch_ffmpeg_release.py` records a pinned-release archive's SHA-256
and provenance. The hash helps verify integrity but does not replace a verified
publisher signature or third-party licensing review.

**Before a public commercial release:** collect the exact binary's license
texts and full dependency notices, identify whether GPL builds are included,
fulfill corresponding-source obligations when applicable, and obtain a legal
redistribution review. Never claim a public binary package has been cleared
merely because its build completed.
