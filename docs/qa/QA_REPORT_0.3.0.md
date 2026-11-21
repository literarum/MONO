# MONO TRANSCRIBE 0.3.0 — трёхпроходный инженерный аудит

**Дата:** 2026-10-16.  
**База:** исходники MONO TRANSCRIBE 0.2.0 из предоставленного ZIP.  
**Цель:** UX/backend hardening + полный воспроизводимый DevOps-контур для одноузлового персонального развёртывания.

**Важно:** реализация конфигурации развёртывания ≠ выполненный публичный деплой. В этой среде нет `docker`/`caddy`, домена, внешнего сервера, сертификатов или реального Groq API. Все неиспытанные требования ниже явно обозначены.

## A. Критерии приёмки

| Критерий | Результат |
|---|---|
| Оригинальная SPA/PWA v0.2.0 сохранена, без переписывания фреймворка | PASS, только прицельные изменения |
| Локальный bind невозможен на 0.0.0.0 по умолчанию | PASS, тест |
| Удалённый режим не доступен без TLS Origin/secret | PASS, тест Node HTTP |
| Секрет Groq не попадает в браузер/исходники | PASS при статическом анализе; реальные внешние следы НЕ ПРОВЕРЕНЫ |
| Health/ready/metrics, завершение SIGTERM, восстановление тестовой задачи | PASS, тест Node |
| Docker/Compose/Caddy/CI/backup/restore поставляются с приложением | PASS, файлы и проверка синтаксиса; runtime НЕ ПРОВЕРЕН |
| 390px/1366px не вызывают horizontal scroll | PASS на статическом браузерном рендере |
| Browser→Node→Caddy→Groq, PWA install, запись 4 часа | НЕ ПРОВЕРЕНО |

## B. Реестр конкретных проблем и действий (>=20)

Все выводы основаны на коде версии 0.2.0 или прямых требованиях модели деплоя. `PATCHED` означает внесённый код/конфигурацию, **не** гарантию всего жизненного цикла на реальном сервере.

| № | Severity | Выявленная проблема в 0.2.0 | Изменение в 0.3.0 | Проверка |
|---:|---|---|---|---|
| 01 | Critical | Только loopback, безопасного пути к HTTPS-развёртыванию нет | Явный `MONO_DEPLOY_MODE=proxy` при сохранённом local default | Node HTTP |
| 02 | Critical | Нет аутентификации внешнего пользователя | Caddy `basic_auth` для всего сайта/API | Конфигурация; runtime НЕ ПРОВЕРЕН |
| 03 | High | Нет защиты от подключения к upstream напрямую при ошибке публикации порта | 32+ символьный `X-Mono-Proxy-Secret` и constant-time comparison | Node HTTP |
| 04 | High | Внешний сервер не проверяет ожидаемый публичный Host | Точная проверка `MONO_PUBLIC_ORIGIN.host` | Node HTTP |
| 05 | High | Cross-origin запросы из чужого сайта могли бы использовать авторизованную сессию | Строгая проверка `Origin` в proxy режиме | Node HTTP |
| 06 | Critical | Отсутствует TLS termination | Caddy HTTPS/ACME, Node только в backend Docker network | Конфигурация; runtime НЕ ПРОВЕРЕН |
| 07 | Medium | Авторизационный Basic-заголовок мог бы дойти до Node | `header_up -Authorization` | Конфигурация |
| 08 | High | Секрет Groq только в ENV процесса | `GROQ_API_KEY_FILE`, Docker secrets, без браузерной передачи | Тест файловых секретов |
| 09 | High | Нет проверки конфигурации публичного запуска | Fail-closed проверка HTTPS origin, длины секрета, режима, ключа | Node tests |
| 10 | Medium | Некорректный PORT приводил бы к неясной ошибке bind | Валидация integer 1..65535 | Code review |
| 11 | High | Некорректная/NaN квота файла обходила ожидаемые лимиты | Валидация MAX_BYTES и верхняя граница 2GiB | Node test |
| 12 | High | Загрузка большого файла могла занимать весь диск без preflight | `statfs` и резерв >=256MiB + размер заявленного файла | Code + integration |
| 13 | High | После ошибки сохранения задания оставался orphaned файл / запись в памяти | Cleanup audio/job если commit не завершился | Code review |
| 14 | Medium | Некорректное percent-encoding URL могло дать 500 | 400 на некорректный URL | Node test |
| 15 | High | Отдача статики не обрабатывала stream error после `stat` | Error handler статического read stream | Code review |
| 16 | High | Не было корректного shutdown для заданий и JSON-файлов | SIGTERM/SIGINT drain, остановка FFmpeg/Groq, re-queue вместо permanently failed | Node SIGTERM + review |
| 17 | Medium | Завершение работы между Groq и cache сохраняло некорректное terminal-состояние | Повторная проверка `stopping/cancelRequested` перед commit | Code review |
| 18 | High | Server-side результаты могли храниться без ограничения без ACK | TTL 24–720ч, default 168ч, periodic reaper | Code review; expiry временем НЕ ПРОВЕРЕН |
| 19 | Medium | Утерянное job после сервера навсегда оставалось в ожидании | При 404 локальная запись переходит в диагностируемый failed | Code review |
| 20 | High | Русский prompt в HTTP-заголовке не кодировался | `encodeURIComponent` в браузере и `decodeURIComponent` на Node | FFmpeg + Groq stub with Cyrillic |
| 21 | Medium | Незавершённая ошибка IndexedDB openDB кешировалась навсегда | Reset rejected connection promise | Code review; browser IDB НЕ ПРОВЕРЕН |
| 22 | Medium | IndexedDB connection не закрывался при versionchange | `onversionchange` закрывает DB | Code review |
| 23 | High | При потере среднего чанка сборка Blob могла выдавать повреждённое аудио | Проверка непрерывности index и chunkCount | Code review; IndexedDB scenario НЕ ПРОВЕРЕН |
| 24 | Medium | Settings показывали только FFmpeg/Groq, а не состояние очереди | Очередь, активные job, upload count, deployment mode | Static UI |
| 25 | Medium | UI-лейбл «Локальное хранение» не раскрывал внешний HTTPS backend | Явная метка HTTPS/облачная обработка | Static UI |
| 26 | Low | Health в UI проверялся только по действию/старту | Refresh раз в 30с и при возвращении во вкладку | Code review |
| 27 | Low | Фоновая вкладка опрашивала сервер каждые 3.5с | Polling suspended while hidden, resume on visibility | Code review |
| 28 | High | Нет воспроизводимой среды Node/FFmpeg | `Dockerfile`, закреплённый major Node, pinned Caddy minor | Syntax/static only |
| 29 | High | При первом контейнерном запуске процесс мог бы иметь привилегии root | Node USER 10001, read_only, cap_drop, no-new-privileges | Compose static |
| 30 | High | Backend port мог бы быть опубликован напрямую | Docker `expose`, internal network only; public 80/443 only at Caddy | Compose static |
| 31 | High | Нет CI-входного контроля | GitHub Actions check/test/bash/compose/build | YAML parse; remote CI NOT RUN |
| 32 | High | Нет воспроизводимого cold backup серверных заданий | Backup script, checksum, app stop | Shell syntax; Docker NOT RUN |
| 33 | High | Восстановление могло стереть продакшен без подтверждения | Restore requires `CONFIRM_RESTORE=YES` and verified SHA256 | Shell syntax |
| 34 | Medium | Нет отдельной readiness-семантики | `/api/ready` 200/503 по FFmpeg/Groq/stop | Node HTTP |
| 35 | Medium | Нет операционных счётчиков без содержимого разговоров | `/api/metrics` counters/queue | Node HTTP |
| 36 | Medium | Логи могли бы скрыть статус API-ошибок | Структурированные события без raw job URL, transcript и prompt | Code review |
| 37 | Medium | Не существовало политики допустимого времени хранения | Job retention настройка + runbook | Code review |
| 38 | High | Нет runbook по secret rotation, rollback, DNS, мониторингу, consent | `ops/DEPLOY.md` + ограничения, backup, rollback | Documentation review |
| 39 | Low | Старый PWA cache мог обслуживать предыдущий JS/CSS | Service worker cache name `mono-shell-v6` | Static check |
| 40 | High | Docker-only backup мог ложно считаться пользовательским backup | Документирована граница IndexedDB и необходимость экспорта из браузера | Documentation review |

## Проход 1 — Specification + source-level audit

Изучены `server.mjs`, `core.mjs`, `public/app.js`, `public/db.js`, `public/sw.js`, `public/index.html`, стили, интеграционные тесты и текущая документация. Приоритет был у потери аудио, уязвимостей при публикации, ошибок retry/backup. Подход: сохранять архитектуру без лишних зависимостей; прокси вместо самостоятельно реализованного TLS/авторизации в Node.

Вывод: публичный сервис без защиты недопустим; UI/browser IndexedDB остаётся single-device storage, сервер содержит только jobs/transient uploads.

## Проход 2 — deterministic/HTTP verification

Реально выполнялось в предоставленной среде (Node 22, FFmpeg):
- `npm run check` — синтаксис Node сервера, SPA, DB, SW, healthcheck.
- `npm test` — **11/11** пройдены.
- FFmpeg WAV→FLAC, Groq HTTP stub (429, backoff, ответ кириллицей), идемпотентный task key, ACK server cleanup, overflow 413.
- Restart с cached сегментом без второго запроса, status/jobs через real HTTP.
- Proxy mode: wrong Host, wrong Origin, missing/mismatched proxy secret → 403; успешный доступ к HTML/API с секретом; `/api/ready` и `/api/metrics`; SIGTERM 0, и отдельный контейнерный Node healthcheck с file-based secrets.
- Проверка невалидной конфигурации завершается отказом запуска.
- `bash -n` для backup/restore; `yaml.safe_load` для Compose YAML.

**Не выполнялось:** `docker compose config`, `docker build`, Caddyfile parse, live TLS/ACME, GitHub-hosted Actions pipeline — нет установленного Docker/Caddy и внешних доступов.

## Проход 3 — UX / adversarial / product

- Статические скриншоты собраны из **реальных HTML/CSS**, без app.js/live IndexedDB: dashboard 1366, mobile 390, settings 1366.
- Проверена геометрия `documentElement.scrollWidth === clientWidth` для всех трёх состояний.
- Запуск настоящей SPA через Playwright по `http://127.0.0.1` отклонён средой `ERR_BLOCKED_BY_ADMINISTRATOR`. Следовательно, полноценное browser E2E **НЕ ПРОВЕРЕНО**.
- Adversarial: ошибочная публикация app port ⇒ proxy-secret gate; старый browser без ACK ⇒ TTL; SIGTERM во время ffmpeg/Groq ⇒ queued retry; missing chunks ⇒ блокировка испорченного экспорта.
- Важно: Docker backup ≠ IndexedDB backup; BASIC auth ≠ multi-tenant authorization; Caddy HTTPS config ≠ действующий сертификат.

## D. SELF-CRITIC

**6.9/10 (прототип DevOps-развёртывания, не production acceptance).** Нет независимого отдельного агента/доступного Docker runtime; оценка проведена вручную по фактическим тестам.

| Severity | Остаточный риск / blocker |
|---|---|
| Critical | Внешний HTTPS-деплой на реальном DNS с Caddy + секретами **не выполнен** |
| High | Реальный браузерный E2E, установка PWA, микрофон и 4-часовое сохранение **не проверены** |
| High | Приложение не multi-tenant: один доверенный пользователь/ключ Basic auth, нет MFA/OIDC/RBAC |
| High | Записи живут в клиентском IndexedDB; централизованного резервирования пользовательской библиотеки нет |
| Medium | TTL и cold restore нужно испытать с реальной перезагрузкой VM/контейнера |
| Medium | Нет SLO измерений/оповещений/off-site encrypted backup/пентеста |
| Medium | Rate limits Groq, WER русского ASR и длительность транскрибации не измерены на реальном ключе |

**H1:** Node доступен в локальном и защищённом proxy тестовом режиме; приложение способно запускать тестовый FFmpeg/Groq конвейер.
**H2:** для первого публичного экземпляра нужны DNS/HTTPS и закрытая сеть; Basic auth защищает один аккаунт; серверный диск/CPU — узкое место.
**H3:** масштабирование на 2+ Node инстанса потребует общей очереди, дедупликации, базы статусов и object storage, прежде чем горизонтально масштабировать прокси.

## Использованные внешние официальные справки

- Caddy basic_auth: https://caddyserver.com/docs/caddyfile/directives/basic_auth
- Caddy reverse_proxy: https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- Caddy environment placeholders: https://caddyserver.com/docs/caddyfile/concepts
- Docker Compose services: https://docs.docker.com/reference/compose-file/services/
- Docker Compose secrets: https://docs.docker.com/compose/how-tos/use-secrets

**Первоисточник для результата проверки — код и реально запущенные тесты**, а не текст документации.
