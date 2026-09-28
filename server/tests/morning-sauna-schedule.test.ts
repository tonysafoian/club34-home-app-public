import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const automation = readFileSync(path.join(root, 'server/routes/automation.ts'), 'utf8');
const cron = readFileSync(path.join(root, 'server/routes/cron.ts'), 'utf8');
const page = readFileSync(path.join(root, 'src/pages/Automations.tsx'), 'utf8');

const checks: Array<[string, () => void]> = [
  ['MWF starts at 8:30 AM PT', () => assert.match(cron, /'30 8 \* \* 1,3,5'[\s\S]*morning-sauna'\)/)],
  ['MWF stops at 9:00 AM PT', () => assert.match(cron, /'0 9 \* \* 1,3,5'[\s\S]*morning-sauna\/stop'\)/)],
  ['Tue/Thu starts at 8:50 AM PT', () => assert.match(cron, /'50 8 \* \* 2,4'[\s\S]*morning-sauna'\)/)],
  ['Tue/Thu stops at 9:20 AM PT', () => assert.match(cron, /'20 9 \* \* 2,4'[\s\S]*morning-sauna\/stop'\)/)],
  ['all four jobs use Pacific time', () => {
    const saunaScheduleBlock = cron.slice(cron.indexOf("cron.schedule('30 8 * * 1,3,5'"), cron.indexOf("cron.schedule('*/30 * * * *'", cron.indexOf("cron.schedule('30 8 * * 1,3,5'")));
    assert.equal((saunaScheduleBlock.match(/timezone: 'America\/Los_Angeles'/g) || []).length, 4);
  }],
  ['vacation mode still skips the scheduled start', () => {
    const startRoute = automation.slice(automation.indexOf("router.post('/morning-sauna'"), automation.indexOf("router.post('/morning-sauna/stop'"));
    assert.ok(startRoute.includes('if (!automation.is_active)'));
    assert.ok(startRoute.includes('skipped: true'));
    assert.ok(startRoute.includes("logAutomationRun(automation.id, 'skipped'"));
  }],
  ['scheduled stop is not vacation-gated', () => {
    const stopRoute = automation.slice(automation.indexOf("router.post('/morning-sauna/stop'"), automation.indexOf("router.post('/morning-sauna/control'"));
    assert.ok(stopRoute.includes('saunaPowerOff()'));
    assert.ok(!stopRoute.includes('!automation.is_active'));
  }],
  ['automatic stop records all outcome classes', () => {
    const stopRoute = automation.slice(automation.indexOf("router.post('/morning-sauna/stop'"), automation.indexOf("router.post('/morning-sauna/control'"));
    for (const outcome of ['success', 'partial', 'skipped', 'failed']) {
      assert.ok(stopRoute.includes(`'${outcome}'`), `missing ${outcome} outcome`);
    }
    assert.ok(stopRoute.includes('logAutomationRun'));
    assert.ok(stopRoute.includes('logAudit'));
  }],
  ['manual start and stop behavior remains present', () => {
    const manualRoute = automation.slice(automation.indexOf("router.post('/morning-sauna/control'"));
    assert.match(manualRoute, /action === 'start'[\s\S]*saunaPowerOff\(\)[\s\S]*saunaPowerOn\(\)[\s\S]*saunaSetTemp\(190\)/);
    assert.match(manualRoute, /else \{[\s\S]*saunaPowerOff\(\)/);
  }],
  ['detail page describes 30-minute helper-based controls', () => {
    assert.match(page, /Runs the sauna at 190\\u00b0F for 30 minutes/);
    assert.match(page, /input_boolean\.sauna_power off→on/);
    assert.match(page, /input_number\.sauna_target_temp to 190°F/);
    assert.match(page, /Turn off HA input_boolean\.sauna_power after 30 minutes/);
  }],
];

let failed = 0;
for (const [name, check] of checks) {
  try {
    check();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failed++;
    console.error(`[FAIL] ${name}`);
    console.error(error);
  }
}

if (failed > 0) {
  console.error(`\n${failed} Morning Sauna regression check(s) failed.`);
  process.exit(1);
}

console.log(`\nAll ${checks.length} Morning Sauna regression checks passed.`);