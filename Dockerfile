# Use full Debian (bookworm)
FROM debian:bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=3000

# Install system packages and Node.js from Debian repos (Node 18 on bookworm)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      tini \
      bash \
      nodejs \
      npm \
 && rm -rf /var/lib/apt/lists/*

# App directory
WORKDIR /app

# Copy minimal sources
COPY public ./public
COPY rtc.mjs ./rtc.mjs

# Create a minimal package.json in the image and install runtime deps
# (The repo currently has no package.json inside voice-agent)
RUN npm init -y \
 && npm install --no-audit --no-fund express \
 && npm cache clean --force

# Create and use a non-root user
RUN useradd -m -u 10001 -s /usr/sbin/nologin appuser \
 && chown -R appuser:appuser /app
USER appuser

EXPOSE 3000

# Tini for proper signal handling
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "rtc.mjs"]
