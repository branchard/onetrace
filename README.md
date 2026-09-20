# Onetrace

[![ci](https://github.com/branchard/onetrace/actions/workflows/ci.yaml/badge.svg)](https://github.com/branchard/onetrace/actions/workflows/ci.yaml)

[Uptrace](https://github.com/uptrace/uptrace) — with ClickHouse, PostgreSQL and Redis — packaged as a **single Docker image** for simple, self-contained deployments.

## What's inside

| Component | Role |
|---|---|
| [Uptrace](https://github.com/uptrace/uptrace) | Traces, logs and metrics UI/API (OTLP receiver) |
| [ClickHouse](https://github.com/ClickHouse/ClickHouse) | Telemetry storage |
| [PostgreSQL](https://www.postgresql.org/) | App metadata (users, projects, dashboards) |
| [Redis](https://github.com/redis/redis) | Caching |

All four run as sibling processes inside the same container, supervised by [`entrypoint.sh`](entrypoint.sh): 
PostgreSQL/ClickHouse/Redis start first, `uptrace` waits for them and runs its migrations, then serves traffic. 
If any process dies, the others are torn down with it.

Uptrace's configuration file is baked into the image — configure it through the environment variables below rather 
than editing it directly.

## Usage

### With Docker

```bash
docker run -d \
  -p 8080:14318 -p 8081:4317 \
  -e SECRET=change-me \
  -e ADMIN_EMAIL=admin@example.com \
  -e ADMIN_PASSWORD=change-me \
  -e ADMIN_TOKEN=change-me \
  -e ORG_NAME=MyOrg \
  -e PROJECT_NAME=MyProject \
  -e PROJECT_TOKEN=change-me \
  --mount type=bind,source="$(pwd)"/data,target=/volumes \
  ghcr.io/branchard/onetrace:latest
```

### With Docker Compose

```yaml
services:
  onetrace:
    image: ghcr.io/branchard/onetrace:latest
    ports:
      - "8080:14318" # Uptrace UI + OTLP/HTTP → http://localhost:8080
      - "8081:4317"  # OTLP/gRPC
    environment:
      SECRET: change-me-in-production
      SITE_URL: http://localhost:8080
      ADMIN_EMAIL: admin@uptrace.local
      ADMIN_PASSWORD: admin
      ADMIN_TOKEN: change-me-in-production
      ORG_NAME: MyOrg
      PROJECT_NAME: MyProject
      PROJECT_TOKEN: change-me-in-production
    volumes:
      - data:/volumes
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:14318/"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 60s

volumes:
  data:
```

## Configuration

### Ports

| Port | Purpose |
|---|---|
| 14318 | Web UI + OTLP/HTTP receiver |
| 4317 | OTLP/gRPC receiver |

### Environment variables

| Variable | Required | Default | Purpose |
|---|:---:|---|---|
| `SECRET` | ✅ | — | Secret used to sign JWTs |
| `ADMIN_EMAIL` | ✅ | — | Bootstrap admin user email |
| `ADMIN_PASSWORD` | ✅ | — | Bootstrap admin user password |
| `ADMIN_TOKEN` | ✅ | — | API token for the bootstrap admin user |
| `ORG_NAME` | ✅ | — | Bootstrap organization name |
| `PROJECT_NAME` | ✅ | — | Bootstrap project name |
| `PROJECT_TOKEN` | ✅ | — | DSN token used to send telemetry to the bootstrap project |
| `SITE_URL` | | `http://localhost:14318` | Public URL of the UI |
| `LOW_MEMORY` | | disabled | Set to `1` to trade some headroom for a smaller footprint — see [Resource usage](#resource-usage) |

### Data persistence

ClickHouse, PostgreSQL and Redis each write their data under `/volumes/clickhouse`, `/volumes/postgresql` and 
`/volumes/redis` respectively — `/var/lib/clickhouse`, `/var/lib/postgresql` and `/data` are just symlinks to those. 
You can mount either:

- **One combined volume** at `/volumes` — everything in a single mount:
  ```bash
  -v data:/volumes
  ```
- **Three separate volumes**, one per service, mounted directly at the legacy paths — Docker follows the symlink, so each still ends up under the matching `/volumes/*` subfolder:
  ```bash
  -v clickhouse-data:/var/lib/clickhouse -v postgres-data:/var/lib/postgresql -v redis-data:/data
  ```

Use three volumes if you want independent backup/retention per service; one is simpler otherwise.

### Resource usage

An idle container settles around **700 MiB**, almost all of it ClickHouse. Note
that a further ~525 MiB sits outside that figure: the mapped `clickhouse` binary
(~760 MiB on disk) shows up in the process's RSS, but those pages are file-backed
and the kernel reclaims them under pressure. The part that is actually charged to
the container is heap — mostly the cost of ~735 threads, since ClickHouse's
defaults (512 background-schedule threads, multi-GiB caches, 90% of host RAM as
its own budget) assume it owns the machine rather than sharing a container with
PostgreSQL, Redis and Uptrace.

Setting `LOW_MEMORY=1` applies a reduced-footprint profile
([`clickhouse-low-memory.xml`](clickhouse-low-memory.xml)). Measured on an idle
container with the demo telemetry flowing:

| | Default | `LOW_MEMORY=1` |
|---|---|---|
| Container (`docker stats`) | 715 MiB | **320 MiB** |
| ClickHouse heap (`RssAnon`) | 432 MiB | 121 MiB |
| ClickHouse threads | 735 | 106 |
| Uptrace (`VmRSS`) | 358 MiB | 213 MiB |
| ClickHouse log writes | ~360 MiB/day | ~5 MiB/day |

What you give up: queries over large time ranges may be slower with caches capped
in the hundreds of MiB instead of gigabytes, merges run on 4 threads instead of
16, `system.metric_log` / `trace_log` / `text_log` stop being written
(`query_log` and `part_log` are kept), and under a sustained ingestion burst
Uptrace drops telemetry rather than growing its buffers.

Without the flag the image behaves exactly like upstream ClickHouse; the profile
is only copied into `/etc/clickhouse-server/config.d/` when it is set. To tune it
yourself, bind mount your own file over
`/etc/clickhouse-server/config.d/low-memory.xml` and leave `LOW_MEMORY` unset —
with the flag on, the entrypoint would try to overwrite your mount.

## Image tags

Published to `ghcr.io/branchard/onetrace` on every change to `main` or on new Uptrace releases:

- `latest`
- `<uptrace-version>-<revision>` (e.g. `2.0.3-1`)
- `<uptrace-version>`, `<major.minor>`, `<major>` (e.g. `2.0.3`, `2.0`, `2`)

## Security considerations

- Do not publish PostgreSQL, ClickHouse or Redis ports. Their credentials are hardcoded.
- Redis has no authentication at all (`requirepass` is never set) — fine as long as its port stays unpublished.
- There's no TLS termination built in — put a reverse proxy in front if you expose the UI/OTLP endpoints beyond localhost.
