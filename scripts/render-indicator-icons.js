// Renders the panel indicator's four icons, large and at their size on a 2x
// screen, on a dark and a light panel: docs/indicator-icons.png, shown in
// the README so the indicator can be recognized.
// Run from the repo root: gjs -m scripts/render-indicator-icons.js

import Cairo from 'cairo';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Rsvg from 'gi://Rsvg?version=2.0';

const ICON_DIR = 'gnome-extension/lyrics-overlay@ernop/icons';
const OUTPUT = 'docs/indicator-icons.png';
// The color the icon files are drawn in; the shell recolors it to the panel's text color.
const DRAWN_COLOR = '#2e3436';

const STATES = [
    {file: 'lyrics-on-symbolic.svg', label: 'Overlay on'},
    {file: 'lyrics-on-none-symbolic.svg', label: 'On, no timed lyrics'},
    {file: 'lyrics-off-symbolic.svg', label: 'Overlay off'},
    {file: 'lyrics-off-none-symbolic.svg', label: 'Off, no timed lyrics'},
];
const PANELS = [
    {title: 'On a dark panel', background: [0, 0, 0], ink: '#ffffff'},
    {title: 'On a light panel', background: [1, 1, 1], ink: '#000000'},
];

const CELL_WIDTH = 270;
const TITLE_HEIGHT = 44;
const BAND_HEIGHT = 200;
const LARGE = 96;
const PANEL_SIZE = 32;

function iconHandle(file, ink) {
    const [, bytes] = GLib.file_get_contents(`${ICON_DIR}/${file}`);
    const svg = new TextDecoder().decode(bytes);
    if (!svg.includes(DRAWN_COLOR))
        throw new Error(`${file} is not drawn in ${DRAWN_COLOR}`);
    return Rsvg.Handle.new_from_data(new TextEncoder().encode(svg.replaceAll(DRAWN_COLOR, ink)));
}

function drawText(cr, text, font, x, y, width) {
    const layout = PangoCairo.create_layout(cr);
    layout.set_font_description(Pango.FontDescription.from_string(font));
    layout.set_width(width * Pango.SCALE);
    layout.set_alignment(Pango.Alignment.CENTER);
    layout.set_text(text, -1);
    cr.moveTo(x, y);
    PangoCairo.show_layout(cr, layout);
}

const width = CELL_WIDTH * STATES.length;
const height = (TITLE_HEIGHT + BAND_HEIGHT) * PANELS.length;
const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, width, height);
const cr = new Cairo.Context(surface);
PANELS.forEach((panel, row) => {
    const top = row * (TITLE_HEIGHT + BAND_HEIGHT);
    cr.setSourceRGB(...panel.background);
    cr.rectangle(0, top, width, TITLE_HEIGHT + BAND_HEIGHT);
    cr.fill();
    const ink = Number.parseInt(panel.ink.slice(1, 3), 16) / 255;
    cr.setSourceRGB(ink, ink, ink);
    drawText(cr, panel.title, 'Sans Bold 18', 0, top + 10, width);
    STATES.forEach((state, column) => {
        const left = column * CELL_WIDTH;
        const handle = iconHandle(state.file, panel.ink);
        const iconsTop = top + TITLE_HEIGHT + 12;
        const gap = 28;
        const x = left + (CELL_WIDTH - LARGE - gap - PANEL_SIZE) / 2;
        handle.render_document(cr, new Rsvg.Rectangle({x, y: iconsTop, width: LARGE, height: LARGE}));
        handle.render_document(cr, new Rsvg.Rectangle({
            x: x + LARGE + gap, y: iconsTop + LARGE - PANEL_SIZE, width: PANEL_SIZE, height: PANEL_SIZE,
        }));
        cr.setSourceRGB(ink, ink, ink);
        drawText(cr, state.label, 'Sans Bold 15', left, iconsTop + LARGE + 18, CELL_WIDTH);
    });
});
cr.$dispose();
surface.writeToPNG(OUTPUT);
print(`wrote ${OUTPUT}`);
