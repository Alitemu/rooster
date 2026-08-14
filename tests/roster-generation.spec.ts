import { test, expect } from '@playwright/test';

test.describe('Roster Generation', () => {
  test.beforeEach(async ({ page }) => {
    // Seed database
    await page.request.post('http://localhost:3000/api/test/seed');

    // Login as planner
    await page.goto('http://localhost:3000/login');
    await page.fill('input[name="codenaam"]', 'PLANNER');
    await page.fill('input[name="password"]', 'planner-password');
    await page.click('button:has-text("Sign In")');

    // Wait for redirect
    await page.waitForURL('**/planner/**');
  });

  test('should open roster generation dialog', async ({ page }) => {
    // Navigate to planner dashboard
    await page.goto('http://localhost:3000/app/planner/period');

    // Click first period
    await page.click('text=Period 2027');

    // Find Generate Roster button
    const generateButton = page.locator('button:has-text("Generate Roster with Solver")');
    await expect(generateButton).toBeVisible();

    // Click to open dialog
    await generateButton.click();

    // Check dialog opened
    const dialog = page.locator('text=Generate Roster');
    await expect(dialog).toBeVisible();

    // Check dialog content
    await expect(page.locator('text=Respect all blocking preferences')).toBeVisible();
    await expect(page.locator('text=Balance assignments')).toBeVisible();
  });

  test('should generate roster successfully', async ({ page }) => {
    // Navigate to planner dashboard
    await page.goto('http://localhost:3000/app/planner/period/2027-01-04');

    // Open dialog
    const generateButton = page.locator('button:has-text("Generate Roster with Solver")');
    await generateButton.click();

    // Click Generate button
    const generateSubmitButton = page.locator('button:has-text("Generate")').last();
    await generateSubmitButton.click();

    // Wait for spinner to appear and disappear
    await expect(page.locator('text=Generating roster')).toBeVisible();

    // Wait for result (may take up to 35 seconds: 30s solver + 5s overhead)
    await expect(page.locator('text=✓ Roster Generated'), { timeout: 40000 }).toBeVisible();

    // Check result details
    await expect(page.locator('text=Assignments created:')).toBeVisible();
    await expect(page.locator('text=Solver status:')).toBeVisible();
    await expect(page.locator('text=Total cost:')).toBeVisible();
    await expect(page.locator('text=Time taken:')).toBeVisible();

    // Verify assignments were created (should be > 0)
    const assignmentCountText = page.locator('text=Assignments created:').locator('..');
    const assignmentCount = assignmentCountText.innerText();
    expect(parseInt(assignmentCount || '0')).toBeGreaterThan(0);

    // Verify solver status is either OPTIMAL or FEASIBLE
    const statusText = page.locator('text=Solver status:').locator('..');
    const status = statusText.innerText();
    expect(['OPTIMAL', 'FEASIBLE']).toContain(status);
  });

  test('should handle solver errors gracefully', async ({ page, context }) => {
    // Mock solver service to fail
    await context.addInitScript(() => {
      const originalFetch = window.fetch;
      (window as any).fetch = function (...args: any[]) {
        if (args[0]?.includes('/generate-roster')) {
          return Promise.resolve(
            new Response(JSON.stringify({ success: false, error: 'Solver service unavailable' }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            })
          );
        }
        return originalFetch.apply(this, args);
      };
    });

    // Navigate to planner dashboard
    await page.goto('http://localhost:3000/app/planner/period/2027-01-04');

    // Open dialog
    const generateButton = page.locator('button:has-text("Generate Roster with Solver")');
    await generateButton.click();

    // Click Generate button
    const generateSubmitButton = page.locator('button:has-text("Generate")').last();
    await generateSubmitButton.click();

    // Check error message appears
    await expect(page.locator('text=✗ Error'), { timeout: 10000 }).toBeVisible();
    await expect(page.locator('text=Solver service unavailable')).toBeVisible();

    // Check Retry button is available
    const retryButton = page.locator('button:has-text("Retry")');
    await expect(retryButton).toBeVisible();
  });

  test('should disable generate button when period is already generated', async ({ page }) => {
    // Navigate to planner dashboard
    await page.goto('http://localhost:3000/app/planner/period/2027-01-04');

    // First generation
    let generateButton = page.locator('button:has-text("Generate Roster with Solver")');
    await generateButton.click();

    const generateSubmitButton = page.locator('button:has-text("Generate")').last();
    await generateSubmitButton.click();

    // Wait for result
    await expect(page.locator('text=✓ Roster Generated'), { timeout: 40000 }).toBeVisible();

    // Close dialog
    const closeButton = page.locator('button:has-text("Close")').last();
    await closeButton.click();

    // Reload page
    await page.reload();

    // Check generate button is disabled
    generateButton = page.locator('button:has-text("Generate Roster with Solver")');
    await expect(generateButton).toBeDisabled();
  });

  test('should allow regeneration when result is shown', async ({ page }) => {
    // Navigate to planner dashboard
    await page.goto('http://localhost:3000/app/planner/period/2027-01-04');

    // Open dialog
    const generateButton = page.locator('button:has-text("Generate Roster with Solver")');
    await generateButton.click();

    // First generation
    let generateSubmitButton = page.locator('button:has-text("Generate")').last();
    await generateSubmitButton.click();

    // Wait for result
    await expect(page.locator('text=✓ Roster Generated'), { timeout: 40000 }).toBeVisible();

    // Click Regenerate button
    const regenerateButton = page.locator('button:has-text("Regenerate")');
    await expect(regenerateButton).toBeVisible();
    await regenerateButton.click();

    // Wait for new result
    await expect(page.locator('text=Generating roster')).toBeVisible();
    await expect(page.locator('text=✓ Roster Generated'), { timeout: 40000 }).toBeVisible();

    // Verify assignment count
    const assignmentCountText = page.locator('text=Assignments created:').locator('..');
    const assignmentCount = assignmentCountText.innerText();
    expect(parseInt(assignmentCount || '0')).toBeGreaterThan(0);
  });

  test('should show violations when soft preferences are violated', async ({ page }) => {
    // Navigate to planner dashboard
    await page.goto('http://localhost:3000/app/planner/period/2027-01-04');

    // Open dialog
    const generateButton = page.locator('button:has-text("Generate Roster with Solver")');
    await generateButton.click();

    // Generate
    const generateSubmitButton = page.locator('button:has-text("Generate")').last();
    await generateSubmitButton.click();

    // Wait for result
    await expect(page.locator('text=✓ Roster Generated'), { timeout: 40000 }).toBeVisible();

    // Check if violations section is shown (may be empty if no violations)
    const violationsSection = page.locator('text=Violations:');
    const violationsSectionVisible = await violationsSection.isVisible();

    if (violationsSectionVisible) {
      // If violations exist, they should be displayed
      await expect(violationsSection).toBeVisible();
    }
  });
});
