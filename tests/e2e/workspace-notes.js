// A light-mode notes window for the README's multi-workspace desktop picture
// (tests/e2e/readme-desktop.mjs). Pure fictional trail notes; no personal data.
//
//   gjs -m workspace-notes.js <title>

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

const TITLE = System.programArgs[0] || 'Notes';

const NOTES_LIST = [
    ['Autumn river loop', 'Today · 6 items', true],
    ['Packing checklist', 'Yesterday', false],
    ['Trailhead maps', 'Oct 12', false],
    ['Camp stove notes', 'Oct 4', false],
    ['Reading list', 'Sep 29', false],
];

const CHECKLIST = [
    [true, 'Start at the ridge overlook right after sunrise (06:45)'],
    [true, 'Download offline topographic map tiles for the valley loop'],
    [false, 'Cross the wooden footbridge and follow the river bend north'],
    [false, 'Stop by the small general store in town for hot cider'],
    [false, 'Catch the golden-hour light from the west meadow before dusk'],
    [false, 'Pack a warm wool layer and light rain shell'],
];

const CSS = `
window { background: #ffffff; color: #161a22; }
headerbar { background: #f5f7fa; border-bottom: 1px solid #e1e6ee; }
.sidebar { background: #f5f7fa; border-right: 1px solid #e1e6ee; padding: 14px 10px; }
.sidebar-head { font-size: 12px; font-weight: 800; color: #4a5568; letter-spacing: 0.06em; padding: 4px 10px 8px; }
.note-row { padding: 10px 12px; border-radius: 8px; }
.note-row-active { background: #dbeafe; }
.note-title { font-size: 14px; font-weight: 700; color: #111827; }
.note-meta { font-size: 12px; color: #475569; }
.doc { background: #ffffff; padding: 26px 32px; }
.doc-title { font-size: 26px; font-weight: 800; color: #0f172a; }
.tag { background: #eef2ff; color: #3730a3; border-radius: 999px; padding: 3px 10px; font-size: 12px; font-weight: 700; }
.tag-amber { background: #fef3c7; color: #92400e; }
.doc-body { font-size: 15px; color: #1e293b; }
.section-head { font-size: 14px; font-weight: 800; color: #0f172a; margin-top: 8px; }
.check-box { font-size: 15px; font-weight: 700; color: #2563eb; min-width: 20px; }
.check-open { color: #64748b; }
.check-text { font-size: 14px; color: #1e293b; }
.check-done { color: #475569; }
.callout { background: #f8fafc; border: 1px solid #e2e8f0; border-left: 4px solid #3b82f6; border-radius: 8px; padding: 12px 16px; }
.callout-text { font-size: 14px; color: #1e293b; }
`;

function label(text, cssClass, options = {}) {
    const classes = Array.isArray(cssClass) ? cssClass : [cssClass];
    return new Gtk.Label({label: text, css_classes: classes, xalign: 0, wrap: true, ...options});
}

function buildSidebar() {
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4, width_request: 196, css_classes: ['sidebar']});
    box.append(label('NOTEBOOKS', 'sidebar-head', {wrap: false}));
    for (const [name, meta, active] of NOTES_LIST) {
        const row = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 2,
            css_classes: active ? ['note-row', 'note-row-active'] : ['note-row']});
        row.append(label(name, 'note-title', {wrap: false}));
        row.append(label(meta, 'note-meta', {wrap: false}));
        box.append(row);
    }
    return box;
}

function buildDocument() {
    const doc = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 14, hexpand: true, css_classes: ['doc']});
    doc.append(label('Autumn river loop', 'doc-title'));

    const tags = new Gtk.Box({spacing: 8});
    tags.append(label('Weekend', ['tag', 'tag-amber'], {wrap: false}));
    tags.append(label('Trail plan', 'tag', {wrap: false}));
    tags.append(label('River valley', 'tag', {wrap: false}));
    doc.append(tags);

    doc.append(label(
        'Keep the morning easy and mostly along the water. The valley trail stays quiet until mid-morning, and the ridge switchbacks dry out quickly once the sun clears the trees.',
        'doc-body',
    ));

    doc.append(label('Day plan', 'section-head'));
    const list = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 9});
    for (const [done, text] of CHECKLIST) {
        const row = new Gtk.Box({spacing: 10});
        row.append(label(done ? '[x]' : '[ ]', done ? 'check-box' : ['check-box', 'check-open'], {wrap: false}));
        row.append(label(text, done ? ['check-text', 'check-done'] : 'check-text'));
        list.append(row);
    }
    doc.append(list);

    const callout = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4, css_classes: ['callout']});
    callout.append(label('Note: the lower bridge trail adds about 25 minutes on the return leg and avoids the steep gravel road.', 'callout-text'));
    doc.append(callout);
    return doc;
}

Adw.init();
Adw.StyleManager.get_default().color_scheme = Adw.ColorScheme.FORCE_LIGHT;
const provider = new Gtk.CssProvider();
provider.load_from_string(CSS);
Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

const body = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL});
body.append(buildSidebar());
body.append(buildDocument());

const toolbar = new Adw.ToolbarView({content: body});
toolbar.add_top_bar(new Adw.HeaderBar({title_widget: new Adw.WindowTitle({title: TITLE})}));

const loop = new GLib.MainLoop(null, false);
const window = new Adw.Window({title: TITLE, content: toolbar, default_width: 758, default_height: 814});
window.connect('close-request', () => {
    loop.quit();
    return false;
});
window.present();
loop.run();
