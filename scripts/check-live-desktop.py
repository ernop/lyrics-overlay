#!/usr/bin/env python3
"""Reports whether the tray indicator and the lyric line are drawn on the
live desktop, read from GNOME Shell's accessibility tree. Read-only: nothing
is shown, clicked or captured, and no lyric text is printed. Exits 1 when
the service has a song but the indicator is drawn nowhere, which is what a
panel box hidden by the owner's Dash to Panel layout looks like."""

import json
import sys
import urllib.request

import gi

gi.require_version('Atspi', '2.0')
from gi.repository import Atspi  # noqa: E402

STATE_URL = 'http://127.0.0.1:8792/api/state'
INDICATOR = ('menu', 'Lyrics overlay')
LINE = ('panel', 'Lyric line')


def shell_root():
    desktop = Atspi.get_desktop(0)
    for index in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(index)
        if app is not None and app.get_name() == 'gnome-shell':
            return app
    raise SystemExit('gnome-shell is not on the accessibility bus')


def find(root, role, name):
    stack = [root]
    while stack:
        node = stack.pop()
        if node.get_role_name() == role and node.get_name() == name:
            return node
        for index in range(node.get_child_count()):
            child = node.get_child_at_index(index)
            if child is not None:
                stack.append(child)
    return None


def drawn_box(node):
    if node is None or not node.get_state_set().contains(Atspi.StateType.SHOWING):
        return None
    return node.get_extents(Atspi.CoordType.SCREEN)


def describe(label, box):
    if box is None:
        return f'{label}: not drawn'
    return f'{label}: drawn at x={box.x} y={box.y}, {box.width}x{box.height}'


def main():
    with urllib.request.urlopen(STATE_URL, timeout=5) as response:
        state = json.load(response)['state']
    root = shell_root()
    indicator = drawn_box(find(root, *INDICATOR))
    line = drawn_box(find(root, *LINE))
    song = 'a song is playing' if state['active'] else 'no song'
    print(f"service: {song}, lyrics {state.get('lyrics')}")
    print(describe('tray indicator', indicator))
    print(describe('lyric line', line))
    if state['active'] and indicator is None:
        print('The service has a song but the indicator is drawn nowhere: '
              'its panel box is hidden on this desktop.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
