# No npm install: application uses Node's built-in APIs.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 10001 mono && useradd -u 10001 -g mono -s /usr/sbin/nologin mono \
 && mkdir -p /app /data && chown mono:mono /data
WORKDIR /app
COPY --chown=mono:mono package.json core.mjs server.mjs ./
COPY --chown=mono:mono public ./public
# server.mjs imports backend/* at startup (local routes, Groq key manager, audio services).
COPY --chown=mono:mono backend ./backend
USER mono
ENV NODE_ENV=production MONO_DATA_DIR=/data PORT=4173
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=6s --start-period=20s --retries=3 \
 CMD node healthcheck.mjs
COPY --chown=mono:mono healthcheck.mjs ./healthcheck.mjs
CMD ["node","server.mjs"]
