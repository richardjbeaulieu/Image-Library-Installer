# Image Library

Browse, search, and organize folders of images (clipart, photos, patterns, mockups).
It runs two ways from the same code:

- **Web app on the NAS (recommended):** runs in Docker on NewFileServer; everyone opens it in a browser. Nothing to install on PCs.
- **Windows desktop app:** runs on each PC (can be blocked on locked-down PCs; see the end of this file).

## What it does
- **Thumbnails + AI search**: Claude describes every image (title, description, tags, colors, style, category, text in the image).
  Search like `red floral watercolor`, `christmas -tree`, `tag:wedding`, `color:navy`, `ext:png`, `folder:christmas`, `zip:"floral bundle"`, `"exact phrase"`.
- **Zip files**: zips in the library folders are unzipped into the same folder, then the zip is deleted (to the trash).
  Extracted files remember the zip they came from (shown in the Info panel, searchable with `zip:`), including the outer zip when zips contain zips.
  After extracting, the zip is moved to the archive folder set in Settings (or deleted if that is empty); the archive folder is never scanned.
  If a zip's files would land loose in the folder, they go into a new folder named after the zip (Settings can turn this off);
  zips that already contain a folder are extracted as they are.
  Zips that were just added wait 10 seconds so a copy or download can finish.
- **Folders**: create real folders, move images by dragging them onto a folder in the sidebar or with *Move to…*.
- **Albums**: hand-picked sets. Add with *Add to album* or drag images onto an album.
- **Smart collections**: saved rules (search words, category, style, color, folder, file type, date) that stay up to date.
- **Groups**: organize albums and smart collections under a named heading.
- **Batch rename** (F2): patterns with `{name}` `{title}` `{category}` `{folder}` `{n}` `{date}`, find/replace, case, and spaces, with a live preview.
- **Remove background**: for clipart on a solid background, creates a copy named `<name> (transparent).png` next to the original,
  with a live preview, a tolerance slider, optional edge softening, and an option to clear matching areas enclosed by the artwork.
  Works on several images at once; it refuses photos and busy backgrounds rather than producing a useless copy.
- **Duplicates**: finds identical files, and optionally visually similar ones (resized or re-saved). Shows every location;
  keep, move, or delete copies one by one or with a rule (keep highest resolution, largest, oldest, newest, shortest path).

## Cost
Images are shrunk to 1024px before being sent. With Claude Opus 5 that's very roughly 1-2 cents per image.
Choose Sonnet 5 or Haiku 4.5 in Settings for lower cost. Each image is described once; moved, renamed, and duplicate files reuse the result.

---

## Web app on the NAS

### How it works
- GitHub builds the server as a Docker image whenever the code changes (workflow **Build NAS server image**)
  and publishes it as `ghcr.io/richardjbeaulieu/image-library`.
- The NAS runs that image. The image folders are mounted into it, so it reads them straight from the NAS's disks.
- Open **http://newfileserver:8787** in Chrome or Edge on any PC connected to Tailscale.

### One-time setup
1. **Publish the image.** Push this folder to GitHub (`git push`). In the repository's **Actions** tab, wait for
   **Build NAS server image** to finish (green check).
2. **Let the NAS download it.** On GitHub, open your profile > **Packages** > **image-library** > **Package settings** >
   **Change visibility** > **Public**. (Or keep it private and add a GitHub token as a registry login in the UGOS Docker app.)
3. **Create the container.** In UGOS, open the **Docker** app > **Project** > **Create**, name it `image-library`,
   and paste the contents of `deploy/docker-compose.yml`. Check the two folder paths on the left of the `volumes` lines:
   - the NAS folder that `X:\ETSY` points to (often `/volume1/Files/ETSY`)
   - a folder for the app's data, e.g. `/volume1/docker/image-library` (create it first)
4. Start the project, open **http://newfileserver:8787**, click **Add a folder**, and add a Claude API key in **Settings**.

### Updating
After pushing changes, wait for the build, then in the UGOS Docker app pull the `latest` image for the project and restart it.

### Differences from the desktop app
- **Download** replaces *Copy file*; several images download as one zip.
- **Drag** thumbnails into Canva (in the browser) or onto the desktop/a folder (Chrome and Edge save the file).
- **Drop files from your PC** onto a folder in the sidebar to upload them.
- **Copy folder path** replaces *Show in folder* (paste into File Explorer).
- **Copy image** needs a secure `https://` address (planned: Tailscale HTTPS).
- **Deleted files** go to a hidden `.image-library-trash` folder inside each library folder and are removed after 30 days.

### Where data lives
Everything (descriptions, albums, collections, settings including the API key, thumbnails) is in the data folder mounted at `/data`.
Back it up along with the NAS.

---

## Windows desktop app

- Run from this folder: double-click **Start Image Library.cmd** (needs Node.js; runs `npm install` the first time).
- **Image Library (portable)** folder: double-click `Image Library.exe`.
- **Installer**: GitHub Actions workflow **Build Windows installer**, or `npm run dist` on a PC that allows it.
  The installer is not code-signed, so Windows may block it (Smart App Control, company policy).

The desktop app shares its library through `X:\ETSY\Image Library\library-data` (descriptions, albums, collections, folder list, model).
Kept on each PC in `%APPDATA%\Image Library`: the API key (encrypted for that Windows user), thumbnails, and personal options.
The desktop app and the NAS web app keep separate libraries.
