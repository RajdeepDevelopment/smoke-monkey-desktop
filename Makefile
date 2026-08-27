SHELL := /bin/bash
DC := docker compose
APP := smoke-monkey

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-22s\033[0m %s\n", $$1, $$2}'

.PHONY: init
init: ## Copy .env.example -> .env if missing
	@test -f .env || cp .env.example .env

.PHONY: build
build: init ## Build all images
	$(DC) build

.PHONY: up
up: init ## Start full stack
	$(DC) up -d --build

.PHONY: up-services
up-services: init ## Start only infra (db, redis, nats, minio, ollama)
	$(DC) up -d postgres redis nats minio ollama

.PHONY: down
down: ## Stop stack
	$(DC) down

.PHONY: down-volumes
down-volumes: ## Stop stack and wipe volumes
	$(DC) down -v

.PHONY: logs
logs: ## Tail all logs
	$(DC) logs -f

.PHONY: logs-api
logs-api: ## Tail api-gateway logs
	$(DC) logs -f api-gateway

.PHONY: logs-worker
logs-worker: ## Tail document-worker logs
	$(DC) logs -f document-worker

.PHONY: psql
psql: ## Open postgres shell
	$(DC) exec postgres psql -U rag -d ragdb

.PHONY: web
web: ## Open web app
	open http://localhost:3001

.PHONY: test
test: ## Run python tests
	cd apps/rag-service && python -m pytest tests -q

.PHONY: lint-py
lint-py: ## Ruff lint python services
	cd apps/rag-service && python -m ruff check src tests
	cd apps/document-worker && python -m ruff check src tests

.PHONY: seed-user
seed-user: ## Create a demo user (demo@rag.local / password)
	$(DC) exec api-gateway node dist/seed.js
