# MONO Native Capture and Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** R-013…R-017/R-023…R-026: короткий первый запуск и реальная запись микрофона/компьютера на обеих ОС.
**Architecture:** CaptureService в Python управляет платформенным helper, принимает durable segments и отдает UI состояния. Ключи хранятся системным vault; onboarding использует тот же API, что настройки, и не имеет отдельной скрытой конфигурации.
**Tech Stack:** C++20 WASAPI, Swift Core Audio/AVFoundation, Python worker, OS vault/dialogs, ES modules, unittest/node:test и native acceptance.
**Spec:** ../../MONO-0.5-SPEC.md; 2026-10-16-mono-master.md. Prerequisites: UI components and CORE-1…CORE-4.

## Global Constraints

Наследует master Global Constraints: никаких сторонних виртуальных драйверов, камера не требуется, разрешения только по действию, 2 s сегменты, отдельные mic/system originals, без скрытого переключения устройства, DPAPI/Keychain без plaintext fallback.

## Review Focus

Переходы start/stop/race, долгий отказ ОС, disconnected default/Bluetooth, sleep/wake, permissions identity в packaged macOS. Испытания adapters на одной платформе не закрывают другую.

### CAPTURE-1: контракт CaptureService и durable audio protocol

**Files:** Create launcher/local_core/capture.py, native/PROTOCOL.md, public/capture-client.js, launcher/tests/test_capture_state.py, tests/capture-http.test.mjs; Modify backend/local/routes.mjs, public/app.js.
**Interfaces:** `CaptureService.capabilities/devices/check_access/test/start/pause/resume/stop/status`; public `POST /api/local/capture/{test,start,pause,resume,stop}` and `GET .../capabilities|devices|status`. Start `{mode:'mic'|'system'|'both',inputId,outputId}` → `{sessionId,recordId,state}`. Helper stdin v1 NDJSON control; stdout events `ready/state/level/segment/error`, sequence and sessionId mandatory. Segment `{track,index,format,sampleRate,channels,startMonotonicNs,frames,relativeFile,sha256}` is not UI-confirmed until CORE-2 receipt.

- [ ] RED: start twice, stop during permission request, pause during stopping, late event from prior session, helper crash/EOF and malformed/foreign paths. Assert one session, request cancellation, committed chunks preserved, disconnected source yields interrupted/error, no false saved status.
- [ ] Implement state machine idle/requesting/ready/recording/paused/stopping/interrupted/error; bounded event queue and watchdog; helper paths fixed by verified manifest. `status` includes actual per-track peak/committedFrames/device IDs and gap markers; polling uses no overlapping calls. Test capture is a temporary local recording, explicit cleanup after playback, no provider request.
- [ ] Run `python -m unittest discover -s launcher/tests -p test_capture_state.py -v`; `node --test tests/capture-http.test.mjs`; HTTP state changes through session/CSRF and a protocol fixture, explicitly distinct from physical audio acceptance. Checkpoint.

### CAPTURE-2: Windows WASAPI adapter

**Files:** Create native/windows/CMakeLists.txt, native/windows/main.cpp, native/windows/wasapi_capture.cpp, native/windows/segment_writer.cpp, native/windows/clock_sync.cpp, native/windows/tests/clock_tests.cpp, native/windows/tests/segment_tests.cpp, docs/qa/windows-capture.md; Modify launcher/local_core/capture.py, launcher/build_portable.py.
**Interfaces:** `MonoAudio.exe --protocol 1 --capture-root <private-session-dir>`; no arbitrary executable/device commands. `enumerate` returns stable endpoint IDs and role/default. WASAPI mic capture and render endpoint loopback use shared/event mode. Segment writer produces independently decodable WAV with native sample format metadata, 2 s per-track frame blocks and monotonic timing; fsync/close before segment event.

- [ ] RED native tests: silence advances timeline when loopback delivers no buffers, device clock drift, discontinuity, packet spanning segment boundary, clipping-safe later mix, cancellation of held stream. Independent expected frame positions/time bounds, not values calculated by production helper.
- [ ] Implement COM device enumeration, microphone/system streams, device notifications and precise flags→gap events. Keep selected endpoint ID; default replacement or unplug stops/interruption with action, never silently retargets. Disable recording MONO playback by product flow; no microphone monitoring by default. Worker commits native segments via CORE-2.
- [ ] Run `cmake -S native/windows -B .codex/build/windows -A x64`; `cmake --build .codex/build/windows --config Release`; `ctest --test-dir .codex/build/windows -C Release --output-on-failure`; inspect every exit and ensure CTest discovered actual test count.
- [ ] Run docs/qa/windows-capture.md: physical mic speech, browser+player+meeting output, selected headphones, both tracks/mix, pause, endpoint unplug, Bluetooth, denial, sleep, helper kill and fresh launch. Independently decode/hash files; impulse positions and drift measured. Four-hour actual capture is mandatory RELEASE-1; short test is not called endurance. Checkpoint Windows adapter.

### CAPTURE-3: macOS Core Audio adapter

**Files:** Create native/macos/Package.swift, native/macos/Sources/MonoAudio/main.swift, native/macos/Sources/MonoAudio/SystemTap.swift, native/macos/Sources/MonoAudio/Microphone.swift, native/macos/Sources/MonoAudio/SegmentWriter.swift, native/macos/Tests/MonoAudioTests/ClockAndSegmentsTests.swift, native/macos/Info.plist, docs/qa/macos-capture.md; Modify launcher/local_core/capture.py, launcher/build_portable.py.
**Interfaces:** bundled `MonoAudio` uses CAPTURE-1 protocol; build target macOS 14.2. Private Core Audio tap + private aggregate device for system audio; mic AVFoundation/Core Audio. Usage strings and stable bundle/signing identity belong to packaged MONO; helper permission attribution verified in release package, not assumed from CLI.

- [ ] RED native tests mirror frame/time invariants from CAPTURE-2 using platform-independent fixture expectations; access denied, unavailable tap, default/output disconnect and late callbacks after stop leave no capture running. Version <14.2 reports unsupported without trying missing APIs.
- [ ] Implement taps, device IDs, permission flow, release tap/aggregate on stop/error and timed independent segments. Preserve source time, report discontinuities/sleep rather than closing gaps. No ScreenCaptureKit/video fallback that silently adds camera/screen requirements.
- [ ] On actual Mac run `swift test --package-path native/macos`; `swift build --package-path native/macos -c release --arch arm64` or `--arch x86_64` on the matching runner; compiler success does not prove permissions or audio.
- [ ] Run docs/qa/macos-capture.md from packaged app for each architecture: first permission/denial/regrant, keychain prompt, mic/system/both, device/sleep/restart/helper crash and actual audio playback validation. Verify who OS attributes capture to; if identity is wrong, correct helper packaging and repeat. No Mac available → retain NOT_RUN and continue only independently verifiable work. Checkpoint macOS adapter.

### CAPTURE-4: secure credentials, first run and contextual help

**Files:** Create launcher/local_core/vault.py, launcher/local_core/vault_windows.py, launcher/local_core/vault_macos.py, backend/groq/key-manager.mjs, public/onboarding.js, public/help.js, launcher/tests/test_vault.py, tests/onboarding.test.mjs, tests/key-manager.test.mjs; Modify public/index.html, public/app.js, server.mjs, launcher/mono_launcher.py.
**Interfaces:** worker `credentials.store/delete/status` plus private credential read restricted to the trusted Node worker channel, never an HTTP read endpoint; `KeyManager.configure(key,{signal}):Promise<KeyStatus>` validates `/openai/v1/models` with no audio; 8 s timeout, one request per action. `KeyStatus={configured,verified,masked,errorCode}` only. `onboarding.resume({library,capture,keyStatus})` persists step completion in local config; `showHint({id,context,severity,action})` respects dismissed educational IDs.

- [ ] RED: invalid/revoked/offline/rate/quota responses; double click/cancel/retry; failed vault commit never claims saved; Keychain locked/denied has no plaintext fallback. Canary key absent from browser storage, logs, export, cache, diagnostic output and response bodies. User-entered field clears after result and is not restored on route change.
- [ ] Implement DPAPI CurrentUser Windows blob and macOS Keychain APIs without key-as-command-argument; keep env/file key compatibility for existing deployments, identify managed external keys and do not silently overwrite them. Replace startup-only key snapshot in local mode; proxy existing environment contract remains. Provider errors redacted centrally.
- [ ] Implement 3 short steps: folder→Groq (Позже)→sound test; links only official Groq keys/billing pages, details collapsed. Same settings components allow later changes. No eager mic/key/audio requests on welcome; intent to transcribe without key returns to the same record after setup.
- [ ] Add contextual help for meeting source/headphones/test/silence/overload and after-recording next action; education dismissal never suppresses save failures. Run `node --test tests/onboarding.test.mjs tests/key-manager.test.mjs`; `python -m unittest discover -s launcher/tests -p test_vault.py -v`.
- [ ] Real clean-profile UI flow on each OS: skip key and record, enter key privately and validate, close/reopen, reject mic permission, use settings to recover. Real secret comes only from user; no paid audio request hidden in setup. Verify network capture metadata contains only intended endpoints and no test audio upload. Checkpoint onboarding/capture gate.
