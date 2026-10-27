import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Normal browser windows only; PWAs get their own <browser>-<id>-Default class.
const BROWSER_CLASSES = ['google-chrome', 'brave-browser'];

// How long after a browser starts its windows are still matched against the
// saved ones. Restoring after a logout goes through the "Restore pages?"
// bubble, so this has to allow for the user getting round to clicking it.
const RESTORE_PERIOD_MS = 5 * 60 * 1000;

const SAVE_DELAY_MS = 1000;

const STATE_FILE = GLib.build_filenamev([GLib.get_user_state_dir(), 'browser-workspaces.json']);

// enable() runs again after every unlock; only the first one is at login,
// when the browsers' autostarted windows may already be up.
let loggedIn = false;

// Counters such as "Inbox (3)" change between saving and restoring.
function normalize(title) {
    return (title ?? '').replace(/\d+/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export default class BrowserWorkspacesExtension extends Extension {
    enable() {
        this._saved = this._load();
        this._pending = new Map();
        this._windows = new Map();
        this._waiting = new Map();
        this._saveId = 0;
        this._moving = false;

        this._createdId = global.display.connect('window-created',
            (display, window) => this._track(window, true));

        for (const window of global.display.list_all_windows())
            this._track(window, false);

        if (!loggedIn) {
            for (const cls of BROWSER_CLASSES)
                this._arm(cls);
            for (const window of this._windows.keys())
                this._match(window);
        }
        loggedIn = true;
    }

    disable() {
        if (this._saveId)
            GLib.Source.remove(this._saveId);
        this._saveId = 0;

        for (const pending of this._pending.values())
            GLib.Source.remove(pending.timeoutId);
        this._pending = null;

        global.display.disconnect(this._createdId);
        this._createdId = null;

        for (const window of [...this._windows.keys()])
            this._untrack(window);
        this._windows = null;

        for (const [window, id] of this._waiting)
            window.disconnect(id);
        this._waiting = null;

        this._saved = null;
    }

    _load() {
        try {
            const [, bytes] = GLib.file_get_contents(STATE_FILE);
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            return {};
        }
    }

    // A window present when the extension is enabled is the user's to place,
    // except at login, when nothing has been placed yet.
    _track(window, isNew) {
        if (window.window_type !== Meta.WindowType.NORMAL)
            return;
        const cls = window.get_wm_class();

        // A Wayland client sets its app id only after the window is created.
        if (!cls && isNew) {
            this._waiting.set(window, window.connect('notify::wm-class', () => {
                window.disconnect(this._waiting.get(window));
                this._waiting.delete(window);
                this._track(window, true);
            }));
            return;
        }
        if (!BROWSER_CLASSES.includes(cls))
            return;

        if (isNew && !this._classWindows(cls).length)
            this._arm(cls);

        const state = {cls, placed: !isNew && loggedIn, workspace: window.get_workspace()};
        state.ids = [
            window.connect('notify::title', () => {
                this._match(window);
                this._queueSave();
            }),
            window.connect('workspace-changed', () => {
                // Moved by the user rather than by us: leave it where they put it.
                const workspace = window.get_workspace();
                if (!this._moving && state.workspace && workspace !== state.workspace)
                    state.placed = true;
                state.workspace = workspace;
                this._queueSave();
            }),
            // At logout the browsers are killed and their windows go one by one;
            // a save landing in the middle of that would forget the rest. So a
            // closing window only drops out of the record at the next change.
            window.connect('unmanaged', () => {
                this._untrack(window);
                this._cancelSave();
            }),
        ];
        this._windows.set(window, state);

        if (isNew) {
            this._match(window);
            this._queueSave();
        }
    }

    _untrack(window) {
        for (const id of this._windows.get(window).ids)
            window.disconnect(id);
        this._windows.delete(window);
    }

    _classWindows(cls) {
        return [...this._windows].filter(([, state]) => state.cls === cls).map(([window]) => window);
    }

    _arm(cls) {
        const records = this._saved[cls];
        if (!records?.length)
            return;

        if (this._pending.has(cls))
            GLib.Source.remove(this._pending.get(cls).timeoutId);

        this._pending.set(cls, {
            records: records.map(record => ({...record, key: normalize(record.title)})),
            endsAt: Date.now() + RESTORE_PERIOD_MS,
            timeoutId: GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESTORE_PERIOD_MS, () => {
                this._pending.delete(cls);
                this._queueSave();
                return GLib.SOURCE_REMOVE;
            }),
        });
    }

    _endRestore(cls) {
        GLib.Source.remove(this._pending.get(cls).timeoutId);
        this._pending.delete(cls);
        this._queueSave();
    }

    _match(window) {
        const state = this._windows.get(window);
        const pending = this._pending.get(state.cls);
        if (state.placed || !pending)
            return;

        // The browser's own startup window, before anything is restored into it.
        const key = normalize(window.get_title());
        if (!key || key.startsWith('new tab'))
            return;

        const index = pending.records.findIndex(record => record.key === key);
        if (index < 0)
            return;
        const [record] = pending.records.splice(index, 1);

        this._ensureWorkspaces(Math.max(record.workspace, ...pending.records.map(r => r.workspace)),
            pending.endsAt - Date.now());

        state.placed = true;
        this._moving = true;
        window.change_workspace_by_index(record.workspace, false);
        this._moving = false;

        if (!pending.records.length)
            this._endRestore(state.cls);
    }

    // With dynamic workspaces only a single empty one is kept, at the end. A
    // window bound for workspace 4 can arrive while 2 and 3 are still empty,
    // and they would be removed under it, shifting it down; so keep them all
    // until the rest of the windows have had their chance to arrive.
    _ensureWorkspaces(last, duration) {
        const manager = global.workspace_manager;
        while (manager.n_workspaces <= last)
            manager.append_new_workspace(false, global.get_current_time());

        if (Meta.prefs_get_dynamic_workspaces()) {
            for (let i = 0; i <= last; i++)
                Main.wm.keepWorkspaceAlive(manager.get_workspace_by_index(i), Math.max(duration, 0));
        }
    }

    _queueSave() {
        if (this._saveId)
            return;

        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveId = 0;
            this._save();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelSave() {
        if (this._saveId)
            GLib.Source.remove(this._saveId);
        this._saveId = 0;
    }

    // A browser still restoring keeps its old record, which is what is being
    // matched against; one with no windows keeps it too, for its next start.
    _save() {
        for (const cls of BROWSER_CLASSES) {
            if (this._pending.has(cls))
                continue;

            const windows = this._classWindows(cls)
                .filter(window => window.get_workspace() && !window.is_on_all_workspaces())
                .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
            if (!windows.length)
                continue;

            this._saved[cls] = windows.map(window => ({
                title: window.get_title() ?? '',
                workspace: window.get_workspace().index(),
            }));
        }

        GLib.file_set_contents(STATE_FILE, JSON.stringify(this._saved, null, 2));
    }
}
