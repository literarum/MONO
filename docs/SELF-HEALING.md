# Самовосстановление записи: доктор и автопилот MONO

Задача: человек нажимает «Начать запись», и запись идёт. Если Windows что-то сломала, MONO сначала молча чинит, потом пробует другой путь. Спрашивает человека только о том, что программа решать не вправе: переключатель конфиденциальности, отключённое устройство.

## 1. Исследование: почему запись на Windows не идёт

| Причина | Как проявляется | Что говорят источники | Можно ли починить без человека |
|---|---|---|---|
| Выключен доступ к микрофону для программ | `IAudioClient::Initialize` → `E_ACCESSDENIED (0x80070005)`; в браузере `NotAllowedError` | Microsoft: переключатель «Разрешить классическим приложениям доступ к микрофону» [1]; Mozilla: тот же код при запрете [2]; подтверждено нашим CI на Windows Server 2025 | **Нет** — решение человека. MONO определяет заранее и открывает нужную страницу «Параметров» |
| Микрофон выключен в Windows (без звука) или уровень ≈ 0 | Запись идёт, но тишина | `IAudioEndpointVolume::GetMute` / `GetMasterVolumeLevelScalar` читают состояние входа [3]. Аппаратная кнопка mute гарнитуры этим не отражается — **НЕТ ДАННЫХ ДЛЯ НАДЁЖНОГО ВЫВОДА** [3] | **Да**, при явном намерении (нажата «Запись»): `SetMute(false)`, уровень до 50 % |
| Микрофон отключён в «Звуке» / Диспетчере устройств | Его нет в списке | `DEVICE_STATE_DISABLED` (0x2), `NOTPRESENT` (0x4), `UNPLUGGED` (0x8); поток открывается только на `ACTIVE` [4] | **Нет**: документированного API включения нет. MONO говорит точный путь |
| Устройство пропало или его переконфигурировали во время записи | `AUDCLNT_E_DEVICE_INVALIDATED (0x88890004)` | Microsoft: освободить интерфейсы и переоткрыть устройство по умолчанию — «без участия пользователя» [5]; SDL и Mumble делают так же; у GStreamer был бесконечный цикл повторов, поэтому повторы надо ограничивать [6] | **Да**: связанная вторая часть на текущем устройстве, не более 3 раз за 5 мин |
| Устройство в монопольном режиме у другой программы | `AUDCLNT_E_DEVICE_IN_USE` | Только при эксклюзивном режиме [7] | Частично: другой путь (устройство по умолчанию, браузерный канал) |
| Остановлена служба Windows Audio | `AUDCLNT_E_SERVICE_NOT_RUNNING` | Перезапуск требует прав администратора [8] | **Нет** без повышения прав — говорим прямо |
| Bluetooth-гарнитура в режиме громкой связи (HFP) | Звук моно и узкополосный | Windows переключает профиль при открытии микрофона [9] | **Нет** (свойство гарнитуры) — предупреждение с советом |
| Браузерный канал: `NotReadableError` | Устройство занято или сбой ОС | MDN: аппаратная ошибка уровня ОС [10]; SDK (Twilio, Stream) повторяют с ослабленными ограничениями и без `deviceId` [11] | **Да**: лестница ограничений + один повтор через 300 мс |
| Флаг тишины WASAPI | Иногда не выставляется | Флаг ненадёжен (свидетельства в комментариях блога инженера Microsoft) [12] | Мы его не используем: решаем по измеренному уровню |

## 2. Принципы (Apple)

- Лучше всего — тихо восстановиться. Предупреждение нужно, только когда восстановиться нельзя или нужно решение человека [13].
- Не показывать коды ошибок как главное сообщение [14]. У MONO код есть только в «Скопировать диагностику».
- У каждой ошибки — одна кнопка, которая её исправляет.
- Повторы ограничены: экспоненциальная пауза и бюджет попыток [6][15]. Ручная остановка всегда сильнее автоматики.

## 3. Как устроено

**Доктор** (`capture.diagnose`), только чтение:
- все входы Windows в любом состоянии: работает, отключён, отсутствует, не подключён;
- для работающих — выключен ли звук и уровень громкости.

Результат показывается в предполётной проверке. Где можно, есть кнопка «Исправить».

**Ремонт** (`capture.repair`) делает ровно две вещи с одним устройством: включает звук и поднимает почти нулевой уровень. Устройство по умолчанию не меняется никогда.

**Автопилот** записи:
1. Перед стартом записи с микрофона:
   - доктор; выключенный звук и нулевой уровень исправляются сразу, с одной строкой «MONO включил его»;
   - если выбранный микрофон исчез — записываем с микрофона по умолчанию;
   - если есть только отключённые — понятное сообщение и кнопка «Открыть параметры звука».
2. Если старт не удался по причине, которую может обойти другой путь, — лестница из двух шагов:
   - то же, но на устройствах по умолчанию;
   - для записи только микрофона — браузерный канал.

   Звук компьютера никогда не выбрасывается молча. Запрет доступа не обходится.
3. 10 с тишины во время записи: доктор ещё раз; если микрофон выключили — включаем, запись продолжается.
4. Устройство пропало во время записи: подтверждённая часть сохраняется, запись продолжается второй частью.
5. Модуль записи упал: перезапускается, а следующий старт ждёт его готовности.

## 4. Как проверено

| Проверка | Где |
|---|---|
| Выключить микрофон → доктор видит → ремонт → тон записывается снова | CI на настоящем Windows с VB-CABLE (`scripts/ci/windows_audio_check.py`) |
| Запрет микрофона → точный `ACCESS_DENIED`, звук компьютера пишется | Тот же CI |
| Выключенный микрофон в предполётной проверке и автоматический ремонт по нажатию «Запись» | E2E в Chromium |
| Модуль записи не открывает микрофон → запись идёт через запасной канал | E2E в Chromium |
| Лестница `getUserMedia`, решения автопилота, проверки | Модульные тесты |

### Результат на настоящем Windows (CI, Windows Server 2025, VB-CABLE, тон 440 Гц амплитудой 0,3662)

| Шаг | Что вернул Windows |
|---|---|
| Диагноз | `CABLE Output`: активен, по умолчанию, `muted:false`, уровень 0,999999 |
| `repair {mute:true}` | `muted:true` |
| Запись 4 с с выключенным микрофоном | Пик **0,0**: Windows отдаёт цифровую тишину, ошибки нет. Без доктора это выглядело бы как «звук не пишется» |
| `repair {mute:false, minimumVolume:0.5}` | `muted:false` |
| Та же запись | Пик **0,3661**: тон записан полностью |

Так закрыт пробел исследования: выключенный в Windows вход действительно даёт тишину без ошибки. Поэтому нужны и чтение `GetMute`, и проверка уровня во время записи.

## 5. Чего нет и почему

- **Включение отключённого устройства** возможно только через недокументированный `IPolicyConfig`. Не используем: может сломаться с любым обновлением Windows.
- **Перезапуск службы Windows Audio** требует прав администратора. Не делаем молча.
- **Аппаратная кнопка mute гарнитуры**: распознаётся только по тишине, поэтому подсказка на экране — **НЕТ ДАННЫХ ДЛЯ НАДЁЖНОГО ВЫВОДА**, что Windows сообщает её через API.

## Источники

1. Microsoft — доступ приложений к микрофону: https://support.microsoft.com/en-US/Windows/privacy/turn-on-app-permissions-for-your-microphone-in-windows
2. Mozilla Bugzilla 1752163 (`E_ACCESSDENIED` при запрете): https://bugzilla.mozilla.org/show_bug.cgi?id=1752163
3. `IAudioEndpointVolume::GetMute`: https://learn.microsoft.com/en-us/windows/win32/api/endpointvolume/nf-endpointvolume-iaudioendpointvolume-getmute ; порядок методов сверен с пакетом pycaw (PyPI)
4. `DEVICE_STATE_XXX`: https://learn.microsoft.com/en-us/windows/win32/coreaudio/device-state-xxx-constants ; `EnumAudioEndpoints`: https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nf-mmdeviceapi-immdeviceenumerator-enumaudioendpoints
5. Recovering from an Invalid-Device Error: https://learn.microsoft.com/en-us/windows/win32/coreaudio/recovering-from-an-invalid-device-error
6. GStreamer — бесконечный цикл при пропаже устройства: https://gitlab.freedesktop.org/gstreamer/gst-plugins-bad/-/merge_requests/141
7. `IAudioClient::Initialize`: https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclient-initialize
8. Служба Windows Audio и права администратора (сторонние руководства, официального документа по коду нет): https://appuals.com/fix-audio-service-not-running
9. Bluetooth HFP/A2DP: https://support.steelseries.com/hc/en-us/articles/360057526291-Why-do-I-lose-Bluetooth-audio-when-taking-a-call ; https://techcommunity.microsoft.com/blog/windowsosplatform/cutting-the-wire-without-cutting-the-audio-quality/4447942
10. MDN `getUserMedia`: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
11. Twilio 31402: https://twilio.com/docs/api/errors/31402 ; SignalWire fallback: https://signalwire.com/docs/browser-sdk/reference/errors/overconstrained-fallback-error
12. Matthew van Eerde, «Draining the WASAPI capture buffer fully»: https://learn.microsoft.com/en-my/archive/blogs/matthew_van_eerde/draining-the-wasapi-capture-buffer-fully
13. Apple, Dealing with Errors: https://developer.apple.com/library/ios/documentation/cocoa/conceptual/ProgrammingWithObjectiveC/ErrorHandling/ErrorHandling.html
14. WWDC 2017 «Writing Great Alerts»: https://developer.apple.com/videos/play/wwdc2017/813
15. Паттерн супервизора с ограниченным бюджетом повторов (пример): https://docs.rs/jflow-core/0.1.0/jflow_core/supervisor/backoff/
