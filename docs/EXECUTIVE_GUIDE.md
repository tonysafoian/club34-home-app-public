# 🏛️ Household OS — Executive Overview & Estate Guide

<div align="center">

### The Operating System for Modern Residential Estates

*A non-technical, visual guide for estate owners, household managers, architects, and family members.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../LICENSE)
[![CI Status](https://img.shields.io/badge/CI%20Matrix-Passing-brightgreen.svg)](../.github/workflows/ci.yml)
[![Version](https://img.shields.io/badge/Version-v1.0.0-amber.svg)](../CHANGELOG.md)

</div>

---

## Executive Summary: What is Household OS?

Modern estates are equipped with extraordinary technology: Crestron lighting systems, commercial HVAC chillers, swimming pools and hydronic spas, automated security gates, high-voltage vehicle charging, backup generators, and smart irrigation. 

However, managing them daily usually requires **15 to 20 different vendor apps**—each with its own login, notifications, and clunky user interface.

**Household OS** replaces that fragmented chaos with **one unified, private estate operating system**:
* 📱 **One App for Everything**: Lights, climate, pool, gates, locks, energy, irrigation, cameras, and Tesla fleet.
* 🧠 **Janus Voice AI**: A private resident AI concierge that remembers household preferences across conversations and executes commands.
* 🔒 **100% Private & Local-First**: Telemetry stays on your local home network. No third-party cloud data broker collects your family's daily habits.
* 🎨 **White-Label & Re-Brandable**: Name your property, upload your family crest, and select a bespoke color palette matching your home's interior design.

---

## 🖥️ The Executive Command Deck

The core interface provides instant situational awareness of the entire property in a single glance:

<div align="center">
  <img src="assets/screenshots/dashboard-command-deck.svg" alt="Unified Executive Command Deck" width="100%" />
  <p><em>Figure 1: The Unified Command Deck displaying climate setpoints, Crestron scenes, Tesla fleet readiness, pool hydrology, electrical demand, and perimeter security.</em></p>
</div>

### Key Capabilities at a Glance:
1. **One Dashboard for the Whole Estate**: Instant control of climate zones, radiant heated floors, gas fireplaces, and motorized shades without opening Crestron or Lutron apps.
2. **Tesla EV Fleet on the Same Screen**: Real-time battery levels, charging rates, cabin pre-conditioning, and vehicle location when family members are en route.
3. **Pool & Spa Hydrology**: One-tap spa heat-up with predictive countdowns, water feature control, and temperature history.
4. **Energy & Standby Generator Insight**: Live electrical demand across 16 circuit breakers, Generac standby generator readiness, and projected monthly utility tariffs.
5. **Perimeter Security**: Gate status, smart lock synchronization, and AI vehicle/visitor identification.

---

## 🧠 Meet Janus: The Resident AI Concierge

Instead of navigating menus or remembering technical settings, family members can simply speak or text to **Janus**, the built-in household AI assistant:

<div align="center">
  <img src="assets/screenshots/janus-voice-ai.svg" alt="Janus AI Assistant" width="100%" />
  <p><em>Figure 2: Janus executing complex multi-system instructions ("Prep house for guests") and answering questions using long-term semantic memory.</em></p>
</div>

### What Makes Janus Different from Siri or Alexa?
* **Real-World Estate Tool Execution**: Janus doesn't just look up web articles. When you ask *"Prep the patio for dinner,"* Janus triggers the evening Crestron lighting scene, starts the fountain water feature, and adjusts the outdoor heaters.
* **Long-Term Memory (`pgvector`)**: Janus remembers facts across conversations (e.g., guest room temperature preferences, sommelier wine cellar targets, family dietary restrictions, gate contractor codes).
* **Private & Non-Intrusive**: Runs on your chosen private LLM endpoint (Google Gemini, OpenRouter, or completely offline via local Ollama).

---

## 🗺️ Interactive Estate Topology & Smart Irrigation

Traditional irrigation controllers present confusing lists of numbered valves (Zone 1, Zone 2...). Household OS maps your estate visually on a 2D interactive canvas:

<div align="center">
  <img src="assets/screenshots/estate-irrigation-map.svg" alt="Estate Irrigation Map" width="100%" />
  <p><em>Figure 3: Interactive property canvas showing real-time water zones, rain skip weather intelligence, and emergency valve overrides.</em></p>
</div>

* **Clickable Property Layout**: Tap on the Front Lawn, Rose Garden, or Citrus Grove to inspect soil moisture or trigger a 15-minute supplemental cycle.
* **Weather-Adaptive Rain Skip**: Automatically suspends scheduled irrigation cycles when hyper-local radar forecasts rainfall, saving thousands of gallons of water annually.
* **Emergency Master Shutoff**: One-tap emergency valve closure in the event of pipe bursts or landscape maintenance.

---

## 🎨 White-Label Customization: Bring Your Own Estate

Household OS is designed to be personalized for every estate:

<div align="center">
  <img src="assets/screenshots/white-label-branding.svg" alt="White Label Rebranding Customizer" width="100%" />
  <p><em>Figure 4: The Estate Branding Customizer in Settings allowing custom estate naming, family crest uploads, and luxury theme selection.</em></p>
</div>

* **Estate Naming**: Customize the name of your estate (e.g., *Villa Paradiso*, *Oakridge Estate*, *Casa Del Sol*).
* **Family Crest / Custom Emblem**: Upload your family crest or property emblem (SVG, PNG, JPG).
* **Six Curated Luxury Color Palettes**:
  * 🏛️ **Classic Amber & Bronze**: Warm candlelight, brushed brass, and rich wood tones.
  * 🌿 **Emerald Sanctuary**: Modern botanical estate aesthetic with sage and deep forest greens.
  * 🌊 **Pacific Azure**: High-tech oceanfront look with deep blue and crisp cyan accents.
  * ⚡ **Obsidian Violet**: Luxury evening mood with charcoal and electric violet.
  * 🍷 **Royal Bordeaux**: Traditional wine country refinement with deep burgundy and rose gold.
  * 🪵 **Nordic Slate**: Understated Scandinavian minimalism with monochrome architectural grays.

---

## 📋 The Twelve Pillars of Household OS

| # | Subsystem | Daily Benefit for the Household |
| :--- | :--- | :--- |
| **01** | **Whole-Estate Dashboard** | Controls lighting scenes, thermostats, fireplaces, sauna, and radiant floors from one unified screen on phones, tablets, or in-wall iPads. |
| **02** | **Pool & Spa Hydrology** | One-tap spa heat-up with live temperature tracking so you always know when the water is ready. |
| **03** | **Interactive Irrigation Map** | Visual 2D property canvas mapping every valve zone with weather-based rain skip automation. |
| **04** | **Tesla EV Fleet** | Unified charging status, cabin pre-conditioning, and vehicle location on the family map. |
| **05** | **Energy & Backup Power** | Real-time 16-channel circuit breaker tracking, Generac standby generator health, and utility tariff projections. |
| **06** | **Security & Activity** | Perimeter motor gates, smart door locks, and AI camera vehicle/visitor recognition timeline. |
| **07** | **Janus Voice Concierge** | Resident AI assistant with persistent long-term memory that manages daily tasks and hardware controls. |
| **08** | **Grocery & Food on Autopilot** | Auto-assembled weekly staples cart with seamless approval over WhatsApp or SMS. |
| **09** | **Family Planning Hub** | Shared family calendar, upcoming travel itineraries, and entertainment queues in one place. |
| **10** | **Morning Executive Briefings** | Automated daily briefings prepared like an executive personal assistant (weather, schedules, home anomalies). |
| **11** | **Hyper-Local Microclimate** | Canyon-tuned weather radar, air quality (AQI), and pollen tracking tied directly into HVAC filtration. |
| **12** | **Self-Healing Infrastructure** | Background circuit breakers and automated retries ensure the system stays online 24/7/365. |

---

## 🖨️ Downloadable & Printable Version

A formatted, magazine-grade HTML and printable PDF document is available in:
* **[`docs/Household_OS_Executive_Guide.html`](Household_OS_Executive_Guide.html)**

Simply open the HTML file in any browser and choose **Print ➔ Save as PDF** to generate a presentation-ready executive brochure for your family or clients!
