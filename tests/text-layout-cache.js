// gjs: fits and paints a two-line lyric through text-layout.js's caches
// (after other sizes) and through a second copy of the module (the
// same file linked as text-layout-fresh.js) with empty caches, and
// reports whether the two agree.
// Usage: gjs -m text-layout-cache.js <dir with text-layout.js, text-layout-fresh.js and shared/> <scratch dir>
// Prints JSON {sameFit, samePixels, wrapWidth, width}.
import Cairo from 'cairo';
import GLib from 'gi://GLib';
import PangoCairo from 'gi://PangoCairo';

const [dir, scratch] = ARGV;
const cached = await import(`file://${dir}/text-layout.js`);
const fresh = await import(`file://${dir}/text-layout-fresh.js`);
const context = PangoCairo.FontMap.get_default().create_context();
const text = 'Stub words that wrap onto two lines, ïj; with dots';
const params = width => ({
    fontSize: 90, family: 'Sans', bold: false, color: 'white', border: 'double', borderScale: 2,
    align: 'center', width, height: 500,
});

function paint(module, fitted, name) {
    const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, 1400, 500);
    const cr = new Cairo.Context(surface);
    module.paintLyric(cr, fitted);
    cr.$dispose();
    const file = `${scratch}/${name}.png`;
    surface.writeToPNG(file);
    return GLib.file_get_contents(file)[1];
}

for (const width of [1400, 1300, 1200, 1350])
    paint(cached, cached.fitLyric(context, text, params(width)), 'warm');
const fromCache = cached.fitLyric(context, text, params(1400));
const fromFresh = fresh.fitLyric(context, text, params(1400));
const a = paint(cached, fromCache, 'cached');
const b = paint(fresh, fromFresh, 'fresh');
print(JSON.stringify({
    sameFit: JSON.stringify(fromCache) === JSON.stringify(fromFresh),
    samePixels: a.length === b.length && a.every((byte, index) => byte === b[index]),
    wrapWidth: fromCache.spec.wrapWidth,
    width: 1400,
}));
