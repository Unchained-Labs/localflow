# localflow — the entry points chezmoi (and you) call.
#
# localflow runs on the HOST, not in a container, and that is not an oversight.
# It needs two things a container cannot cheaply have: read access to
# ~/.claude/sessions, which is mode 0700, and the `claude` binary on PATH so it
# can spawn and resume sessions. Bind-mounting both into an image to save a
# `pnpm install` would trade a working tool for a fragile one.
#
#   make up      build and serve on 127.0.0.1:7317, detached
#   make down    stop it
#   make logs    tail the log
#   make status  is it up?
#
# Actions (spawn / reprompt / reroute / stop / task) stay OFF unless you ask:
#   make up ACTIONS=1 ROOTS=~/dev

PORT   ?= 7317
HOST   ?= 127.0.0.1
STATE  ?= $(HOME)/.localflow
PIDFILE = $(STATE)/localflow.pid
LOGFILE = $(STATE)/localflow.log
ACTIONS ?=
ROOTS   ?=

ARGS = serve --port $(PORT) --host $(HOST)
ifeq ($(ACTIONS),1)
ARGS += --allow-actions
ARGS += $(foreach r,$(ROOTS),--allow-root $(r))
endif

.PHONY: up down restart logs status build install demo

install:
	pnpm install --frozen-lockfile

build: install
	pnpm build

# One definition of "is it up", used by both up and status. Recursing into
# `make status` for the guard worked but printed make's own error banner every
# time the answer was no, which reads as a failure when it is just an answer.
RUNNING = [ -f $(PIDFILE) ] && kill -0 $$(cat $(PIDFILE)) 2>/dev/null

up: build
	@mkdir -p $(STATE)
	@if $(RUNNING); then \
	  echo "localflow: already running on $(HOST):$(PORT) (pid $$(cat $(PIDFILE)))"; \
	else \
	  setsid nohup node dist/src/cli.js $(ARGS) >>$(LOGFILE) 2>&1 < /dev/null & \
	  echo $$! > $(PIDFILE); \
	  sleep 1; \
	  echo "localflow: http://$(HOST):$(PORT)  (log: $(LOGFILE))"; \
	fi

down:
	@if $(RUNNING); then \
	  kill $$(cat $(PIDFILE)) && rm -f $(PIDFILE) && echo "localflow: stopped"; \
	else \
	  rm -f $(PIDFILE); echo "localflow: not running"; \
	fi

restart: down up

logs:
	@tail -n 150 -f $(LOGFILE)

# Reports; does not judge. "Not running" is an answer, not a build failure, and
# a target that exits non-zero for it makes `make status` print a scary banner
# for the normal case. Health checks should curl /api/health, which is the thing
# that actually knows whether it works.
status:
	@if $(RUNNING); then \
	  echo "localflow: running (pid $$(cat $(PIDFILE))) on $(HOST):$(PORT)"; \
	else \
	  echo "localflow: not running"; \
	fi

# ---- the demo reel -----------------------------------------------------------
#
# Rebuilds docs/assets/demo.{mp4,gif,-poster.jpg} and the stills beside them, end
# to end: a synthetic machine (tools/fixture.mjs), a real server reading it, a
# real browser driving the board (tools/capture.mjs), and the compositor that
# cuts the frames together with captions (tools/mkdemo.py).
#
#   make demo               rebuild the reel into docs/assets
#   make demo DEMO_KEEP=1   leave .demo/ behind — the fixture, the frames, the log
#
# Runs on its own port and its own Chrome profile, so a localflow you are
# already using on 7317 is not disturbed.
#
# Needs chromium (or Chrome), ffmpeg, and python3 with Pillow. soif is optional:
# with it the reel gets its water beat, without it that beat drops itself and
# says so.
DEMO_DIR  ?= $(CURDIR)/.demo
DEMO_PORT ?= 7318
DEMO_CDP  ?= 9223
CHROME    ?= $(shell command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null || command -v google-chrome 2>/dev/null)

# The working directories the fixture's sessions claim to be in. Actions are
# armed for the reel — the New task and Reroute dialogs are two of its beats —
# and the spawn dialog will not open for a directory outside the allowed roots.
DEMO_ROOT ?= /home/w

demo: build
	@if [ -z "$(CHROME)" ]; then echo "make demo: no chromium on PATH — set CHROME=/path/to/chrome"; exit 1; fi
	@rm -rf $(DEMO_DIR) && mkdir -p $(DEMO_DIR)
	@node tools/fixture.mjs $(DEMO_DIR)/machine
	@# One shell for the whole shoot, so the trap can take the server and the
	@# browser down again when a beat fails. Two backgrounded processes left
	@# running after a failed capture is a port conflict on the next attempt,
	@# which reads as a second, unrelated bug.
	@set -e; \
	  . $(DEMO_DIR)/machine/env.sh; \
	  node dist/src/cli.js serve --port $(DEMO_PORT) --host 127.0.0.1 \
	    --allow-actions --allow-remote --allow-root $(DEMO_ROOT) \
	    >$(DEMO_DIR)/server.log 2>&1 & server=$$!; \
	  "$(CHROME)" --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
	    --force-device-scale-factor=1 --window-size=1440,900 \
	    --remote-debugging-port=$(DEMO_CDP) --user-data-dir=$(DEMO_DIR)/chrome \
	    about:blank >$(DEMO_DIR)/chrome.log 2>&1 & chrome=$$!; \
	  trap 'kill $$server $$chrome 2>/dev/null || true' EXIT; \
	  sleep 5; \
	  node tools/capture.mjs $(DEMO_DIR)/frames --port $(DEMO_PORT) --cdp $(DEMO_CDP); \
	  python3 tools/mkdemo.py $(DEMO_DIR)/frames $(DEMO_DIR)/out
	cp $(DEMO_DIR)/out/localflow.mp4 docs/assets/demo.mp4
	cp $(DEMO_DIR)/out/localflow.gif docs/assets/demo.gif
	cp $(DEMO_DIR)/out/localflow-poster.jpg docs/assets/demo-poster.jpg
	cp $(DEMO_DIR)/frames/*-board.png docs/assets/board.png
	cp $(DEMO_DIR)/frames/*-graph.png docs/assets/drawer.png
	@[ -n "$(DEMO_KEEP)" ] || rm -rf $(DEMO_DIR)
	@echo "demo: docs/assets updated"
