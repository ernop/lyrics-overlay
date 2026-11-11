// The page the add-on shows while it lacks access to localhost. Firefox
// asks the user to grant a permission only in answer to a press like this
// one; once granted, this tab becomes the settings tab.
'use strict';

document.getElementById('allow').addEventListener('click', async () => {
    if (await browser.permissions.request(SETTINGS_ACCESS))
        location.replace(SETTINGS_PAGE);
    else
        document.getElementById('refused').hidden = false;
});
