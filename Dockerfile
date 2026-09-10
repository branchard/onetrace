FROM alpine:latest

# Uptrace (See: https://github.com/uptrace/uptrace/blob/f617f6c76a035a1b2a83cc19cb2bc2802a68f0a6/cmd/uptrace/Dockerfile)
RUN apk --update add ca-certificates
COPY --from=uptrace/uptrace:latest /uptrace /uptrace
COPY --from=uptrace/uptrace:latest /entrypoint.sh /uptrace-entrypoint.sh
EXPOSE 4317 14318

# ClickHouse 26.3 (See: https://github.com/ClickHouse/docker-library/blob/e0d01891a279d0c8c03d92255aa24734729e1edf/server/26.3.29.7/Dockerfile.alpine)
ENV LANG=en_US.UTF-8 LANGUAGE=en_US:en LC_ALL=en_US.UTF-8 TZ=UTC CLICKHOUSE_CONFIG=/etc/clickhouse-server/config.xml
COPY --from=clickhouse/clickhouse-server:26.3-alpine /lib/libc.so.6 /lib/libdl.so.2 /lib/libm.so.6 /lib/libpthread.so.0 /lib/librt.so.1 /lib/libnss_dns.so.2 /lib/libnss_files.so.2 /lib/libresolv.so.2 /lib/ld-2.35.so /lib/
COPY --from=clickhouse/clickhouse-server:26.3-alpine /etc/nsswitch.conf /etc/
COPY --from=clickhouse/clickhouse-server:26.3-alpine /etc/clickhouse-server/config.d/docker_related_config.xml /etc/clickhouse-server/config.d/
COPY --from=clickhouse/clickhouse-server:26.3-alpine /entrypoint.sh /clickhouse-entrypoint.sh
RUN mkdir -p /lib64 && ln -sf /lib/ld-2.35.so /lib64/ld-linux-x86-64.so.2

# clickhouse-server/-client are symlinks to a single ~760MB static-ish binary.
COPY --from=clickhouse/clickhouse-server:26.3-alpine /usr/bin/clickhouse /usr/bin/clickhouse
RUN ln -s clickhouse /usr/bin/clickhouse-server && ln -s clickhouse /usr/bin/clickhouse-client
COPY --from=clickhouse/clickhouse-server:26.3-alpine /etc/clickhouse-server/config.xml /etc/clickhouse-server/users.xml /etc/clickhouse-server/
COPY --from=clickhouse/clickhouse-server:26.3-alpine /etc/clickhouse-client/config.xml /etc/clickhouse-client/

# same uid/gid (101) and directory layout as the upstream image
RUN apk add --no-cache bash tzdata \
    && cp /usr/share/zoneinfo/UTC /etc/localtime \
    && echo "UTC" > /etc/timezone \
    && addgroup -S -g 101 clickhouse \
    && adduser -S -h /var/lib/clickhouse -s /bin/bash -G clickhouse -g "ClickHouse server" -u 101 clickhouse \
    && mkdir -p /var/lib/clickhouse /var/log/clickhouse-server /etc/clickhouse-server/users.d /docker-entrypoint-initdb.d \
    && chown clickhouse:clickhouse /var/lib/clickhouse \
    && chown root:clickhouse /var/log/clickhouse-server \
    && chmod ugo+Xrw -R /var/lib/clickhouse /var/log/clickhouse-server /etc/clickhouse-client /etc/clickhouse-server
VOLUME /var/lib/clickhouse
ENV CLICKHOUSE_DB=uptrace CLICKHOUSE_USER=uptrace CLICKHOUSE_PASSWORD=uptrace

# PostgreSQL 18 (See: https://github.com/docker-library/postgres/blob/e00e1bd34ec5c8a8e7ad89b273b3d42efaf6d5bc/18/alpine3.24/Dockerfile)
# Built for musl/Alpine already, so no glibc-compat dance is needed here: copy
# the self-contained /usr/local tree and pull in its runtime shared libraries.
COPY --from=postgres:18-alpine /usr/local /usr/local
RUN mv /usr/local/bin/docker-entrypoint.sh /usr/local/bin/postgres-entrypoint.sh \
    # Drop the LLVM JIT extension: it needs a ~200MB libLLVM just for an
    # optimization that only kicks in on very expensive queries.
    && rm -rf /usr/local/lib/postgresql/llvmjit.so /usr/local/lib/postgresql/llvmjit_types.bc /usr/local/lib/postgresql/bitcode \
    && mkdir -p /docker-entrypoint-initdb.d \
    && printf '#!/bin/sh\nset -e\necho "jit = off" >> "$PGDATA/postgresql.conf"\n' > /docker-entrypoint-initdb.d/00-disable-jit.sh \
    && chmod +x /docker-entrypoint-initdb.d/00-disable-jit.sh \
    && apk add --no-cache \
        icu-data-full icu-libs \
        libssl3 libcrypto3 libgcc libstdc++ \
        libcurl libedit libldap krb5-libs liburing libuuid \
        libxml2 libxslt lz4-libs zstd-libs zstd \
    && addgroup -g 70 -S postgres \
    && adduser -u 70 -S -D -G postgres -H -h /var/lib/postgresql -s /bin/sh postgres \
    && install -d -o postgres -g postgres -m 1777 /var/lib/postgresql \
    && install -d -o postgres -g postgres -m 3777 /var/run/postgresql
ENV PGDATA=/var/lib/postgresql/18/docker POSTGRES_USER=uptrace POSTGRES_PASSWORD=uptrace POSTGRES_DB=uptrace
VOLUME /var/lib/postgresql

# Redis 8 (See: https://github.com/redis/docker-library-redis/blob/8.2.9/alpine/Dockerfile)
# Also musl/Alpine-native: same approach as PostgreSQL above.
COPY --from=redis:8-alpine /usr/local /usr/local
RUN mv /usr/local/bin/docker-entrypoint.sh /usr/local/bin/redis-entrypoint.sh \
    && apk add --no-cache tzdata setpriv \
    && addgroup -S -g 1000 redis \
    && adduser -S -G redis -u 999 redis \
    && mkdir -p /data && chown redis:redis /data
VOLUME /data
# redis-server resolves its data dir relative to the cwd; the other services
# use absolute paths so this only affects redis.
WORKDIR /data

# Orchestration: start ClickHouse, PostgreSQL and Redis, wait for them to be
# ready, then run uptrace in the foreground. See entrypoint.sh.
COPY entrypoint.sh /entrypoint.sh
COPY uptrace.yml /etc/uptrace/uptrace.yml
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
