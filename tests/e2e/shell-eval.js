// gjs helper: runs one org.gnome.Shell.Eval call and prints {ok, result} as
// JSON, so the node harness never parses GVariant text.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

const [code] = System.programArgs;
const reply = Gio.DBus.session.call_sync('org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell', 'Eval',
    new GLib.Variant('(s)', [code]), new GLib.VariantType('(bs)'), Gio.DBusCallFlags.NONE, 30000, null);
const [ok, result] = reply.deepUnpack();
print(JSON.stringify({ok, result}));
