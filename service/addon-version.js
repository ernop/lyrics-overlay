// Which version of the Firefox add-on reports to the service, set against
// the version this checkout carries (firefox/manifest.json), so the
// settings page can show an add-on that Firefox has not updated. Add-ons
// before 1.3.0 name no version in their reports; they are known only to be
// older than that.
//
// Free of GNOME code so it runs under both gjs and node (tests).

/** Firefox add-on versions: up to four dot-separated whole numbers. */
const VERSION = /^\d{1,9}(\.\d{1,9}){0,3}$/u;

export function isAddonVersion(value) {
    return typeof value === 'string' && VERSION.test(value);
}

/** Negative, zero or positive as a is older than, the same as, or newer than b. */
export function compareVersions(a, b) {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);
    for (let index = 0; index < Math.max(partsA.length, partsB.length); index++) {
        const difference = (partsA[index] ?? 0) - (partsB[index] ?? 0);
        if (difference !== 0)
            return difference;
    }
    return 0;
}

/**
 * unheard: no add-on has reported since the service started.
 * unnamed: the last report named no version (an add-on before 1.3.0).
 * @typedef {{status: 'unheard'|'unnamed', current: string}
 *   | {status: 'current'|'older'|'newer', version: string, current: string}} AddonStatus
 */

export class AddonVersion {
    /** @param {{current: string}} options current: the version of this checkout's add-on */
    constructor({current}) {
        if (!isAddonVersion(current))
            throw new Error(`AddonVersion needs the add-on's current version, not ${JSON.stringify(current)}`);
        /** @type {AddonStatus} */
        this._status = {status: 'unheard', current};
    }

    /** @param {string|null} version what a report named; null when it named none */
    heard(version) {
        const current = this._status.current;
        if (version === null) {
            this._status = {status: 'unnamed', current};
            return;
        }
        const order = compareVersions(version, current);
        this._status = {status: order === 0 ? 'current' : order < 0 ? 'older' : 'newer', version, current};
    }

    /** @returns {AddonStatus} */
    describe() {
        return {...this._status};
    }
}
