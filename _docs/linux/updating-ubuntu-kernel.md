---
layout: doc
title: "Install Latest Kernel in Ubuntu and Auto-Load `rbd` module"
category: linux
order: 60
last_updated: 2026-07-17
tags: ['ceph', 'high-availability', 'kernel', 'linux', 'rbd', 'ubuntu']
---
### Install Latest Kernel in Ubuntu and Auto-Load `rbd` module 

This guide provides a robust script to install the latest Ubuntu kernel (6.14.x or higher) with `linux-modules-extra` from `http://archive.ubuntu.com/ubuntu/pool/main/l/linux/` and ensures the Ceph RBD module (`rbd.ko`) loads automatically at boot 
---

## 1. Script to Install the Latest Kernel with `linux-modules-extra`

This script finds, downloads, and installs the latest 6.14.x (or higher) kernel from `http://archive.ubuntu.com/ubuntu/pool/main/l/linux/`, ensuring `linux-modules-extra` for Ceph RBD support. It includes error handling, dependency fixes, and cleanup of kernels without `linux-modules-extra`.

### Improved Script (`update_kernel.sh`)

```bash
#!/bin/bash

# Script to install the latest Ubuntu kernel (6.15.x or higher) with linux-modules-extra
# Ensures Ceph RBD support and cleans up kernels without linux-modules-extra
# Uses http://archive.ubuntu.com/ubuntu/pool/main/l/linux/

set -euo pipefail

# Configuration
MIN_KERNEL_VERSION="6.15"
UBUNTU_ARCHIVE="http://archive.ubuntu.com/ubuntu/pool/main/l/linux"
TEMP_DIR="/tmp/kernel-update"
LOG_FILE="/var/log/kernel-update.log"

# Enable colored output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Version comparison function
version_ge() {
    # Returns 0 if $1 >= $2, 1 otherwise
    [ "$(printf '%s\n' "$1" "$2" | sort -V | head -n1)" = "$2" ]
}

# Log function with color
log() {
    local color="$1"
    shift
    echo -e "[$(date '+%Y-%m-%d %H:%M:%S')] ${color}$1${NC}" | tee -a "$LOG_FILE"
}

# Check if running as root
if [[ $EUID -ne 0 ]]; then
    log "$RED" "❌ This script must be run as root (use sudo)."
    exit 1
fi

# Create temporary directory
mkdir -p "$TEMP_DIR"
cd "$TEMP_DIR" || { 
    log "$RED" "❌ Failed to change to $TEMP_DIR"
    exit 1
}

# Cleanup function
cleanup() {
    if [ -d "$TEMP_DIR" ]; then
        rm -rf "$TEMP_DIR"
    fi
}
trap cleanup EXIT

# Find the latest kernel version (6.15.x or higher)
log "$BLUE" "🔍 Searching for the latest kernel version >= $MIN_KERNEL_VERSION..."

# Get all available kernel packages and extract versions
ALL_KERNELS=$(curl -s "$UBUNTU_ARCHIVE/" | grep -o 'linux-image-unsigned-[0-9]\+\.[0-9]\+\.[0-9]\+-[0-9]\+-generic_.*_amd64\.deb' | sort -V)

if [ -z "$ALL_KERNELS" ]; then
    log "$RED" "❌ No kernel packages found."
    exit 1
fi

# Find the latest kernel version that meets our minimum requirement
LATEST_KERNEL=""
for KERNEL_PKG in $ALL_KERNELS; do
    KERNEL_VER=$(echo "$KERNEL_PKG" | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+' | head -n 1)
    if version_ge "$KERNEL_VER" "$MIN_KERNEL_VERSION"; then
        LATEST_KERNEL="$KERNEL_PKG"
    fi
done

if [ -z "$LATEST_KERNEL" ]; then
    log "$RED" "❌ No kernel version >= $MIN_KERNEL_VERSION found."
    exit 1
fi

KERNEL_VERSION=$(echo "$LATEST_KERNEL" | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+-[0-9]\+' | head -n 1)
KERNEL_FULL="${KERNEL_VERSION}-generic"
log "$GREEN" "✅ Latest kernel found: $KERNEL_FULL"

# Define package patterns
PACKAGES=(
    "linux-modules-${KERNEL_FULL}_[0-9]\+\.[0-9]\+\.[0-9]\+-[0-9]\+\.[0-9]\+_amd64.deb"
    "linux-modules-extra-${KERNEL_FULL}_[0-9]\+\.[0-9]\+\.[0-9]\+-[0-9]\+\.[0-9]\+_amd64.deb"
    "linux-image-unsigned-${KERNEL_FULL}_[0-9]\+\.[0-9]\+\.[0-9]\+-[0-9]\+\.[0-9]\+_amd64.deb"
)

# Download packages
log "$BLUE" "📦 Downloading kernel packages..."
for PKG_PATTERN in "${PACKAGES[@]}"; do
    PKG=$(curl -s "$UBUNTU_ARCHIVE/" | grep -o "$PKG_PATTERN" | sort -V | tail -n 1)
    if [ -z "$PKG" ]; then
        log "$RED" "❌ Package not found for pattern: $PKG_PATTERN"
        exit 1
    fi
    log "$BLUE" "⬇️ Downloading $PKG..."
    if ! wget -q "$UBUNTU_ARCHIVE/$PKG"; then
        log "$RED" "❌ Failed to download $PKG"
        exit 1
    fi
done

# Install packages
log "$BLUE" "📦 Installing kernel packages..."
if ! dpkg -i *.deb; then
    log "$YELLOW" "⚠️ Dependency issues detected; attempting to fix..."
    apt update && apt install -f -y
fi

# Update GRUB
log "$BLUE" "🔄 Updating GRUB..."
update-grub

# Clean up kernels without linux-modules-extra
log "$BLUE" "🧹 Cleaning up kernels without linux-modules-extra..."
CURRENT_KERNEL=$(uname -r)
INSTALLED_KERNELS=$(dpkg -l | grep -E '^ii.*linux-image-[0-9]' | awk '{print $2}' | grep -v "$CURRENT_KERNEL")

for KERNEL in $INSTALLED_KERNELS; do
    # Extract kernel version from package name
    if [[ "$KERNEL" =~ linux-image-unsigned-([0-9]+\.[0-9]+\.[0-9]+-[0-9]+)-generic ]]; then
        KERNEL_VER="${BASH_REMATCH[1]}-generic"
    elif [[ "$KERNEL" =~ linux-image-([0-9]+\.[0-9]+\.[0-9]+-[0-9]+)-generic ]]; then
        KERNEL_VER="${BASH_REMATCH[1]}-generic"
    else
        continue
    fi
    
    # Check if linux-modules-extra exists for this kernel
    if ! dpkg -l | grep -q "^ii.*linux-modules-extra-${KERNEL_VER}"; then
        log "$YELLOW" "🗑️ Removing kernel $KERNEL_VER (no linux-modules-extra)..."
        apt remove -y --purge "linux-image-*${KERNEL_VER}" "linux-modules-*${KERNEL_VER}" "linux-headers-*${KERNEL_VER}"
    fi
done
apt autoremove -y

# Update initramfs
log "$BLUE" "🔄 Updating initramfs..."
update-initramfs -u -k all

# Log success
log "$GREEN" "✅ Kernel $KERNEL_FULL installed. Reboot to apply changes: 'sudo reboot'"

exit 0
```

### How to Use the Script
1. **Save the Script**:
   ```bash
   nano update_kernel.sh
   ```
   - Paste the script, save (`Ctrl+X`, `Y`, `Enter`).

2. **Make Executable**:
   ```bash
   chmod +x update_kernel.sh
   ```

3. **Run the Script**:
   ```bash
   sudo ./update_kernel.sh
   ```

4. **Reboot**:
   ```bash
   sudo reboot
   ```

---


## 2. Automatically Load `rbd` at Boot

To ensure the `rbd` module loads on startup for Ceph RBD functionality:

### Steps
1. **Create a Module-Load Configuration**:
   ```bash
   echo "rbd" | sudo tee /etc/modules-load.d/rbd.conf
   ```
   - This configures `systemd` to load the `rbd` module at boot.

2. **Install `ceph-common`**:
   ```bash
   sudo apt update
   sudo apt install -y ceph-common
   ```
   - Provides user-space tools for Ceph RBD (e.g., `rbd` command).

3. **Update `initramfs`** (Final Step):
   ```bash
   sudo update-initramfs -u -k all
   ```
   - Ensures the `rbd` module is included in the initial ramdisk for all installed kernels.

4. **Verify After Reboot**:
   ```bash
   sudo reboot
   lsmod | grep rbd
   ```
   - Expected output: `rbd` listed.
   - If missing, load manually to test:
     ```bash
     sudo modprobe rbd
     lsmod | grep rbd
     ```

---

## 3. Final Verification

After rebooting:
```bash
uname -r            # Confirm new kernel (e.g., 6.14.0-24-generic)
lsmod | grep rbd    # Verify rbd module is loaded
find /lib/modules/$(uname -r) -name rbd.ko  # Confirm rbd.ko exists
```
- If `rbd` is not loaded:
  ```bash
  sudo modprobe rbd
  ```

---

## 4. Addressing Headers Dependency Issue

The `linux-headers-6.14.0-24` package is unconfigured due to dependencies (`libc6 >= 2.38`, `libdw1t64`, `libelf1t64`, `libssl3t64`). If headers are not needed (e.g., no DKMS modules), remove them:
```bash
sudo apt remove --purge linux-headers-6.14.0-24
sudo apt autoremove
```

If headers are required:
```bash
echo 'deb http://archive.ubuntu.com/ubuntu jammy-proposed main restricted universe multiverse' | sudo tee /etc/apt/sources.list.d/jammy-proposed.list
sudo apt update
sudo apt install -y --allow-downgrades libc6 libelf1 libssl3
sudo dpkg --configure -a
sudo apt install -f
sudo rm /etc/apt/sources.list.d/jammy-proposed.list
sudo apt update
sudo update-initramfs -u -k all
```


---

This documentation is streamlined, with the correct URL and `initramfs` update as the final step for `rbd` auto-loading. The script is robust and production-ready. If you need further refinements or encounter issues, share details, and I’ll assist!
