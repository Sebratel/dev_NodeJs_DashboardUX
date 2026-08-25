#!/usr/bin/env bash
# Sobe automation + bff + frontend juntos (rede docker-compose local,
# simulando as 3 stacks de producao se comunicando) e roda a suite
# Playwright em e2e/tests contra eles. Sempre derruba os containers ao
# final, mesmo se os testes falharem.
set -euo pipefail
cd "$(dirname "$0")"

cleanup() {
  echo ">>> Derrubando containers de e2e..."
  docker compose down -v
}
trap cleanup EXIT

echo ">>> Buildando e subindo automation + bff + frontend..."
docker compose up --build -d

echo ">>> Aguardando bff responder em :3210..."
for _ in $(seq 1 40); do
  if curl -sf http://localhost:3210/api/reports/jobs > /dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo ">>> Aguardando frontend responder em :3211..."
for _ in $(seq 1 40); do
  if curl -sf http://localhost:3211/ > /dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo ">>> Instalando dependencias do Playwright (se necessario)..."
npm install --no-audit --no-fund
npx playwright install --with-deps chromium

echo ">>> Rodando testes e2e..."
npm test
