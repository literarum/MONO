# Platform contracts checked 2026-10-17

- [Microsoft: IAudioCaptureClient.GetBuffer](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudiocaptureclient-getbuffer): packet frames, device position and timestamp flags; QPC position uses100 ns units. Release each acquired packet promptly, before filesystem work.
- [Microsoft: loopback recording](https://learn.microsoft.com/en-gb/windows/win32/coreaudio/loopback-recording): loopback captures the selected render endpoint in shared mode; event-driven loopback is supported on the approved Windows10 22H2/11 target. No virtual driver is needed.
- [Apple: capturing system audio with Core Audio taps](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps): macOS14.2 minimum, private tap/aggregate lifecycle, `NSAudioCaptureUsageDescription`. The permission identity must be verified from the packaged app on an actual Mac.
- [Apple: AudioHardwareCreateProcessTap](https://developer.apple.com/documentation/coreaudio/audiohardwarecreateprocesstap(_:_:)): create/destroy OSStatus contract. Newer AudioHardwareSystem wrappers are not substituted for the deployment target without availability guards.
- [Python: native directory dialogs](https://docs.python.org/3/library/dialog.html): `askdirectory` delegates the directory chooser to the platform. The UI process owns its own main thread; the archive worker remains responsive.
- [Microsoft: known folders](https://learn.microsoft.com/en-us/windows/win32/shell/known-folders): resolve Documents with `SHGetKnownFolderPath`, respecting redirection rather than concatenating the profile directory.

These references support implementation decisions. They do not prove that audio, permissions, packaging, signing or a native dialog works on this host or on macOS.

Checked 2026-10-18 during Windows initialization diagnosis:
- [Microsoft: stream flags](https://learn.microsoft.com/en-us/windows/win32/coreaudio/audclnt-streamflags-xxx-constants): LOOPBACK=0x00020000, EVENTCALLBACK=0x00040000. Shared loopback only on a render endpoint.
- [Microsoft: IAudioClient.Initialize](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclient-initialize): shared event-driven duration and periodicity both zero; initialize only once per fresh client. The current host still rejects loopback with E_INVALIDARG even with those values and an independently called native ABI. That failed experiment is not runtime acceptance.
