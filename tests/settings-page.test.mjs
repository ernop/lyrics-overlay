// Guards the browser-served settings page and GJS modules against undefined
// references, missing static files or exports, unknown GSettings keys, and
// command ops outside the shared allowlist.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {Linter} from 'eslint';

import {PAGE_COMMAND_OPS} from '../service/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS_DIR = path.join(ROOT, 'service', 'settings-page');
const SCHEMA_XML = path.join(ROOT, 'gnome-extension', 'lyrics-overlay@ernop', 'schemas',
    'org.gnome.shell.extensions.lyrics-overlay.gschema.xml');

const BROWSER_GLOBALS = {
    AudioContext: 'readonly',
    Blob: 'readonly',
    CSS: 'readonly',
    CustomEvent: 'readonly',
    DOMRect: 'readonly',
    Event: 'readonly',
    File: 'readonly',
    HTMLElement: 'readonly',
    IntersectionObserver: 'readonly',
    MutationObserver: 'readonly',
    ResizeObserver: 'readonly',
    SVGElement: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
    URL: 'readonly',
    URLSearchParams: 'readonly',
    alert: 'readonly',
    cancelAnimationFrame: 'readonly',
    clearInterval: 'readonly',
    clearTimeout: 'readonly',
    confirm: 'readonly',
    console: 'readonly',
    devicePixelRatio: 'readonly',
    document: 'readonly',
    fetch: 'readonly',
    getComputedStyle: 'readonly',
    history: 'readonly',
    localStorage: 'readonly',
    location: 'readonly',
    navigator: 'readonly',
    performance: 'readonly',
    queueMicrotask: 'readonly',
    requestAnimationFrame: 'readonly',
    sessionStorage: 'readonly',
    setInterval: 'readonly',
    setTimeout: 'readonly',
    structuredClone: 'readonly',
    webkitAudioContext: 'readonly',
    window: 'readonly',
};

const GJS_GLOBALS = {
    ARGV: 'readonly',
    ByteArray: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
    clearInterval: 'readonly',
    clearTimeout: 'readonly',
    console: 'readonly',
    imports: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    print: 'readonly',
    printerr: 'readonly',
    setInterval: 'readonly',
    setTimeout: 'readonly',
};

const STATIC_RULES = {
    'no-class-assign': 'error',
    'no-const-assign': 'error',
    'no-dupe-keys': 'error',
    'no-func-assign': 'error',
    'no-redeclare': 'error',
    'no-undef': 'error',
};

function lintDir(relDir, globals) {
    const linter = new Linter();
    const absDir = path.join(ROOT, relDir);
    const errors = [];
    for (const name of fs.readdirSync(absDir).sort()) {
        if (!name.endsWith('.js'))
            continue;
        const relPath = path.join(relDir, name);
        const code = fs.readFileSync(path.join(absDir, name), 'utf8');
        const messages = linter.verify(code, [{
            languageOptions: {ecmaVersion: 'latest', sourceType: 'module', globals},
            rules: STATIC_RULES,
        }], relPath);
        for (const msg of messages)
            errors.push(`${relPath}:${msg.line}:${msg.column} [${msg.ruleId}] ${msg.message}`);
    }
    return errors;
}

function parseServedStaticMap() {
    const httpSrc = fs.readFileSync(path.join(ROOT, 'service', 'http.js'), 'utf8');
    const served = new Map();
    for (const match of httpSrc.matchAll(/add\('([^']+)',\s*'([^']+)'/gu))
        served.set(match[1], path.join(ROOT, match[2]));
    const sharedList = httpSrc.match(/for\s*\(const\s+name\s+of\s*\[([^\]]+)\]\)/u);
    if (sharedList) {
        for (const item of sharedList[1].matchAll(/'([^']+)'/gu))
            served.set(`/shared/${item[1]}`, path.join(ROOT, 'shared', item[1]));
    }
    return served;
}

function parseNamedImports(code) {
    const imports = [];
    for (const match of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/gu)) {
        const names = match[1]
            .split(',')
            .map(part => part.trim())
            .filter(Boolean)
            .map(part => part.split(/\s+as\s+/u)[0].trim());
        imports.push({specifier: match[2], names});
    }
    return imports;
}

function exportedNames(code) {
    const names = new Set();
    for (const match of code.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gu))
        names.add(match[1]);
    for (const match of code.matchAll(/export\s*\{([^}]+)\}/gu)) {
        for (const part of match[1].split(',').map(p => p.trim()).filter(Boolean)) {
            const pieces = part.split(/\s+as\s+/u);
            names.add((pieces[1] ?? pieces[0]).trim());
        }
    }
    return names;
}

test('settings page, service, shared, and desktop JS modules have no undefined references or duplicate declarations', () => {
    const errors = [
        ...lintDir('service/settings-page', BROWSER_GLOBALS),
        ...lintDir('service', GJS_GLOBALS),
        ...lintDir('shared', GJS_GLOBALS),
        ...lintDir('desktop', GJS_GLOBALS),
    ];
    assert.deepEqual(errors, [], `static JS errors found:\n${errors.join('\n')}`);
});

test('every browser import in the settings page is served by http.js and exports every imported name', () => {
    const served = parseServedStaticMap();
    const visited = new Set();
    const checkModule = (urlPath, filePath) => {
        if (visited.has(urlPath))
            return;
        visited.add(urlPath);
        const code = fs.readFileSync(filePath, 'utf8');
        for (const {specifier, names} of parseNamedImports(code)) {
            const resolvedUrl = specifier.startsWith('/')
                ? specifier
                : path.posix.normalize(path.posix.join(path.posix.dirname(urlPath), specifier));
            const targetFile = served.get(resolvedUrl);
            assert.ok(targetFile, `${urlPath} imports ${specifier} (${resolvedUrl}), which is missing from loadStaticFiles`);
            assert.ok(fs.existsSync(targetFile), `${resolvedUrl} points to missing file ${targetFile}`);
            const targetExports = exportedNames(fs.readFileSync(targetFile, 'utf8'));
            for (const name of names)
                assert.ok(targetExports.has(name), `${urlPath} imports "${name}" from ${resolvedUrl}, which does not export it`);
            checkModule(resolvedUrl, targetFile);
        }
    };

    for (const name of fs.readdirSync(SETTINGS_DIR).sort()) {
        if (!name.endsWith('.js'))
            continue;
        const urlPath = `/${name}`;
        assert.ok(served.has(urlPath), `service/settings-page/${name} must be served by loadStaticFiles`);
        checkModule(urlPath, path.join(SETTINGS_DIR, name));
    }
});

test('every command op and setting key referenced by settings.js and lead-sheet.js is valid', () => {
    const schemaSrc = fs.readFileSync(SCHEMA_XML, 'utf8');
    const schemaKeys = new Set([...schemaSrc.matchAll(/<key\s+name="([^"]+)"/gu)].map(m => m[1]));
    assert.ok(schemaKeys.size > 0, 'parsed GSettings schema keys');

    for (const name of ['settings.js', 'lead-sheet.js']) {
        const src = fs.readFileSync(path.join(SETTINGS_DIR, name), 'utf8');
        const ops = [...new Set([...src.matchAll(/\{op:\s*'([a-zA-Z]+)'/gu)].map(m => m[1]))];
        for (const op of ops)
            assert.ok(PAGE_COMMAND_OPS.has(op), `${name} sends command "${op}", which is missing from PAGE_COMMAND_OPS`);

        const keyPatterns = [
            /(?<![.\w])(?:sliderCell|segmentedCell|switchCell|noteCell|activeMonitor|showToggle|set)\('([a-z0-9-]+)'/gu,
            /(?<![.\w])(?:cfgToggle|cfgChoice|cfgSlider)\([^,]+,\s*'([a-z0-9-]+)'/gu,
        ];
        for (const pattern of keyPatterns) {
            for (const match of src.matchAll(pattern))
                assert.ok(schemaKeys.has(match[1]), `${name} references unknown GSettings key "${match[1]}"`);
        }
    }
});
