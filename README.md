# Onetrace

[![ci](https://github.com/branchard/onetrace/actions/workflows/ci.yml/badge.svg)](https://github.com/branchard/onetrace/actions/workflows/ci.yml)

[Uptrace](https://github.com/uptrace/uptrace) — with ClickHouse, PostgreSQL and Redis — packaged as a **single Docker image** for simple, self-contained deployments.

## What's inside

| Component | Role |
|---|---|
| [Uptrace](https://github.com/uptrace/uptrace) | Traces, logs and metrics UI/API (OTLP receiver) |
| [ClickHouse](https://github.com/ClickHouse/ClickHouse) | Telemetry storage |
| [PostgreSQL](https://www.postgresql.org/) | App metadata (users, projects, dashboards) |
| [Redis](https://github.com/redis/redis) | Caching |

All four run as sibling processes inside the same container, supervised by [`entrypoint.sh`](entrypoint.sh): PostgreSQL/ClickHouse/Redis start first, `uptrace` waits for them and runs its migrations, then serves traffic. If any process dies, the others are torn down with it.

PostgreSQL, ClickHouse and Redis are **internal only** — nothing but Uptrace's own ports are exposed.

Uptrace's configuration file is baked into the image — configure it through the environment variables below rather than editing it directly.

## Usage

### With Docker

```bash
docker run -d \
  -p 8080:14318 -p 8081:4317 \
  -e SECRET=change-me \
  -e ADMIN_EMAIL=admin@example.com \
  -e ADMIN_PASSWORD=change-me \
  -e ORG_NAME=MyOrg \
  -e PROJECT_NAME=MyProject \
  -v onetrace-clickhouse:/var/lib/clickhouse \
  -v onetrace-postgres:/var/lib/postgresql \
  -v onetrace-redis:/data \
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
      - clickhouse-data:/var/lib/clickhouse
      - postgres-data:/var/lib/postgresql
      - redis-data:/data
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:14318/"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 60s

volumes:
  clickhouse-data:
  postgres-data:
  redis-data:
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
| `ORG_NAME` | ✅ | — | Bootstrap organization name |
| `PROJECT_NAME` | ✅ | — | Bootstrap project name |
| `SITE_URL` | | `http://localhost:14318` | Public URL of the UI |

PostgreSQL/ClickHouse credentials (`POSTGRES_*` / `CLICKHOUSE_*` env vars, all default to `uptrace`) are internal to the container and hardcoded as such in the `uptrace.yml`.

Data is persisted through three volumes: `/var/lib/clickhouse`, `/var/lib/postgresql`, `/data` (Redis).

## Image tags

Published to `ghcr.io/branchard/onetrace` on every change to `main` or on new Uptrace releases:

- `latest`
- `<uptrace-version>-<revision>` (e.g. `2.0.3-1`)
- `<uptrace-version>`, `<major.minor>`, `<major>` (e.g. `2.0.3`, `2.0`, `2`)
