"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const monitor = require("./monitor-opentoken-subscriptions");

function fixtureResponse() {
  return {
    success: true,
    data: [
      {
        id: 1,
        title: "normal plan",
        price_amount: 9.9,
        rate_multiplier: 0.5,
      },
      {
        id: 2,
        title: "cheap plan",
        price_amount: 0.02,
        rate_multiplier: 0.02,
      },
      {
        id: 3,
        title: "free trial",
        price_amount: 0,
        duration: 7,
      },
    ],
  };
}

function testExtractPlans() {
  const plans = monitor.extractPlans(fixtureResponse());
  assert.strictEqual(plans.length, 3);
  assert.strictEqual(plans[1].title, "cheap plan");
}

function testFindAlertsAtThreshold() {
  const plans = monitor.extractPlans(fixtureResponse());
  const alerts = monitor.findAlerts(plans, 0.02, {
    OPENTOKEN_SUBSCRIPTION_PRICE_FIELDS: "price_amount,rate_multiplier",
  });
  assert.ok(alerts.some((item) => item.title === "cheap plan" && item.metric.path === "price_amount"));
  assert.ok(alerts.some((item) => item.title === "cheap plan" && item.metric.path === "rate_multiplier"));
  assert.ok(alerts.some((item) => item.title === "free trial" && item.metric.path === "price_amount"));
  assert.ok(!alerts.some((item) => item.title === "normal plan"));
}

function testCanExcludeZero() {
  const plans = monitor.extractPlans(fixtureResponse());
  const alerts = monitor.findAlerts(plans, 0.02, {
    OPENTOKEN_SUBSCRIPTION_PRICE_FIELDS: "price_amount,rate_multiplier",
    OPENTOKEN_SUBSCRIPTION_INCLUDE_ZERO: "0",
  });
  assert.ok(alerts.some((item) => item.title === "cheap plan"));
  assert.ok(!alerts.some((item) => item.title === "free trial"));
}

function testExtractOtokapiPlans() {
  const plans = monitor.extractPlans({
    code: 0,
    data: [
      { id: 10, name: "starter", price: 1, rate_multiplier: 0.12 },
      { id: 11, name: "promo", price: 1, rate_multiplier: "2%" },
    ],
  });
  assert.strictEqual(plans.length, 2);
  assert.strictEqual(plans[0].name, "starter");
}

function testFindMinimumRateMultiplier() {
  const plans = monitor.extractPlans({
    code: 0,
    data: [
      { id: 10, name: "starter", price: 1, rate_multiplier: 0.12 },
      { id: 11, name: "promo", price: 1, rate_multiplier: "2%" },
      { id: 12, name: "edge", price: 1, rate_multiplier: 0.03 },
    ],
  });
  const minimum = monitor.findMinimumMetric(plans, {
    OPENTOKEN_SUBSCRIPTION_PRICE_FIELDS: "rate_multiplier",
  });
  assert.strictEqual(minimum.title, "promo");
  assert.strictEqual(minimum.metric_path, "rate_multiplier");
  assert.strictEqual(minimum.metric_value, 0.02);
}

function testComputedMultiplierFromQuota() {
  const plans = [
    {
      id: 23,
      name: "体验日卡",
      price: 10,
      validity_days: 1,
      features: "每日 $100 调用额度\n1 天有效期",
    },
    {
      id: 37,
      name: "顶配版",
      price: 350,
      validity_days: 7,
      features: "每日 $1000 调用额度\n倍率约 0.05(¥1 ≈ $20 调用额度)\n7 天有效期",
    },
  ];
  const experience = monitor.collectPlanMetrics(plans[0], {
    OPENTOKEN_SUBSCRIPTION_PRICE_FIELDS: "computed_multiplier",
  });
  const top = monitor.collectPlanMetrics(plans[1], {
    OPENTOKEN_SUBSCRIPTION_PRICE_FIELDS: "declared_multiplier,computed_multiplier",
  });
  assert.strictEqual(experience[0].path, "computed_multiplier");
  assert.strictEqual(experience[0].value, 0.1);
  assert.ok(top.some((item) => item.path === "declared_multiplier" && item.value === 0.05));
  assert.ok(top.some((item) => item.path === "computed_multiplier" && item.value === 0.05));

  const minimum = monitor.findMinimumMetric(plans, {
    OPENTOKEN_SUBSCRIPTION_PRICE_FIELDS: "declared_multiplier,computed_multiplier",
  });
  assert.strictEqual(minimum.metric_value, 0.05);
}

function testPriceDoesNotMatchOriginalPrice() {
  const metrics = monitor.collectPlanMetrics(
    { id: 1, name: "promo", price: 10, original_price: 0 },
    { OPENTOKEN_SUBSCRIPTION_PRICE_FIELDS: "price" }
  );
  assert.deepStrictEqual(metrics.map((item) => item.path), ["price"]);
}

function testExtractBrowserAuthTokenCandidates() {
  const token = [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6Ik90b2thcGkifQ",
    "c2lnbmF0dXJlX3BhcnRfdGVzdF90b2tlbg",
  ].join(".");
  const text = `_https://otokapi.com auth_token ${token}`;
  const compressedText = `_https://tokap-E0auth_token ${token}`;
  assert.deepStrictEqual(monitor.extractBrowserAuthTokensFromText(text), [token]);
  assert.deepStrictEqual(monitor.extractBrowserAuthTokensFromText(compressedText), [token]);
  assert.deepStrictEqual(monitor.extractBrowserAuthTokensFromText(`_https://other.example auth_token ${token}`), []);
}

function testWatchDefaultsToOneMinute() {
  const options = monitor.parseArgs(["--watch"]);
  assert.strictEqual(options.intervalSeconds, 60);
}

async function testRunOnceDryRunDoesNotWriteState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opentoken-subscription-monitor-"));
  const fixture = path.join(dir, "plans.json");
  const state = path.join(dir, "state.json");
  fs.writeFileSync(fixture, JSON.stringify(fixtureResponse()), "utf8");

  const result = await monitor.runOnce(
    {
      dryRun: true,
      fixture,
      intervalSeconds: 0,
      json: true,
      listOnly: false,
      noState: false,
      repeatAlerts: false,
      threshold: 0.02,
    },
    {
      OPENTOKEN_SUBSCRIPTION_PRICE_FIELDS: "price_amount,ratio",
      OPENTOKEN_SUBSCRIPTION_STATE_FILE: state,
      LARK_CHAT_ID: "oc_test",
    }
  );
  assert.strictEqual(result.plan_count, 3);
  assert.strictEqual(result.notify.sent, false);
  assert.strictEqual(result.notify.reason, "dry-run");
  assert.strictEqual(fs.existsSync(state), false);
}

async function testRunOnceMinimumModeOnlyReportsOneLowest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opentoken-subscription-monitor-"));
  const fixture = path.join(dir, "plans.json");
  fs.writeFileSync(
    fixture,
    JSON.stringify({
      data: [
        {
          id: 23,
          name: "体验日卡",
          price: 10,
          validity_days: 1,
          features: "每日 $100 调用额度",
        },
        {
          id: 37,
          name: "顶配版",
          price: 350,
          validity_days: 7,
          features: "每日 $1000 调用额度\n倍率约 0.05(¥1 ≈ $20 调用额度)",
        },
      ],
    }),
    "utf8"
  );

  const result = await monitor.runOnce(
    {
      alertMode: "minimum",
      dryRun: true,
      fixture,
      intervalSeconds: 0,
      json: true,
      listOnly: false,
      noState: false,
      repeatAlerts: false,
      threshold: 0.05,
    },
    {
      OPENTOKEN_SUBSCRIPTION_PRICE_FIELDS: "declared_multiplier,computed_multiplier",
      OPENTOKEN_SUBSCRIPTION_STATE_FILE: path.join(dir, "state.json"),
      LARK_USER_ID: "ou_test",
    }
  );
  assert.strictEqual(result.alert_mode, "minimum");
  assert.strictEqual(result.alert_count, 1);
  assert.strictEqual(result.alerts[0].title, "顶配版");
  assert.strictEqual(result.alerts[0].metric_value, 0.05);
}

async function main() {
  testExtractPlans();
  testFindAlertsAtThreshold();
  testCanExcludeZero();
  testExtractOtokapiPlans();
  testFindMinimumRateMultiplier();
  testComputedMultiplierFromQuota();
  testPriceDoesNotMatchOriginalPrice();
  testExtractBrowserAuthTokenCandidates();
  testWatchDefaultsToOneMinute();
  await testRunOnceDryRunDoesNotWriteState();
  await testRunOnceMinimumModeOnlyReportsOneLowest();
  console.log("opentoken subscription monitor canaries ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
