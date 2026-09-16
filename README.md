# Image Library

A Windows desktop app for browsing, searching, and organizing folders of images (clipart, photos, patterns, mockups).

## Start it
Double-click **Start Image Library.cmd**, or run `npm start` in this folder.
(First time on a new computer: run `npm install` here first. It needs Node.js.)

## First-time setup
1. Click **+** next to *Folders* (or *Add a folder*) and pick your image folders.
2. Open **Settings** (gear icon) and paste a Claude API key from console.anthropic.com.
   The key is stored encrypted on this computer.

## What it does
- **Thumbnails + AI search**: Claude describes every image (title, description, tags, colors, style, category, text in the image).
  Search like `red floral watercolor`, `christmas -tree`, `tag:wedding`, `color:navy`, `ext:png`, `folder:christmas`, `"exact phrase"`.
- **Zip files**: zips in your folders are unzipped into the same folder, then the zip is sent to the Recycle Bin
  (switch to permanent delete in Settings). Zips that were just added wait 10 seconds so a copy/download can finish.
- **Use images in Canva, Photoshop, etc.**: drag a thumbnail (or several) out of the app, or
  *Copy file* (Ctrl+C) to paste the file, or *Copy image* to paste the pixels.
- **Folders**: create real folders on disk, move images by dragging them onto a folder in the sidebar or with *Move to…*.
  Files dragged in from Explorer are copied in.
- **Albums**: hand-picked sets. Add with *Add to album* or drag images onto an album.
- **Smart collections**: saved rules (search words, category, style, color, folder, file type, date) that stay up to date.
- **Groups**: organize albums and smart collections under a named heading.
- **Batch rename** (F2): patterns with `{name}` `{title}` `{category}` `{folder}` `{n}` `{date}`, find/replace, case, and spaces, with a live preview.
- **Duplicates**: finds identical files, and optionally visually similar ones (resized/re-saved). Shows every location;
  keep, move, or delete copies one by one or with a rule (keep highest resolution, largest, oldest, newest, shortest path).
  Deleted files go to the Recycle Bin.

## Cost
Images are shrunk to 1024px before being sent. With Claude Opus 5 that's very roughly 1-2 cents per image.
Choose Sonnet 5 or Haiku 4.5 in Settings for lower cost. Each image is analyzed once; moved, renamed, and duplicate files reuse the result.

## Shared library (all PCs)
Descriptions, albums, smart collections, groups, the folder list, and the AI model are stored in
`X:\ETSY\Image Library\library-data`, so every PC sees the same library and each image is only described once.
Changes from other PCs appear within a few seconds. To use a different shared folder: Settings > Shared library data > Change.

Kept on each PC (in `%APPDATA%\Image Library`): the API key (encrypted for that Windows user), thumbnails,
and the options for auto-describe, zip extraction, folder watching, and how many images are described at once.
Tip: turn on zip extraction on just one PC.

## Other ways to run it
- **Image Library (portable)** folder: double-click `Image Library.exe`. Needs no Node.js.
- **Installer (.exe)**: on a PC that allows it, copy this folder to a local drive and run `npm install` then `npm run dist`.
  The installer appears in `installer\`. Or push this folder to a GitHub repository and run the
  "Build Windows installer" workflow from the Actions tab.
  The installer is not code-signed, so Windows SmartScreen will warn on first run, and company-managed PCs may block it.