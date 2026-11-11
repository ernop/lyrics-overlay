// Where the service's settings page is, and the access the add-on needs to
// find its tab; shared by the background page and the grant page.
'use strict';

// The service under the one name Firefox never first tries over HTTPS
// (HTTPS-First exempts localhost, not its subdomains): a tab that loaded
// the page at lyrics.localhost would wait seconds for that attempt.
const SETTINGS_ORIGIN = 'http://localhost:8792';
const SETTINGS_PAGE = `${SETTINGS_ORIGIN}/settings`;
// Match patterns carry no port; an origin check picks this service's tabs.
const SETTINGS_TABS = 'http://localhost/settings*';
// Firefox grants a manifest's host permissions only on a fresh install, so
// the update that added this one (1.2.0) leaves the add-on without it, as
// does a user turning it off in the add-on's permissions.
const SETTINGS_ACCESS = {origins: ['http://localhost/*']};
