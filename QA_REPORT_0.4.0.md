# MONO TRANSCRIBE 0.4.0 — THREE-PASS QUALITY & RELEASE GATE

**Дата:** 2026-10-16  
**Основа:** 0.3.0 SPA/PWA (Node HTTP, IndexedDB, FFmpeg, Groq adapter).  
**Изменение:** self-hosted one-click Python launcher, native packaging, persistent shell,
portable workspace import/export.

## Outcome contract

Определение успеха: пользователь открывает `.exe` / `.app` двойным кликом без терминала;
вместе стартует строго локальный backend и PWA в самостоятельном окне. Библиотека и
серверные задания переживают перезапуск; повторное открытие не запускает копию
backend; в готовом пакете Python/Node/FFmpeg поставляются в комплекте; выход
закрывает дочерний процесс; ключ не появляется в JavaScript.

Не заявлять готовность дистрибутива до проверки на целевых ОС, подписи
приложения и реальные четырёхчасовые тесты.

## Проверки: три прохода

### Pass 1 — source, correctness, architecture

- Проанализированы `server.mjs`, `core.mjs`, `public/app.js`, `public/db.js`,
  `public/sw.js`, PWA manifest, Docker/CI и существующие тесты.
- Сохранён устойчивый origin `http://127.0.0.1:4173` — без этого IndexedDB
  появляется пустой при смене порта.
- Лаунчер не использует системные рантаймы в готовой сборке; разделены source `--dev`
  и bundle execution.
- Backend принудительно ограничен loopback; Node injection через `NODE_OPTIONS` /
  `NODE_PATH` отключён; выбранный конечный адрес Groq не наследуется в production.
- Backend получает канал stdin от лаунчера и завершает работу при EOF.

### Pass 2 — subprocess & fault injection

- Проверен старт Node из Python supervisor с HTTP `/api/health`; код 0.
- Сформирован staging-комплект **с отдельными** `runtime/bin/node`,
  `runtime/bin/ffmpeg`, `runtime/bin/ffprobe`, пройдена проверка SHA-256.
- `mono.run(dev=False, smoke=True)` реально запускал скопированный Node без
  `PATH` fallback; пройдено.
- Принудительный `SIGKILL` Python launcher → EOF stdin → backend освободил порт.
- OS file lock не позволяет открыть второй backend; локальный клиент
  сверяет `instanceId`, а не просто совпадение занятого порта.
- Старый серверный интеграционный тест FFmpeg → имитация Groq → 429 → результат →
  ACK cleanup и recovery продолжает проходить.
- Синтаксис Node и Python компилируется без ошибок.
- Сломанные/изменённые runtime файлы отклоняются.

### Pass 3 — visual, portability and adversarial review

- Chromium фактически отрендерил статические HTML/CSS для 1440px и 390px,
  экрана Studio и Settings/light. Во всех четырёх случаях `scrollWidth <= innerWidth`.
- Временная блокировка сетевого перехода Chromium к localhost и test hostname:
  **НЕ ПРОВЕРЕНО** реальное взаимодействие browser→backend; визуальные скриншоты
  являются **static render**, не browser E2E.
- Добавлены функции backup/export c File System Access API, streaming chunks;
  манифест создаётся последним, импорт создаёт новые IDs и удаляет backend job
  references. Pure JS validation проверена Node-тестами.
- Парсинг типов и опасных путей в `manifest.json` проверен на фиктивных данных;
  восстановление многогигабайтной реальной библиотеки **НЕ ПРОВЕРЕНО**.

## Реестр проблем/рисков (минимум 20)

`FIXED` = исправлено кодом, тестом или явным инвариантом;
`PARTIAL` = есть mitigation, но целевая ОС/E2E не проверены;
`OPEN` = останется в release gate, не выдаётся за готовый production.

| № | Priority | Дефект / риск предыдущей архитектуры | Решение / статус |
|---|---|---|---|
| 01 | P0 | Новый случайный порт «теряет» видимость IndexedDB | FIXED: стабильный порт 4173 |
| 02 | P0 | Порт мог занять чужой HTTP процесс | FIXED: startup event собственного child + случайный instanceId |
| 03 | P0 | После падения лаунчера backend продолжал работать бесконтрольно | FIXED: parent stdin EOF shutdown; SIGKILL regression |
| 04 | P0 | Двойной клик мог создать две конкурирующие очереди | FIXED: OS exclusive file lock |
| 05 | P0 | Переключение WebView↔Chromium делает видимой другую библиотеку | FIXED: закрепление ui-engine.json, без silent fallback |
| 06 | P0 | Встраивание произвольного системного Node разрушает воспроизводимость | FIXED: в bundle sidecar строгий путь; dev явно opt-in |
| 07 | P0 | Отсутствующий FFmpeg ломает долгие задания | FIXED: FFmpeg+FFprobe включены в staging и checksum manifest |
| 08 | P0 | Port bind на 0.0.0.0 открывает персональные записи в LAN | FIXED: forced `MONO_DEPLOY_MODE=local`, `127.0.0.1` |
| 09 | P0 | `NODE_OPTIONS` мог подгрузить произвольный JS перед backend | FIXED: очищается env |
| 10 | P0 | Внешнее `MONO_GROQ_ENDPOINT` могло изменить destination для приватного аудио | FIXED: игнорируется вне `--dev` |
| 11 | P1 | Лаунчер открывает окно до ready, пользователь видит ошибку сети | FIXED: JSON listening event + активный health |
| 12 | P1 | Сервер при закрытии окна не останавливается | FIXED: lifecycle в `finally`, timeout и kill fallback |
| 13 | P1 | Процесс завис при ошибке и не показал никакого сообщения | FIXED: GUI error on Windows/macOS, rotating local logs |
| 14 | P1 | Распаковка в read-only папку исключает записи | FIXED: данные отдельно в user-data, portable marker optional |
| 15 | P1 | Сборку легко изменить или повредить незаметно | FIXED: runtime и app asset sizes + SHA-256 check при старте |
| 16 | P1 | Во время аварии рабочего процесса была рискована потеря cached progress | FIXED: сохраняется queue state из 0.3 + restart |
| 17 | P1 | Не было экспорта исходников аудио вместе с правками | PARTIAL: folder backup/export реализован для Chromium |
| 18 | P1 | Экспорт 4-часового файла через `getAll()` создавал RAM pressure | FIXED: `streamRecordingAudio()` по chunk индексам |
| 19 | P1 | Восстановленный `jobId` мог привязать новую запись к старому серверу | FIXED: очищаются transient поля и задаётся новый UUID |
| 20 | P1 | Импорт с тем же ID мог затереть существующий транскрипт | FIXED: новые UUID для каждой импортированной записи |
| 21 | P1 | Подмена пути файла в backup manifest | FIXED: строгая проверка GUID/extension/path, Node regression |
| 22 | P1 | Частичная резервная копия выдавалась бы за успешную | FIXED: manifest записывается последним |
| 23 | P1 | Падение записи из-за модуля UI и сервера | PARTIAL: backend и рендер независимы, реальная запись не испытана |
| 24 | P1 | Не было механизма native GUI без вкладки и адресной строки | PARTIAL: Chromium app mode / pywebview; Windows/macOS runtime pending |
| 25 | P2 | Браузерное резервное копирование не работало бы на некоторых WebView | OPEN: File System Access не универсален |
| 26 | P2 | Смена компьютерной ОС не переносит webview local profile корректно | PARTIAL: экспорт/импорт; profile raw перенос запрещён |
| 27 | P2 | Generic PyInstaller icon снижает доверие/визуальное качество | FIXED: собственные ICO/ICNS |
| 28 | P0 | Unsigned macOS `.app` блокируется Gatekeeper | OPEN: нужны Apple Developer ID, signing + notarization |
| 29 | P1 | Unsigned Windows `.exe` может показывать SmartScreen | OPEN: нужен Authenticode signing |
| 30 | P1 | FFmpeg macOS/Homebrew exe может зависеть от отсутствующих dylib | PARTIAL: checksum-verified standalone build in CI; runtime не испытан |
| 31 | P1 | Auto-install PWA браузером не поддерживается как гарантированный механизм | FIXED BY DESIGN: собственное app window, без скрытой установки |
| 32 | P1 | Пользователь может думать, что Groq работает вообще без ключа | FIXED IN DOCS: offline-first, ключ для cloud отдельно |
| 33 | P1 | Отсутствие теста реальной записи 4h может скрывать потерю данных | OPEN: hardware endurance test |
| 34 | P1 | Реальная Groq/transcription не проверена | OPEN: не выполнять платный запрос без ключа |
| 35 | P1 | Десктопное окно Chromium → local Node полностью не прошло E2E | OPEN: административный блок браузерных переходов |
| 36 | P2 | Непрозрачное происхождение FFmpeg binary в дистрибутиве | PARTIAL: SHA release + PROVENANCE; tag следует pin до release |

Примечание к №16: тесты recovery — из предыдущей версии. Версия 0.4 не
переписывает очередь, лишь делает её жизненный цикл управляемым лаунчером.

## Measured tests

- `npm run check`: PASS
- `npm test`: **14 / 14 PASS** (Node unit + integration stub)
- `python -m unittest discover -s launcher/tests -q`: **17 / 17 PASS**
- `python -m compileall -q launcher`: PASS
- Подготовка runtime staging с Node, FFmpeg, FFprobe: PASS
- `SIGKILL` parent test: PASS
- 4 static screenshots Chromium: PASS (0 horizontal overflow)
- Real PyInstaller Windows/macOS binary: **NOT BUILT**
- Container Docker, notarization, signing, production Groq: **NOT TESTED**

Замечание по среде: при запуске дочернего Python в тестовом окружении печаталось
сообщение о неудачной warmup чужого spreadsheet runtime. Exit codes тестов были 0;
это не связано с runtime приложения.

## Four-audit gate

**A. SPEC:** Direct, offline self-hosted launch и восстановление процессов поддержаны.
Полное «без пользовательских действий в абсолютно любой ОС» невозможно обещать
без OS permissions, исправных embedded runtimes и подписанных бинарников.

**B. EVIDENCE:** Код и тесты реальны; UI Chromium отрендерен статически. Build
на реальных Windows/macOS не выполнен. SHA-256 — контроль целостности, не
подпись производителя.

**C. ADVERSARIAL:** Первый критичный риск при переносе — profile storage/origin.
Он локализован pinning + backup, но mac WebView backup может быть недоступен.
Следующий — 4h запись с нехваткой места и browser shutdown. Такой тест в release gate.
Supply chain требует pinned FFmpeg и подписей.

**D. SELF-CRITIC (не независимый агент): 7.2 / 10.** Причины:
1. [P0] Не протестированы и не подписаны нативные Windows/macOS сборки.
2. [P1] Нужны 4h tests и physical audio device coverage.
3. [P1] Пропущен full browser→backend E2E из-за test-environment policy.
4. [P1] File System Access backup не универсален для WebView.
5. [P1] Долгоживущие фоновые обработки возобновляются после повторного запуска,
   но не продолжаются после закрытия окна в текущем дизайне.

Score ограничен невыполненными critical acceptance tests. Готовый commercial product
пока не заявляется.

## Следующие проверяемые milestones

1. CI build Windows/macOS на каждой архитектуре → VM clean boot → first-launch
   без Node/Python/FFmpeg → mic capture → export/import.
2. macOS notarize, Windows sign → проверка Gatekeeper/SmartScreen.
3. Endurance 4h + kill process at random intervals → compare audio segments/checksums.
4. Real Groq golden Russian corpus → word error rate + overlap/join audit.
5. Portable external SSD, move folder between OS user accounts → documented restore.
