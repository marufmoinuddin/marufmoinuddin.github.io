---
layout: post
title: Windows 10 Mobile Offline Update Guide (Windows Phone 8.1 → Windows 10 Mobile 10586.107 and beyond)
date: 2017-04-09
category: Windows
tags: [windows, windows-phone, lumia, offline-update, iutool, guide]
excerpt: "A comprehensive guide for using the community Offline Update Project (iutool) to push Windows 10 Mobile onto Lumia and other Windows Phone 8.x devices no longer supported by Microsoft's official Upgrade Advisor."
read_time: 12
---

# Windows 10 Mobile Offline Update Guide (Windows Phone 8.1 → Windows 10 Mobile 10586.107)

This guide compiles two sources — an English technical walkthrough and a Bengali community tutorial — into one consolidated reference for using the community "Offline Update Project" (`iutool`) to push Windows 10 Mobile onto Lumia and other Windows Phone 8.x devices that Microsoft's official Upgrade Advisor no longer supports. Since Microsoft shut down WP8.1 update servers in mid-2017, this offline `.cab` deployment method (built around Microsoft's own `iutool.exe`/`getdulogs.exe` binaries) is the only way to move these devices to Windows 10 Mobile.

**Link verification note:** I checked every source link.

- The GitHub repository (`HikariCalyx/w10m_oup`) is live and matches the supported-device list quoted in the source material.
- The main XDA thread is live at **`https://xdaforums.com/t/guide-win10-mobile-semi-offline-update-project-10586-107-updated-v5-3-beta6.3527340/`** — note this is the correct base URL; the specific `/page-14` and `/page-24` anchors cited in the source material could not be independently confirmed (XDA blocks automated fetches of individual pages), but the thread itself, its author (hikari_calyx), and its content are verified genuine.
- The Quora link and the Mega/group-hosted file links (iutool.zip, Keyboard.cab, the Bengali tutorial's package mirrors) could not be verified — Quora requires login for full content, and the Mega/Facebook-group links weren't included as fetchable URLs in the source text. Prefer the GitHub repo or the XDA thread's own attachments (linked below) over third-party mirrors.

---

## ⚠️ Before You Start

- **This is an unofficial, community-built process.** It repurposes Microsoft's own deployment tooling but is not supported by Microsoft. Proceed at your own risk — a failed flash can leave a device unusable.
- **Back up everything first**: photos, videos, documents, and contacts, to your PC or a memory card. Perform a factory reset of the phone before starting is recommended by the Bengali guide, and **removing your PIN/screen lock** is strongly recommended by both sources to avoid the device becoming unresponsive mid-update.
- **Charge the battery** to at least 80% (English source) — the Bengali guide and the original XDA thread simply say a full charge is recommended, and note the process can proceed even below 40% but isn't advised.

---

## Prerequisites

| Requirement | Detail |
|---|---|
| Starting OS build | At least **8.10.14219.341**. If your phone is older, update it through normal channels first. |
| Free storage | At least ~2.5 GB free internal space. |
| Unsupported hardware | Any 4 GB ROM device (e.g. **Lumia 530**, HTC 8S, Huawei Ascend W1) — the partition layout can't fit the upgrade. HTC 8X/8XT are also unsupported (MainOS partition too small). |
| Host PC | Windows 7 SP1, 8, 8.1, or 10, with the Windows Phone USB drivers installed (via Windows Update or the Windows Device Recovery Tool) and all Visual C++ Redistributables installed. |
| Cable/port | A good-quality data cable in a **USB 2.0 port** — older USB 3.0/USB-C controllers can drop packets mid-transfer. |
| Developer Mode | Enable via **Settings → Update & Security → For Developers** on the phone. |

---

## Step 1 — Get the Tools and Packages

1. Download the package repository from the actively maintained GitHub project:
   **https://github.com/HikariCalyx/w10m_oup** (Windows 10 Mobile Offline Update Project V5.2, MIT-licensed, maintained by hikari_calyx).
2. The companion walkthrough and community discussion/support thread — including the original `iutool.7z` attachment and the newer semi-automated `HCTSW_WXMSOUP` tool — lives on XDA:
   **https://xdaforums.com/t/guide-win10-mobile-semi-offline-update-project-10586-107-updated-v5-3-beta6.3527340/**
3. Extract everything with 7-Zip. You'll end up with two kinds of assets:
   - **Tooling binaries** — `iutool.exe` (and, for later builds, `getdulogs.exe`).
   - **Package folders**, organized by device "generation" and screen resolution/chipset.
4. Pick the correct folder for your phone (see the table below), and copy **only that folder's `.cab` files** into a short path on your `C:` or `D:` drive, e.g. `C:\W10MPackages`. Do not extract or mix in `.cab` files from other device folders.

### Device → Package Folder Map

| Devices | Folder |
|---|---|
| Lumia 52X, 62X, 720/T, 810, 820, 822, Huawei Ascend W2 | `2nd Generation\480x800` |
| Lumia 1320 | `2nd Generation\720x1280` |
| Lumia 920/T, 925/T, 928, 1020 | `2nd Generation\768x1280` |
| Lumia 1520 | `2nd Generation\1520` |
| Samsung ATIV S / ATIV S Neo | `2nd Generation\I8750` |
| Lumia 43X / 532 | `3rd Generation\43X-532` |
| Lumia 535 | `3rd Generation\535` |
| Lumia 63X | `3rd Generation\63X` |
| Lumia 73X | `3rd Generation\73X` |
| Lumia 830 | `3rd Generation\830` |
| Lumia 929 Icon / 930, Samsung ATIV SE | `3rd Generation\929-930-ATIVSE` |
| Lumia McLaren/Goldfinger | `3rd Generation\McLaren-Goldfinger` |
| HTC One M8 for Windows (AT&T) | `3rd Generation\M8ATT` |
| HTC One M8 for Windows (Verizon) | `3rd Generation\M8Verizon` |
| HTC One M8 for Windows (T-Mobile) | `3rd Generation\M8TMobile` |
| Lumia 540, TrekStor WinPhone 4.7 | `4th Generation\540` |
| Lumia 640 / 640 XL | `4th Generation\640-XL` |
| LG Lancet VW820 | `4th Generation\VW820` |
| BLU WIN HD/LTE, MCJ Madosma Q501 | `4th Generation\BLUWINHDLTE-MADOSMAQ501` |
| Micromax W092 | `4th Generation\MICROMAXW092` |
| Micromax W121, BLU WIN HD, RAMOS Q7 | `4th Generation\MICROMAXW121-BLUWINHD-RAMOSQ7` |


---

## Step 2 — Connect the Device

1. Make sure the phone shows in **Settings → Update & Security → For Developers** with Developer Mode on.
2. Plug the phone into a **rear USB 2.0 port** with a reliable cable.
3. If Windows shows any driver error, or the device previously paired oddly: open **Control Panel → Devices and Printers**, right-click the phone, and choose **Remove device**. Reconnect it and let Windows re-enumerate it before continuing.

---

## Step 3 — Run `iutool`

1. Open **Command Prompt as Administrator** (search "cmd" in Start, right-click → Run as administrator).
2. Change directory to wherever you extracted `iutool.exe`:
   ```
   cd C:\Path\To\Your\Extracted\IUTool\Folder
   ```
3. Confirm the tool can see exactly one connected device:
   ```
   iutool -l
   ```
   (Note: that's a lowercase **L**, not the digit 1.) This should print an identifier string for your phone. If it returns blank or errors, redo the "Remove device" step above and reconnect.
4. Push the package folder you isolated in Step 1:
   ```
   iutool -V -p "C:\W10MPackages"
   ```
   (Substitute your actual path, e.g. `D:\480x800`.) **Do not disconnect the phone during this transfer.**

You may see benign errors during transfer (e.g. "System cannot find the file specified" for MMOS-related files, or code `0x8024a000`/`8024a110`) — both sources note these are expected and simply mean the device has taken over and is proceeding on its own.

---

## Step 4 — Let the Phone Finish

- The command prompt will show transfer progress, then a completion message (something like "Update Started").
- Unplug the phone and put it on charge.
- Within roughly 5–10 minutes, check **Settings → Update & Security → Phone Update** — you should see an update actively installing.
- The phone will show its "gears" spinning-update screen, reboot, and land on the Windows 10 Mobile 10586.107 out-of-box setup. The full process can take up to ~40 minutes.

---

## Step 5 — Fix the Keyboard (if needed)

If your phone's pre-installed language wasn't English (US) or Simplified Chinese, the on-screen keyboard commonly stops working after the flash. To fix it:

1. In **Settings → Time & Language → Keyboard**, add the **English (United States)** keyboard, then remove any other keyboards.
2. Reconnect the (still-unlocked) phone to the PC.
3. Get the matching language `.cab` (referred to as `Keyboard.cab` / the "Internal IME Fix Package," keyed by locale code — e.g. `en-gb`, `en-in`, `fr-fr`, `ja-jp`, `zh-hk`; see the XDA thread for the full code list and the attached fix package).
4. From an elevated Command Prompt in the `iutool` folder:
   ```
   iutool -V -p "D:\Keyboard.cab"
   ```
5. Expect a benign error (code `8024a110`) — the phone will still reboot and finish applying the fix. After that, the keyboard should work normally.

---

## Step 6 — Post-Flash Cleanup (Recommended)

Because the offline method layers new files onto an old on-device database, the registry can be inconsistent right after the flash:

1. Go to **Settings → System → About**.
2. Choose **Reset your phone**.
3. Let it complete a full factory reset — this clears the old cache/temp state and stabilizes the new Windows 10 Mobile install.

---

## Step 7 — Getting Further Updates (10586.107 → RS1 → RS2)

Once on the initial 10586.107 build, later Windows 10 Mobile builds (Anniversary Update "RS1"/14393, Creators Update "RS2"/15063) can be pulled the same way, but this stage genuinely requires internet access (a few GB of downloads) and a bit more manual curation:

1. On a PC with an internet connection, use a download manager (the Bengali source recommends Firefox + the "DownThemAll" extension) to bulk-download the relevant build's `.cab` packages from Microsoft's public update catalog mirrors linked in the XDA thread.
2. From the `iutool`/`getdulogs` folder on an elevated Command Prompt, capture your phone's installed-package manifest:
   ```
   getdulogs -o D:\my.cab
   ```
3. Open the resulting `my.cab` (7-Zip/WinRAR), extract `InstalledPackages.csv`, and open it in a text editor. Remove lines containing `Nokia`, `OEM`, and `Qualcomm` — these are device-specific packages you don't need to re-push.
4. Use PowerShell (run as Administrator, `Set-ExecutionPolicy Unrestricted`) with a small script that cross-references your trimmed CSV against the downloaded build folder, copying only the `.cab` files your phone actually needs into a fresh folder (e.g. `D:\RS1`).
5. Push that curated folder the same way as Step 3:
   ```
   iutool -V -p D:\RS1
   ```
6. Repeat the same process pointed at the RS2 package set once RS1 is successfully installed.

**Simpler alternative for this stage:** the newer semi-automated tool from the XDA thread (`HCTSW_WXMSOUP`, run via `run_en.cmd`) automates the `getdulogs` capture, package matching, and download steps described above — it's the actively maintained successor to the fully manual process and is generally easier to follow than hand-curating CSVs and PowerShell scripts.

---

## Verified Sources

| Source | Status |
|---|---|
| GitHub — `HikariCalyx/w10m_oup` (packages, README, supported-device list) | ✅ Live, confirmed current: https://github.com/HikariCalyx/w10m_oup |
| XDA — "[GUIDE] Win10 Mobile (Semi-)Offline Update Project 10586.107" | ✅ Live, confirmed original thread by hikari_calyx: https://xdaforums.com/t/guide-win10-mobile-semi-offline-update-project-10586-107-updated-v5-3-beta6.3527340/ |
| Specific `/page-14`, `/page-24` anchors cited in the English source | ⚠️ Unverifiable via automated fetch (site blocks bots on individual pages), but the base thread is confirmed genuine and contains matching content |
| Quora link on USB port advice | ⚠️ Not independently verified |
| Mega/Facebook-group mirrors named in the Bengali tutorial (`iutool.zip`, `iutool_1703.zip`, `Keyboard.cab`, the 10586.107 offline `.wim`) | ⚠️ Not fetchable/verifiable — use the GitHub repo or XDA thread attachments instead, as those are confirmed authentic and actively maintained |

---

### Notes on Discrepancies Between the Two Sources

- Supported-device lists match across both sources and the current GitHub README, with one exception: an XDA forum commenter (`ca_guri01`) corrected the OP that the **Lumia 520/520T/521 actually have 8 GB ROM**, not 4 GB, and so are *not* excluded by the 4 GB ROM limitation — only the 530 and similarly capacity-limited devices are excluded.
- If you hit an install error partway through, don't disconnect the phone — run `getdulogs -o 123.cab` to capture a log bundle you can inspect (`ImgUpd.log` inside) or share when asking for help on the XDA thread.
