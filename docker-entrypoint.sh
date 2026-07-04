#!/usr/bin/env bash
set -euo pipefail

SSH_USER="codebuddy"
USER_HOME="/home/${SSH_USER}"
SSH_PASSWORD="${SSH_PASSWORD:-codebuddy}"
ENV_FILE="${USER_HOME}/.codebuddy/env.sh"

# Gateway settings
GATEWAY_ENABLED="${CODEBUDDY_GATEWAY_ENABLED:-true}"
GATEWAY_HOST="${CODEBUDDY_GATEWAY_HOST:-0.0.0.0}"
GATEWAY_PORT="${CODEBUDDY_GATEWAY_PORT:-10532}"
GATEWAY_DIR="/opt/codebuddy-gateway"

ensure_file() {
  local path="$1"
  if [[ ! -f "${path}" ]]; then
    touch "${path}"
  fi
}

ensure_source_env() {
  local path="$1"
  local marker="# codebuddy-gateway env"
  if ! grep -Fq "${marker}" "${path}"; then
    cat >> "${path}" <<'EOF'

# codebuddy-gateway env
if [ -f "$HOME/.codebuddy/env.sh" ]; then
  . "$HOME/.codebuddy/env.sh"
fi
EOF
  fi
}

start_gateway() {
  echo "Starting codebuddy-gateway on ${GATEWAY_HOST}:${GATEWAY_PORT}..."

  # Build env vars to pass through to the gateway process.
  local -a pass_env=()
  if [[ -n "${CODEBUDDY_API_KEY:-}" ]]; then
    pass_env+=("CODEBUDDY_API_KEY=${CODEBUDDY_API_KEY}")
  fi
  # Point SDK to the system-installed CLI package path so it can resolve
  # dist/codebuddy-headless.js relative to the real npm package directory.
  pass_env+=("CODEBUDDY_CODE_PATH=/usr/local/lib/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy")

  while true; do
    cd "${GATEWAY_DIR}"
    runuser -u "${SSH_USER}" -- \
      env HOME="${USER_HOME}" \
        "${pass_env[@]}" \
        CODEBUDDY_GATEWAY_HOST="${GATEWAY_HOST}" \
        CODEBUDDY_GATEWAY_PORT="${GATEWAY_PORT}" \
        CODEBUDDY_GATEWAY_TOOLS="${CODEBUDDY_GATEWAY_TOOLS:-}" \
        CODEBUDDY_GATEWAY_DISALLOWED_TOOLS="${CODEBUDDY_GATEWAY_DISALLOWED_TOOLS:-Bash(git commit),Bash(git push),Bash(rm),Bash(sudo)}" \
        CODEBUDDY_GATEWAY_MODEL="${CODEBUDDY_GATEWAY_MODEL:-}" \
        CODEBUDDY_GATEWAY_MAX_TURNS="${CODEBUDDY_GATEWAY_MAX_TURNS:-30}" \
        CODEBUDDY_GATEWAY_TIMEOUT="${CODEBUDDY_GATEWAY_TIMEOUT:-300000}" \
        node server.mjs
    echo "codebuddy-gateway exited, restarting in 5s..."
    sleep 5
  done
}

mkdir -p "${USER_HOME}" "${USER_HOME}/.ssh" "${USER_HOME}/.codebuddy" /var/run/sshd
cp -an /etc/skel/. "${USER_HOME}/" 2>/dev/null || true

ensure_file "${USER_HOME}/.bashrc"
ensure_file "${USER_HOME}/.profile"
ensure_file "${USER_HOME}/.bash_profile"

ensure_source_env "${USER_HOME}/.bashrc"
ensure_source_env "${USER_HOME}/.profile"
ensure_source_env "${USER_HOME}/.bash_profile"

if [[ ! -f "${ENV_FILE}" ]]; then
  cat > "${ENV_FILE}" <<'EOF'
#!/usr/bin/env bash
EOF
fi

# Optional environment variables used by CodeBuddy.
if [[ -n "${CODEBUDDY_API_KEY:-}" ]]; then
  sed -i '/^export CODEBUDDY_API_KEY=/d' "${ENV_FILE}"
  printf 'export CODEBUDDY_API_KEY=%q\n' "${CODEBUDDY_API_KEY}" >> "${ENV_FILE}"
fi

echo "${SSH_USER}:${SSH_PASSWORD}" | chpasswd

if [[ -n "${SSH_PUBLIC_KEY:-}" ]]; then
  AUTHORIZED_KEYS="${USER_HOME}/.ssh/authorized_keys"
  ensure_file "${AUTHORIZED_KEYS}"
  while IFS= read -r key; do
    if [[ -n "${key}" ]] && ! grep -Fxq "${key}" "${AUTHORIZED_KEYS}"; then
      printf '%s\n' "${key}" >> "${AUTHORIZED_KEYS}"
    fi
  done <<< "${SSH_PUBLIC_KEY}"
  chmod 600 "${AUTHORIZED_KEYS}"
fi

chmod 700 "${USER_HOME}/.ssh" "${USER_HOME}/.codebuddy"
chmod 600 "${ENV_FILE}"
chown -R "${SSH_USER}:${SSH_USER}" "${USER_HOME}"

if [[ ! -f /etc/ssh/ssh_host_rsa_key ]]; then
  ssh-keygen -A
fi

# Start gateway in background if enabled
if [[ "${GATEWAY_ENABLED,,}" == "true" ]]; then
  start_gateway &
fi

exec /usr/sbin/sshd -D -e
