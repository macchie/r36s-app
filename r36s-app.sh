#!/bin/bash
# ==============================================================================
# R36S BUN.JS PORT LAUNCHER (PRODUCTION READY)
# Designed for ArkOS / AmberELEC / ROCKNIX
# Target: Panel 4 Hardware Revisions (RK3326)
# ==============================================================================

# 1. Configuration - Adjust these to match your file structure
APP_NAME="r36s-app"
APP_DIR="/roms/ports/r36s-app"
BINARY_NAME="r36s-app"
LOG_FILE="$APP_DIR/error.log"

# 2. Environment Setup
# Ensure we are in the correct directory for relative pathing in your TS code
cd "$APP_DIR" || { echo "Directory $APP_DIR not found"; sleep 5; exit 1; }

# 3. Screen/Input Preparation (Standard for R36S Ports)
# Clear the console to prevent terminal text bleed-through on Panel 4
clear
printf "\033c" # Hard reset terminal buffer

# Blank the VT cursor and text so only framebuffer output is visible
echo 0 > /sys/class/graphics/fbcon/cursor_blink 2>/dev/null
setterm --blank force --cursor off 2>/dev/null

# 4. Permissions Check
# Ensures the Bun binary is executable regardless of how it was copied (FTP/FAT32)
if [ -f "./$BINARY_NAME" ]; then
    chmod +x "./$BINARY_NAME"
else
    echo "Error: Binary $BINARY_NAME not found in $APP_DIR"
    sleep 5
    exit 1
fi

# 5. Launch Application
# We use 'stdbuf' to ensure logs aren't buffered if you're debugging via SSH
# We redirect stderr to a log file to help you diagnose Panel 4 display issues
echo "Starting $APP_NAME..."
./"$BINARY_NAME" 2> "$LOG_FILE"

# 6. Post-Run Cleanup
# Restore VT cursor and console
setterm --blank poke --cursor on 2>/dev/null
echo 1 > /sys/class/graphics/fbcon/cursor_blink 2>/dev/null

# Return to the EmulationStation frontend
echo "Application closed. Returning to menu..."
sleep 2
clear