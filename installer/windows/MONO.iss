; MONO Transcribe — установщик для Windows 10/11 (Inno Setup 6).
; Собирается в CI: .github/workflows/windows-installer.yml → MONO-Setup-<версия>.exe.
; Ставится в профиль пользователя без прав администратора, со своими Python,
; Node.js, FFmpeg и модулем записи — ничего не требует от PATH и winget.

#define AppName "MONO Transcribe"
#ifndef AppVersion
  #define AppVersion "0.4.0"
#endif
#ifndef Stage
  #define Stage "..\..\.build\installer-stage"
#endif

[Setup]
AppId={{8D3E1C52-6A4B-4F0B-9C2E-4D5A7E1B9F10}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=MONO
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
WizardStyle=modern
WizardSizePercent=110
SetupIconFile=..\..\launcher\assets\MONO.ico
UninstallDisplayIcon={app}\app\launcher\assets\MONO.ico
UninstallDisplayName={#AppName}
OutputDir=..\..\.build\installer
OutputBaseFilename=MONO-Setup-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"

[CustomMessages]
ru.WelcomeLabel2=Будет установлено приложение [name/ver].%n%nMONO записывает встречи и голос и превращает их в текст. Всё нужное для работы — звук, обработка, локальный сервер — устанавливается вместе с приложением; права администратора не требуются.%n%nЗакройте MONO, если он запущен, и нажмите «Далее».
ru.FinishedLabel=MONO установлен. Запускайте его ярлыком «{#AppName}» на рабочем столе или в меню «Пуск».%n%nПри первом запуске приложение предложит выбрать папку для записей и подключить Groq для расшифровки.

[Tasks]
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"; GroupDescription: "Ярлыки:"

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\runtime\python\pythonw.exe"; Parameters: """{app}\app\launcher\mono_launcher.py"" --dev"; WorkingDir: "{app}\app"; IconFilename: "{app}\app\launcher\assets\MONO.ico"; Comment: "Запись и расшифровка речи"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\runtime\python\pythonw.exe"; Parameters: """{app}\app\launcher\mono_launcher.py"" --dev"; WorkingDir: "{app}\app"; IconFilename: "{app}\app\launcher\assets\MONO.ico"; Comment: "Запись и расшифровка речи"; Tasks: desktopicon

[Run]
Filename: "{app}\runtime\python\pythonw.exe"; Parameters: """{app}\app\launcher\mono_launcher.py"" --dev"; WorkingDir: "{app}\app"; Description: "Запустить {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Byte-code caches written at run time. User data lives in %LOCALAPPDATA%\MONO Transcribe
; and in the chosen archive folder and is never removed by the uninstaller.
Type: filesandordirs; Name: "{app}\app\launcher\__pycache__"
Type: filesandordirs; Name: "{app}\app\launcher\local_core\__pycache__"
