# MONO TRANSCRIBE 0.3.0 — DevOps runbook

## Scope and honest security model

**Supported deployment**: one operator, one Linux VM, one public HTTPS domain, Docker Compose + Caddy + Node/FFmpeg. **NOT** multi-tenant SaaS. Multiple browsers/users accessing the same instance do not get separate server tenants or isolated jobs. Basic authentication is intended for a single trusted operator; do not share credentials.

The application stores **recordings and transcripts in the browser's IndexedDB**. The server temporarily stores uploaded audio, segment results, and job status on `/data`. Docker backups **do not back up the IndexedDB library**; users must export original audio and transcripts from each browser separately. Browser storage may be evicted. Never interpret the container volume as a full user-data backup.

The Node port is not published to the host; Caddy is the only public network entry point. Caddy handles HTTPS + Basic auth, and forwards a secret header to Node; Node validates secret, Host, and Origin. Basic auth over HTTPS is not an enterprise identity provider: no MFA, SSO, individual accounts, authorization roles, abuse detection, or audit trails by account.

## Prerequisites

- Linux VPS/VM with Docker Engine and Compose plugin, DNS A/AAAA pointing to the VM.
- Inbound TCP 80 and 443 for certificate issuance and HTTPS, UDP 443 optional; SSH limited to administrator IPs.
- Outbound HTTPS to Groq, public DNS, valid domain and ACME email.
- Budget for disk, upload traffic, memory and backup storage; test live with representative long audio.
- Docker version that supports Compose `secrets`, `healthcheck`, `cpus`, `mem_limit`, `read_only`.
- The actual Groq API key. Do **not** put it in `.env`, images, source code, logs or shell history.

## Setup

```bash
cp .env.example .env
mkdir -m 700 -p secrets backups
umask 077
# From a secret manager / interactive terminal, place only the raw key in this file.
# Example shell interactive method (no key in shell history):
read -rsp 'Groq API key: ' KEY; printf '%s' "$KEY" > secrets/groq_api_key; unset KEY; echo
openssl rand -hex 32 > secrets/mono_proxy_secret
chmod 600 secrets/*
docker run --rm caddy:2.10-alpine caddy hash-password
```

Edit `.env`: `MONO_DOMAIN` must be your real DNS name, `ACME_EMAIL` must be reachable, and `MONO_BASIC_HASH` must contain the **hash** printed by Caddy, enclosed in single quotes in `.env`. Choose a unique user and a strong password; store it in a password manager. Don't use placeholder hashes. Update `MONO_MAX_UPLOAD_BYTES` and `MONO_JOB_TTL_HOURS` if needed (allowed retention: 24–720 hours).

```bash
docker compose config --quiet
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs --tail=60 app caddy
```

Navigate to `https://<your-domain>`, sign in using HTTP Basic auth. Test PWA installation from HTTPS and a non-sensitive 10-second audio file **after** confirming Groq costs and participant consent. Do not send confidential recordings as first test.

If ACME fails, check DNS, ports 80/443 and Caddy logs. Do not expose Node `4173` to work around HTTPS issues.

## Monitoring

Health endpoints are protected like everything else:
- `GET /api/health` — availability, capabilities, queued/processing jobs, uptime, storage settings; 200 does not prove readiness.
- `GET /api/ready` — 200 if FFmpeg/FFprobe/key present and not draining, 503 otherwise.
- `GET /api/metrics` — counters since process start (`requests`, 5xx errors, completed/failed, overload rejections, queue depth).

Container checks call `/api/ready` internally using the proxy secret. Docker Compose restarts failed processes, **but a failing healthcheck alone does not necessarily cause automatic restart** (Docker behavior). Use monitoring/alerts or an external uptime probe for production.
Structured API logs include method, generalized route, status, duration. Avoid logging raw URLs or transcription content. Protect Docker log access (administrators only); configure logging rotation at daemon level.

Suggested operator alerts: readiness down >2 minutes, persistent queued tasks, server disk <20% free, elevated failed jobs, certificate renewal errors, backup age >24 hours. Thresholds are operational proposals, not measured SLOs.

## Backup and restore

```bash
bash scripts/backup.sh
# creates backups/mono-data-<timestamp>.tar.gz and SHA-256
CONFIRM_RESTORE=YES bash scripts/restore.sh backups/mono-data-<timestamp>.tar.gz
```

Backup briefly **stops the app writer** and restarts it, giving a cold consistent copy of `/data`. Run during an idle window; active Groq requests may be interrupted and later retried, possibly incurring a second charge. Restoring **overwrites** the named data volume and requires explicit confirmation. Store backups encrypted off-host with restricted access, and routinely test restoration on a non-production machine. Because backup contains potentially confidential audio/transcripts, never commit or share it.

Server auto-deletes completed server-side audio as soon as processing ends; persisted job/results are removed on acknowledgment from browser. Failed/cancelled/unacknowledged jobs are purged after configured retention. This is **not** a guarantee that Groq provider logs follow the same retention; consult Groq privacy terms.

## Release and rollback

Before upgrade: backup; note current git commit/image digest; run `npm test`; build new image; run `docker compose up -d --build`; check readiness and a non-sensitive smoke scenario. Keep the previous image/tag available for rollback.

For rollback, restore previous image or commit with `docker compose up -d --build`; if on-disk schema changes are introduced in a future release, test backward compatibility or restore a matching backup. Current version stores JSON job files and browser IndexedDB separately: restoring server files does not revert client IndexedDB.

To limit blast radius, start with one operator's test audio. Do not scale `app` to multiple replicas: worker queue/jobs and JSON file persistence assume a **single Node process**. For horizontal scaling first migrate queues to a shared durable store and enforce distributed deduplication.

## Known limitations / NOT VERIFIED

- No Docker binary was available in the authoring/test environment; live Compose/Caddy/certificate run is **NOT VERIFIED** here.
- Browser-to-localhost Chromium navigation was restricted in the test environment; complete PWA browser E2E is **NOT VERIFIED**.
- No external VPS, DNS, production credentials, Groq account, and 4-hour audio verification were available.
- No automated cloud off-site backup, backup encryption, SIEM, intrusion detection, performance SLO or failover.
- Audio upload and transcription use server resources; 1 GiB maximum upload, 2 concurrent uploads and one serial worker, so capacity planning remains workload-specific.
- Caddy HTTP Basic auth alone does not provide strong protection against credential stuffing. Use strong credentials, network allowlist/VPN where possible, and configure dedicated auth-failure monitoring with URL redaction (not included by default).

## Capacity model (estimates)

For a 4-hour recording segmented in 4-minute non-overlapping ownership windows with 0.8s overlap on each side, expect **60 jobs sent to Groq**. Approximately 94.4 seconds of overlap leads to ~4.0262 billed audio hours before retries (assuming per-request 10s minimum does not apply because segments exceed it). At $0.04/hour => ~$0.16105. Each additional retry may be charged again; estimated cost is not the actual invoice.

A 4-hour, 48 kHz, mono 16-bit **uncompressed** PCM recording is `4*3600*48000*2 ≈ 1.3824 GB` (decimal), above the default 1 GiB upload limit. Browser `MediaRecorder` commonly uses compression, but exact rates depend on browser and source. Monitor disk/IndexedDB capacity and export originals often.
