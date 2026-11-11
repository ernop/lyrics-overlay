import test from 'node:test';
import assert from 'node:assert/strict';

import {defaultSourceName, listMicrophones} from '../service/microphones.js';

// Shaped like `pw-dump` output, with made-up devices.
const MIC = 'alsa_input.usb-Example_Audio_Desk_Mic_0001-00.analog-stereo';
const METADATA = [{
    id: 41, type: 'PipeWire:Interface:Metadata', props: {'metadata.name': 'default'},
    metadata: [
        {subject: 0, key: 'default.audio.sink', type: 'Spa:String:JSON', value: {name: 'alsa_output.pci-0000_00_1f.3.analog-stereo'}},
        {subject: 0, key: 'default.audio.source', type: 'Spa:String:JSON', value: {name: MIC}},
    ],
}];

test('the default source is read from the default metadata', () => {
    assert.equal(defaultSourceName(METADATA), MIC);
    assert.equal(defaultSourceName([{id: 41, type: 'PipeWire:Interface:Metadata', metadata: []}]), '');
});

test('the microphone list holds every audio input except the echo canceller\'s own, by description', () => {
    const node = (id, mediaClass, name, description) => ({id, type: 'PipeWire:Interface:Node',
        info: {props: {'media.class': mediaClass, 'node.name': name, 'node.description': description}}});
    const dump = [
        ...METADATA,
        node(45, 'Audio/Source', MIC, 'Desk Mic Analog Stereo'),
        node(46, 'Audio/Source', 'alsa_input.pci-0000_00_1f.3.analog-stereo', 'Built-in Audio Analog Stereo'),
        node(47, 'Audio/Sink', 'alsa_output.pci-0000_00_1f.3.analog-stereo', 'Built-in Audio Analog Stereo'),
        node(48, 'Audio/Source', 'lyrics-overlay.voice', 'Lyrics overlay voice (echo cancelled)'),
        {id: 49, type: 'PipeWire:Interface:Client', info: {props: {'application.name': 'pw-dump'}}},
    ];
    assert.deepEqual(listMicrophones(dump), {
        microphones: [
            {name: 'alsa_input.pci-0000_00_1f.3.analog-stereo', description: 'Built-in Audio Analog Stereo'},
            {name: MIC, description: 'Desk Mic Analog Stereo'},
        ],
        defaultName: MIC,
    });
});
