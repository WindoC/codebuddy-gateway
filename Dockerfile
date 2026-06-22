FROM node:22-bookworm

ARG CODEBUDDY_UID=1000
ARG CODEBUDDY_GID=1000

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        openssh-server \
        ca-certificates \
        nano \
        tini \
        jq \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @tencent-ai/codebuddy-code@latest

RUN set -eux; \
    if ! getent group codebuddy >/dev/null; then \
      if getent group "${CODEBUDDY_GID}" >/dev/null; then \
        groupadd codebuddy; \
      else \
        groupadd -g "${CODEBUDDY_GID}" codebuddy; \
      fi; \
    fi; \
    if ! id -u codebuddy >/dev/null 2>&1; then \
      if getent passwd "${CODEBUDDY_UID}" >/dev/null; then \
        useradd -m -g codebuddy -s /bin/bash codebuddy; \
      else \
        useradd -m -u "${CODEBUDDY_UID}" -g codebuddy -s /bin/bash codebuddy; \
      fi; \
    fi; \
    mkdir -p /var/run/sshd /etc/ssh /home/codebuddy/.codebuddy /home/codebuddy/.ssh /home/codebuddy/workspace; \
    touch /home/codebuddy/.bashrc /home/codebuddy/.profile /home/codebuddy/.bash_profile; \
    chown -R codebuddy:codebuddy /home/codebuddy

# Install gateway dependencies (uses @tencent-ai/agent-sdk)
COPY gateway/package.json /opt/codebuddy-gateway/package.json
WORKDIR /opt/codebuddy-gateway
RUN npm install --omit=dev
COPY gateway/server.mjs /opt/codebuddy-gateway/server.mjs
RUN chown -R codebuddy:codebuddy /opt/codebuddy-gateway

COPY sshd_config /etc/ssh/sshd_config
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY codebuddy-stdin.sh /usr/local/bin/codebuddy-stdin

RUN chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/codebuddy-stdin

WORKDIR /home/codebuddy/workspace

VOLUME ["/home/codebuddy"]

EXPOSE 22 10532

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
