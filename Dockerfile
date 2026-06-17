# ServerMind image. Runs the CONTROLLER by default (bun run start); an AGENT is
# the same image with `command: bun run agent`.
#
# Note: this image is meant for the CONTROLLER (which manages no host) and for
# local fleet simulation. A real production agent runs natively on each host —
# managing a host from inside a container fights container isolation.
FROM oven/bun:1.3.4

# procps gives `free`, `uptime`, `ps` so status snapshots are complete (the slim
# base image omits them). The DB clients (`mysql`, `psql`) let the MySQL/Postgres
# health probes and user-defined db_query custom tools actually run. Mainly for
# the local fleet sim — real hosts already have whatever clients they need.
RUN apt-get update && apt-get install -y --no-install-recommends \
      procps default-mysql-client postgresql-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# App source (see .dockerignore for what's excluded).
COPY . .

ENV NODE_ENV=production
EXPOSE 5500

CMD ["bun", "run", "start"]
