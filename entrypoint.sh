#!/usr/bin/env bash
set -Eeo pipefail

UPTRACE="/uptrace --config=/etc/uptrace/uptrace.yml"
uptrace_pid=""

terminate() {
	trap - TERM INT
	kill -TERM "$ch_pid" "$redis_pid" "$uptrace_pid" 2>/dev/null || true
	kill -INT "$pg_pid" 2>/dev/null || true
	wait "$ch_pid" "$pg_pid" "$redis_pid" "$uptrace_pid" 2>/dev/null || true
}
trap 'terminate; exit 0' TERM INT

# ClickHouse's entrypoint only runs its init/bootstrap logic when called with no
# arguments (any argument makes it exec that argument directly instead). See
# https://github.com/ClickHouse/docker-library
/clickhouse-entrypoint.sh &
ch_pid=$!

/usr/local/bin/postgres-entrypoint.sh postgres &
pg_pid=$!

/usr/local/bin/redis-entrypoint.sh redis-server &
redis_pid=$!

# init/migrate are idempotent, so retry the pair together: ClickHouse briefly
# restarts itself between its own bootstrap and final startup, and a ping can
# succeed against the transient instance right before it goes down.
until $UPTRACE pg ping >/dev/null 2>&1; do sleep 1; done
until $UPTRACE pg init && $UPTRACE pg migrate; do sleep 1; done

until $UPTRACE ch ping >/dev/null 2>&1; do sleep 1; done
until $UPTRACE ch init && $UPTRACE ch migrate; do sleep 1; done

until /usr/local/bin/redis-cli ping >/dev/null 2>&1; do sleep 1; done

$UPTRACE serve &
uptrace_pid=$!

# If any one service dies, tear down the rest rather than limping along.
wait -n "$ch_pid" "$pg_pid" "$redis_pid" "$uptrace_pid" || true
terminate
exit 1
