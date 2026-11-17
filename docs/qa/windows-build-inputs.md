# Windows build inputs

The current Windows producer targets normal GIL-enabled CPython **3.14.8 x64**.
Use an isolated Python environment. The official full-runtime ZIP can be
extracted without registering Python, changing system PATH or creating shortcuts:
<https://docs.python.org/3.14/using/windows.html#offline-installs>.
The release manifest is <https://www.python.org/ftp/python/3.14.8/windows-3.14.8.json>.
Verify its published hashes and Python Software Foundation signatures before use.

Install `launcher/requirements-build-windows-bootstrap.lock`, then
`launcher/requirements-build-windows.lock` and
`launcher/requirements-core-windows.lock`, using `--require-hashes` and
`--no-build-isolation` for the latter two. Do not substitute a free-threaded
interpreter or reuse a CPython3.12 compiled core.

```powershell
python launcher/fetch_msvc_windows.py --output .compiler-input
python launcher/build_core.py --output .core-build --compiler-input .compiler-input --nuitka-archive .compiler-input/archives/nuitka-4.3.1.tar.gz
python scripts/verify-compiled-core.py --bundle .core-build/bundle --run-tests --report .core-build/verification.json
```

Stop after any nonzero exit; the Windows workflow explicitly propagates failures.
Only after successful verification, select `.core-build/bundle` through
`MONO_BUILD_CORE_BUNDLE` for `launcher/build_portable.py`.
Select the separately reviewed Node, shared LGPL FFmpeg and native capture
capsules as described by their build commands; do not use an ambient FFmpeg.

Windows Node input is pinned to the October security release **24.22.1**:

```powershell
python launcher/node_windows.py --output .node-windows
$env:MONO_BUILD_NODE=(Resolve-Path .node-windows/node.exe).Path
```

The acquisition command checks independent archive/member pins, extracts only
the fixed executable/license members and never executes the download. Before
approving a Windows candidate, run `scripts/verify-package.py` with
`--require-node-baseline` (also when using `--execute --exercise-core`). This
checks exact executable/license bytes and PE architecture before starting any
child process. The CI source and frozen checks require it. Generic component
integrity verification alone is not a security-runtime clearance.
`node scripts/verify-node-security.mjs` additionally checks the DNS-NUL fix with
two positive controls and a private loopback-only DNS server; CI requires it.
Sources: [Node24.22.1](https://nodejs.org/en/blog/release/v24.22.1),
[October advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).

`compiler-msvc-windows.lock.json` pins Nuitka, five Microsoft VC payloads and
the two Windows SDK NuGet packages. The acquisition tool downloads and extracts
files into its new output directory; it does not run an installer, register a
toolchain, change registry/PATH persistently, install certificates or execute
downloaded code. It refuses unsafe/linked/duplicate paths and changed bytes.
Before compilation the producer compares the entire extracted tree against the
pinned archives again. Compiler PATH, headers and libraries are private to its
child process. MSVC is selected from that verified PATH, without an experimental
MinGW override or an unconstrained `--msvc=latest` selection.
The English compiler resources are assembled next to `cl.exe`; these derived
copies are checked against the signed resource archive as well. Ambient `CL`,
`_CL_`, `LINK` and `_LINK_` options are removed from the build child environment.

Input pins were established using Microsoft package signatures (OPC signatures
with certificate-chain validation for VC payloads, NuGet author/repository
verification for SDK packages), plus the signed Microsoft layout verifier.
Re-review publisher provenance before changing a pin. A locally computed hash
alone does not establish publisher trust. The older WinLibs lock/acquisition
utility remains for historical input verification; it is not the current
Windows core compilation path.

This procedure is a build contract, not a release clearance. A successful build
does not establish actual microphone/system capture, native GUI/chooser behavior,
clean Windows compatibility, speech quality, endurance, full corresponding-source
compliance, or owner Authenticode signing. Those gates remain separately required.
