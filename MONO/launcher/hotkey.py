"""System-wide recording hotkey for Windows: Ctrl+Alt+R starts or stops recording
even when the MONO window is in the background (RegisterHotKey, user32).

The launcher forwards each press to its own backend with a per-launch secret
token (MONO_LAUNCHER_TOKEN); the open window receives it over /api/local/events.
"""
from __future__ import annotations
import ctypes, os, threading, urllib.request
from ctypes import wintypes

MOD_ALT, MOD_CONTROL, MOD_NOREPEAT = 0x0001, 0x0002, 0x4000
WM_HOTKEY = 0x0312
VK_R = 0x52


def forward(url: str, token: str, timeout: float = 3.0) -> bool:
    request = urllib.request.Request(url + "/api/launcher/hotkey", data=b"{}", method="POST",
                                     headers={"Content-Type": "application/json", "X-Mono-Launcher-Token": token})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status == 204
    except OSError:
        return False


def start_global_hotkey(url: str, token: str, logger, *, key: int = VK_R,
                        modifiers: int = MOD_CONTROL | MOD_ALT | MOD_NOREPEAT) -> threading.Thread | None:
    if os.name != "nt":
        return None

    def loop() -> None:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        # The hotkey belongs to this thread's message queue.
        if not user32.RegisterHotKey(None, 1, modifiers, key):
            logger.warning("Global hotkey Ctrl+Alt+R is taken by another app (error %s)", ctypes.get_last_error())
            return
        logger.info("Global hotkey Ctrl+Alt+R registered")
        message = wintypes.MSG()
        try:
            while user32.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
                if message.message == WM_HOTKEY and not forward(url, token):
                    logger.warning("Hotkey press could not reach the backend")
        finally:
            user32.UnregisterHotKey(None, 1)

    thread = threading.Thread(target=loop, name="mono-hotkey", daemon=True)
    thread.start()
    return thread
