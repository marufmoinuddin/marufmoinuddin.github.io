---
layout: post
title: Reviving a "Dead" (Bricked) Lumia Using Windows Device Recovery Tool's Emergency/Thor2 Mode
date: 2017-08-29
category: Windows
tags: [windows, windows-phone, lumia, unbrick, wdrt, thor2, guide]
excerpt: "A comprehensive guide for recovering a bricked Lumia via the Windows Device Recovery Tool's hidden thor2.exe emergency-flash mode, with corrections and additions from the definitive XDA community reference."
read_time: 10
---

# Reviving a "Dead" (Bricked) Lumia Using Windows Device Recovery Tool's Emergency/Thor2 Mode

This guide merges a Bengali community tutorial for recovering a bricked Lumia via the Windows Device Recovery Tool's hidden `thor2.exe` emergency-flash mode, with updated technical detail and corrections pulled from the long-running XDA thread **"Finally... unbrick your Lumia device QHSUSB_DLOAD without JTAG"** (the definitive, still-active community reference for this exact procedure).

**Link verification note:**

- **XDA thread** (`https://xdaforums.com/t/finally-unbrick-your-lumia-device-qhsusb_dload-without-jtag.3082592/`) — ✅ verified live, with dated posts running from 2015 up through at least 2023, confirming the method still works on current Windows versions.
- **LumiaFirmware** (`https://lumiafirmware.com/`, referenced in the source as `lumiafirmware.com`) — ✅ verified live and actively maintained (build-dated 2026), listing `.ffu` downloads by RM/product code for essentially every Lumia model.
- **7-Zip** (`https://www.7-zip.org/`) — standard, well-known open-source tool site; no verification concerns.
- **The `db.tt/aGTK0qcsok` Dropbox short-link** for "Tools to Unbrick Lumia.zip" — ⚠️ **could not be verified**. Dropbox's `db.tt` short-link service is old infrastructure and links from this era frequently rot or get deleted by the original uploader. Don't rely on it — see the "Where to actually get the emergency files" note below for a verified alternative.

---

## ⚠️ What This Actually Does, and the Risk

This procedure reflashes your phone's **bootloader** directly over USB while it's sitting in Qualcomm's low-level **DLOAD/Emergency Download mode** — the state a Lumia falls into when a normal flash fails and the phone shows a black screen with no vibration, no boot logo, nothing. It bypasses the normal FFU flashing path entirely. If a step is done wrong, you can turn a "stuck bootloader" phone into a truly unrecoverable one, so follow the sequence exactly and don't skip the verification steps below.

**Confirm you're in the right scenario first**: plug the dead phone into a PC and check **Control Panel → Devices and Printers → View connected devices**. If it shows up as an unknown device named something like **Qualcomm HS-USB QDLoader 9008**, **Qualcomm HighSpeed Download**, or **QHUSB_DLOAD**, this guide applies to you.

---

## What You'll Need

1. **Windows Device Recovery Tool (WDRT)** — Microsoft's official Lumia recovery/flashing tool, which bundles the `thor2.exe` binary this whole process depends on.
2. **The emergency ("unbrick") files for your specific chipset generation** — a set of `.hex`/`.mbn` files for older ~20-series Lumias, or `.ede`/`.edp` files for 30-/40-series Lumias. See "Where to actually get the emergency files" below.
3. A known-good **USB data cable**.
4. A **charged battery** removed and ready to reseat (many Lumias of this era have removable batteries — that reseat step matters, see Step 2 below).
5. The dead phone.
6. Your phone's stock **`.ffu` firmware image**, matched exactly to your **product/RM code** (found under the battery cover or in the phone's original box/settings).
7. Comfort with the **Command Prompt** and a general understanding of how Windows Phone flashing works — this is not a one-click tool.

---

## Step 1 — Install Drivers and WDRT

1. Extract the emergency-tools archive with 7-Zip.
2. Install every driver inside the `Nokia_WP8x_NXP_MTKx_Asha` folder, plus `X2_FlashDriver_Emergency.msi`.
3. On a PC connected to the internet, download and install **Windows Device Recovery Tool** from Microsoft.
4. On **lumiafirmware.com**, find your phone's exact **RM product code** and download the matching `.ffu` firmware file. Rename it to `Lumia.ffu`.
5. Move `Lumia.ffu` into WDRT's install folder:

   - 32-bit Windows: `C:\Program Files\Microsoft Care Suite\Windows Device Recovery Tool`
   - 64-bit Windows: `C:\Program Files (x86)\Microsoft Care Suite\Windows Device Recovery Tool`

---

## Step 2 — Identify Your Device's Root Key Hash (RKH)

This step is identical for both device families below and is how you figure out exactly which emergency file matches your specific phone.

1. Open **Command Prompt as Administrator**.
2. `cd` into the WDRT folder path from Step 1.
3. Dump the phone's GPT partition table:

   ```
   thor2 -mode ffureader -ffufile Lumia.ffu -dump_gpt -filedir C:\Lumia
   ```
4. This creates `GPT0.bin` and `GPT1.bin` in `C:\Lumia`. Rename `GPT0.bin` to `msimage.mbn` and move it into the WDRT folder.
5. The command's console output will print two RKH (Root Key Hash) lines, e.g.:

   ```
   RKH of SBL1: F771E62AF89994064F77CD3BC16829503BDF9A3D506D3FACECAEF3F808C868FD
   RKH of UEFI: F771E62AF89994064F77CD3BC16829503BDF9A3D506D3FACECAEF3F808C868FD
   ```

### ⚠️ Correction to the original Bengali instructions

The source tutorial says to copy the **first 10 digits** of the RKH to find the matching filename. Cross-checking against the current XDA thread shows this is imprecise — **the emergency `.hex` file is named after the first 40 hex characters (20 bytes) of the RKH string**, not 10. Using the example above, the correct filename to search for is:

```
F771E62AF89994064F77CD3BC16829503BDF9A3D.hex
```

Copy that full 40-character substring (not just the first 10 characters) and search for it inside the emergency-files archive.

---

## Step 3 — Flash the Bootloader (Method Depends on Your Chipset Generation)

The XDA thread confirms the same device split the Bengali source describes: **older, ~20-series Lumias use raw `.hex` files; 30-series and 40-series Lumias use `.ede`/`.edp` file pairs instead.** Use the section that matches your phone.

### 3A — Lumia X1X / X2X family (e.g. Lumia 810, 525, 620, 1020)

1. In the emergency-files archive, find the `.hex` file whose name matches the 40-character RKH substring you identified in Step 2. Rename it to `HEX.hex` and place it in the WDRT folder alongside `msimage.mbn`.
2. Run:

   ```
   thor2 -mode emergency -hexfile HEX.hex -mbnfile msimage.mbn -orig_gpt
   ```
3. Immediately after starting the command: **remove the phone's battery, reseat it, and reconnect the data cable to the PC.** This timing matters — the command is waiting for the phone to briefly re-enumerate in DLOAD mode, and the tool is writing a fresh bootloader to the device during this window.

### 3B — Lumia X3X / X4X / X5X family (e.g. Lumia 830, 540, 640, 950)

1. Extract `Lumia Emergency Files.7z`, go into the folder matching your RM code (e.g. `RM-1141` for the Lumia 540), and rename the `.ede` and `.edp` files inside to `EDE.ede` and `EDP.edp`. Move both into the WDRT folder.
2. Run:

   ```
   thor2 -mode emergency -protocol sahara -hexfile EDE.ede -edfile EDP.edp -orig_gpt
   ```
3. As with 3A, reseat the battery and reconnect the cable right after issuing the command.

### Where to actually get the emergency files

Since the original Dropbox mirror is unverifiable, the current, actively-maintained source for these `.hex`/`.ede`/`.edp` archives is the attachments on the XDA thread itself:
**https://xdaforums.com/t/finally-unbrick-your-lumia-device-qhsusb_dload-without-jtag.3082592/**
That thread is also where to post your RKH and ask for help if your specific model's file isn't in the archive — this is common enough that thread regulars actively help match files to RKHs.

### A simpler alternative worth trying first

Per the XDA thread, a **"Simple method"** exists for some DLOAD-stuck phones: WDRT version 2.10 and later added the ability to detect and recover some DLOAD scenarios automatically, without any manual `thor2` commands at all. If your phone shows up as a Qualcomm DLOAD device, it's worth just running the latest WDRT normally first — some users report it resolves the brick on its own before you need any of the manual steps below.

---

## Step 4 — Confirm the Red Screen

Within a few seconds of Step 3, the phone should vibrate and show a **solid red screen**. This confirms the emergency bootloader write succeeded and the phone is now in a flashable state.

If it doesn't work on the first try, disconnect the phone, reconnect it, and re-run the same `thor2 -mode emergency ...` command again — the XDA thread notes it commonly takes **3–4 attempts** before the phone responds and shows red.

---

## Step 5 — Flash the Full Firmware

With the phone on the red screen, run:

```
thor2 -mode uefiflash -ffufile Lumia.ffu -do_full_nvi_update -do_factory_reset -reboot
```

Watch the phone's screen — a progress indicator will gradually fill/turn blue while `thor2` writes the full firmware image. **Do not disconnect until it reaches 100%.** If an error appears before 100%, disconnect, reconnect, and re-run the same command.

---

## Step 6 — First Boot

Once flashing completes, the phone will restart automatically. You'll see the Nokia or Microsoft boot logo — that's expected and not a sign of failure. After roughly 10–15 minutes, the phone will boot fully and prompt you through initial language/region setup, same as a factory-new device.

---

## Verified Sources

| Source | Status |
|---|---|
| XDA — "Finally... unbrick your Lumia device QHSUSB_DLOAD without JTAG" | ✅ Live, active, dated posts confirm it still works on modern Windows: https://xdaforums.com/t/finally-unbrick-your-lumia-device-qhsusb_dload-without-jtag.3082592/ |
| LumiaFirmware (`.ffu` downloads by RM code) | ✅ Live, actively maintained: https://lumiafirmware.com/ |
| 7-Zip | ✅ Standard, verified tool: https://www.7-zip.org/ |
| `db.tt/aGTK0qcsok` (original "Tools to Unbrick Lumia.zip" mirror) | ⚠️ Unverifiable — old Dropbox short-link, prone to link rot. Use the XDA thread's own attachments instead. |

---

### Key Corrections/Additions Made to the Original Tutorial

1. **RKH-to-filename matching**: the original "first 10 digits" instruction is corrected to **first 40 hex characters (20 bytes)** of the RKH string, based on multiple independent confirmations in the XDA thread.
2. **File source**: the original Dropbox mirror is flagged as unverifiable; the XDA thread's own attachments are the actively-maintained, community-supported alternative.
3. **Simpler first attempt**: added the "Simple method" note — recent WDRT versions (2.10+) can sometimes recover DLOAD-mode phones automatically without any manual `thor2` commands.
4. **Retry guidance**: added the XDA-sourced detail that getting the red screen commonly takes 3–4 attempts, which the original tutorial didn't mention and which can otherwise make someone think the process has failed when it hasn't.
