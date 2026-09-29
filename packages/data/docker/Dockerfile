# CLI tools for the data pipeline, for machines without a native tippecanoe (e.g. Windows).
# Built and run automatically by packages/data/scripts/lib/tippecanoe.ts.
FROM ubuntu:24.04 AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential ca-certificates git libsqlite3-dev zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*
ARG TIPPECANOE_VERSION=2.79.0
RUN git clone --depth 1 --branch ${TIPPECANOE_VERSION} https://github.com/felt/tippecanoe.git /src \
  && make -C /src -j"$(nproc)" \
  && make -C /src install

FROM ubuntu:24.04
RUN apt-get update \
  && apt-get install -y --no-install-recommends libsqlite3-0 zlib1g \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/tippecanoe* /usr/local/bin/tile-join /usr/local/bin/
WORKDIR /data
