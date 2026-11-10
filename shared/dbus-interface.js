// The session-bus contract between the lyrics service and the GNOME Shell
// extension: state and line signals out, commands in, payloads as JSON
// strings. Both sides import this one definition (the install script
// copies it into the extension).

export const BUS_NAME = 'net.fuseki.LyricsOverlay';
export const OBJECT_PATH = '/net/fuseki/LyricsOverlay';

export const INTERFACE_XML = `<node>
  <interface name="net.fuseki.LyricsOverlay1">
    <method name="GetState"><arg type="s" direction="out" name="state"/></method>
    <method name="GetLine"><arg type="s" direction="out" name="line"/></method>
    <method name="Command">
      <arg type="s" direction="in" name="command"/>
      <arg type="s" direction="out" name="result"/>
    </method>
    <method name="FocusSong"><arg type="s" direction="out" name="result"/></method>
    <signal name="StateChanged"><arg type="s" name="state"/></signal>
    <signal name="LineChanged"><arg type="s" name="line"/></signal>
    <signal name="PitchFrames"><arg type="s" name="frames"/></signal>
  </interface>
</node>`;
