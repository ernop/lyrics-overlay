// Full garbage collection every 200 ms from the main loop, so an object
// the service forgot to keep (a dropped Soup.Server stops listening) dies
// within a test instead of minutes into real use. Imported for its effect
// by service-under-gc.js, ahead of the service.
import GLib from 'gi://GLib';
import System from 'system';

GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
    System.gc();
    return GLib.SOURCE_CONTINUE;
});
