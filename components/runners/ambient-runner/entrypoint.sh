#!/bin/bash
cd /sandbox/runner/ambient-runner
exec uvicorn main:app --host 0.0.0.0 --port 8001
