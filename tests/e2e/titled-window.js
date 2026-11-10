// A plain window with the title given as its argument, opened by the shell
// e2e test inside the hermetic headless shell to stand in for a browser
// window: `gjs -m titled-window.js <title>`.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

Gtk.init();
const loop = new GLib.MainLoop(null, false);
const window = new Gtk.Window({title: System.programArgs[0], default_width: 480, default_height: 320});
window.connect('close-request', () => {
    loop.quit();
    return false;
});
window.present();
loop.run();
