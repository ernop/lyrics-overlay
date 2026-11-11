// A throwaway desktop session for tests: a temporary HOME and XDG dirs, and
// private D-Bus daemons started inside that environment.
//
// The order matters: services a bus activates inherit the bus daemon's
// environment, so a private bus started from the real environment lets an
// activated dconf-service write the real ~/.config/dconf/user. A bus here
// activates only what its serviceDir holds, and nothing when it is null.

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Creates the session's dirs under tmp and returns its complete environment. */
export function isolatedEnv(tmp) {
    for (const dir of ['home', 'run', 'config', 'data', 'cache', 'state'])
        fs.mkdirSync(path.join(tmp, dir), {mode: 0o700});
    return {
        HOME: path.join(tmp, 'home'),
        XDG_RUNTIME_DIR: path.join(tmp, 'run'),
        XDG_CONFIG_HOME: path.join(tmp, 'config'),
        XDG_DATA_HOME: path.join(tmp, 'data'),
        XDG_CACHE_HOME: path.join(tmp, 'cache'),
        XDG_STATE_HOME: path.join(tmp, 'state'),
        XDG_DATA_DIRS: '/usr/local/share:/usr/share',
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        GIO_USE_VFS: 'local',
    };
}

function busConfig(socketDir, serviceDir) {
    return `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:dir=${socketDir}</listen>
  <auth>EXTERNAL</auth>
  ${serviceDir ? `<servicedir>${serviceDir}</servicedir>` : ''}
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`;
}

/**
 * A services dir under tmp that activates only dconf-service, for a bus
 * whose clients store settings: started by that bus, it writes the
 * session's own XDG_CONFIG_HOME.
 * @returns {string} the dir, for startBus
 */
export function dconfServiceDir(tmp) {
    const dir = path.join(tmp, 'services');
    fs.mkdirSync(dir, {mode: 0o700});
    fs.copyFileSync('/usr/share/dbus-1/services/ca.desrt.dconf.service', path.join(dir, 'ca.desrt.dconf.service'));
    return dir;
}

/**
 * @param {string} dir temporary dir for the socket and config
 * @param {string} name distinguishes several buses in one dir
 * @param {Record<string, string>} env from isolatedEnv()
 * @param {string|null} serviceDir the only activatable services, or none
 */
export async function startBus(dir, name, env, serviceDir) {
    const socketDir = path.join(dir, `${name}-socket`);
    fs.mkdirSync(socketDir, {mode: 0o700});
    const configPath = path.join(dir, `${name}.conf`);
    fs.writeFileSync(configPath, busConfig(socketDir, serviceDir));
    const daemon = spawn('dbus-daemon', ['--config-file', configPath, '--nofork', '--print-address=1'],
        {env, stdio: ['ignore', 'pipe', 'inherit']});
    const address = await new Promise((resolve, reject) => {
        daemon.once('error', reject);
        daemon.stdout.once('data', data => resolve(data.toString().trim()));
    });
    return {daemon, address};
}
