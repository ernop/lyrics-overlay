// Config for the private PipeWire client the pitch capture runs as
// `pipewire -c <file>`. Its echo canceller subtracts what the speakers
// play (the default sink's monitor) from the microphone, so the pitch
// trace follows the singer instead of the song. The nodes exist only while
// capture runs and have zero priority, so they never become the default
// microphone.

export const VOICE_NODE = 'lyrics-overlay.voice';

/**
 * @param {{microphone: string}} options a source's node name, or '' for the default source
 * @returns {string} the config file's text
 */
export function echoCancelConfig({microphone}) {
    if (!/^[\w.:@+-]*$/u.test(microphone))
        throw new Error(`not a PipeWire node name: ${JSON.stringify(microphone)}`);
    const target = microphone ? `\n                target.object = "${microphone}"\n                node.dont-fallback = true` : '';
    return `context.properties = {
    log.level = 2
}

context.spa-libs = {
    audio.convert.* = audioconvert/libspa-audioconvert
    support.*       = support/libspa-support
}

context.modules = [
    { name = libpipewire-module-protocol-native }
    { name = libpipewire-module-client-node }
    { name = libpipewire-module-adapter }
    { name = libpipewire-module-echo-cancel
        args = {
            library.name = aec/libspa-aec-webrtc
            monitor.mode = true
            audio.rate = 48000
            audio.channels = 1
            audio.position = [ MONO ]
            aec.args = {
                webrtc.gain_control = false
                webrtc.noise_suppression = true
                webrtc.high_pass_filter = true
                webrtc.transient_suppression = false
            }
            capture.props = {
                node.name = "lyrics-overlay.voice-capture"${target}
            }
            source.props = {
                node.name = "${VOICE_NODE}"
                node.description = "Lyrics overlay voice (echo cancelled)"
                priority.session = 0
                priority.driver = 0
            }
            sink.props = {
                node.name = "lyrics-overlay.voice-reference"
            }
        }
    }
]
`;
}
