---
name: Home Automation
description: Control and query home devices via Home Assistant — pool/spa, lights, pumps, heaters, printers, media players and speakers. Load BEFORE any ha_* tool call so you use the exact entity_id.
channels: [chat, whatsapp, email]
roles: [admin, member]
---

# Home Automation (Home Assistant)

Janus controls the house through Home Assistant. Use the device directory below
FIRST — never call `ha_get_states` just to look up an entity you already know.
Match the user's words to a device by app name, then call `ha_call_service`
directly with the `entity_id`. Only fall back to `ha_get_states` for a device
that is genuinely not listed here.

## Tools

- `ha_call_service(domain, service, entity_id, data?)` — perform an action.
  Examples: `light.turn_on`, `light.turn_off`, `switch.turn_on`,
  `switch.turn_off`, `climate.set_temperature`, `media_player.play_media`.
- `ha_get_state(entity_id)` — read one entity's current state/attributes.
- `ha_get_states()` — list all entities (only when a device isn't in this directory).
- `ha_get_logbook(entity_id?, hours?)` — recent history for a device.

Common patterns:
- Turn a light on: `ha_call_service("light", "turn_on", "light.pool_light")`.
- Set a light effect: `ha_call_service("light", "turn_on", "light.pool_light", { effect: "Caribbean Blue" })`.
- Set pool temperature: `ha_call_service("climate", "set_temperature", "climate.pool", { temperature: 90 })`.
- Toggle a switch (pump/heater): `switch.turn_on` / `switch.turn_off`.

Confirm before destructive or high-cost actions (turning on heaters/pumps that
cost money to run, or anything affecting the whole house). Read state to verify
the result when the user asked for a specific outcome.

## Pool & Spa

| Device | Entity ID | Notes |
|--------|-----------|-------|
| Pool Light | light.pool_light | Effects: Alpine White, Sky Blue, Cobalt Blue, Caribbean Blue, Spring Green, Emerald Green, Emerald Rose, Magenta, Violet, Slow Splash, Fast Splash, USA!, Fat Tuesday, Disco Tech |
| Spa Light | light.spa_light | Same effects as Pool Light |
| Laminar LED Light | light.laminar_led_lt | |
| Pool Pump | switch.pool_pump | |
| Spa Pump | switch.spa_pump | |
| Pool Heater | switch.pool_heater | |
| Spa Heater | switch.spa_heater | |
| Solar Heater | switch.solar_heater | |
| Booster Pump | switch.booster_pump | |
| Laminar Jets | switch.laminar_jets | |
| Bubbler | switch.bubbler | |
| Pool Thermostat | climate.pool | Heat/off, 34–104°F |
| Spa Thermostat | climate.spa | Heat/off, 34–104°F |
| Pool Temp | sensor.pool_temp | °F |
| Spa Temp | sensor.spa_temp | °F |
| Air Temp (poolside) | sensor.air_temp | °F |
| Pool Salinity | sensor.pool_salinity | |
| Spa Salinity | sensor.spa_salinity | |
| Pool pH | sensor.ph | |
| Pool ORP | sensor.orp | |
| Pool Cover | sensor.cover_pool | |
| Freeze Protection | binary_sensor.freeze_protection | |

## Printers

| Device | Entity ID | Notes |
|--------|-----------|-------|
| Sandra's Office Printer | sensor.hp_color_laserjet_pro_mfp_3301_2 | Status: idle/printing/stopped |
| — Black Toner | sensor.hp_color_laserjet_pro_mfp_3301_black_cartridge_2 | |
| — Cyan Toner | sensor.hp_color_laserjet_pro_mfp_3301_cyan_cartridge_2 | |
| — Magenta Toner | sensor.hp_color_laserjet_pro_mfp_3301_magenta_cartridge_2 | |
| — Yellow Toner | sensor.hp_color_laserjet_pro_mfp_3301_yellow_cartridge_2 | |
| TigerDen Printer | sensor.hp_color_laserjet_pro_mfp_3301 | Status: idle/printing/stopped |
| — Black Toner | sensor.hp_color_laserjet_pro_mfp_3301_black_cartridge | |
| — Cyan Toner | sensor.hp_color_laserjet_pro_mfp_3301_cyan_cartridge | |
| — Magenta Toner | sensor.hp_color_laserjet_pro_mfp_3301_magenta_cartridge | |
| — Yellow Toner | sensor.hp_color_laserjet_pro_mfp_3301_yellow_cartridge | |

## Media Players

| Device | Entity ID |
|--------|-----------|
| FAM TV | media_player.fam_tv |
| Kitchen TV | media_player.kitchen_tv |
| Gym TV | media_player.gym_tv |
| Family Room TV | media_player.family_room_tv |
| Tony's Office TV | media_player.tony_office_tv |
| Theater TV | media_player.theater_tv |
| Theater Receiver | media_player.theater_reciever_2 (inputs: PS5, Apple TV, Switch, GoogleTV, etc.) |
| Glam Room Speaker | media_player.glam_room_speaker |
| Tony's Office Speaker | media_player.tonys_office_speaker |
| Kitchen Display | media_player.kitchen_display_1 |
| Tony's Closet Display | media_player.tonys_closet_display |
| Emme's Room Speaker | media_player.emme_s_room_speaker |
| Master Bedroom Speaker | media_player.master_bedroom_speaker |
| Playroom Speaker | media_player.playroom_speaker |
| Bathroom Speaker | media_player.bathroom_speaker |
| TigerDen Speaker | media_player.tigerden |
| Family Room Display | media_player.family_room_display |
| Gym Speaker | media_player.gym_speaker |
| Lana's Closet Speaker | media_player.lanas_closet_speaker |
| Main Rack Speaker | media_player.main_rack_speaker |
