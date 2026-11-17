# Frozen Chrome Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Launch installed Chrome from frozen Windows MONO without inheriting its bundled DLL search state.

**Architecture:** Keep direct Popen, engine pinning and the persistent profile. A scoped, serialized external-browser boundary supplies a cleaned environment copy and restores the previous DLL directory immediately after spawn; internal bundled runtimes are unchanged.

**Tech Stack:** Python3.14.8, ctypes Win32 DLL APIs, existing PyInstaller and pinned runtimes.

**Spec:** `.codex/task/frozen-chrome-environment-20261027/contract.md`

## Global Constraints

- Windows frozen Chrome only; no permission/security/driver/service modification.
- Preserve profile/archive/keys, original launch arguments and direct parent mechanism.
- No os.environ mutation; retain bundle environment for internal workers.
- No physical success claim before real normal EXE microphone capture/readback.
- Non-Git checkout: retain hash inventory, original bytes and evidence; no Git initialization/cleanup.

## Review Focus

- Failed query/reset/restore and Popen exception must not silently leave an altered loader state.
- Quoted Unicode/mixed-case PATH children are removed; prefix-neighbor/system entries retained.
- Process-wide DLL state requires serialized launch and an exact previous-state restore.
- No-explicit-directory state is preserved; developer/non-Windows/internal helpers are unaffected.
- Existing-profile process handoff and a still-live test backend can invalidate a normal-launch comparison.

### Task 1: Scoped external browser environment

**Files:** modify `launcher/mono_launcher.py`; add `launcher/tests/test_external_browser_environment.py`.
**Interface:** `_external_browser_environment()` yields child env or None; `_windows_dll_directory_api()` provides get/set operations. `launch_chromium(chrome, folder, url)` keeps its current interface.

- [ ] Add production-launch regression asserting neutral DLL state and bundle-free PATH at Popen, with restoration afterward; run unchanged baseline and retain expected RED.
- [ ] Implement Win32 adapter and serialized context; only launch_chromium consumes it.
- [ ] Add query/reset/restore/spawn failure, absent-directory, nonfrozen/non-Windows, PATH-boundary and overlapping-launch cases; run GREEN.
- [ ] Verify real Win32 reset/restore in an isolated test process and retain a mutation that omitting reset fails the original oracle.
- [ ] Run neighboring launcher and full Python/Node checks with pinned runtime inputs; inspect failures without deadline/assertion relaxation.

### Task 2: Source-matched package and actual microphone

**Files:** new build/task artifacts only; preserve old package and user data.

- [ ] Build fresh onefile QA candidate using existing verified native core and pinned runtime bundles; verify actual EXE/resources/core.
- [ ] Fresh-context review of changed source/tests/evidence, with security focus; fix confirmed important findings with RED/GREEN.
- [ ] Collect exec57757 terminal exit; request direct-profile window close only after the candidate is ready.
- [ ] Launch actual new EXE through supported Computer Use, retaining same Chrome profile and direct Popen parent; verify live backend/metadata.
- [ ] Human Intel Smart Sound speech/playback plus independent bounded record decode; otherwise retain failure and reopen investigation.
- [ ] Bind final source/contract/evidence/package hashes and residual native/clean-OS/signing/Mac gates. Update Desktop shortcut only for a verified candidate.
