# MONO Transcribe — установка из исходников для Windows 10/11.
# Запускается из INSTALL-MONO-Windows.cmd. Совместим с Windows PowerShell 5.1.
# Файл сохранён в UTF-8 с BOM: без BOM PowerShell 5.1 читает кириллицу как ANSI.
param([switch]$NoLaunch,[switch]$Unattended)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
try{[Console]::OutputEncoding=[System.Text.Encoding]::UTF8}catch{}
$Root=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Log=Join-Path $env:TEMP 'mono-install.log'
Start-Transcript -Path $Log -Force | Out-Null

function Step($text){Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan}
function Ok($text){Write-Host "    [OK] $text" -ForegroundColor Green}
function Warn($text){Write-Host "    [!] $text" -ForegroundColor Yellow}
function Fail($text){Write-Host ''; Write-Host "[ОШИБКА] $text" -ForegroundColor Red; Write-Host "Журнал установки: $Log"; Stop-Transcript | Out-Null; exit 1}
function Ask($question){
  if($Unattended){return $false}
  $answer=Read-Host "$question [y/N]"
  return $answer -match '^(y|yes|д|да)$'
}
function Refresh-Path{
  $machine=[Environment]::GetEnvironmentVariable('Path','Machine')
  $user=[Environment]::GetEnvironmentVariable('Path','User')
  $env:Path=(@($machine,$user) | Where-Object {$_}) -join ';'
}
function Has-Winget{return [bool](Get-Command winget.exe -ErrorAction SilentlyContinue)}
function Winget-Install($id,$name){
  if(-not (Has-Winget)){Fail "$name не найден, а winget (Установщик приложений) недоступен. Установите $name вручную и запустите установку снова."}
  Write-Host "    Устанавливаю $name через winget…"
  & winget.exe install --id $id --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Host
  # 0 = installed; 0x8A15002B (no applicable upgrade) and 0x8A150061 (already installed) are fine.
  if(@(0,-1978335189,-1978335135) -notcontains $LASTEXITCODE){Fail "winget не смог установить $name (код $LASTEXITCODE)."}
  Refresh-Path
}
function Version-Of($exe,$arguments){
  try{$out=& $exe @arguments 2>&1 | Select-Object -First 1;return "$out"}catch{return ''}
}

Write-Host 'MONO Transcribe — установка' -ForegroundColor White
Write-Host "Папка приложения: $Root"

Step 'Снимаю пометку «загружено из интернета» с файлов приложения'
Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue
Ok 'Готово'

# --- Node.js ≥ 20 ---------------------------------------------------------------
Step 'Node.js (сервер приложения)'
Refresh-Path
$node=Get-Command node.exe -ErrorAction SilentlyContinue
$nodeOk=$false
if($node){$v=Version-Of $node.Source @('--version');if($v -match '^v(\d+)\.' -and [int]$Matches[1] -ge 20){$nodeOk=$true;Ok "Node.js $v"}else{Warn "Найден устаревший Node.js $v, нужен 20 или новее"}}
if(-not $nodeOk){Winget-Install 'OpenJS.NodeJS.LTS' 'Node.js LTS';$node=Get-Command node.exe -ErrorAction SilentlyContinue;if(-not $node){Fail 'Node.js установлен, но не найден в PATH. Перезагрузите компьютер и запустите установку снова.'};Ok ("Node.js "+(Version-Of $node.Source @('--version')))}

# --- Python ≥ 3.11 с tkinter -----------------------------------------------------
Step 'Python (локальное ядро архива)'
function Find-Python{
  $candidates=@()
  $py=Get-Command py.exe -ErrorAction SilentlyContinue
  if($py){try{$candidates+=(& $py.Source -3 -c 'import sys;print(sys.executable)' 2>$null)}catch{}}
  $python=Get-Command python.exe -ErrorAction SilentlyContinue
  # The Microsoft Store alias in WindowsApps only opens the Store: ignore it.
  if($python -and $python.Source -notmatch 'WindowsApps'){$candidates+=$python.Source}
  # Prefer an interpreter with tkinter (system folder dialog); accept one without it.
  foreach($probe in @('import sys,tkinter;print(1 if sys.version_info>=(3,11) else 0)','import sys;print(1 if sys.version_info>=(3,11) else 0)')){
    foreach($c in $candidates){
      if(-not $c -or -not (Test-Path $c)){continue}
      $check=& $c -c $probe 2>$null
      if("$check".Trim() -eq '1'){return $c}
    }
  }
  return $null
}
$python=Find-Python
if(-not $python){Winget-Install 'Python.Python.3.13' 'Python 3.13';$python=Find-Python}
if(-not $python){Fail 'Не найден Python 3.11 или новее. Установите Python с python.org и запустите установку снова.'}
$tkOut=& $python -c 'import tkinter;print(1)' 2>$null
if("$tkOut".Trim() -ne '1'){Warn 'В Python нет tcl/tk: кнопка «Выбрать папку» недоступна, архив создаётся в «Документы\MONO Library».'}
$pythonw=Join-Path (Split-Path $python) 'pythonw.exe'
if(-not (Test-Path $pythonw)){Fail "Рядом с $python нет pythonw.exe — нужен стандартный Python с python.org."}
Ok ((Version-Of $python @('--version'))+" — $python")

# --- FFmpeg + FFprobe ----------------------------------------------------------
Step 'FFmpeg (обработка звука)'
function Has-FFmpeg{return [bool]((Get-Command ffmpeg.exe -ErrorAction SilentlyContinue) -and (Get-Command ffprobe.exe -ErrorAction SilentlyContinue))}
if(-not (Has-FFmpeg)){
  Winget-Install 'Gyan.FFmpeg' 'FFmpeg'
  if(-not (Has-FFmpeg)){
    # Known winget-pkgs issue: the package root, not its bin folder, may be added to PATH.
    $bin=Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages') -Filter ffmpeg.exe -Recurse -ErrorAction SilentlyContinue | Where-Object {Test-Path (Join-Path $_.DirectoryName 'ffprobe.exe')} | Select-Object -First 1
    if($bin){
      $user=[Environment]::GetEnvironmentVariable('Path','User')
      if(($user -split ';') -notcontains $bin.DirectoryName){[Environment]::SetEnvironmentVariable('Path',(@($user,$bin.DirectoryName) | Where-Object {$_}) -join ';','User')}
      Refresh-Path
    }
  }
}
if(-not (Has-FFmpeg)){Fail 'FFmpeg не найден. Установите FFmpeg (ffmpeg.exe и ffprobe.exe в PATH) и запустите установку снова.'}
Ok ((Version-Of 'ffmpeg.exe' @('-version')) -replace ' Copyright.*','')

# --- Нативный модуль записи звука компьютера (необязательно) ----------------------
Step 'Модуль записи звука компьютера (WASAPI, необязательно)'
$helper=Join-Path $Root '.build\capture-windows\bundle\MonoAudio.exe'
$dotnet=Get-Command dotnet.exe -ErrorAction SilentlyContinue
$sdk10=$false
if($dotnet){$sdks=& $dotnet.Source --list-sdks 2>$null;$sdk10=[bool]($sdks | Where-Object {$_ -match '^10\.'})}
if(-not $sdk10 -and -not (Test-Path $helper)){
  Warn 'Для записи «Звука компьютера» нужен .NET SDK 10 (около 1 ГБ). Без него MONO пишет микрофон через окно браузера.'
  if(Ask '    Установить .NET SDK 10 и собрать модуль?'){Winget-Install 'Microsoft.DotNet.SDK.10' '.NET SDK 10';$dotnet=Get-Command dotnet.exe -ErrorAction SilentlyContinue;$sdk10=[bool]$dotnet}
}
if($sdk10){
  Write-Host '    Собираю MonoAudio.exe (локальная сборка для этого компьютера)…'
  & $dotnet.Source publish (Join-Path $Root 'native\windows\MonoAudio.csproj') -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:DebugType=None -o (Split-Path $helper) --nologo -v quiet | Out-Host
  if($LASTEXITCODE -eq 0 -and (Test-Path $helper)){Ok 'Модуль собран: доступны «Звук компьютера» и «Микрофон и компьютер»'}else{Warn 'Сборка модуля не удалась — останется запись микрофона через браузер'}
}elseif(Test-Path $helper){Ok 'Модуль уже собран'}else{Ok 'Пропущено: запись микрофона через окно браузера'}

# --- Окно приложения -----------------------------------------------------------
Step 'Окно приложения (Microsoft Edge или Google Chrome)'
$browser=@("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe","$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe","$env:ProgramFiles\Google\Chrome\Application\chrome.exe","$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object {Test-Path $_} | Select-Object -First 1
if(-not $browser){Fail 'Не найден Microsoft Edge или Google Chrome — MONO открывается в окне одного из них.'}
Ok $browser

# --- Проверка: сервер стартует и отвечает -------------------------------------------
Step 'Проверка запуска (сервер, ядро архива, FFmpeg)'
$running=$false
try{$health=Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/health' -TimeoutSec 2;$running=($health.mode -eq 'local')}catch{}
if($running){Ok 'MONO уже запущен — проверка пропущена'}
else{
  $smoke=& $python (Join-Path $Root 'launcher\mono_launcher.py') --dev --smoke 2>&1 | Out-String
  if($LASTEXITCODE -ne 0 -or $smoke -notmatch '"ok": true'){Fail "Проверочный запуск не удался:`n$smoke"}
  Ok 'Сервер запускается и отвечает'
}

# --- Ярлыки -----------------------------------------------------------------------
Step 'Ярлык на рабочем столе и в меню «Пуск»'
$shell=New-Object -ComObject WScript.Shell
$targets=@([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Programs'))
foreach($folder in $targets){
  $link=$shell.CreateShortcut((Join-Path $folder 'MONO Transcribe.lnk'))
  # pythonw.exe: без консольного окна. Сервер и ядро скрыты (CREATE_NO_WINDOW).
  $link.TargetPath=$pythonw
  $link.Arguments='"'+(Join-Path $Root 'launcher\mono_launcher.py')+'" --dev'
  $link.WorkingDirectory=$Root
  $link.IconLocation=(Join-Path $Root 'launcher\assets\MONO.ico')+',0'
  $link.Description='MONO Transcribe — запись и расшифровка речи'
  $link.Save()
  Ok (Join-Path $folder 'MONO Transcribe.lnk')
}

Write-Host ''
Write-Host 'Готово. Запускайте MONO ярлыком «MONO Transcribe» на рабочем столе.' -ForegroundColor Green
Write-Host 'Данные хранятся в %LOCALAPPDATA%\MONO Transcribe и в выбранной вами папке архива.'
Stop-Transcript | Out-Null
if(-not $NoLaunch -and -not $running){Start-Process -FilePath $pythonw -ArgumentList ('"'+(Join-Path $Root 'launcher\mono_launcher.py')+'" --dev') -WorkingDirectory $Root}
exit 0
