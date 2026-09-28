---
name: Notion Tasks & Projects
description: Query, create, and update the household's Notion task and project databases (Recurring Tasks, Club 34 Projects, TigerDen Projects, TigerDen Consumables). Load BEFORE any Notion tool call for exact property names and people/status filter formats.
channels: [chat, whatsapp, email]
roles: [admin, member]
---

# Notion Tasks & Projects

Use EXACT property names — never guess or abbreviate. The database IDs are also
kept in core, so you always have them; they are repeated here for convenience.
Never call `recall_facts` to look up a database ID.

## Tools

- `query_notion_database(database_id, filter?, sorts?)` — read pages.
- `create_notion_page(database_id, properties, children?)` — create a page.
- `update_notion_page(page_id, properties)` — update a page.
- `get_notion_database(database_id)` — discover real property names if a write
  fails with "property not found", then retry.

## Databases

### 1. Recurring Tasks Tracker (`2b8e96d8-93fa-80b9-859f-c321f25e74ae`)
- **Title:** "Task"
- **Properties:** "Assignee" (people), "Description" (rich_text), "Due date" (date, lowercase 'd'), "Effort level" (select: 5 mins/10 mins/15 min/30 mins/45 mins/1 hr/1hr 30mins/2 hrs/3 hrs), "Priority" (select: High/Medium/Low), "Recur Interval" (number), "Recur Unit" (select: N/A/Day(s)/Week(s)/Month(s)/Year(s)), "Status" (status: Not started/In progress/Done), "Summary" (rich_text), "Task type" (multi_select), "Past due" (formula, read-only)

### 2. Club 34 Projects (`2b8e96d8-93fa-80bb-9428-cd132f827553`)
- **Title:** "Project name"
- **Properties:**
  - "Assignee" (people)
  - "Attach file" (files — READ ONLY via API; cannot upload programmatically)
  - "Budget" (number/$)
  - "Due Date" (date — capital 'D')
  - "End value" (number)
  - "Percent Complte" (number — TYPO, keep exactly as spelled)
  - "Priority" (select: High/Medium/Low)
  - "Start date" (date)
  - "Status" (status: Not started/In progress/Done — NO "Cancelled")
  - "Team" (multi_select: Home Team/LionDen/DesignQueen)
  - "Team 1" (people — secondary members)
- Notes go in page BODY (children blocks), NOT as a property.

### 3. TigerDen Projects (`2b8e96d8-93fa-80cc-b1fa-fa4eef48c6fe`)
- **Title:** "Project name"
- **Key differences from Club 34:**
  - "% Complete" (number/percent — not "Percent Complte")
  - "Status" includes "Cancelled"
  - "Team" is people type (not multi_select)
- Notes go in page BODY, not a property.

### 4. TigerDen Consumables Inventory (`2bfe96d8-93fa-8027-922d-c2357bda2572`)
- **Title:** "Name"
- **Properties:** "Category" (select: Hardware/Accessories/Tools/Electronics/Lumber/Tile), "Condition" (rich_text), "Last ordered date" (date), "Length" (rich_text), "Location" (select: Warehouse 1/2/3/Lift#1/Lift#2/Floor Storage Bin), "Notes" (rich_text), "Quantity in stock" (number), "Reorder minimum" (number), "SPECIES" (rich_text), "Supplier" (select), "Thickness" (rich_text), "Use" (select), "Width" (rich_text)

## Operations

- If creation fails with "property not found", call `get_notion_database` to
  discover real names, then retry.
- Notes/descriptions in Club 34 or TigerDen Projects go in the page BODY, NOT as
  a property.
- **Defaults for new projects:** Status = "Not started", Priority = "Medium",
  completion = 0. Never create with just a title.
- **People field format:** `{ "Assignee": { "people": [{ "object": "user", "id": "NOTION-UUID" }] } }`
- **Status filtering:** use `"status"` not `"select"`:
  `{ "property": "Status", "status": { "equals": "In progress" } }`
- **People filtering:** `{ "property": "Assignee", "people": { "contains": "<NOTION-UUID>" } }`
- NEVER say you need "a specific user ID" — the household directory has all UUIDs.
