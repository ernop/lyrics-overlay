// The microphones the pitch trace can hear, read from a full `pw-dump`:
// the audio inputs for the settings page, and which one is the session's
// default (its default-device metadata).

// The echo canceller's own nodes are sources too; they are never a choice.
const OWN_NODE_PREFIX = 'lyrics-overlay.';

/** The default source's node name in `pw-dump` output, or ''. */
export function defaultSourceName(dump) {
    for (const object of dump) {
        if (object.type !== 'PipeWire:Interface:Metadata')
            continue;
        const entry = (object.metadata ?? []).find(item => item.key === 'default.audio.source');
        if (entry)
            return entry.value.name;
    }
    return '';
}

/**
 * Every audio input in a full `pw-dump`, ordered by description.
 * @returns {{microphones: Array<{name: string, description: string}>, defaultName: string}}
 */
export function listMicrophones(dump) {
    const microphones = [];
    for (const object of dump) {
        const props = object.type === 'PipeWire:Interface:Node' ? object.info?.props : null;
        if (props?.['media.class'] !== 'Audio/Source' || props['node.name'].startsWith(OWN_NODE_PREFIX))
            continue;
        microphones.push({name: props['node.name'], description: props['node.description'] ?? props['node.name']});
    }
    microphones.sort((a, b) => a.description.localeCompare(b.description));
    return {microphones, defaultName: defaultSourceName(dump)};
}
