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

.PHONY: up down restart logs status build install

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
