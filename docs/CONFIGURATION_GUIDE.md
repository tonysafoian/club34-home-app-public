# 🏛️ Janus Home Automation — Non-Technical Setup & Configuration Guide

Welcome to **Janus**! Janus is a private, intelligent household operating system designed to run seamlessly on top of your existing Home Assistant setup. 

When you install the Janus add-on, **all of your existing lights, thermostats, locks, and switches are automatically discovered with zero configuration.**

Follow this quick step-by-step guide to activate your free AI voice assistant, connect your family calendars, and personalize your estate.

---

## ⚡ Quick Checklist

- [ ] **Step 1: Sign in with Local Access Mode** (Click "Enter Local Access Mode" — instant access to all your lights & devices).
- [ ] **Step 2: Get your free Google Gemini API Key** (takes 60 seconds at aistudio.google.com).
- [ ] **Step 3: Paste the key into Home Assistant** (Janus Add-on ➔ Configuration tab).
- [ ] **Step 4: Personalize your household** (Add family members & change estate branding under Settings).
- [ ] **Step 5 (Optional): Connect Google Calendar** (For morning schedule digests).

---

## 🔑 1. Logging In: Local Access vs Google Sign-In

When you launch Janus, you will see the login screen:

### 🏠 Enter Local Access Mode (Recommended)
- **Click "Enter Local Access Mode".**
- Because Janus runs directly inside your private Home Assistant instance, this gives you **instant, full administrative control** over your smart home.
- All your lights, thermostats, locks, scenes, and media players are automatically discovered.
- **No external accounts or passwords required.**

### 🌐 Google Sign-In (Optional Cloud Feature)
- **Google Sign-In is completely optional.**
- It is only needed if you want Janus to read your family Google Calendar and Gmail to generate spoken morning briefings.
- If you click "Sign in with Google" before configuring Google OAuth, Janus will explain that it is optional and invite you to use Local Access Mode.
- *(See Section 5 below if you want to set up Google Calendar sync).*

---

## 2. Get Your Free Google Gemini AI Key (Voice & Reasoning)

Janus uses Google's latest Gemini AI models to provide natural voice conversations, understand your spoken requests, and deliver morning household briefings. Google provides a **generous free tier** that is more than enough for everyday household use.

1. Go to **[Google AI Studio](https://aistudio.google.com/)** in your web browser.
2. Sign in with your standard Google / Gmail account.
3. Click the blue **Get API key** button in the top navigation.
4. Click **Create API key** (choose any project or create a default one).
5. Copy the generated key. It will start with `AIzaSy...`.

---

## 3. Add the API Key to Home Assistant

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

## 5. (Optional) Step-by-Step Google Cloud Console Setup (Calendar, Gmail & Single Sign-On)

If you want Janus to incorporate your Google Calendar and Gmail into morning briefings:

### Part A: Create a Free Project in Google Cloud
1. Go to **[Google Cloud Console](https://console.cloud.google.com/)** and sign in with your Google account.
2. Click the project dropdown at the top-left and select **New Project**.
3. Project Name: Enter **Janus Home** and click **Create**. Ensure this new project is selected in the top bar.

### Part B: Enable the APIs
1. In the top search bar, search for **Google Calendar API** and click **Enable**.
2. Search for **Gmail API** and click **Enable** (optional, for package delivery tracking).

### Part C: Configure the OAuth Consent Screen
*(Google requires this before generating credentials)*
1. Go to the left navigation menu (☰) ➔ **APIs & Services** ➔ **OAuth consent screen**.
2. User Type: Select **External** and click **Create**.
3. App Information:
   - **App name**: `Janus`
   - **User support email**: Select your email address.
   - **Developer contact information**: Enter your email address.
   - Click **Save and Continue**.
4. Scopes: Click **Save and Continue** (no special scopes needed here; Janus requests them dynamically).
5. Test Users:
   - Click **+ Add Users**, enter your Google / Gmail address (and any family member emails who will log in), and click **Add**.
   - Click **Save and Continue**, then return to the Dashboard.

### Part D: Create OAuth 2.0 Client Credentials
1. Go to **APIs & Services** ➔ **Credentials**.
2. Click **+ Create Credentials** at the top ➔ select **OAuth client ID**.
3. **Application type**: Select **Web application**.
4. **Name**: `Janus Web Client`.
5. **Authorized redirect URIs**: Click **+ Add URI** and enter your Home Assistant callback URL:
   - If using Nabu Casa: `https://<your-unique-id>.ui.nabu.casa/auth/google/callback`
   - If using DuckDNS or custom domain: `https://<your-domain>/auth/google/callback`
   - If testing locally: `http://localhost:8123/auth/google/callback`
6. Click **Create**. A modal will pop up with your **Client ID** and **Client Secret**. Copy both values.

### Part E: Enter Credentials in Home Assistant
1. In Home Assistant, navigate to **Settings** ➔ **Add-ons** ➔ **Janus**.
2. Click on the **Configuration** tab.
3. Paste the values into:
   - `google_client_id`
   - `google_client_secret`
4. Click **Save** in the bottom right, then click **Restart** on the add-on.

### Part F: Connect Your Account
1. Open Janus.
2. You can now tap **Sign in with Google** directly on the login screen, OR go to **Settings ➔ Google Services** and click **Connect Google Account**!

---

## 6. Personalize Your Estate Branding & Colors

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

## 7. Smart Home Devices & Multi-Room Audio

- **Smart Home Devices**: Click **Systems** in the top navigation bar. All lights, climate thermostats, smart switches, and sensors paired with Home Assistant appear here automatically. You can toggle them, adjust temperatures, or run scenes directly.
- **Audio Speakers**: Janus automatically scans your Home Assistant network for Sonos, Apple AirPlay/HomePods, and Google Cast media players. Spoken voice announcements and morning briefings can be directed to any individual room or the entire house.

---

## ❓ Frequently Asked Questions (FAQ)

### Can I sign in with Google, and what features does it unlock?
**Yes!** While Local Access Mode is all you need for 100% smart home control (lights, climate, locks, switches, scenes, and Gemini Voice AI), connecting your Google Account unlocks executive lifestyle features:
1. **Spoken Morning Executive Briefings**: Janus reads your day's schedule from your Google Calendar, cross-references weather, and delivers a personalized voice briefing.
2. **AI Voice Schedule Awareness**: You can ask Janus voice queries like *"What does my schedule look like today?"*, *"When is my next meeting?"*, or *"Do I have time for lunch at noon?"*.
3. **Live Family Schedule Deck**: Displays your personal and family calendars right on the Janus Command Deck with automatic conflict alerts.
4. **Package & Delivery Tracking**: Scans Gmail for Amazon, UPS, and FedEx delivery tracking updates and shows them on your dashboard.
5. **One-Tap Single Sign-On (SSO)**: Family members can sign into Janus on iPhones, iPads, and laptops with one tap using their standard Google / Gmail account.

### Why does Google Sign-In require my own Google Cloud Client ID?
Google's OAuth 2.0 security policy strictly prohibits third-party self-hosted applications on private local networks from using a single shared login secret. Google requires that your specific Home Assistant domain be registered under a free Web Application Client ID in Google Cloud. This is the exact same requirement Home Assistant itself enforces for its official Google Assistant and Google Calendar integrations. Follow Section 5 above to set this up in about 3 minutes.

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
