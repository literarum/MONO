/* MONO.exe — the one icon a person clicks. It does three small things and exits:
 *   1. Finds the data folder: MONO-DATA next to it when MONO.portable is there (portable copy),
 *      otherwise %LOCALAPPDATA%\MONO Transcribe (installed copy); MONO_HOME wins if set.
 *   2. Applies an update that MONO has already verified (signature and every file's SHA-256) and
 *      unpacked into <data>\updates\ready\app: app is renamed to app.previous, ready\app becomes app;
 *      if the second step fails, the first is undone, so MONO always starts from a whole folder.
 *   3. Starts runtime\python\pythonw.exe app\launcher\mono_launcher.py, which opens MONO in a window
 *      of the person's own browser.
 * Build: cl /nologo /O1 /W4 /DUNICODE /D_UNICODE MONO.c MONO.res /link /SUBSYSTEM:WINDOWS user32.lib shell32.lib */
#include <windows.h>
#include <shellapi.h>
#include <wchar.h>
#include <stdio.h>
#include <string.h>

#define LONG_PATH 32768

static wchar_t root[LONG_PATH], data[LONG_PATH];

static void join(wchar_t *out, const wchar_t *a, const wchar_t *b) { swprintf(out, LONG_PATH, L"%s\\%s", a, b); }
static BOOL exists(const wchar_t *path) { return GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES; }
static BOOL isDirectory(const wchar_t *path) { DWORD a = GetFileAttributesW(path); return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY); }

static void message(const wchar_t *text) { MessageBoxW(NULL, text, L"MONO", MB_OK | MB_ICONERROR); }

static void removeTree(const wchar_t *path) {
    /* SHFileOperation needs a double-NUL terminated list. */
    static wchar_t list[LONG_PATH + 2];
    SHFILEOPSTRUCTW op = {0};
    wcsncpy(list, path, LONG_PATH); list[wcslen(list) + 1] = 0;
    op.wFunc = FO_DELETE; op.pFrom = list; op.fFlags = FOF_NO_UI;
    SHFileOperationW(&op);
}

static void writeApplied(const wchar_t *version, const wchar_t *result) {
    wchar_t file[LONG_PATH]; char text[512]; DWORD written;
    HANDLE handle;
    swprintf(file, LONG_PATH, L"%s\\updates\\applied.json", data);
    handle = CreateFileW(file, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (handle == INVALID_HANDLE_VALUE) return;
    {
        SYSTEMTIME t; GetSystemTime(&t);
        _snprintf(text, sizeof text, "{\"version\":\"%ls\",\"result\":\"%ls\",\"at\":\"%04u-%02u-%02uT%02u:%02u:%02uZ\"}",
                  version, result, t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond);
    }
    WriteFile(handle, text, (DWORD)strlen(text), &written, NULL);
    CloseHandle(handle);
}

/* The version is read from READY ({"version":"x.y.z",...}); only digits and dots are kept. */
static void readyVersion(const wchar_t *marker, wchar_t *version, size_t size) {
    char buffer[512] = {0}; DWORD read = 0; HANDLE h; char *at; size_t n = 0;
    version[0] = 0;
    h = CreateFileW(marker, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (h == INVALID_HANDLE_VALUE) return;
    ReadFile(h, buffer, sizeof buffer - 1, &read, NULL); CloseHandle(h);
    at = strstr(buffer, "\"version\":\"");
    if (!at) return;
    for (at += 11; *at && *at != '"' && n + 1 < size; at++) if ((*at >= '0' && *at <= '9') || *at == '.') version[n++] = (wchar_t)*at;
    version[n] = 0;
}

static void applyUpdate(void) {
    wchar_t ready[LONG_PATH], readyApp[LONG_PATH], marker[LONG_PATH], app[LONG_PATH], previous[LONG_PATH], version[64];
    swprintf(ready, LONG_PATH, L"%s\\updates\\ready", data);
    join(readyApp, ready, L"app"); join(marker, ready, L"READY");
    join(app, root, L"app"); join(previous, root, L"app.previous");
    if (!exists(marker) || !isDirectory(readyApp)) return;
    readyVersion(marker, version, 64);
    if (isDirectory(previous)) removeTree(previous);
    if (!MoveFileExW(app, previous, 0)) { writeApplied(version, L"app-busy"); return; } /* MONO still running: next time */
    if (!MoveFileExW(readyApp, app, 0)) {
        MoveFileExW(previous, app, 0); /* roll back: the old version starts */
        writeApplied(version, L"rolled-back");
        return;
    }
    DeleteFileW(marker); RemoveDirectoryW(ready);
    writeApplied(version, L"ok");
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previousInstance, PWSTR arguments, int show) {
    wchar_t portable[LONG_PATH], python[LONG_PATH], script[LONG_PATH], app[LONG_PATH], command[LONG_PATH], local[LONG_PATH];
    STARTUPINFOW startup = {sizeof startup};
    PROCESS_INFORMATION process;
    DWORD length;
    (void)instance; (void)previousInstance; (void)show;

    length = GetModuleFileNameW(NULL, root, LONG_PATH);
    if (!length || length >= LONG_PATH) { message(L"Не удалось определить папку MONO."); return 1; }
    *wcsrchr(root, L'\\') = 0;

    if (GetEnvironmentVariableW(L"MONO_HOME", data, LONG_PATH) == 0) {
        join(portable, root, L"MONO.portable");
        if (exists(portable)) join(data, root, L"MONO-DATA");
        else if (GetEnvironmentVariableW(L"LOCALAPPDATA", local, LONG_PATH)) join(data, local, L"MONO Transcribe");
        else { message(L"Не найдена папка данных пользователя."); return 1; }
        SetEnvironmentVariableW(L"MONO_HOME", data);
    }
    CreateDirectoryW(data, NULL);

    applyUpdate();

    join(app, root, L"app");
    swprintf(python, LONG_PATH, L"%s\\runtime\\python\\pythonw.exe", root);
    swprintf(script, LONG_PATH, L"%s\\launcher\\mono_launcher.py", app);
    if (!exists(python) || !exists(script)) { message(L"Файлы MONO неполные. Распакуйте архив MONO заново."); return 1; }
    swprintf(command, LONG_PATH, L"\"%s\" \"%s\" --dev %s", python, script, arguments ? arguments : L"");
    if (!CreateProcessW(python, command, NULL, NULL, FALSE, 0, NULL, app, &startup, &process)) {
        message(L"Не удалось запустить MONO."); return 1;
    }
    CloseHandle(process.hThread); CloseHandle(process.hProcess);
    return 0;
}
