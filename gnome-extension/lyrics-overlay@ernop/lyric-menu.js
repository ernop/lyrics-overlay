// The lyric's own menu: a right press on the lyric opens the indicator's
// menu contents at the pointer, so the settings, the pitch trace and the
// song controls are reachable without finding the panel icon. Built the way
// GNOME's desktop background menu is: a popup on the layout manager's dummy
// cursor, moved to the press point before it opens.

import St from 'gi://St';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {LyricsMenu} from './indicator.js';

export class LyricContextMenu {
    /** @param {Omit<ConstructorParameters<typeof LyricsMenu>[0], 'menu'>} options */
    constructor(options) {
        this._menu = new PopupMenu.PopupMenu(Main.layoutManager.dummyCursor, 0, St.Side.TOP);
        Main.layoutManager.uiGroup.add_child(this._menu.actor);
        this._menu.actor.hide();
        this._manager = new PopupMenu.PopupMenuManager(this._menu.actor);
        this._manager.addMenu(this._menu);
        this._contents = new LyricsMenu({...options, menu: this._menu});
    }

    get isOpen() {
        return this._menu.isOpen;
    }

    /** @param {{x: number, y: number}} point stage coordinates of the press */
    open({x, y}) {
        const layout = Main.layoutManager;
        layout.setDummyCursorGeometry(x, y, 0, 0);
        // The menu opens below the press, or above it when only that side
        // has room, and never shrinks to fit; capped at the larger side, its
        // items scroll instead of running off the screen.
        const workArea = layout.getWorkAreaForMonitor(layout.findIndexForActor(layout.dummyCursor));
        const actor = this._menu.actor;
        const room = Math.max(y - workArea.y, workArea.y + workArea.height - y) -
            actor.get_theme_node().get_length('-boxpointer-gap') - actor.margin_top - actor.margin_bottom;
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        actor.style = `max-height: ${Math.floor(room / scaleFactor) - 1}px;`;
        this._menu.open(BoxPointer.PopupAnimation.FULL);
    }

    close() {
        this._menu.close();
    }

    setState(state) {
        this._contents.setState(state);
    }

    destroy() {
        this._contents.destroy();
        this._manager.removeMenu(this._menu);
        this._menu.destroy();
    }
}
