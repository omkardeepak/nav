const { test, expect } = require('@playwright/test');

test.describe.serial('Frontdesk E2E Tests', () => {
  let createdToken = '';
  let createdTicketId = '';
  let pageErrors = [];
  let consoleErrors = [];

  function trackErrors(page) {
    page.on('pageerror', err => {
      pageErrors.push(err.message || String(err));
    });
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text();
        // Ignore expected HTTP network errors from intentional negative assertions (409 concurrent claim, 401 wrong password)
        if (text.includes('409 (Conflict)') || text.includes('401 (Unauthorized)')) return;
        consoleErrors.push(text);
      }
    });
  }

  test.beforeEach(() => {
    pageErrors = [];
    consoleErrors = [];
  });

  test.afterEach(() => {
    expect(pageErrors, 'Expected no unhandled page errors').toEqual([]);
    expect(consoleErrors, 'Expected no browser console errors').toEqual([]);
  });

  test('1. Customer creates a ticket at /#/new (priority "I cannot work at all") and lands on /#/c/<token>', async ({ page }) => {
    trackErrors(page);

    await page.goto('/#/new');
    await expect(page.locator('h2')).toContainText('Contact Arvo Support');

    await page.fill('#n', 'Alice Customer');
    await page.fill('#em', 'alice@customer.example');
    await page.fill('#s', 'Production system offline');
    await page.selectOption('#p', { label: 'I cannot work at all' });
    await page.fill('#b', 'We cannot process orders at all right now. Urgent help needed!');

    await page.click('#go');

    // Wait for URL redirect to customer token hash: /#/c/<token>
    await page.waitForURL(/#\/c\/[a-f0-9]+/);
    const hash = new URL(page.url()).hash;
    createdToken = hash.replace('#/c/', '');
    expect(createdToken).toBeTruthy();

    await expect(page.locator('h2')).toContainText('Production system offline');
    await expect(page.locator('.msg.customer')).toContainText('We cannot process orders at all right now');
  });

  test('2. Asha takes ticket; Bilal sees "Already taken by Asha" when clicking Take concurrently', async ({ browser }) => {
    const ashaContext = await browser.newContext();
    const bilalContext = await browser.newContext();
    const ashaPage = await ashaContext.newPage();
    const bilalPage = await bilalContext.newPage();
    trackErrors(ashaPage);
    trackErrors(bilalPage);

    try {
      // 1. Asha signs in
      await ashaPage.goto('/#/');
      await expect(ashaPage.locator('h2')).toContainText('Agent sign in');
      await ashaPage.selectOption('#ag', { label: 'Asha' });
      await ashaPage.fill('#pw', 'frontdesk');
      await ashaPage.click('#go');
      await expect(ashaPage.locator('h2')).toContainText('Tickets');

      // 2. Bilal signs in in a second browser context
      await bilalPage.goto('/#/');
      await expect(bilalPage.locator('h2')).toContainText('Agent sign in');
      await bilalPage.selectOption('#ag', { label: 'Bilal' });
      await bilalPage.fill('#pw', 'frontdesk');
      await bilalPage.click('#go');
      await expect(bilalPage.locator('h2')).toContainText('Tickets');

      // 3. Open both lists to "Unassigned" BEFORE the first click
      await ashaPage.click('button[data-f="unassigned"]');
      await bilalPage.click('button[data-f="unassigned"]');

      // Find the created ticket in Asha's list
      const ashaTicketLink = ashaPage.locator('tr a[href^="#/t/"]', { hasText: 'Production system offline' });
      await expect(ashaTicketLink).toBeVisible();
      const href = await ashaTicketLink.getAttribute('href');
      createdTicketId = href.replace('#/t/', '');
      expect(createdTicketId).toBeTruthy();

      const ashaTakeBtn = ashaPage.locator(`button[data-claim="${createdTicketId}"]`);
      const bilalTakeBtn = bilalPage.locator(`button[data-claim="${createdTicketId}"]`);
      await expect(ashaTakeBtn).toBeVisible();
      await expect(bilalTakeBtn).toBeVisible();

      // 4. Asha clicks Take first
      await ashaTakeBtn.click();
      // Asha's list re-renders and the ticket is no longer in "Unassigned"
      await expect(ashaPage.locator(`button[data-claim="${createdTicketId}"]`)).toHaveCount(0);

      // 5. Bilal clicks Take on the same ticket (list was already open)
      const dialogPromise = bilalPage.waitForEvent('dialog');
      await bilalTakeBtn.click();
      const dialog = await dialogPromise;

      // Assert Bilal sees "Already taken by Asha"
      expect(dialog.message()).toContain('Already taken by Asha');
      await dialog.accept();
    } finally {
      await ashaContext.close();
      await bilalContext.close();
    }
  });

  test('3. Asha writes internal note "PRIVATE-123" and public reply; customer page does NOT leak note', async ({ browser }) => {
    const ashaContext = await browser.newContext();
    const ashaPage = await ashaContext.newPage();
    trackErrors(ashaPage);

    try {
      // Asha logs in and opens the ticket
      await ashaPage.goto('/#/');
      await ashaPage.selectOption('#ag', { label: 'Asha' });
      await ashaPage.fill('#pw', 'frontdesk');
      await ashaPage.click('#go');
      await expect(ashaPage.locator('h2')).toContainText('Tickets');

      await ashaPage.goto(`/#/t/${createdTicketId}`);
      await expect(ashaPage.locator('h2')).toContainText(`Production system offline`);

      // Write internal note containing "PRIVATE-123"
      await ashaPage.click('button[data-tab="note"]');
      await expect(ashaPage.locator('#send')).toHaveText('Save internal note');
      await ashaPage.fill('#txt', 'Confidential diagnostics: PRIVATE-123. Do not disclose.');
      await ashaPage.click('#send');
      await expect(ashaPage.locator('.msg.internal')).toContainText('PRIVATE-123');

      // Write public reply
      await ashaPage.click('button[data-tab="reply"]');
      await expect(ashaPage.locator('#send')).toHaveText('Send reply');
      await ashaPage.fill('#txt', 'Hello Alice, we have identified the cause and deployed a hotfix.');
      await ashaPage.click('#send');
      await expect(ashaPage.locator('.msg.agent')).toContainText('Hello Alice, we have identified the cause and deployed a hotfix.');
    } finally {
      await ashaContext.close();
    }

    // Now inspect customer page
    const customerContext = await browser.newContext();
    const customerPage = await customerContext.newPage();
    trackErrors(customerPage);

    const capturedResponses = [];
    customerPage.on('response', async res => {
      try {
        const text = await res.text();
        capturedResponses.push(text);
      } catch (e) {
        // Ignore binary or streaming responses
      }
    });

    try {
      await customerPage.goto(`/#/c/${createdToken}`);
      await expect(customerPage.locator('h2')).toContainText('Production system offline');
      await expect(customerPage.locator('.msg.agent')).toContainText('Hello Alice, we have identified the cause and deployed a hotfix.');

      // Verify "PRIVATE-123" is NOT anywhere in the rendered page text or HTML
      const pageContent = await customerPage.content();
      expect(pageContent).not.toContain('PRIVATE-123');

      const bodyText = await customerPage.innerText('body');
      expect(bodyText).not.toContain('PRIVATE-123');

      // Verify "PRIVATE-123" is NOT in any network response captured during the test
      expect(capturedResponses.length).toBeGreaterThan(0);
      for (const responseText of capturedResponses) {
        expect(responseText).not.toContain('PRIVATE-123');
      }
    } finally {
      await customerContext.close();
    }
  });

  test('4. Asha replies with "wait for the customer" checked -> "Waiting on customer" badge, no "Late" badge; customer replies -> badge disappears', async ({ browser }) => {
    const ashaContext = await browser.newContext();
    const ashaPage = await ashaContext.newPage();
    trackErrors(ashaPage);

    try {
      // Asha logs in and opens ticket
      await ashaPage.goto('/#/');
      await ashaPage.selectOption('#ag', { label: 'Asha' });
      await ashaPage.fill('#pw', 'frontdesk');
      await ashaPage.click('#go');
      await expect(ashaPage.locator('h2')).toContainText('Tickets');

      await ashaPage.goto(`/#/t/${createdTicketId}`);
      await expect(ashaPage.locator('#send')).toHaveText('Send reply');
      await ashaPage.fill('#txt', 'Could you please confirm if services are working on your side?');
      await ashaPage.check('#wait');
      await ashaPage.click('#send');
      await expect(ashaPage.locator('.msg.agent').last()).toContainText('Could you please confirm if services are working on your side?');

      // Check Tickets list
      await ashaPage.click('header a[href="#/"]');
      await ashaPage.click('button[data-f="all"]');

      const ticketRow = ashaPage.locator(`tr:has(a[href="#/t/${createdTicketId}"])`);
      await expect(ticketRow).toBeVisible();
      await expect(ticketRow.locator('.b.wait')).toHaveText('Waiting on customer');
      await expect(ticketRow.locator('.b.late')).toHaveCount(0);
    } finally {
      await ashaContext.close();
    }

    // Customer replies
    const customerContext = await browser.newContext();
    const customerPage = await customerContext.newPage();
    trackErrors(customerPage);

    try {
      await customerPage.goto(`/#/c/${createdToken}`);
      await pageWaitAndFill(customerPage, '#b', 'Confirmed, everything is back to normal! Thank you!');
      await customerPage.click('#go');
      await expect(customerPage.locator('.msg.customer').last()).toContainText('Confirmed, everything is back to normal!');
    } finally {
      await customerContext.close();
    }

    // Asha verifies badge disappeared in list
    const ashaContext2 = await browser.newContext();
    const ashaPage2 = await ashaContext2.newPage();
    trackErrors(ashaPage2);

    try {
      await ashaPage2.goto('/#/');
      await ashaPage2.selectOption('#ag', { label: 'Asha' });
      await ashaPage2.fill('#pw', 'frontdesk');
      await ashaPage2.click('#go');
      await expect(ashaPage2.locator('h2')).toContainText('Tickets');

      await ashaPage2.click('button[data-f="all"]');
      const ticketRow = ashaPage2.locator(`tr:has(a[href="#/t/${createdTicketId}"])`);
      await expect(ticketRow).toBeVisible();
      await expect(ticketRow.locator('.b.wait')).toHaveCount(0);
    } finally {
      await ashaContext2.close();
    }
  });

  test('5. Seeded critical ticket shows "Late" badge; Asha cannot view late report; Meera sees report & holiday links and late tickets', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    trackErrors(page);

    try {
      // 1. Asha signs in
      await page.goto('/#/');
      await page.selectOption('#ag', { label: 'Asha' });
      await page.fill('#pw', 'frontdesk');
      await page.click('#go');
      await expect(page.locator('h2')).toContainText('Tickets');

      // In All tickets list, ticket #1 (seeded critical 3 days ago) shows "Late" badge
      await page.click('button[data-f="all"]');
      const seededRow = page.locator('tr:has(a[href="#/t/1"])');
      await expect(seededRow).toBeVisible();
      await expect(seededRow).toContainText('Whole team cannot log in');
      await expect(seededRow.locator('.b.late')).toHaveText('Late');

      // Asha sees neither report nor holiday links
      await expect(page.locator('header a[href="#/report"]')).toHaveCount(0);
      await expect(page.locator('header a[href="#/holidays"]')).toHaveCount(0);

      // Asha opening /#/report sees "The late report is for the support lead"
      await page.goto('/#/report');
      await expect(page.locator('.card')).toContainText('The late report is for the support lead');

      // Asha signs out
      await page.click('#lo');

      // 2. Meera signs in
      await page.goto('/#/');
      await expect(page.locator('h2')).toContainText('Agent sign in');
      await page.selectOption('#ag', { label: 'Meera (support lead)' });
      await page.fill('#pw', 'frontdesk');
      await page.click('#go');
      await expect(page.locator('h2')).toContainText('Tickets');

      // Meera sees both report and holiday links (and people link)
      await expect(page.locator('header a[href="#/report"]')).toBeVisible();
      await expect(page.locator('header a[href="#/holidays"]')).toBeVisible();

      // Meera opens /#/report and sees the late ticket report
      await page.click('header a[href="#/report"]');
      await page.waitForURL(/#\/report/);
      await expect(page.locator('h2')).toContainText('Late tickets');

      const reportRows = page.locator('tr:has(a[href="#/t/1"])');
      await expect(reportRows.first()).toBeVisible();
      await expect(reportRows.first()).toContainText('Whole team cannot log in');
      await expect(reportRows.first()).toContainText('critical');
    } finally {
      await context.close();
    }
  });

  test('6. Meera adds a holiday, sees it listed, then deletes it', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    trackErrors(page);

    try {
      await page.goto('/#/');
      await page.selectOption('#ag', { label: 'Meera (support lead)' });
      await page.fill('#pw', 'frontdesk');
      await page.click('#go');
      await expect(page.locator('h2')).toContainText('Tickets');

      await page.click('header a[href="#/holidays"]');
      await page.waitForURL(/#\/holidays/);
      await expect(page.locator('h2')).toContainText('Holidays');

      // Add a holiday
      await page.fill('#hd', '2026-11-25');
      await page.fill('#hn', 'Test Holiday');
      await page.click('#add');

      // Verify it appears in the table
      const holidayRow = page.locator('tr:has-text("Test Holiday")');
      await expect(holidayRow).toBeVisible();
      await expect(holidayRow).toContainText('2026-11-25');

      // Remove the holiday
      const delBtn = page.locator('button[data-del="2026-11-25"]');
      await expect(delBtn).toBeVisible();
      await delBtn.click();

      // Verify it was removed
      await expect(page.locator('tr:has-text("Test Holiday")')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('7. Meera resets Bilal\'s password; Bilal signs in with it, and the old password fails', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    trackErrors(page);

    let newPassword = '';
    try {
      // 1. Meera logs in and navigates to /#/people
      await page.goto('/#/');
      await page.selectOption('#ag', { label: 'Meera (support lead)' });
      await page.fill('#pw', 'frontdesk');
      await page.click('#go');
      await expect(page.locator('h2')).toContainText('Tickets');

      await page.click('header a[href="#/people"]');
      await page.waitForURL(/#\/people/);
      await expect(page.locator('h2')).toContainText('People');

      // Reset Bilal's password
      const bilalRow = page.locator('tr:has-text("Bilal")');
      await expect(bilalRow).toBeVisible();
      const resetBtn = bilalRow.locator('button[data-reset]');
      await resetBtn.click();

      // Success box appears with new password
      const resetBox = page.locator('#reset-box');
      await expect(resetBox).toBeVisible();
      newPassword = (await page.locator('#new-pw').textContent() || '').trim();
      expect(newPassword.length).toBeGreaterThanOrEqual(12);

      // Sign out
      await page.click('#lo');

      // 2. Bilal tries to log in with old password -> fails
      await page.selectOption('#ag', { label: 'Bilal' });
      await page.fill('#pw', 'frontdesk');
      await page.click('#go');
      await expect(page.locator('#e')).toContainText('Wrong agent or password');

      // 3. Bilal logs in with new password -> succeeds
      await page.fill('#pw', newPassword);
      await page.click('#go');
      await expect(page.locator('h2')).toContainText('Tickets');

      // Clean up: Bilal changes password back to frontdesk at /#/password
      await page.click('header a[href="#/password"]');
      await page.fill('#cp', newPassword);
      await page.fill('#np', 'frontdesk');
      await page.click('#go');
      await expect(page.locator('.card')).toContainText('Password changed');
    } finally {
      await context.close();
    }
  });

  test('8. Meera navigates to /#/sla, views SLA policies and important notice', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    trackErrors(page);

    try {
      await page.goto('/#/');
      await page.selectOption('#ag', { label: 'Meera (support lead)' });
      await page.fill('#pw', 'frontdesk');
      await page.click('#go');
      await expect(page.locator('h2')).toContainText('Tickets');

      // Click SLA link next to Holidays
      await expect(page.locator('header a[href="#/sla"]')).toBeVisible();
      await page.click('header a[href="#/sla"]');
      await page.waitForURL(/#\/sla/);
      await expect(page.locator('h2')).toContainText('SLA Targets');

      // Verify notice is present
      await expect(page.locator('.card p')).toContainText('Changes apply only to tickets created or reopened from now on. Existing tickets keep their deadlines.');

      // Verify rows for critical, medium, low
      await expect(page.locator('tr[data-prio="critical"]')).toBeVisible();
      await expect(page.locator('tr[data-prio="medium"]')).toBeVisible();
      await expect(page.locator('tr[data-prio="low"]')).toBeVisible();

      // Test editing Low priority: save button updates successfully
      const lowRow = page.locator('tr[data-prio="low"]');
      await lowRow.locator('button[data-save-sla="low"]').click();
      await expect(page.locator('#sla-msg')).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('9. Assert there are no console errors on each page', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    trackErrors(page);

    try {
      // 1. /#/new
      await page.goto('/#/new');
      await expect(page.locator('h2')).toContainText('Contact Arvo Support');

      // 2. /#/ (Login page)
      await page.goto('/#/');
      await expect(page.locator('h2')).toContainText('Agent sign in');

      // Sign in as Asha
      await page.selectOption('#ag', { label: 'Asha' });
      await page.fill('#pw', 'frontdesk');
      await page.click('#go');
      await expect(page.locator('h2')).toContainText('Tickets');

      // 3. /#/ (Home with tickets list)
      await page.click('button[data-f="all"]');
      await expect(page.locator('table')).toBeVisible();

      // 4. /#/t/1 (Ticket details)
      await page.goto('/#/t/1');
      await expect(page.locator('h2')).toContainText('Whole team cannot log in');

      // 5. /#/password
      await page.goto('/#/password');
      await expect(page.locator('h2')).toContainText('Change password');

      // Sign out Asha, Sign in Meera
      await page.click('#lo');
      await page.goto('/#/');
      await expect(page.locator('h2')).toContainText('Agent sign in');
      await page.selectOption('#ag', { label: 'Meera (support lead)' });
      await page.fill('#pw', 'frontdesk');
      await page.click('#go');
      await expect(page.locator('h2')).toContainText('Tickets');

      // 6. /#/report (Late report)
      await page.goto('/#/report');
      await expect(page.locator('h2')).toContainText('Late tickets');

      // 7. /#/holidays
      await page.goto('/#/holidays');
      await expect(page.locator('h2')).toContainText('Holidays');

      // 8. /#/sla
      await page.goto('/#/sla');
      await expect(page.locator('h2')).toContainText('SLA Targets');

      // 9. /#/people
      await page.goto('/#/people');
      await expect(page.locator('h2')).toContainText('People');

      // 10. /#/c/<token> (Customer page)
      await page.goto(`/#/c/${createdToken}`);
      await expect(page.locator('h2')).toContainText('Production system offline');
    } finally {
      await context.close();
    }
  });
});

async function pageWaitAndFill(page, selector, text) {
  await page.waitForSelector(selector);
  await page.fill(selector, text);
}
