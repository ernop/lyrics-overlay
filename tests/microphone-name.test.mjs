import test from 'node:test';
import assert from 'node:assert/strict';

import {defaultSourceName, nodeDescription} from '../service/microphone-name.js';

// Shaped like `pw-dump -N default` and `pw-dump -N <node>`, with a made-up device.
const MIC = 'alsa_input.usb-Example_Audio_Desk_Mic_0001-00.analog-stereo';
const METADATA = [{
    id: 41, type: 'PipeWire:Interface:Metadata', props: {'metadata.name': 'default'},
    metadata: [
        {subject: 0, key: 'default.audio.sink', type: 'Spa:String:JSON', value: {name: 'alsa_output.pci-0000_00_1f.3.analog-stereo'}},
        {subject: 0, key: 'default.audio.source', type: 'Spa:String:JSON', value: {name: MIC}},
    ],
}];
const NODE = [{
    id: 45, type: 'PipeWire:Interface:Node',
    info: {props: {'node.name': MIC, 'node.nick': 'Desk Mic', 'node.description': 'Desk Mic Analog Stereo'}},
}];

test('the default source is read from the default metadata', () => {
    assert.equal(defaultSourceName(METADATA), MIC);
    assert.equal(defaultSourceName([{id: 41, type: 'PipeWire:Interface:Metadata', metadata: []}]), '');
});

test('the microphone is named by its node description', () => {
    assert.equal(nodeDescription(NODE), 'Desk Mic Analog Stereo');
    assert.equal(nodeDescription([]), '');
});
