import { test, expect } from '@playwright/test';
import { getBaseUrl } from './setup';

/**
 * The page behind the link mailed to the beheerder (lib/wachtwoordHerstel.ts).
 * The API is answered here by the test, the real one is covered by
 * lib/wachtwoordHerstel.test.ts: what this checks is the page itself, with the token in the fragment.
 */

const pagina = (fragment = '') => `${getBaseUrl()}/wachtwoord-herstel${fragment}`;

test('without the link from the mail the page says so and offers the start page', async ({ page }) => {
  await page.goto(pagina());
  await expect(page.getByTestId('herstel-geen-link')).toContainText('Deze pagina werkt alleen met de link uit de e-mail');
  await expect(page.getByRole('link', { name: 'Naar de startpagina' })).toBeVisible();
  await expect(page.getByLabel('Nieuw wachtwoord')).toHaveCount(0);
});

test('two different passwords are caught before anything is sent', async ({ page }) => {
  let verzonden = 0;
  await page.route(/\/api\/auth\/wachtwoord-herstel$/, (route) => {
    verzonden++;
    return route.abort();
  });
  await page.goto(pagina('#token=abc.def'));
  await page.getByLabel('Nieuw wachtwoord').fill('Nieuw-wachtwoord2@');
  await page.getByLabel('Herhaal het wachtwoord').fill('Anders-wachtwoord3#');
  await page.getByRole('button', { name: 'Wachtwoord instellen' }).click();
  await expect(page.getByTestId('herstel-fout')).toContainText('De wachtwoorden komen niet overeen.');
  expect(verzonden).toBe(0);
});

test('sends the token from the fragment, shows an answer of the server, and on success clears the address and offers the login', async ({ page }) => {
  const bodies: Array<Record<string, unknown>> = [];
  let antwoord: 'fout' | 'goed' = 'fout';
  await page.route(/\/api\/auth\/wachtwoord-herstel$/, (route) => {
    bodies.push(route.request().postDataJSON());
    return antwoord === 'fout'
      ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'INVALID_TOKEN', message: 'Deze link is verlopen of al gebruikt. Vraag op de startpagina een nieuwe aan.' } }) })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { codenaam: 'admin' } }) });
  });
  await page.goto(pagina('#token=abc.def'));
  const vul = async () => {
    await page.getByLabel('Nieuw wachtwoord').fill('Nieuw-wachtwoord2@');
    await page.getByLabel('Herhaal het wachtwoord').fill('Nieuw-wachtwoord2@');
    await page.getByRole('button', { name: 'Wachtwoord instellen' }).click();
  };
  await vul();
  await expect(page.getByTestId('herstel-fout')).toContainText('verlopen of al gebruikt');
  expect(bodies[0]).toEqual({ token: 'abc.def', wachtwoord: 'Nieuw-wachtwoord2@' });

  antwoord = 'goed';
  await vul();
  await expect(page.getByRole('status')).toContainText('Je nieuwe wachtwoord is ingesteld');
  await expect(page.getByRole('link', { name: 'Naar inloggen' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
});
