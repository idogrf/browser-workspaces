# Browser Workspaces

A GNOME Shell extension that puts Chrome and Brave windows back on the
workspaces they were on, when they are restored after logging out and back in.

On X11 Chrome saves each window's workspace in its session and restores it. On
Wayland a client cannot choose its workspace, so every restored window lands on
whichever workspace is active.

## How it works

While the browsers run, the extension records the title and workspace of every
normal Chrome (`google-chrome`) and Brave (`brave-browser`) window in
`~/.local/state/browser-workspaces.json`, a second after anything changes. PWAs
have their own window classes and are left alone.

When a browser starts — or at login, when it was autostarted — the windows that
appear in the next five minutes are matched to that record by title, with
digits ignored so counters like "Inbox (3)" still match. A matched window is
moved to its saved workspace, creating workspaces as needed. "New Tab" windows
are never matched, so the startup window waits until "Restore" fills it.

A window the user moves before it is matched is left where they put it.

## Limitations

- Matching is by the active tab's title. A window whose page loads with a
  different title than it had before stays on the current workspace.
- Windows closing during logout are not removed from the record, so the
  record is the state just before logging out. A window closed by hand drops out
  at the next change to any browser window.

## Install

```bash
ln -s ~/Private/Repos/gnome_extensions/browser-workspaces ~/.local/share/gnome-shell/extensions/browser-workspaces@idogr
gnome-extensions enable browser-workspaces@idogr
```

A newly added extension is picked up after logging out and back in.

## Uninstall

```bash
gnome-extensions disable browser-workspaces@idogr
rm ~/.local/share/gnome-shell/extensions/browser-workspaces@idogr ~/.local/state/browser-workspaces.json
```
