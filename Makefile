# @see: https://stackoverflow.com/a/70550568
MAKEFLAGS += --no-print-directory
.PHONY: help start stop clean

##@ Global
help: ## Show this help
	@# @see: https://www.avonture.be/blog/makefile-help/
	@awk 'BEGIN {FS = ":.*##"; printf "Usage:\n  make \033[36m<target>\033[0m\n\nTargets:\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2 } ' $(MAKEFILE_LIST)

start: ## Start containers with Docker Compose
	@echo "Determining latest stable Uptrace version…"; \
	url="https://hub.docker.com/v2/repositories/uptrace/uptrace/tags?page_size=100"; \
	tags=""; \
	while [ -n "$$url" ] && [ "$$url" != "null" ]; do \
		page=$$(curl -fsSL "$$url"); \
		tags="$$tags $$(echo "$$page" | jq -r '.results[].name')"; \
		url=$$(echo "$$page" | jq -r '.next'); \
	done; \
	version=$$(echo "$$tags" | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$$' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1); \
	if [ -z "$${version}" ]; then \
		echo "Could not determine the latest stable Uptrace version" >&2; \
		exit 1; \
	fi; \
	echo "Latest stable Uptrace version: $${version}"; \
	UPTRACE_VERSION=$${version} docker compose up -d --build
	@echo "Open http://localhost:8080 in your browser (email: admin@uptrace.local, password: admin)"

stop: ## Stop and delete all containers
	UPTRACE_VERSION=none docker compose down

clean: ## Stop, delete all containers and remove volumes
	UPTRACE_VERSION=none docker compose down --remove-orphans --volumes