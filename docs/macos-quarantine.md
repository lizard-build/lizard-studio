# macOS file quarantine

Chrome enables `LSFileQuarantineEnabled`. Its native-messaging children can
inherit that state, including tools that install Python wheels or unpack native
modules. macOS can then block those modules when a later command loads them.

The router starts both agent hosts through `launchd` on macOS. This covers
agent commands, the shared `bashExec` handler and host updates. A launch failure
reports an error and closes the affected host; it never starts a replacement
directly from Chrome. Linux and Windows keep direct child processes.

The host relay sets `LIZARD_STUDIO_ROUTER_PID` to its own PID before starting
the host. The legacy Claude entry point compares that marker with its actual
parent, so it runs the host instead of opening another router.

Host protocol version 33 lets the updated panel request a host update from
older installations. The existing installer and updater already ship the relay
module, so this change adds no runtime files to the package manifest.

## Check on macOS

Run `npm test`, then `node test/e2e/macos-quarantine.mjs` from a logged-in desktop
session with Xcode command-line tools installed. The second check opens a
temporary Cocoa app with Chrome's quarantine setting. It checks that:

- A file written directly by that app has `com.apple.quarantine`.
- Files written by the host relay's child and its shell child do not.
- The host sees the correct parent marker.
- The relay preserves native-messaging bytes, including the final output.

The check keeps its fixtures in the temporary directory it prints. It does not
change Chrome, the installed helper or macOS security settings.

## Existing files

The new launch path does not clear attributes on existing files. A previously
marked wheel cache or virtual environment can still fail to load. Restore the
affected package from a verified source using the fixed helper or Terminal,
without reusing the marked cache. Keep this repair scoped to the affected
dependencies; do not clear quarantine across a user's home directory.
