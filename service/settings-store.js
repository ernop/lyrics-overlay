// The look and pitch settings the settings page edits, held where the
// shell extension reads them: its GSettings schema. The service compiles
// the schema from this checkout at start, so it validates exactly the keys
// its own page offers, whatever extension version is installed.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {MIN_GEOMETRY_HEIGHT, MIN_GEOMETRY_WIDTH, clampGeometry} from '../shared/overlay-geometry.js';

export const SCHEMA_ID = 'org.gnome.shell.extensions.lyrics-overlay';

const BOX_KEYS = ['cx', 'cy', 'width', 'height'];
const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

// The schema cannot express these; a value failing one is refused.
const VALUE_CHECKS = {
    'font-family': value => (value.length <= 200 && !/[\u0000-\u001f]/u.test(value)) || 'a font family name of at most 200 characters',
    'text-custom-color': value => value === '' || HEX_COLOR.test(value) || 'empty or a color written #rrggbb',
    'text-backdrop-color': value => HEX_COLOR.test(value) || 'a color written #rrggbb',
    'pitch-line-color': value => HEX_COLOR.test(value) || 'a color written #rrggbb',
    'pitch-microphone': value => /^[\w.:@+-]{0,200}$/u.test(value) || 'a PipeWire node name, or empty for the default',
    'box-monitor': value => (value >= -1 && value <= 32) || 'a monitor index (-1 for primary, or 0..32)',
    'pitch-box-monitor': value => (value >= -1 && value <= 32) || 'a monitor index (-1 for primary, or 0..32)',
};
const MIN_FIXED_SPAN = 6;

function boxVariant(name, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new SettingsError(`${name} must be an object with cx, cy, width and height`);
    const keys = Object.keys(value);
    if (keys.length !== BOX_KEYS.length || BOX_KEYS.some(key => !Object.hasOwn(value, key)))
        throw new SettingsError(`${name} must hold exactly cx, cy, width and height`);
    for (const key of BOX_KEYS) {
        if (typeof value[key] !== 'number' || !Number.isFinite(value[key]))
            throw new SettingsError(`${name}.${key} must be a finite number`);
    }
    if (value.width < MIN_GEOMETRY_WIDTH || value.width > 1)
        throw new SettingsError(`${name}.width must be from ${MIN_GEOMETRY_WIDTH} to 1`);
    if (value.height < MIN_GEOMETRY_HEIGHT || value.height > 1)
        throw new SettingsError(`${name}.height must be from ${MIN_GEOMETRY_HEIGHT} to 1`);
    if (value.cx < 0 || value.cx > 1 || value.cy < 0 || value.cy > 1)
        throw new SettingsError(`${name} center (cx, cy) must be from 0 to 1`);
    return new GLib.Variant('a{sd}', clampGeometry(value));
}

const SCALAR_TYPES = {
    b: {check: value => typeof value === 'boolean', want: 'true or false', variant: value => GLib.Variant.new_boolean(value)},
    d: {check: value => Number.isFinite(value), want: 'a number', variant: value => GLib.Variant.new_double(value)},
    i: {check: value => Number.isInteger(value), want: 'a whole number', variant: value => GLib.Variant.new_int32(value)},
    s: {check: value => typeof value === 'string', want: 'text', variant: value => GLib.Variant.new_string(value)},
};
const BOX_TYPE = 'a{sd}';

export class SettingsError extends Error {}

function compileSchema(schemaSourceDir, targetDir) {
    GLib.mkdir_with_parents(targetDir, 0o700);
    const process = Gio.Subprocess.new(['glib-compile-schemas', '--strict', `--targetdir=${targetDir}`, schemaSourceDir],
        Gio.SubprocessFlags.STDERR_PIPE);
    const [, , stderr] = process.communicate_utf8(null, null);
    if (!process.get_successful())
        throw new Error(`glib-compile-schemas failed: ${stderr.trim()}`);
}

function describeRange(key) {
    const [kind, detail] = key.get_range().deepUnpack();
    if (kind === 'range') {
        const [min, max] = detail.deepUnpack();
        return {min, max};
    }
    if (kind === 'enum')
        return {choices: detail.deepUnpack()};
    return {};
}

export class SettingsStore {
    /**
     * @param {{schemaSourceDir: string, compiledDir: string}} options
     */
    constructor({schemaSourceDir, compiledDir}) {
        compileSchema(schemaSourceDir, compiledDir);
        const source = Gio.SettingsSchemaSource.new_from_directory(compiledDir, null, true);
        const schema = source.lookup(SCHEMA_ID, false);
        if (!schema)
            throw new Error(`${schemaSourceDir} does not define ${SCHEMA_ID}`);
        this._schema = schema;
        this._settings = new Gio.Settings({settings_schema: schema});
        // A changed group lands at once (one apply per write); delay mode
        // cannot be left, so every write path must end with apply().
        this._settings.delay();
        /** @type {Record<string, {type: string, writable: boolean, default: unknown, min?: number, max?: number, choices?: string[]}>} */
        this._keys = {};
        for (const name of schema.list_keys().sort()) {
            const key = schema.get_key(name);
            const type = key.get_value_type().dup_string();
            this._keys[name] = {
                type,
                writable: type in SCALAR_TYPES || type === BOX_TYPE,
                default: key.get_default_value().deepUnpack(),
                ...describeRange(key),
            };
        }
    }

    /** Every key's type, default, range or choices, and whether the page may write it. */
    describe() {
        return this._keys;
    }

    values() {
        const values = {};
        for (const name of Object.keys(this._keys))
            values[name] = this._settings.get_value(name).deepUnpack();
        return values;
    }

    get(name) {
        if (!(name in this._keys))
            throw new Error(`no setting named ${name}`);
        return this._settings.get_value(name).deepUnpack();
    }

    /**
     * Checks every change, then writes them together.
     * @param {Record<string, unknown>} changes
     */
    set(changes) {
        if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length)
            throw new SettingsError('changes must be an object naming at least one setting');
        const variants = Object.entries(changes).map(([name, value]) => [name, this._variant(name, value)]);
        const after = {...this.values(), ...changes};
        if (after['pitch-range-top'] - after['pitch-range-bottom'] < MIN_FIXED_SPAN)
            throw new SettingsError(`the top of the pitch range must be at least ${MIN_FIXED_SPAN} semitones above its bottom`);
        for (const [name, variant] of variants)
            this._settings.set_value(name, variant);
        this._settings.apply();
    }

    /** @param {string[]} names */
    reset(names) {
        if (!Array.isArray(names) || !names.length)
            throw new SettingsError('keys must list at least one setting');
        for (const name of names) {
            if (!(name in this._keys))
                throw new SettingsError(`there is no setting named ${JSON.stringify(name)}`);
        }
        for (const name of names)
            this._settings.reset(name);
        this._settings.apply();
    }

    /** @param {(name: string) => void} callback */
    onChanged(callback) {
        return this._settings.connect('changed', (_settings, name) => callback(name));
    }

    _variant(name, value) {
        const key = this._keys[name];
        if (!key)
            throw new SettingsError(`there is no setting named ${JSON.stringify(name)}`);
        if (!key.writable)
            throw new SettingsError(`${name} cannot be edited from the settings page`);
        if (key.type === BOX_TYPE)
            return boxVariant(name, value);
        const type = SCALAR_TYPES[key.type];
        if (!type.check(value))
            throw new SettingsError(`${name} must be ${type.want}`);
        const variant = type.variant(value);
        if (!this._schema.get_key(name).range_check(variant)) {
            const allowed = key.choices ? `one of ${key.choices.join(', ')}` : `from ${key.min} to ${key.max}`;
            throw new SettingsError(`${name} must be ${allowed}`);
        }
        const verdict = VALUE_CHECKS[name]?.(value) ?? true;
        if (verdict !== true)
            throw new SettingsError(`${name} must be ${verdict}`);
        return variant;
    }
}

export function isSettingsError(error) {
    return error instanceof SettingsError;
}
