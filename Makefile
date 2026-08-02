.DEFAULT_GOAL := help

ifeq (exec,$(firstword $(MAKECMDGOALS)))
  # use the rest as arguments for "run"
  RUN_ARGS := $(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS))
  # ...and turn them into do-nothing targets
  $(eval $(RUN_ARGS):;@:)
endif

.PHONY: help
help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'

.PHONY: start
start: ## - Starting all docker containers from compose file
	make -C infrastructure start

.PHONY: stop
stop: ## - Stop all docker containers from compose file
	make -C infrastructure stop

.PHONY: build
build: ## - build all docker containers from compose file
	make -C infrastructure build

.PHONY: exec
exec: ## - Exec a service command, for example make exec auth sh
	make -C infrastructure exec $(RUN_ARGS)

.PHONY: logs
logs: ## - Follow logs for all services
	docker compose -p messenger -f infrastructure/docker-compose.yml -f infrastructure/docker-compose.override.yml logs -f

.PHONY: migrate
migrate: ## - Run database migrations inside the migration container
	make -C infrastructure migrate

.PHONY: seed
seed: ## - Seed development data inside containers
	@echo "Seed data is introduced with the auth and chat milestones"

.PHONY: test
test: ## - Run Go tests in containers
	make -C infrastructure exec auth sh -lc 'go test ./...'

.PHONY: e2e
e2e: ## - Run Playwright browser E2E tests in Docker
	docker compose -p messenger -f infrastructure/docker-compose.yml -f infrastructure/docker-compose.override.yml run --rm e2e

.PHONY: trust-local-ca
trust-local-ca: ## - Trust the Docker-generated local CA on macOS
	make -C infrastructure trust-local-ca

.PHONY: format
format: ## - Format all Go source files in containers
	make -C infrastructure exec auth sh -lc 'go list -f "{{range .GoFiles}}{{$$.Dir}}/{{.}} {{end}}" ./... | xargs gofmt -w'


.PHONY: lint
lint: ## - Run Go vet in containers
	make -C infrastructure exec auth sh -lc 'go vet ./...'
