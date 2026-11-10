// The microphone the pitch trace hears, named for the menu. The echo
// canceller's capture side names no device, so PipeWire links it to the
// default source; these read that source's name out of two small dumps:
// `pw-dump default` (the session's default-device metadata) and
// `pw-dump <node name>` (that one node).

/** The default source's node name in `pw-dump default` output, or ''. */
export function defaultSourceName(metadataDump) {
    for (const object of metadataDump) {
        const entry = (object.metadata ?? []).find(item => item.key === 'default.audio.source');
        if (entry)
            return entry.value.name;
    }
    return '';
}

/** The node's description in `pw-dump <node name>` output, or ''. */
export function nodeDescription(nodeDump) {
    const node = nodeDump.find(object => object.type === 'PipeWire:Interface:Node');
    return node?.info.props['node.description'] ?? '';
}
