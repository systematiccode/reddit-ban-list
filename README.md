# Ban List Post (Auto‑Updated)

This app maintains a single subreddit post that lists **recently banned users** in a clean, readable format.  
It is intended for communities that want a **public, always-up-to-date ban list** (or a mod-only maintained post) without manual editing.

The app:
- Fetches the current ban list (up to a configurable limit)
- Optionally pulls ban reasons from modlog and/or mod notes
- Formats the output as a **table** or **bulleted list**
- Updates an “active” post on a schedule, or on demand via mod menu actions

---

## How It Works

- The app tracks an **active post** using a configurable key (`postIdKey`) stored per-subreddit.
- On each run, it rebuilds the ban list and updates the active post **if it is editable**.
- If the active post is not editable (locked/archived/removed/insufficient perms), the app follows the configured **fallback policy** (do nothing or create a new post).

---

## Moderator Menu Actions

These actions appear under the subreddit mod tools menu:

- **Ban List: Update active post (safe)**  
  Updates the active post only. If it can’t be edited, follows the manual-update fallback setting.

- **Ban List: Create NEW post (set active)**  
  Creates a new ban list post and makes it the active post.

- **Ban List: Create NEW post (do NOT set active)**  
  Creates a new ban list post but keeps the current active post unchanged.

- **Ban List: Refresh schedule (only if needed)**  
  Ensures the scheduled job matches the current cron setting.

- **Ban List: PURGE old crons + reschedule**  
  Clears stored schedule metadata and recreates the scheduled job.

- **Ban List: Debug — print last report to logs**  
  Prints the last internal run report (only useful when troubleshooting).

---

## Configuration (Devvit Settings)

### Post & Storage
- **Post title (`postTitle`)**  
  Title used when creating a new ban list post.

- **Post key (`postIdKey`)**  
  Storage key that identifies which post is considered “active” for updates in this subreddit.

### Auto‑Update Schedule
- **Enable auto-update schedule (`scheduleEnabled`)**  
  Turns scheduled updates on/off.

- **Auto-update cron (UNIX cron) (`scheduleCron`)**  
  Cron expression for how often to run updates.  
  Default is `*/2 * * * *` (every 2 minutes).

### Fallback Behavior (When Active Post Can’t Be Edited)
- **CRON fallback (`fallbackOnUneditable_cron`)**  
  What to do during scheduled runs when the active post is uneditable:  
  - `do_nothing` (default)  
  - `create_new`

- **MANUAL UPDATE fallback (`fallbackOnUneditable_manualUpdate`)**  
  What to do when a moderator triggers “Update active post” and it’s uneditable:  
  - `do_nothing`  
  - `create_new` (default)

- **Set new post as active (`setNewPostAsActive`)**  
  When fallback creates a new post, sets it as the active post.

### Ban Reason Source
- **Reason source (`reasonSource`)**  
  Where the displayed “reason” is pulled from:  
  - `modlog_banuser`  
  - `mod_note`  
  - `modlog_then_modnote`

### Mapping (Categorization)
- **Mapping rules JSON (`mappingJson`)**  
  JSON array that maps keywords found in reasons/notes to a category label.
  Example shape:
  ```json
  [
    { "label": "Scamming", "keywords": ["scam", "scammer"] },
    { "label": "Harassment/Discrimination", "keywords": ["harass", "slur"] }
  ]
  ```

- **Default category label (`defaultLabel`)**  
  Used when no mapping rule matches.

### Output Format
- **Show category column (`showCategory`)**  
  Adds a category column (based on mapping).

- **Show ban reason/rule column (`showReason`)**  
  Shows the reason text column.

- **Output mode (`outputMode`)**  
  - `table` (default)  
  - `bullets`

- **Apply mapping to reason prefix (`applyMappingToReasonPrefix`)**  
  If enabled, attempts to rewrite the reason prefix using the mapped label.

- **Only replace reason prefix if mapped (`reasonPrefixOnlyIfMapped`)**  
  When rewriting prefixes, only changes them when a mapping match occurred; otherwise keeps the original reason.

- **Sort order (`sortOrder`)**  
  - `username_asc` (default)  
  - `username_desc`

### Filters & Limits
- **Exclude if reason contains (`excludeIfReasonContains`)**  
  Comma-separated phrases. If the reason contains any of these (case-insensitive), that user is excluded from the post.

- **How many mod notes to fetch per user (`modNotesPerUser`)**  
  Controls how many notes are checked per user when using mod-note sources.

- **How many modlog entries to scan (`modlogLookbackLimit`)**  
  Controls the scan depth for finding relevant ban reasons in modlog.

- **Max banned users to list (`banListLimit`)**  
  Limits how many banned users are included (up to 1000).

- **Max rows to include in the post (`maxRowsInPost`)**  
  Extra safety cap to avoid Reddit post size limits.

### Debug
- **Verbose logs (`debugVerbose`)**  
  Enables additional troubleshooting output. Turn off for quieter logs.

---

## Notes

- This app does **not** change ban status or apply bans.  
  It only **publishes a list** based on the subreddit’s ban list and configured reason sources.
- If your active post becomes locked/archived, set an appropriate fallback policy (create a new post vs do nothing).
