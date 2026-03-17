all: build

SSH_USER=ark
SSH_HOST=192.168.1.180

clean:
	@rm -rf r36s-app || true

build: clean
	bun build main.ts --compile --minify --target=bun-linux-arm64 --baseline --outfile ./r36s-app/r36s-app
	@chmod +x r36s-app/r36s-app

build-native: clean
	bun build main-native.ts --compile --minify --target=bun-linux-arm64 --baseline --outfile ./r36s-app/r36s-app
	@chmod +x ./r36s-app/r36s-app

deploy:
	@if [ ! -f r36s-app/r36s-app ]; then \
		echo "Error: r36s-app/r36s-app not found. Please run 'make build' first."; \
		exit 1; \
	fi
	@echo "Deploying to device..."
	ssh ${SSH_USER}@${SSH_HOST} "mkdir -p /roms/ports/r36s-app && rm -rf /roms/ports/r36s-app/r36s-app"
	scp r36s-app/r36s-app ${SSH_USER}@${SSH_HOST}:/roms/ports/r36s-app/r36s-app