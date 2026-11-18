"""Real-device capture check for Windows CI (VB-CABLE as the only sound card).

A looping tone is played to the default render device (CABLE Input) by the
workflow; the default capture device (CABLE Output) therefore carries it.
For every mode the native helper offers, record ~6 s through the real
CaptureService + MonoAudio.exe and require committed, non-silent audio.
Prints one JSON report; exits non-zero on any failure.
"""
import array, json, os, struct, sys, tempfile, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "launcher"))
work = Path(tempfile.mkdtemp(prefix="mono-audio-"))
os.environ["MONO_CONFIG_DIR"] = str(work / "config")
os.environ["MONO_DEFAULT_LIBRARY_ROOT"] = str(work / "library")
from local_core.config import LocalConfig  # noqa: E402


def peak_of(file: Path) -> float:
    data = file.read_bytes()
    fmt = data.index(b"fmt ") + 8
    tag, channels, rate, _, align, bits = struct.unpack_from("<HHIIHH", data, fmt)
    if tag == 0xFFFE:
        tag = struct.unpack_from("<H", data, fmt + 24)[0]
    start = data.index(b"data") + 8
    body = data[start:start + struct.unpack_from("<I", data, start - 4)[0]]
    if tag == 3 and bits == 32:
        samples = array.array("f", body)
        return max((abs(x) for x in samples), default=0.0)
    if tag == 1 and bits == 16:
        samples = array.array("h", body)
        return max((abs(x) for x in samples), default=0) / 32768
    if tag == 1 and bits == 32:
        samples = array.array("i", body)
        return max((abs(x) for x in samples), default=0) / 2**31
    if tag == 1 and bits == 24:
        best = 0
        for i in range(0, len(body) - 2, 3):
            value = int.from_bytes(body[i:i + 3], "little", signed=True)
            best = max(best, abs(value))
        return best / 2**23
    raise ValueError(f"unsupported format tag={tag} bits={bits}")


def main() -> int:
    config = LocalConfig()
    config.configure({"useDefault": True})
    service = config.capture_service()
    report = {"capabilities": None, "modes": {}}
    deadline = time.monotonic() + 30
    caps = service.capabilities()
    while not caps.get("ready") and caps.get("state") != "error" and time.monotonic() < deadline:
        service.tick(); time.sleep(0.05); caps = service.capabilities()
    report["capabilities"] = {k: caps.get(k) for k in ("ready", "supported", "modes", "state", "reason", "inputDevices", "outputDevices")}
    failed = not caps.get("ready")
    library = config.get_library()
    for mode in caps.get("modes") or []:
        result = {}
        try:
            started = service.start({"mode": mode})
            record = started["recordId"]
            until = time.monotonic() + 7
            states = []
            while time.monotonic() < until:
                service.tick(); time.sleep(0.02)
                state = service.status()["state"]
                if not states or states[-1] != state: states.append(state)
                if state in ("interrupted", "error"): break
            service.stop()
            until = time.monotonic() + 10
            while service.status()["state"] in ("stopping", "recording", "requesting", "paused") and time.monotonic() < until:
                service.tick(); time.sleep(0.02)
            status = service.status()
            raw = library._raw(record)
            peaks = {}
            for part in raw["_segments"]:
                peaks.setdefault(part["track"], 0.0)
                peaks[part["track"]] = max(peaks[part["track"]], peak_of(library.root / part["path"]))
            result = {"states": states + [status["state"]], "errorCode": status.get("errorCode"), "failureDetails": status.get("failureDetails"),
                      "duration": raw.get("duration"), "segments": len(raw["_segments"]), "peaks": {k: round(v, 4) for k, v in peaks.items()},
                      "format": {k: raw["_segments"][0].get(k) for k in ("sampleRate", "channels", "bitsPerSample", "formatTag")} if raw["_segments"] else None}
            ok = status["state"] == "ready" and raw["_segments"] and all(v > 0.01 for v in peaks.values())
            result["ok"] = bool(ok)
            failed |= not ok
        except Exception as error:  # report everything, keep testing other modes
            result = {"ok": False, "exception": f"{type(error).__name__}: {error}", "status": service.status()}
            failed = True
        report["modes"][mode] = result
        # A second start right after stop must not report DEVICE_BUSY.
    if caps.get("modes"):
        try:
            first = service.start({"mode": "mic"});
            t = time.monotonic() + 3
            while time.monotonic() < t: service.tick(); time.sleep(0.02)
            service.stop(); t = time.monotonic() + 10
            while service.status()["state"] not in ("ready", "interrupted", "error") and time.monotonic() < t: service.tick(); time.sleep(0.02)
            again = service.start({"mode": "mic"}); t = time.monotonic() + 3
            while time.monotonic() < t: service.tick(); time.sleep(0.02)
            status = service.status(); service.stop()
            report["restart"] = {"state": status["state"], "errorCode": status.get("errorCode")}
            failed |= status["state"] not in ("recording", "requesting")
        except Exception as error:
            report["restart"] = {"exception": f"{type(error).__name__}: {error}"}; failed = True
    service.close()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
