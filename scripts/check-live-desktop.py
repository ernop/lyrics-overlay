#!/usr/bin/env python3
"""Reports whether the tray indicator and the lyric line are drawn on the
live desktop. Read-only: nothing is shown, clicked or captured, and no lyric
text is printed. Prefers the standalone XWayland desktop frontend's D-Bus
status method (net.fuseki.LyricsOverlayDesktop), falling back to GNOME Shell's
accessibility tree if the legacy extension is running instead. Exits 1 when
the service has a song but no indicator is visible."""

import json
import sys
import urllib.request

import gi

gi.require_version('Gio', '2.0')
from gi.repository import Gio  # noqa: E402

STATE_URL = 'http://127.0.0.1:8792/api/state'
DESKTOP_BUS = 'net.fuseki.LyricsOverlayDesktop'
DESKTOP_PATH = '/net/fuseki/LyricsOverlayDesktop'
DESKTOP_IFACE = 'net.fuseki.LyricsOverlayDesktop1'
INDICATOR = ('menu', 'Lyrics overlay')
LINE = ('panel', 'Lyric line')


def query_standalone_desktop():
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    try:
        result = bus.call_sync(
            DESKTOP_BUS,
            DESKTOP_PATH,
            DESKTOP_IFACE,
            'GetStatus',
            None,
            None,
            Gio.DBusCallFlags.NO_AUTO_START,
            2000,
            None,
        )
    except Exception:
        return None
    return json.loads(result.unpack()[0])


def describe_box(label, visible, box):
    if not visible or not box:
        return f'{label}: not drawn'
    return (f"{label}: drawn at x={round(box['x'])} y={round(box['y'])}, "
            f"{round(box['width'])}x{round(box['height'])}")


def check_legacy_gnome_shell(state):
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi

    desktop = Atspi.get_desktop(0)
    root = None
    for index in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(index)
        if app is not None and app.get_name() == 'gnome-shell':
            root = app
            break
    if root is None:
        raise SystemExit('neither lyrics-overlay-desktop nor gnome-shell is reachable')

    def find(role, name):
        stack = [root]
        while stack:
            node = stack.pop()
            if node.get_role_name() == role and node.get_name() == name:
                return node
            for idx in range(node.get_child_count()):
                child = node.get_child_at_index(idx)
                if child is not None:
                    stack.append(child)
        return None

    def drawn_box(node):
        if node is None or not node.get_state_set().contains(Atspi.StateType.SHOWING):
            return None
        r = node.get_extents(Atspi.CoordType.SCREEN)
        return {'x': r.x, 'y': r.y, 'width': r.width, 'height': r.height}

    indicator = drawn_box(find(*INDICATOR))
    line = drawn_box(find(*LINE))
    print('frontend: legacy GNOME Shell extension')
    print(describe_box('tray indicator', indicator is not None, indicator))
    print(describe_box('lyric line', line is not None, line))
    if state['active'] and indicator is None:
        print('The service has a song but the indicator is drawn nowhere: '
              'its panel box is hidden on this desktop.', file=sys.stderr)
        return 1
    return 0


def main():
    with urllib.request.urlopen(STATE_URL, timeout=5) as response:
        state = json.load(response)['state']
    song = 'a song is playing' if state['active'] else 'no song'
    print(f"service: {song}, lyrics {state.get('lyrics')}")

    status = query_standalone_desktop()
    if status is None:
        return check_legacy_gnome_shell(state)

    print(f"frontend: standalone XWayland desktop (tray-mode={status['trayMode']}, "
          f"monitors={status['monitorCount']})")
    print(describe_box('tray button', status['trayButtonVisible'], status['trayButtonBox']))
    print(f"tray SNI: {'registered' if status['traySniActive'] else 'inactive'} "
          f"(watcher {'present' if status['traySniWatcher'] else 'absent'})")
    raiser = status.get('windowRaiserActive')
    if raiser is not None:
        print(f"window raiser: {'active (GNOME Shell)' if raiser else 'inactive (log out and back in if just installed, or non-GNOME)'}")
    print(describe_box('lyric line', status['lyricVisible'], status['lyricBox']))
    if status['lyricVisible'] and status['inkBox']:
        ink = status['inkBox']
        print(f"lyric ink hit-box (local): x={round(ink['x'])} y={round(ink['y'])}, "
              f"{round(ink['width'])}x{round(ink['height'])}")
    print(describe_box('pitch panel', status['pitchVisible'], status['pitchBox']))

    if state['active'] and not status['trayButtonVisible'] and not status['traySniActive']:
        print('The service has a song but neither tray button nor StatusNotifierItem is active.',
              file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
