// gjs: paints one lyric with the shell extension's paintLyric and reports
// the color found around the center of its ink, by distance and angle.
// Usage: gjs -m paint-lyric-ring.js <dir with text-layout.js and shared/> <png> <text> [font size] [border]
// Prints JSON {ring, inkRadius, center: rgb, fontSize, requiredHeight, samples: [{distance, angle, rgb}]}.
import Cairo from 'cairo';
import GdkPixbuf from 'gi://GdkPixbuf';
import PangoCairo from 'gi://PangoCairo';

const [dir, png, text, size = '220', border = 'double'] = ARGV;
const {fitLyric, paintLyric} = await import(`file://${dir}/text-layout.js`);

const WIDTH = 800, HEIGHT = 600;
const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, WIDTH, HEIGHT);
const cr = new Cairo.Context(surface);
cr.setSourceRGB(0, 0, 1);
cr.paint();
const context = PangoCairo.FontMap.get_default().create_context();
const fitted = fitLyric(context, text, {
    fontSize: Number(size), family: 'Sans', bold: true, color: 'yellow', border,
    align: 'center', anchor: 'center', width: WIDTH, height: HEIGHT,
});
paintLyric(cr, fitted);
cr.$dispose();
surface.writeToPNG(png);

const reach = fitted.ring.inner + fitted.ring.outer + fitted.ring.extraPad;
const box = fitted.inkBox;
const center = {x: box.x + box.width / 2, y: box.y + box.height / 2};
const rx = box.width / 2 - reach;
const ry = box.height / 2 - reach;
const pixbuf = GdkPixbuf.Pixbuf.new_from_file(png);
const pixels = pixbuf.get_pixels();
const stride = pixbuf.get_rowstride(), channels = pixbuf.get_n_channels();
const samples = [];
const maxR = fitted.ring.inner + fitted.ring.outer;
for (let offset = 3; offset < maxR - 2; offset += 2) {
    for (let step = 0; step < 32; step++) {
        const angle = step * Math.PI / 16;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const x = Math.round(center.x + (rx + offset) * cos);
        const y = Math.round(center.y + (ry + offset) * sin);
        const at = y * stride + x * channels;
        samples.push({distance: offset, angle: step, rgb: [pixels[at], pixels[at + 1], pixels[at + 2]]});
    }
}
const middle = Math.round(center.y) * stride + Math.round(center.x) * channels;
const centerRgb = [pixels[middle], pixels[middle + 1], pixels[middle + 2]];
print(JSON.stringify({
    ring: fitted.ring,
    inkRadius: Math.max(rx, ry),
    center: centerRgb,
    fontSize: fitted.spec.fontSize,
    requiredHeight: fitted.requiredHeight,
    samples,
}));
