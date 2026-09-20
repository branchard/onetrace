#!/usr/bin/env bash
set -Eeo pipefail

UPTRACE="/uptrace --config=/etc/uptrace/uptrace.yaml"
uptrace_pid=""

# Prefixes a service's combined stdout/stderr with a tag, without changing its
# PID: `> >(...)` redirects output through the tagger as a side process, so
# "$!" right after still refers to the service itself (a plain `| awk ...`
# pipe would make "$!" refer to awk instead, breaking kill/wait below).
tag() {
	awk -v tag="$1" '{ print tag " " $0; fflush() }'
}

report_crash() {
	for entry in "ClickHouse:$ch_pid" "Postgres:$pg_pid" "Redis:$redis_pid" "Uptrace:$uptrace_pid"; do
		name="${entry%%:*}"
		pid="${entry#*:}"
		kill -0 "$pid" 2>/dev/null || echo "[$name] exited unexpectedly, shutting down the rest." >&2
	done
}

terminate() {
	trap - TERM INT
	kill -TERM "$ch_pid" "$redis_pid" "$uptrace_pid" 2>/dev/null || true
	kill -INT "$pg_pid" 2>/dev/null || true
	wait "$ch_pid" "$pg_pid" "$redis_pid" "$uptrace_pid" 2>/dev/null || true
}
trap 'terminate; exit 0' TERM INT

# A named Docker volume gets these subdirectories (with their ownership) from
# the image automatically on its first mount, but a plain bind mount to an
# empty host directory does not — recreate them every start so /volumes works
# as a single mount point either way.
mkdir -p /volumes/clickhouse /volumes/postgresql /volumes/redis
chown clickhouse:clickhouse /volumes/clickhouse
chown postgres:postgres /volumes/postgresql
chown redis:redis /volumes/redis

# Optional low-memory profile, on top of the corrections that always apply (see
# clickhouse-tuning.xml, baked in as config.d/10-onetrace.xml). Unlike those,
# every setting it carries is a real trade-off: smaller caches, less merge
# headroom, a tighter memory budget and bounded ingestion buffers. Off by default
# so capacity is never silently reduced. See clickhouse-low-memory.xml.
ch_low_memory_config=/etc/clickhouse-server/config.d/20-low-memory.xml
ch_malloc_conf=""
case "${LOW_MEMORY:-}" in
	1 | [Tt][Rr][Uu][Ee])
		cp /usr/share/onetrace/clickhouse-low-memory.xml "$ch_low_memory_config"
		# jemalloc defaults to 4 x ncpu arenas, each retaining its own dirty
		# pages (~60 MiB of them measured on 12 cores).
		ch_malloc_conf="narenas:2,dirty_decay_ms:5000,muzzy_decay_ms:0"
		# Read by uptrace.yaml, which falls back to Uptrace's own defaults.
		export UPTRACE_MAX_BUFFERED_RECORDS=20e3
		export UPTRACE_MAX_CUMULATIVE_TIMESERIES=100e3
		export UPTRACE_QUERY_LIMIT=50000
		export UPTRACE_MAX_QUERY_MEMORY=100000000
		export UPTRACE_SELF_MONITORING_DISABLED=true
		echo "[onetrace] LOW_MEMORY is set: using the reduced-footprint profile."
		;;
	*)
		# The container filesystem survives `docker restart`, so a profile
		# enabled on an earlier start must not linger once LOW_MEMORY is unset.
		rm -f "$ch_low_memory_config"
		;;
esac

# ClickHouse's entrypoint only runs its init/bootstrap logic when called with no
# arguments (any argument makes it exec that argument directly instead). See
# https://github.com/ClickHouse/docker-library
# MALLOC_CONF is set as a prefix rather than exported so it reaches jemalloc (a
# ClickHouse-only dependency) and nothing else; an empty value is a no-op.
MALLOC_CONF="$ch_malloc_conf" /clickhouse-entrypoint.sh > >(tag "[ClickHouse]") 2>&1 &
ch_pid=$!

/usr/local/bin/postgres-entrypoint.sh postgres > >(tag "[Postgres]") 2>&1 &
pg_pid=$!

/usr/local/bin/redis-entrypoint.sh redis-server > >(tag "[Redis]") 2>&1 &
redis_pid=$!

# init/migrate are idempotent, so retry the pair together: ClickHouse briefly
# restarts itself between its own bootstrap and final startup, and a ping can
# succeed against the transient instance right before it goes down.
until $UPTRACE pg ping >/dev/null 2>&1; do sleep 1; done
until $UPTRACE pg init && $UPTRACE pg migrate; do sleep 1; done

until $UPTRACE ch ping >/dev/null 2>&1; do sleep 1; done
until $UPTRACE ch init && $UPTRACE ch migrate; do sleep 1; done

until /usr/local/bin/redis-cli ping >/dev/null 2>&1; do sleep 1; done

$UPTRACE serve > >(tag "[Uptrace]") 2>&1 &
uptrace_pid=$!

# If any one service dies, tear down the rest rather than limping along.
wait -n "$ch_pid" "$pg_pid" "$redis_pid" "$uptrace_pid" || true
report_crash
terminate
exit 1
