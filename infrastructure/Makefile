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
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'

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

.PHONY: e2e
e2e: check_dist_files ## - Run Playwright tests against an isolated PostgreSQL schema
	@bash scripts/e2e.sh $(APP_NAME)

.PHONY: e2e-one
e2e-one: check_dist_files ## - Run one Playwright test title against the isolated test database/Redis
	@bash scripts/e2e.sh $(APP_NAME) test "$${SPEC:-}" "$${TEST:-}"

.PHONY: e2e-baseline
e2e-baseline: check_dist_files ## - Update only the visual baseline spec (SPEC=tests/visual-baseline.spec.ts)
	@bash scripts/e2e.sh $(APP_NAME) baseline "$${SPEC:-}" "$${TEST:-}"

.PHONY: frontend-spec
frontend-spec: ## - Run one Angular spec in an already-running frontend container
	@SPEC="$${SPEC:-}"; case "$$SPEC" in src/*.spec.ts|src/**/*.spec.ts) ;; *) printf '%s\n' 'Set SPEC to a frontend spec path, e.g. src/app/home/home.component.spec.ts' >&2; exit 2 ;; esac; \
	case "/$$SPEC/" in */../*|*//*) printf '%s\n' 'SPEC must be a normalized relative spec path' >&2; exit 2 ;; esac; \
	docker compose -p $(APP_NAME) exec -T -e SPEC="$$SPEC" frontend sh -lc 'test -f "/app/$$SPEC"' && \
	docker compose -p $(APP_NAME) exec -T frontend npm test -- --include="$$SPEC"

.PHONY: frontend-build
frontend-build: ## - Run the Angular production build in an already-running frontend container
	docker compose -p $(APP_NAME) exec -T frontend npm run build -- --configuration production

.PHONY: frontend-test
frontend-test: start ## - Run Angular headless tests with the frontend container dependencies
	docker compose -p $(APP_NAME) exec -T frontend npm test -- --coverage
