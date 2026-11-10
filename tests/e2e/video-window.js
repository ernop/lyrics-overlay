// A stand-in for a browser playing a song's video, for the README's desktop
// picture (tests/e2e/readme-desktop.mjs): the video with its controls, the
// title and channel, and an up-next list, in the dark style. Every name in
// it is made up; video-frame.jpg is a generated image.
//
//   gjs -m video-window.js <title>

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

const HERE = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const TITLE = System.programArgs[0];
const UP_NEXT = [
    ['Be Thou My Vision', 'The Chapel Sessions', '#7a3b12', '#e7a14a'],
    ['Shenandoah', 'Riverside Folk', '#123a5a', '#5fa8d3'],
    ['The Water Is Wide', 'Harbor Lane Trio', '#2d4a2b', '#9cc58a'],
    ['Down to the River to Pray', 'The Chapel Sessions', '#4a2142', '#d58bc2'],
    ['Simple Gifts', 'Meadow Choir', '#5a4a12', '#e9d36b'],
];

const CSS = `
window, .page { background: #0f0f0f; }
label { color: #fff; }
.controls { background: linear-gradient(to bottom, rgba(0, 0, 0, 0), rgba(0, 0, 0, 0.8)); padding: 28px 18px 12px; }
.controls image { color: #fff; }
.controls progressbar trough { min-height: 5px; border-radius: 3px; background: rgba(255, 255, 255, 0.35); }
.controls progressbar progress { min-height: 5px; border-radius: 3px; background: #ff3b30; }
.video-title { font-size: 24px; font-weight: 800; }
.channel { font-size: 16px; font-weight: 700; }
.small { font-size: 14px; }
.next-heading { font-size: 18px; font-weight: 800; }
.next-title { font-size: 15px; font-weight: 700; }
${UP_NEXT.map(([, , from, to], index) =>
        `.thumb-${index} { border-radius: 10px; background: linear-gradient(135deg, ${from}, ${to}); }`).join('\n')}
`;

function label(text, cssClass, options = {}) {
    return new Gtk.Label({label: text, css_classes: [cssClass], xalign: 0, wrap: true, ...options});
}

function videoArea() {
    const picture = Gtk.Picture.new_for_file(Gio.File.new_for_path(GLib.build_filenamev([HERE, 'video-frame.jpg'])));
    picture.content_fit = Gtk.ContentFit.COVER;
    const controls = new Gtk.Box({spacing: 16, valign: Gtk.Align.END, css_classes: ['controls']});
    controls.append(new Gtk.Image({icon_name: 'media-playback-pause-symbolic', pixel_size: 22}));
    controls.append(label('0:13 / 3:42', 'small', {wrap: false}));
    controls.append(new Gtk.ProgressBar({fraction: 13 / 222, hexpand: true, valign: Gtk.Align.CENTER}));
    controls.append(new Gtk.Image({icon_name: 'audio-volume-high-symbolic', pixel_size: 22}));
    controls.append(new Gtk.Image({icon_name: 'view-fullscreen-symbolic', pixel_size: 22}));
    const overlay = new Gtk.Overlay({child: picture});
    overlay.add_overlay(controls);
    return new Gtk.AspectFrame({ratio: 16 / 9, obey_child: false, child: overlay, xalign: 0, valign: Gtk.Align.START});
}

function mainColumn() {
    const column = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 14, hexpand: true});
    column.append(videoArea());
    column.append(label(`${TITLE} (live at the chapel)`, 'video-title'));
    const channel = new Gtk.Box({spacing: 12});
    channel.append(new Adw.Avatar({size: 44, text: 'The Chapel Sessions', show_initials: true}));
    const names = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER});
    names.append(label('The Chapel Sessions', 'channel'));
    names.append(label('A traditional hymn, sung live. Words by John Newton, 1779.', 'small'));
    channel.append(names);
    column.append(channel);
    return column;
}

function upNext() {
    const list = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 14, width_request: 400});
    list.append(label('Up next', 'next-heading'));
    UP_NEXT.forEach(([title, channel], index) => {
        const row = new Gtk.Box({spacing: 12});
        row.append(new Gtk.Box({css_classes: [`thumb-${index}`], width_request: 168, height_request: 94}));
        const text = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4, valign: Gtk.Align.CENTER});
        text.append(label(title, 'next-title'));
        text.append(label(channel, 'small'));
        row.append(text);
        list.append(row);
    });
    return list;
}

Adw.init();
Adw.StyleManager.get_default().color_scheme = Adw.ColorScheme.FORCE_DARK;
const provider = new Gtk.CssProvider();
provider.load_from_string(CSS);
Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

const page = new Gtk.Box({spacing: 28, margin_top: 22, margin_bottom: 22, margin_start: 28, margin_end: 28, css_classes: ['page']});
page.append(mainColumn());
page.append(upNext());
const toolbar = new Adw.ToolbarView({content: page});
toolbar.add_top_bar(new Adw.HeaderBar({title_widget: new Adw.WindowTitle({title: TITLE})}));

const loop = new GLib.MainLoop(null, false);
const window = new Adw.Window({title: TITLE, content: toolbar, default_width: 1240, default_height: 640});
window.connect('close-request', () => {
    loop.quit();
    return false;
});
window.present();
loop.run();
