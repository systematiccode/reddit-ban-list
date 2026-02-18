# Ban List DB -- Auto-Managed & Auto-Posted

This app maintains a **database-driven ban list** for your subreddit and
automatically publishes a clean, formatted post from that database.

Unlike simple ban scrapers, this app:

-   Maintains a persistent KV database of banned users\
-   Updates in real time via ModAction triggers\
-   Uses **modlog (primary)** for ban reasons\
-   Ignores temporary bans\
-   Supports manual backlog import\
-   Publishes from DB only (no full rebuild each run)\
-   Supports scheduled updates and manual publishing\
-   Allows configurable mapping, filtering, and footer

------------------------------------------------------------------------

## How It Works

### Real-Time Monitoring

The app listens to moderator actions:

-   `banuser`
-   `unbanuser`

On permanent ban: - Fetches modlog entry - Confirms it is permanent -
Extracts reason from modlog description - Applies mapping & filters -
Saves to database

On unban: - Removes user from database

Temporary bans are ignored.

------------------------------------------------------------------------

## Database Design

Each subreddit has its own KV database:

-   Index of usernames\
-   Individual user records containing:
    -   Username
    -   Normalized reason
    -   Raw reason
    -   Last updated timestamp

The published post is generated strictly from this database.

------------------------------------------------------------------------

## Reason Resolution

When a ban occurs:

1.  **Modlog is checked first**
    -   `type = banuser`
    -   `details` determines permanent vs temporary
    -   `description` is used as raw reason
2.  **Mod notes are used only as fallback** (if modlog description is
    empty)

------------------------------------------------------------------------

## Publishing Behavior

The post is generated from the database:

-   Applies optional "mapped-only" filter
-   Sorts (by reason or username)
-   Builds markdown table
-   Updates existing post if editable
-   Creates fallback post if configured
-   Optional scheduled updates via cron

The post respects Reddit's size limits and truncates safely.

------------------------------------------------------------------------

## Settings Overview

### Posting

-   Post title
-   Post key
-   Max rows in post
-   Sort order
-   Only include mapped reasons (optional)

### Scheduler

-   Enable/disable schedule
-   Cron expression
-   Create new post if edit fails
-   Set new post as active

### Mapping & Filtering

-   Exclude if text contains
-   Exclude if mapped label matches
-   Mapping rules JSON
-   Default label

### Footer

-   Enable footer
-   Custom footer text
-   Optional footer link
-   Custom link label

### Reason Sources

-   Modlog lookup limit
-   Modlog match time window
-   Mod notes lookup limit

### Debug

-   Verbose logging

------------------------------------------------------------------------

## Moderator Tools

The app provides moderator menu actions:

-   Import backlog JSON (manual DB fill)
-   Clear entire ban database
-   Update active post
-   Create new post (set active)
-   Create new post (do not set active)
-   Refresh schedule
-   View debug snapshot

------------------------------------------------------------------------

## Important Notes

-   The app does not create or modify bans.
-   Only permanent bans are stored.
-   Unbans immediately remove users from the database.
-   The published post reflects the internal DB, not a live API scrape.

------------------------------------------------------------------------

## Designed For

Communities that want:

-   Transparent ban visibility\
-   Categorized ban reasons\
-   Automatic maintenance\
-   Controlled formatting\
-   Database-backed reliability
