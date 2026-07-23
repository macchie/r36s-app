# SSH connection configuration (can be overridden via environment variables or command line)
SSH_USER ?= ark
SSH_HOST ?= 192.168.1.180

# Build paths
ROM_LOCATION := $(shell if mountpoint -q /roms2 2>/dev/null; then echo "/roms2"; else echo "/roms"; fi)

OUT_DIR = ./r36s-app
OUT_FILE = $(OUT_DIR)/r36s-app
DEPLOY_DIR = ${ROM_LOCATION}/ports/r36s-app

# Bun configuration
BUN = bun
BUN_FLAGS = --compile --minify --target=bun-linux-arm64 --baseline

# Default target
all: build

.PHONY: all clean build build-native deploy help

help:
	@echo "Available targets:"
	@echo "  make build         - Build the Framebuffer version (main.ts)"
	@echo "  make build-native  - Build the Native TUI version (main-native.ts)"
	@echo "  make clean         - Clean up build artifacts"
	@echo "  make deploy        - Deploy the compiled app to the R36S console"

clean:
	@echo "Cleaning up..."
	@rm -rf $(OUT_DIR) || true

# Helper function to compile the target file
define compile_app
	@mkdir -p $(OUT_DIR)
	$(BUN) build $(1) $(BUN_FLAGS) --outfile $(OUT_FILE)
	@chmod +x $(OUT_FILE)
endef

build: clean
	@echo "Building Framebuffer version..."
	$(call compile_app,main.ts)

build-native: clean
	@echo "Building Native TUI version..."
	$(call compile_app,main-native.ts)

deploy:
	@if [ ! -f $(OUT_FILE) ]; then \
		echo "Error: $(OUT_FILE) not found. Please run 'make build' or 'make build-native' first."; \
		exit 1; \
	fi
	@echo "Deploying to R36S device at $(SSH_HOST)..."
	ssh $(SSH_USER)@$(SSH_HOST) "mkdir -p $(DEPLOY_DIR) && rm -f $(DEPLOY_DIR)/r36s-app"
	scp $(OUT_FILE) $(SSH_USER)@$(SSH_HOST):$(DEPLOY_DIR)/r36s-app