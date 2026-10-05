#!/usr/bin/env bash

"$(pnpm --silent cli:latest codex || command -v codex)" -c 'tui.terminal_title=["spinner","thread-title","run-state","task-progress"]'
exec bash --login -i
