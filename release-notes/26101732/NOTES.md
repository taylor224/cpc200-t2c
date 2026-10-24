# T2C Tesla UI 26101732

No more automatic quality step-down (disconnects, then a huge picture), the adapter's UI log survives a power cut, and no DNS gap at Bluetooth internet (re)connects.

- The page no longer changes picture quality, frame rate or transport on its own. Builds up to 26101726 stepped the quality down after a Wi-Fi stall; each step restarted CarPlay and enlarged the UI. Picture size and UI size are now one setting with five quality levels, and a decoder that cannot keep up only shows a hint.
- Release notes are shown in the update dialog, on the car page and on the phone page. The car page checks for a new release 30 s after it connects and every 6 hours and shows a banner on the home screen; nothing installs by itself. A page left open across a firmware update reloads itself once.
- The end of the adapter's UI log is kept on flash: every 2 minutes, and within 15 s of a CarPlay drop together with the reason lines (session teardown, which device left Wi-Fi, DNS forwarder state). The previous boot's copy is kept as well. Diagnostics: t2cui_saved, t2cui_prev, t2cd_log. A firmware update clears these copies.
- A Bluetooth internet (PAN) connect no longer removes the adapter's DNS redirect for up to 20 s. In that window the car's connectivity check failed at once, which can make the car switch to LTE and drop the CarPlay page (close 1006, then "DNS address not found").
- The hotspot password no longer appears in the saved log.
- Known issue: when the phone leaves the adapter's Wi-Fi while Bluetooth stays connected, CarPlay does not come back by itself; power-cycle the adapter. A fix is in progress.
