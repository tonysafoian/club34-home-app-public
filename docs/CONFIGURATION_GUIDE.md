# 🏛️ Janus Home Automation — Non-Technical Setup & Configuration Guide

Welcome to **Janus**! Janus is a private, intelligent household operating system designed to run seamlessly on top of your existing Home Assistant setup. 

When you install the Janus add-on, **all of your existing lights, thermostats, locks, and switches are automatically discovered with zero configuration.**

Follow this quick step-by-step guide to activate your free AI voice assistant, connect your family calendars, and personalize your estate.

---

## ⚡ Quick Checklist

- [ ] **Step 1:** Get your free Google Gemini API Key (takes 60 seconds).
- [ ] **Step 2:** Paste the key into the Janus Add-on settings in Home Assistant.
- [ ] **Step 3:** Open Janus and connect your Google Account (for calendar & morning briefs).
- [ ] **Step 4:** Add your family members and household staff on the Settings page.
- [ ] **Step 5:** Personalize your estate name and color theme.

---

## 1. Get Your Free Google Gemini AI Key (Voice & Reasoning)

Janus uses Google's latest Gemini AI models to provide natural voice conversations, understand your spoken requests, and deliver morning household briefings. Google provides a **generous free tier** that is more than enough for everyday household use.

1. Go to **[Google AI Studio](https://aistudio.google.com/)** in your web browser.
2. Sign in with your standard Google / Gmail account.
3. Click the blue **Get API key** button in the top navigation.
4. Click **Create API key** (choose any project or create a default one).
5. Copy the generated key. It will start with `AIzaSy...`.

---

## 2. Add the API Key to Home Assistant

Once you have copied your key:

1. Open **Home Assistant** in your browser.
2. Navigate to **Settings** ➔ **Add-ons** (or **Apps** on newer versions).
3. Click on the **Janus** add-on.
4. Click on the **Configuration** tab at the top.
5. In the `gemini_api_key` field, paste your copied key.
6. Click **Save** at the bottom right.
7. Click the **Restart** button on the add-on to apply the change.

> **💡 That's it!** Janus now has its full voice AI brain activated.

---

## 3. Connect Google Services (Family Calendars & Morning Briefs)

Janus can review your family schedule and generate an intelligent daily morning executive digest (meetings, school runs, weather, and household reminders):

1. Open Janus from the **Home Assistant sidebar** (or click **Open Web UI** on the Janus add-on page).
2. Click the **Settings** gear icon in the top right (or navigate to `/settings`).
3. Scroll down to the **Google Services** card.
4. Click **Connect Google Account**.
5. Follow Google's standard authorization prompt to approve access to Google Calendar.
6. Once redirected back, the card will display a green **Connected as your-email@gmail.com** badge.

---

## 4. Set Up Household & Family Members (No Code!)

Janus allows you to add everyone in your home so the AI knows who is who when you speak to it:

1. In Janus, go to **Settings** ➔ **Household & Family Members**.
2. Click **+ Add Member**.
3. Fill in the member's details:
   - **Full Name / Display Name**: (e.g., *Sarah Miller*)
   - **Role**: Choose between *Admin*, *Family Member*, *Household Staff*, or *Guest*.
   - **Email Address**: (Used for system notifications and calendar matching).
   - **WhatsApp Phone Number**: (Optional, format: `+1XXXXXXXXXX` for estate alerts and broadcast messages).
   - **Spoken Aliases / Nicknames**: (e.g., *Mom, Sarah, Dr. Miller*) — this tells Janus AI who you mean when you say *"Remind Mom to check the gate"*.
4. Click **Save Member**.
5. Repeat for each person in your family or household staff.

---

## 5. Personalize Your Estate Branding & Colors

Give Janus the look and feel of your home:

1. In Janus, go to **Settings** ➔ **Estate Branding & Appearance**.
2. **Estate Name**: Change from *"Janus"* to your family name or residence (e.g., *"The Miller Residence"*, *"Highland Villa"*, or *"Oakridge Estate"*). Click **Save**.
3. **Accent Palette**: Choose your preferred color theme:
   - 🟡 **Janus Amber** (Classic warm estate glow)
   - 🔵 **Cobalt Blue** (Modern, clean, architectural)
   - 🟢 **Emerald Green** (Natural, lush botanical)
   - 🟣 **Royal Amethyst** (Refined, regal luxury)
   - 🌸 **Rose Gold** (Soft, elegant warm bronze)
   - ⚪ **Slate Neutral** (Minimalist, understated monochrome)
4. **Custom Emblem / Logo**: Upload an image file (family crest, estate photo, or monogram) to appear in the header and home command deck.

---

## 6. Smart Home Devices & Multi-Room Audio

- **Smart Home Devices**: Click **Systems** in the top navigation bar. All lights, climate thermostats, smart switches, and sensors paired with Home Assistant appear here automatically. You can toggle them, adjust temperatures, or run scenes directly.
- **Audio Speakers**: Janus automatically scans your Home Assistant network for Sonos, Apple AirPlay/HomePods, and Google Cast media players. Spoken voice announcements and morning briefings can be directed to any individual room or the entire house.

---

## ❓ Frequently Asked Questions (FAQ)

### Do I ever need to write YAML or code to make changes?
**No.** All family members, estate names, color themes, and connected accounts are configured directly in the Janus graphical interface.

### Is the Gemini API Key really free?
**Yes.** Google AI Studio provides a free tier with 15 requests per minute and 1,500 requests per day. For a household, a typical day of voice queries and morning briefings uses less than 20–50 requests, keeping you well within the 100% free limit.

### Does Janus send my cameras or smart devices to external clouds?
**No.** Janus communicates directly with your Home Assistant instance over your local private network. Only explicit voice or conversational questions that you ask Janus are processed by the LLM for natural language understanding.

### Can family members install Janus on their iPhones or Android phones?
**Yes.** Janus is built as a Progressive Web App (PWA):
1. Open your Home Assistant URL in Safari (iOS) or Chrome (Android).
2. Tap the **Share** button (iOS) or the three-dot menu (Android).
3. Select **Add to Home Screen**.
4. Janus will install as a standalone app with smooth animations, dark mode, and instant launch.

### How do I update Janus when a new version is released?
1. In Home Assistant, go to **Settings** ➔ **Add-ons** ➔ **Add-on Store**.
2. Click the three dots (⋮) in the top-right and select **Check for updates**.
3. Return to the Janus add-on page and click **Update**.
4. All of your settings, custom family members, and database history are stored in Home Assistant's permanent `/data` storage and will remain intact across updates.

### Need help or found an issue?
Submit feedback or feature requests on the [GitHub Repository](https://github.com/tonysafoian/janus-home-app).
