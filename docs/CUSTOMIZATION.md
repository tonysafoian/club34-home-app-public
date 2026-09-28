# 🎨 Customization Guide — Bring Your Own Estate

Janus is engineered to be completely modular. Whether you are running a single-family smart home or managing a multi-acre residential property, this guide explains how to customize the platform for your own space.

---

## 🏷️ 1. App Identity & Branding

You can easily rebrand the dashboard with your family or property name.

### Name & Metadata
1. Open `index.html` and edit the title and meta tags:
   ```html
   <title>Your Estate OS</title>
   <meta name="description" content="Estate Management & Automation Hub" />
   ```
2. Update your `.env` configuration:
   ```env
   APP_DOMAIN=yourdomain.com
   HOUSEHOLD_DOMAIN=yourdomain.com
   ADMIN_EMAIL=yourname@yourdomain.com
   ```

### Theme & Colors
Janus uses Tailwind CSS with CSS variables defined in [`src/index.css`](../src/index.css). You can adjust the accent colors (HSL) to match your home's aesthetics:
```css
:root {
  --primary: 215 100% 50%;       /* Accent color (buttons, highlights) */
  --background: 220 20% 98%;     /* Light mode background */
  --card: 0 0% 100%;             /* Card panels */
}

.dark {
  --primary: 215 100% 60%;
  --background: 224 71% 4%;      /* Deep midnight dark mode */
  --card: 224 71% 7%;
}
```

---

## 🗺️ 2. Property & Irrigation Map (SVG Customization)

The estate dashboard displays a high-resolution interactive property map for monitoring irrigation zones, landscape lighting, and perimeter sensors.

### Replacing the Default SVG
The base layout is stored at:
```
src/assets/irrigation-map.svg
```

To replace this with your own property:
1. Export a 2D architectural site plan, Google Earth satellite outline, or blueprint of your property as an SVG file.
2. Ensure the viewBox is set cleanly (e.g. `viewBox="0 0 1000 600"`).
3. Replace `src/assets/irrigation-map.svg` with your SVG.

### Binding Clickable Zones
Zone pins and overlay polygons are configured in [`src/lib/irrigation/controllers.ts`](../src/lib/irrigation/controllers.ts). Each zone specifies coordinates corresponding to your SVG:
```ts
export interface IrrigationZone {
  id: string;
  name: string;
  controllerId: string;
  stationNumber: number;
  x: number;  // Percentage from left (0 to 100)
  y: number;  // Percentage from top (0 to 100)
  haEntityId: string; // Associated Home Assistant switch or valve
}
```

---

## 👥 3. Household Members & Access Roles

Household members and user profiles are stored in PostgreSQL.

### Seeding Household Members
Edit [`scripts/seed-household-members.example.sql`](../scripts/seed-household-members.example.sql) to add your family members:
```sql
INSERT INTO household_members (name, email, role, phone, avatar_url, preferences)
VALUES 
  ('Alex Johnson', 'alex@example.com', 'admin', '+15551234567', '/avatars/alex.jpg', '{"hvac_temp_pref": 69}'),
  ('Sam Johnson', 'sam@example.com', 'family', '+15552345678', '/avatars/sam.jpg', '{"hvac_temp_pref": 72}');
```

Apply the seed:
```bash
docker exec -i household-postgres psql -U postgres -d household_db < scripts/seed-household-members.example.sql
```

---

## ❄️ 4. Climate, Rooms & HVAC Zones

Climate controls in [`src/pages/HomeSystems.tsx`](../src/pages/HomeSystems.tsx) read from Home Assistant `climate` entities.

To map your thermostats:
1. Check the entity IDs in your Home Assistant (e.g., `climate.living_room`, `climate.primary_bedroom`).
2. Update the room definitions in `src/lib/homeAssistant.ts` or set them via the Admin settings panel in the web UI.

---

## ⚡ 5. Electrical & Backup Power Configuration

Janus provides comprehensive estate power observability, including backup generator telemetry, circuit-level wattage monitoring, and utility rate tariff tracking:

### Backup Generator (Generac Mobile Link / Local Bridge)
Monitor fuel levels, utility grid presence, transfer switch state, and weekly exercise cycles:
* In `src/pages/HomeSystems.tsx`, the `GeneracCard` displays real-time generator status (`READY`, `RUNNING_UTILITY_LOSS`, `EXERCISING`).
* Connect via Home Assistant's Generac Mobile Link integration or local Modbus controller.

### Circuit-Level Energy Monitoring (Emporia Vue)
Monitor high-draw estate circuits (HVAC compressors, EV wall chargers, pool pumps, kitchen sub-panels):
* Expose 16-channel Emporia Vue CT clamps to Home Assistant via ESPHome or the Emporia cloud integration.
* Janus aggregates historical circuit draw into daily and monthly cost reports in `/home-systems?section=energy`.
