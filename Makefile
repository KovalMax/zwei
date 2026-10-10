.DEFAULT_GOAL := help
export SPEC TEST

ifeq (exec,$(firstword $(MAKECMDGOALS)))
  # use the rest as arguments for "run"
  RUN_ARGS := $(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS))
  # ...and turn them into do-nothing targets
  $(eval $(RUN_ARGS):;@:)
endif

.PHONY: help
help:
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'

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

.PHONY: frontend-spec
frontend-spec: ## - Run one Angular spec in the already-running frontend container (SPEC=src/...spec.ts)
	$(MAKE) -C infrastructure frontend-spec

.PHONY: frontend-build
frontend-build: ## - Run the Angular production build in the already-running frontend container
	$(MAKE) -C infrastructure frontend-build

.PHONY: test
test: ## - Run Go tests in containers
	make -C infrastructure exec auth sh -lc 'go test ./...'

.PHONY: e2e
e2e: ## - Run Playwright browser E2E tests in Docker
	make -C infrastructure e2e

.PHONY: e2e-one
e2e-one: ## - Run one Playwright test in a spec through isolated setup (SPEC=tests/...spec.ts TEST='test title')
	$(MAKE) -C infrastructure e2e-one

.PHONY: e2e-baseline
e2e-baseline: ## - Update reviewed visual snapshots (SPEC=tests/visual-baseline.spec.ts)
	$(MAKE) -C infrastructure e2e-baseline

.PHONY: trust-local-ca
trust-local-ca: ## - Trust the Docker-generated local CA on macOS
	make -C infrastructure trust-local-ca

.PHONY: format
format: ## - Format all Go source files in containers
	make -C infrastructure exec auth sh -lc 'go list -f "{{range .GoFiles}}{{$$.Dir}}/{{.}} {{end}}" ./... | xargs gofmt -w'


.PHONY: lint
lint: ## - Run Go vet in containers
	make -C infrastructure exec auth sh -lc 'go vet ./...'
