# Firmware images served to the adapter

The Tesla page and the phone page download `<base>/<branch>/version.json` from `main` and then the image named there. GitHub release assets are not sent with CORS headers, so the in-page updater reads the copy on this branch through raw.githubusercontent.com. Each file is also attached to the matching GitHub release for manual download.
