#!/usr/bin/env bash
# Refuse to run Compose with exported variables that override compose.env.
# This script only reads the child process environment; it never unsets values
# and never invokes Docker.

set -u

readonly compose_variables=(
  NODE_ENV
  DATABASE_URL
  POSTGRES_USER
  POSTGRES_PASSWORD
  POSTGRES_DB
  POSTGRES_HOST_PORT
  BACKEND_HOST_PORT
  FRONTEND_HOST_PORT
  JWT_SECRET
  INTERNAL_SECRET
  ORDER_EXPIRATION_ENABLED
  ORDER_EXPIRATION_BATCH_SIZE
  VNPAY_TMN_CODE
  VNPAY_HASH_SECRET
  VNPAY_PAYMENT_URL
  VNPAY_RETURN_URL
  VNPAY_ALLOW_HTTP_LOCAL_RETURN_URL
  VNPAY_QUERYDR_URL
  VNPAY_QUERYDR_TIMEOUT_MS
  PAYMENT_RECONCILIATION_ENABLED
  PAYMENT_RECONCILIATION_INTERVAL_MS
  PAYMENT_RECONCILIATION_BATCH_SIZE
  PAYMENT_RECONCILIATION_LEASE_MS
  PAYMENT_RECONCILIATION_COOLDOWN_MS
  PAYMENT_RECONCILIATION_IP_ADDR
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
