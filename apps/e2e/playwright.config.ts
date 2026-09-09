import { defineConfig, devices } from "@playwright/test";
import { env } from "./tests/support/env";

/**
 * One suite, five projects, three personas.
 *
 *   public    no credentials: widget delivery, config refusals, the ask
 *             contract, the hosted assistant, the embedded widget on a
 *             harness page, and the anonymous security surface.
 *   setup     signs each persona in through the real sign-in page and saves
 *             its storage state. A persona with no credentials in the
 *             environment is recorded as absent and its project skips.
 *   learner   signed-in student: conversation, progress, sign-out.
 *   teacher   tenant owner/admin: agent, courses, publish, widget, hosted
 *             publication, users, insights.
 *   admin     platform owner: tenants, sections, provisioning.
 *
 * Nothing here talks to the database. Every assertion goes through the same
 * routes a person uses, so a green run is evidence about the product and not
 * about a fixture. See docs/TESTING.md for what each project proves, what it
 * needs, and what remains manual.
 */
env.ensureStorageStates();

export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Journeys mutate shared tenant state; run them in order, one worker.
  fullyParallel: false,
  workers: 1,
  retries: env.ci ? 1 : 0,
  forbidOnly: env.ci,
  outputDir: "./test-results",
  reporter: env.ci
    ? [["list"], ["html", { open: "never" }], ["github"]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: env.baseUrl,
    // The system Chrome, so the suite needs no browser download. Set
    // E2E_BROWSER_CHANNEL=chromium to use Playwright's own build instead.
    channel: env.browserChannel,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "public",
      testMatch: /tests\/public\/.*\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], channel: env.browserChannel },
    },
    {
      name: "setup",
      testMatch: /tests\/auth\.setup\.ts$/,
    },
    {
      name: "learner",
      testMatch: /tests\/learner\/.*\.spec\.ts$/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        channel: env.browserChannel,
        storageState: env.storageStatePath("learner"),
      },
    },
    {
      name: "teacher",
      testMatch: /tests\/teacher\/.*\.spec\.ts$/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        channel: env.browserChannel,
        storageState: env.storageStatePath("teacher"),
      },
    },
    {
      name: "admin",
      testMatch: /tests\/admin\/.*\.spec\.ts$/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        channel: env.browserChannel,
        storageState: env.storageStatePath("admin"),
      },
    },
  ],
});
