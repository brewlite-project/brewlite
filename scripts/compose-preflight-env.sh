#!/usr/bin/env bash
# Refuse to run Compose with exported variables that override compose.env.
# This script only reads the child process environment; it never unsets values
# and never invokes Docker.

set -u

readonly compose_variables=(
  DATABASE_URL
  POSTGRES_USER
  POSTGRES_PASSWORD
  POSTGRES_DB
  JWT_SECRET
  INTERNAL_SECRET
  VNPAY_TMN_CODE
  VNPAY_HASH_SECRET
  VNPAY_PAYMENT_URL
  VNPAY_RETURN_URL
  VNPAY_QUERYDR_URL
  VNPAY_QUERYDR_TIMEOUT_MS
  COMPOSE_PROJECT_NAME
)

conflicts=()

for variable_name in "${compose_variables[@]}"; do
  if printenv "$variable_name" >/dev/null 2>&1; then
    conflicts+=("$variable_name")
  fi
done

if ((${#conflicts[@]} > 0)); then
  printf 'Compose preflight failed: exported variable(s) would override compose.env:\n' >&2
  for variable_name in "${conflicts[@]}"; do
    printf '  - %s\n' "$variable_name" >&2
  done
  printf '\nUnset the listed variable(s) in this Git Bash session, then rerun:\n' >&2
  printf '  unset %s\n' "${conflicts[*]}" >&2
  printf '\nThe preflight does not print or modify variable values.\n' >&2
  exit 1
fi

printf 'Compose preflight passed: no conflicting exported variables detected.\n'
