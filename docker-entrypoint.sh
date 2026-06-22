#!/usr/bin/env bash
set -euo pipefail

SSH_USER="codebuddy"
USER_HOME="/home/${SSH_USER}"
SSH_PASSWORD="${SSH_PASSWORD:-codebuddy}"
ENV_FILE="${USER_HOME}/.codebuddy/env.sh"

ensure_file() {
  local path="$1"
  if [[ ! -f "${path}" ]]; then
    touch "${path}"
  fi
}

ensure_source_env() {
  local path="$1"
  local marker="# ssh-codebuddy env"
  if ! grep -Fq "${marker}" "${path}"; then
    cat >> "${path}" <<'EOF'

# ssh-codebuddy env
if [ -f "$HOME/.codebuddy/env.sh" ]; then
  . "$HOME/.codebuddy/env.sh"
fi
EOF
  fi
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

# CodeBuddy 可能需要的一些环境变量（按需扩展）
if [[ -n "${CODEBUDDY_API_KEY:-}" ]]; then
  sed -i '/^export CODEBUDDY_API_KEY=/d' "${ENV_FILE}"
  printf 'export CODEBUDDY_API_KEY=%q\n' "${CODEBUDDY_API_KEY}" >> "${ENV_FILE}"
fi

if [[ -n "${CODEBUDDY_BASE_URL:-}" ]]; then
  sed -i '/^export CODEBUDDY_BASE_URL=/d' "${ENV_FILE}"
  printf 'export CODEBUDDY_BASE_URL=%q\n' "${CODEBUDDY_BASE_URL}" >> "${ENV_FILE}"
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

exec /usr/sbin/sshd -D -e
