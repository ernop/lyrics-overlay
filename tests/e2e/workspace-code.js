// A dark-mode code editor window for the README's multi-workspace desktop
// picture (tests/e2e/readme-desktop.mjs). Fictional Python code; no personal data.
//
//   gjs -m workspace-code.js <title>

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

const TITLE = System.programArgs[0] || 'melody.py — Code';

const CODE_LINES = [
    '<span foreground="#7c88a1"># Compute frequencies and cents for a traditional pentatonic scale.</span>',
    '<span foreground="#7aa2f7">from</span> dataclasses <span foreground="#7aa2f7">import</span> dataclass',
    '<span foreground="#7aa2f7">import</span> math',
    '',
    'A4_HZ = <span foreground="#ff9e64">440.0</span>',
    'MIYAKO_BUSHI = (<span foreground="#ff9e64">0</span>, <span foreground="#ff9e64">1</span>, <span foreground="#ff9e64">5</span>, <span foreground="#ff9e64">7</span>, <span foreground="#ff9e64">8</span>)  <span foreground="#7c88a1"># semitones from tonic</span>',
    '',
    '<span foreground="#bb9af7">@dataclass</span>(frozen=<span foreground="#ff9e64">True</span>)',
    '<span foreground="#7aa2f7">class</span> <span foreground="#7dcfff">Note</span>:',
    '    name: <span foreground="#7dcfff">str</span>',
    '    midi: <span foreground="#7dcfff">int</span>',
    '    hz: <span foreground="#7dcfff">float</span>',
    '',
    '<span foreground="#7aa2f7">def</span> <span foreground="#7dcfff">midi_to_hz</span>(midi: <span foreground="#7dcfff">float</span>) -&gt; <span foreground="#7dcfff">float</span>:',
    '    <span foreground="#9ece6a">&quot;&quot;&quot;Equal-temperament frequency in Hz for a MIDI note number.&quot;&quot;&quot;</span>',
    '    <span foreground="#7aa2f7">return</span> A4_HZ * (<span foreground="#ff9e64">2.0</span> ** ((midi - <span foreground="#ff9e64">69.0</span>) / <span foreground="#ff9e64">12.0</span>))',
    '',
    '<span foreground="#7aa2f7">def</span> <span foreground="#7dcfff">build_scale</span>(root_midi: <span foreground="#7dcfff">int</span>, intervals=MIYAKO_BUSHI) -&gt; <span foreground="#7dcfff">list</span>[Note]:',
    '    names = (<span foreground="#9ece6a">&quot;C&quot;</span>, <span foreground="#9ece6a">&quot;C#&quot;</span>, <span foreground="#9ece6a">&quot;D&quot;</span>, <span foreground="#9ece6a">&quot;D#&quot;</span>, <span foreground="#9ece6a">&quot;E&quot;</span>, <span foreground="#9ece6a">&quot;F&quot;</span>, <span foreground="#9ece6a">&quot;F#&quot;</span>, <span foreground="#9ece6a">&quot;G&quot;</span>, <span foreground="#9ece6a">&quot;G#&quot;</span>, <span foreground="#9ece6a">&quot;A&quot;</span>, <span foreground="#9ece6a">&quot;A#&quot;</span>, <span foreground="#9ece6a">&quot;B&quot;</span>)',
    '    notes = []',
    '    <span foreground="#7aa2f7">for</span> step <span foreground="#7aa2f7">in</span> intervals:',
    '        midi = root_midi + step',
    '        label = <span foreground="#9ece6a">f&quot;{names[midi % 12]}{midi // 12 - 1}&quot;</span>',
    '        notes.append(Note(label, midi, round(midi_to_hz(midi), <span foreground="#ff9e64">2</span>)))',
    '    <span foreground="#7aa2f7">return</span> notes',
    '',
    '<span foreground="#7aa2f7">if</span> __name__ == <span foreground="#9ece6a">&quot;__main__&quot;</span>:',
    '    <span foreground="#7aa2f7">for</span> note <span foreground="#7aa2f7">in</span> build_scale(<span foreground="#ff9e64">64</span>):  <span foreground="#7c88a1"># E4 tonic</span>',
    '        print(<span foreground="#9ece6a">f&quot;{note.name:&lt;4}  {note.hz:&gt;7.2f} Hz&quot;</span>)',
];

const CSS = `
window { background: #11151d; color: #e2e8f0; }
headerbar { background: #0c1017; border-bottom: 1px solid #1e2636; }
.tabs { background: #0c1017; border-bottom: 1px solid #1e2636; padding: 0 12px; }
.tab { padding: 8px 14px; font-size: 13px; color: #94a3b8; font-family: monospace; }
.tab-active { color: #ffffff; border-bottom: 2px solid #60a5fa; background: #11151d; font-weight: 700; }
.editor { background: #11151d; padding: 14px 16px; }
.lineno { font-family: monospace; font-size: 13px; color: #56637a; min-width: 28px; }
.code { font-family: monospace; font-size: 13px; color: #e2e8f0; }
.terminal { background: #090c12; border-top: 1px solid #1e2636; padding: 12px 18px; }
.term-head { font-family: monospace; font-size: 12px; font-weight: 700; color: #94a3b8; }
.term-line { font-family: monospace; font-size: 13px; color: #cbd5e1; }
.term-ok { font-family: monospace; font-size: 13px; color: #4ade80; font-weight: 700; }
`;

function buildTabs() {
    const bar = new Gtk.Box({spacing: 4, css_classes: ['tabs']});
    bar.append(new Gtk.Label({label: 'melody.py', css_classes: ['tab', 'tab-active']}));
    bar.append(new Gtk.Label({label: 'scales.py', css_classes: ['tab']}));
    bar.append(new Gtk.Label({label: 'test_melody.py', css_classes: ['tab']}));
    return bar;
}

function buildEditor() {
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4, vexpand: true, css_classes: ['editor']});
    CODE_LINES.forEach((markup, index) => {
        const row = new Gtk.Box({spacing: 14});
        row.append(new Gtk.Label({label: String(index + 1), xalign: 1, css_classes: ['lineno']}));
        const code = new Gtk.Label({xalign: 0, css_classes: ['code']});
        code.set_markup(markup);
        row.append(code);
        box.append(row);
    });
    return box;
}

function buildTerminal() {
    const term = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 5, css_classes: ['terminal']});
    term.append(new Gtk.Label({label: 'TERMINAL', xalign: 0, css_classes: ['term-head']}));
    term.append(new Gtk.Label({label: '$ python3 -m unittest', xalign: 0, css_classes: ['term-line']}));
    term.append(new Gtk.Label({label: 'Ran 12 tests in 0.04s — OK', xalign: 0, css_classes: ['term-ok']}));
    return term;
}

Adw.init();
Adw.StyleManager.get_default().color_scheme = Adw.ColorScheme.FORCE_DARK;
const provider = new Gtk.CssProvider();
provider.load_from_string(CSS);
Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

const body = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
body.append(buildTabs());
body.append(buildEditor());
body.append(buildTerminal());

const toolbar = new Adw.ToolbarView({content: body});
toolbar.add_top_bar(new Adw.HeaderBar({title_widget: new Adw.WindowTitle({title: TITLE})}));

const loop = new GLib.MainLoop(null, false);
const window = new Adw.Window({title: TITLE, content: toolbar, default_width: 756, default_height: 814});
window.connect('close-request', () => {
    loop.quit();
    return false;
});
window.present();
loop.run();
