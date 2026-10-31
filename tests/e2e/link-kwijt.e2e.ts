import { test, expect } from '@playwright/test';
import { getBaseUrl } from './setup';

/**
 * "Link kwijt?" on the start page (issue #1, 0.905.0): the mail goes out through the operator's Power Automate
 * flow, whose trigger on a shared mailbox can take up to a quarter of an hour. Asking again meanwhile only sends more
 * mails, so the page says how long it can take, before and after asking. The test installation sends no mail, and
 * then the app rightly refuses a request ("kan nu niet"): the server's answer is stood in for here, as it is when
 * the request is received. What the server does with a request has its own tests (lib/linkAanvraag).
 */

test('says before and after asking that the mail can take a quarter of an hour, and not to ask again', async ({ page }) => {
  await page.goto(`${getBaseUrl()}/`);
  await expect(page.getByText('De e-mail kan tot een kwartier onderweg zijn. Vraag de link één keer aan.')).toBeVisible();

  for (const pad of ['**/api/link-aanvragen', '**/api/aios/link-aanvragen']) {
    await page.route(pad, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) }));
  }
  await page.getByLabel('Link kwijt? Vraag hem opnieuw aan met je werk-e-mailadres').fill(`onbekend-${crypto.randomUUID().slice(0, 8)}@example.test`);
  await page.getByRole('button', { name: 'Link aanvragen' }).click();
  const antwoord = page.getByRole('status').filter({ hasText: 'Aanvraag ontvangen.' });
  await expect(antwoord).toContainText(
    'Als dit e-mailadres bij ons bekend is, krijg je een e-mail met je persoonlijke link. Dat kan tot een kwartier duren. Vraag hem in die tijd niet opnieuw aan, want dan krijg je meerdere e-mails.'
  );
  await expect(antwoord).toContainText('Na een kwartier nog geen e-mail?');
  await expect(antwoord).not.toContainText('paar minuten');
});
