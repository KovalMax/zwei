.DEFAULT_GOAL := help
APP_NAME ?= "messenger"

ifeq (exec,$(firstword $(MAKECMDGOALS)))
  # use the rest as arguments for "exec"
  RUN_ARGS := $(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS))
  # ...and turn them into do-nothing targets
  $(eval $(RUN_ARGS):;@:)
endif

.PHONY: help
help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'

.PHONY: start
start: check_dist_files ## - Starting all docker containers from compose file
	@bash scripts/start.sh $(APP_NAME)

.PHONY: stop
stop: ## - Stop all docker containers from compose file
	@bash scripts/stop.sh $(APP_NAME)

.PHONY: build
build: check_dist_files ## - build all docker containers from compose file
	@bash scripts/build.sh $(APP_NAME)

.PHONY: exec
exec: ## - Exec some docker container e.g. make exec auth sh
	docker compose -p $(APP_NAME) exec $(RUN_ARGS)

.PHONY: check_dist_files
check_dist_files:
	cp -n .env.dist .env || true
	cp -n docker-compose.override.dist.yml docker-compose.override.yml || true

.PHONY: trust-local-ca
trust-local-ca: ## - Trust the Docker-generated local CA on macOS
	@bash scripts/trust-local-ca.sh

.PHONY: migrate
migrate: check_dist_files ## - Run PostgreSQL migrations inside the database container
	@bash scripts/migrate.sh $(APP_NAME)
