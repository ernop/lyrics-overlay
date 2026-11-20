// gjs: paints one lyric with the shell extension's paintLyric and reports
// the color found around the center of its ink, by distance and angle.
// Usage: gjs -m paint-lyric-ring.js <dir with text-layout.js and shared/> <png> <text> [font size] [border] [family]
// Prints JSON {ring, spaceScale, inkRadius, center, auraRgb, midlineBgPixels, fontSize, requiredHeight, samples}.
import Cairo from 'cairo';
import GdkPixbuf from 'gi://GdkPixbuf';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

const [dir, png, text, size = '220', border = 'double', family = 'Sans'] = ARGV;
const {fitLyric, paintLyric} = await import(`file://${dir}/text-layout.js`);

const WIDTH = 800, HEIGHT = 600;
const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, WIDTH, HEIGHT);
const cr = new Cairo.Context(surface);
cr.setSourceRGB(0, 0, 1);
cr.paint();
const context = PangoCairo.FontMap.get_default().create_context();
const fitted = fitLyric(context, text, {
    fontSize: Number(size), family, bold: true, color: 'yellow', border,
    align: 'center', anchor: 'center', width: WIDTH, height: HEIGHT,
});
paintLyric(cr, fitted);
cr.$dispose();
surface.writeToPNG(png);

const reach = fitted.ring.inner + fitted.ring.outer;
const box = fitted.inkBox;
const center = {x: box.x + box.width / 2, y: box.y + box.height / 2};
const rx = box.width / 2 - reach;
const ry = box.height / 2 - reach;
const pixbuf = GdkPixbuf.Pixbuf.new_from_file(png);
const pixels = pixbuf.get_pixels();
const stride = pixbuf.get_rowstride(), channels = pixbuf.get_n_channels();
const pixelAt = (px, py) => {
    const x = Math.max(0, Math.min(WIDTH - 1, Math.round(px)));
    const y = Math.max(0, Math.min(HEIGHT - 1, Math.round(py)));
    const at = y * stride + x * channels;
    return [pixels[at], pixels[at + 1], pixels[at + 2]];
};

const samples = [];
const maxR = fitted.ring.inner + fitted.ring.outer;
for (let offset = 3; offset < maxR - 2; offset += 2) {
    for (let step = 0; step < 32; step++) {
        const angle = step * Math.PI / 16;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        samples.push({
            distance: offset,
            angle: step,
            rgb: pixelAt(center.x + (rx + offset) * cos, center.y + (ry + offset) * sin),
        });
    }
}

// Compute the first line's exact x-height midline for word-gap scanning.
const measure = Pango.Layout.new(context);
const desc = new Pango.FontDescription();
desc.set_family(family);
desc.set_weight(Pango.Weight.BOLD);
desc.set_absolute_size(Number(size) * Pango.SCALE);
measure.set_font_description(desc);
measure.set_text(text, -1);
const baseline = measure.get_iter().get_baseline() / Pango.SCALE;
const midY = Math.round(fitted.origin.y + baseline + (fitted.fontMetrics.xTop + fitted.fontMetrics.xBottom) / 2);
let midlineBgPixels = 0;
const scanStart = Math.round(box.x + reach + 2);
const scanEnd = Math.round(box.x + box.width - reach - 2);
for (let x = scanStart; x <= scanEnd; x++) {
    const [r, , b] = pixelAt(x, midY);
    if (b > 100 && r < 40)
        midlineBgPixels++;
}

const auraY = Math.round(fitted.origin.y + baseline + fitted.fontMetrics.xBottom + reach + 8);
const auraRgb = pixelAt(center.x, auraY);
print(JSON.stringify({
    ring: fitted.ring,
    spaceScale: fitted.spec.spaceScale,
    inkRadius: Math.max(rx, ry),
    center: pixelAt(center.x, center.y),
    auraRgb,
    midlineBgPixels,
    lineCount: fitted.lineCount,
    fontSize: fitted.spec.fontSize,
    requiredHeight: fitted.requiredHeight,
    samples,
}));
