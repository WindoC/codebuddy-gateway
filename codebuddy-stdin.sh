#!/usr/bin/env bash
set -euo pipefail

# If stdin is a TTY, behave exactly like the codebuddy CLI.
if [ -t 0 ]; then
  exec codebuddy "$@"
fi

PROMPT="$(cat)"

if [[ -z "${PROMPT}" ]]; then
  exec codebuddy "$@"
fi

# -p = --print (non-interactive headless mode)
# -y = --dangerously-skip-permissions (required for non-interactive mode)
exec codebuddy -p "${PROMPT}" -y "$@"
