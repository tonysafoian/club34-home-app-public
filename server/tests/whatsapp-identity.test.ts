import { query } from "../lib/db";

async function verifyWhatsAppIdentityResolution() {
  const results: { test: string; passed: boolean; detail: string }[] = [];

  const { rows: tonyHM } = await query(
    `SELECT display_name, whatsapp_number, role FROM household_members WHERE email = 'admin@example.com'`
  );
  results.push({
    test: "Admin exists in household_members with phone",
    passed: tonyHM.length === 1 && tonyHM[0].whatsapp_number === "15550100",
    detail: tonyHM.length ? `phone=${tonyHM[0].whatsapp_number}, role=${tonyHM[0].role}` : "NOT FOUND",
  });

  const { rows: tonyProfile } = await query(
    `SELECT phone_number, user_id FROM profiles WHERE user_id = 'google_sample_admin_uid'`
  );
  results.push({
    test: "Admin exists in profiles with phone",
    passed: tonyProfile.length === 1 && tonyProfile[0].phone_number === "15550100",
    detail: tonyProfile.length ? `phone=${tonyProfile[0].phone_number}` : "NOT FOUND",
  });

  const { rows: tonyRole } = await query(
    `SELECT role FROM user_roles WHERE user_id = 'google_sample_admin_uid'`
  );
  results.push({
    test: "Admin has admin role in user_roles",
    passed: tonyRole.length === 1 && tonyRole[0].role === "admin",
    detail: tonyRole.length ? `role=${tonyRole[0].role}` : "NOT FOUND",
  });

  const familyMembers = [
    { name: "Family Member", email: "member@example.com", phone: "15550101" },
    { name: "Member 2", email: "member2@example.com", phone: "15550102" },
    { name: "Member 3", email: "member3@example.com", phone: "15550103" },
  ];
  for (const m of familyMembers) {
    const { rows } = await query(
      `SELECT whatsapp_number FROM household_members WHERE email = $1`, [m.email]
    );
    results.push({
      test: `${m.name} has phone in household_members`,
      passed: rows.length === 1 && rows[0].whatsapp_number === m.phone,
      detail: rows.length ? `phone=${rows[0].whatsapp_number}` : "NOT FOUND",
    });
  }

  const { rows: outsiderCheck } = await query(
    `SELECT display_name FROM household_members WHERE whatsapp_number = '15551234567'`
  );
  results.push({
    test: "Unknown phone not in household_members",
    passed: outsiderCheck.length === 0,
    detail: outsiderCheck.length ? `FOUND: ${outsiderCheck[0].display_name}` : "correctly absent",
  });

  const port = process.env.PORT || 5000;
  const baseUrl = `http://localhost:${port}`;

  try {
    const tonyRes = await fetch(`${baseUrl}/api/janus/whatsapp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ waId: "15550100", senderName: "Admin", text: "identity test admin check", type: "text" }),
    });
    const tonyData = await tonyRes.json() as Record<string, unknown>;
    const tonyIsNotOutsider = tonyData.outsider !== true;
    results.push({
      test: "Admin (15550100) resolves as non-outsider via webhook",
      passed: tonyIsNotOutsider,
      detail: JSON.stringify(tonyData),
    });
  } catch (e) {
    results.push({ test: "Admin webhook test", passed: false, detail: `Error: ${e}` });
  }

  try {
    const unknownRes = await fetch(`${baseUrl}/api/janus/whatsapp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ waId: "15559999999", senderName: "Stranger", text: "hello there", type: "text" }),
    });
    const unknownData = await unknownRes.json() as Record<string, unknown>;
    results.push({
      test: "Unknown number (15559999999) resolves as outsider via webhook",
      passed: unknownData.outsider === true,
      detail: JSON.stringify(unknownData),
    });
  } catch (e) {
    results.push({ test: "Unknown webhook test", passed: false, detail: `Error: ${e}` });
  }

  let allPassed = true;
  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    if (!r.passed) allPassed = false;
    console.log(`[${status}] ${r.test} — ${r.detail}`);
  }

  if (!allPassed) {
    console.error("\nSome tests FAILED!");
    process.exit(1);
  }
  console.log(`\nAll ${results.length} tests passed.`);
  process.exit(0);
}

verifyWhatsAppIdentityResolution().catch((e) => { console.error(e); process.exit(1); });
