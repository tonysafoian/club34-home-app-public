# 🏀 Community & Sports Hub (Pickup League Coordinator)

Household OS includes a dedicated community sports module originally designed to organize weekly pickup basketball games. It manages recurring game schedules, player rosters, real-time RSVPs, waitlists, and automated weather contingency notifications.

---

## 📅 1. How It Works

1. **Game Coordination**:
   - Recurring games (e.g., Sunday mornings at 9:00 AM) are scheduled automatically.
   - Court weather forecasts (temperature, precipitation probability, wind) are evaluated 24 hours and 2 hours prior to tip-off.

2. **RSVP Pipeline**:
   - Members receive an automated notification (SMS or WhatsApp) asking to confirm attendance.
   - Live roster tracking: Once 10 players confirm ("IN"), subsequent responders are placed on an active **Waitlist**.
   - If a player cancels ("OUT"), the first waitlisted player is automatically promoted and notified.

3. **Game Day Roster**:
   - The interactive `/ball` dashboard displays current attendees, waitlist order, and organizer contact details.

---

## ⚙️ 2. Configuration & Seeding

### Environment Variables
Configure your sport and location in `.env`:
```env
BALL_TITLE="Weekly Pickup Basketball"
BALL_LOCATION="Community Recreation Center, Court 1"
HOST_NAME="Organizer Name"
HOST_EMAIL="organizer@example.com"
```

### Seeding Your Roster
Add your players to [`scripts/seed-ball-roster.example.sql`](../../scripts/seed-ball-roster.example.sql):
```sql
INSERT INTO ball_roster (name, phone, role, is_active)
VALUES
  ('Marcus Vance', '+15551112222', 'regular', true),
  ('David Chen', '+15552223333', 'regular', true),
  ('Chris Taylor', '+15553334444', 'substitute', true);
```

Run the seed script:
```bash
docker exec -i household-postgres psql -U postgres -d household_db < scripts/seed-ball-roster.example.sql
```

---

## 📱 3. Messaging Integrations (WhatsApp & SMS)

Household OS supports automated messaging for game reminders:
- **WATI (WhatsApp Business API)**:
  ```env
  WATI_API_KEY=your_wati_api_key
  WATI_TENANT_ID=your_wati_tenant_id
  ```
- **Twilio SMS**:
  ```env
  TWILIO_ACCOUNT_SID=your_sid
  TWILIO_AUTH_TOKEN=your_token
  TWILIO_FROM_PHONE=+15559998888
  ```

---

## 🎾 4. Adapting for Other Sports & Clubs

The data model and dashboard are sport-agnostic. You can easily adapt the module for:
* **Tennis & Pickleball**: Court reservation tracking, doubles partner matching.
* **Golf Leagues**: Tee time scheduling, handicap tracking.
* **Running & Cycling Groups**: Route planning, start time polling.
* **Soccer / Futsal**: 5v5 or 7v7 squad coordination.
