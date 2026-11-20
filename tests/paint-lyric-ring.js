// gjs: paints one lyric with the shell extension's paintLyric and reports
// the color found around the center of its ink, by distance and angle.
// Usage: gjs -m paint-lyric-ring.js <dir with text-layout.js and shared/> <png> <text> [font size]
// Prints JSON {ring: {inner, outer}, inkRadius, center: rgb, samples: [{distance, angle, rgb}]}.
import Cairo from 'cairo';
import GdkPixbuf from 'gi://GdkPixbuf';
import PangoCairo from 'gi://PangoCairo';

const [dir, png, text, size = '160'] = ARGV;
const {fitLyric, paintLyric} = await import(`file://${dir}/text-layout.js`);

const WIDTH = 800, HEIGHT = 600;
const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, WIDTH, HEIGHT);
const cr = new Cairo.Context(surface);
cr.setSourceRGB(0, 0, 1);
cr.paint();
const context = PangoCairo.FontMap.get_default().create_context();
const fitted = fitLyric(context, text, {
    fontSize: Number(size), family: 'Sans', bold: false, color: 'yellow', border: 'double', borderScale: 4,
    align: 'center', width: WIDTH, height: HEIGHT,
});
paintLyric(cr, fitted);
cr.$dispose();
surface.writeToPNG(png);

const reach = fitted.ring.inner + fitted.ring.outer;
const box = fitted.inkBox;
const center = {x: box.x + box.width / 2, y: box.y + box.height / 2};
const inkRadius = Math.max(box.width, box.height) / 2 - reach;
const pixbuf = GdkPixbuf.Pixbuf.new_from_file(png);
const pixels = pixbuf.get_pixels();
const stride = pixbuf.get_rowstride(), channels = pixbuf.get_n_channels();
const samples = [];
for (let distance = Math.ceil(inkRadius) + 2; distance < reach + inkRadius - 2; distance += 2) {
    for (let step = 0; step < 32; step++) {
        const angle = step * Math.PI / 16;
        const x = Math.round(center.x + distance * Math.cos(angle));
        const y = Math.round(center.y + distance * Math.sin(angle));
        const at = y * stride + x * channels;
        samples.push({distance: distance - inkRadius, angle: step, rgb: [pixels[at], pixels[at + 1], pixels[at + 2]]});
    }
}
const middle = Math.round(center.y) * stride + Math.round(center.x) * channels;
const centerRgb = [pixels[middle], pixels[middle + 1], pixels[middle + 2]];
print(JSON.stringify({ring: fitted.ring, inkRadius, center: centerRgb, samples}));
