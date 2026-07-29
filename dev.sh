#!/usr/bin/env bash
# Run backend and frontend together. Ctrl-C stops both.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d backend/.venv ]; then
  echo "Setting up backend venv..."
  python3 -m venv backend/.venv
  backend/.venv/bin/pip install -r backend/requirements.txt
fi

if [ ! -d frontend/node_modules ]; then
  echo "Installing frontend dependencies..."
  (cd frontend && npm install)
fi

trap 'kill 0' EXIT

(cd backend && .venv/bin/uvicorn app.main:app --port 8000 --reload) &
(cd frontend && npm run dev) &
wait
