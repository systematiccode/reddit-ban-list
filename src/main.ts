import { Devvit, Context, RedditAPIClient } from '@devvit/public-api';

/**
 * Banned Users List (Auto-updated) — FULL CODE
 *
 * ✅ Up to 1000 banned users (config: banListLimit)
 * ✅ Ban reason pulled from Modlog (type=banuser) + optional mod-note fallback
 * ✅ Mapping rules configurable via JSON
 * ✅ Output configurable:
 *    - showCategory (optional)
 *    - showReason (optional)
 *    - table or bullets
 * ✅ Scheduler safe (won’t create duplicate cron actions)
 * ✅ Manual mod action to PURGE old cron jobs + reschedule (best-effort)
 *
 * ✅ NEW FIX (requested):
 * applyMappingToReasonPrefix + reasonPrefixOnlyIfMapped
 *  - If applyMappingToReasonPrefix=true:
 *      - reasonPrefixOnlyIfMapped=true  => only replace prefix when mapping matched; else keep original reason
 *      - reasonPrefixOnlyIfMapped=false => always replace prefix (unmatched becomes defaultLabel prefix)
 */

const JOB_NAME = 'update_banned_list_post';

const KV_POST_PREFIX = 'banned_list_post:';
const KV_DEBUG_PREFIX = 'banned_list_debug:';
const KV_CRON_PREFIX = 'banned_list_cron:';
const KV_JOBID_PREFIX = 'banned_list_jobid:';

type StoredPostRef = { postId: string; updatedAt: string; idKey: string };
type MappingRule = { label: string; keywords: string[] };
type FallbackBehavior = 'do_nothing' | 'create_new';
type ReasonSource = 'modlog_banuser' | 'mod_note' | 'modlog_then_modnote';
type Actor = 'cron' | 'manual_update' | 'manual_create' | 'install_or_upgrade' | 'schedule_action';
type OutputMode = 'table' | 'bullets';

type Row = { user: string; category: string; reason: string };

type DebugReport = {
  ts: string;
  subreddit: string;
  idKey: string;
  actor: Actor;

  settings: Record<string, any>;

  bannedUsers: { count: number; sample: string[] };

  modlog: {
    fetched: number;
    mapped: number;
    missing: number;
    sampleEntryKeys: string[];
    sampleTargetKeys: string[];
  };

  modNotes: { attempts: number; failures: number };

  rows: {
    finalCount: number;
    excludedCount: number;
    truncated: boolean;
    sample: Array<{ user: string; category: string; reason: string }>;
  };

  post: {
    kvPostKey: string;
    storedPostId?: string | null;

    fetchOk?: boolean;
    archivedRaw?: any;
    archivedParsed?: boolean;
    lockedRaw?: any;
    lockedParsed?: boolean;

    canEdit?: boolean;
    notEditableReason?: string | null;

    mode: 'update_existing_only' | 'create_new_and_set_active' | 'create_new_no_change_active';
    fallbackChosen?: FallbackBehavior;

    editAttempted?: boolean;
    editSucceeded?: boolean;
    editError?: string;

    createAttempted?: boolean;
    createSucceeded?: boolean;
    createdPostId?: string;

    didSetNewActive?: boolean;
    finalActivePostId?: string | null;

    skipped?: boolean;
    skippedReason?: string;
  };

  scheduler: {
    kvCronKey: string;
    kvJobIdKey: string;
    prevCron?: string | null;
    prevJobId?: string | null;

    cancelAttempted: boolean;
    cancelSucceeded?: boolean;

    scheduleAttempted: boolean;
    scheduleSucceeded?: boolean;
    scheduleJobId?: string;
    scheduleError?: string;

    purgeAttempted?: boolean;
    purgeCanceledJobIds?: string[];

    note: string[];
  };

  notes: string[];
};

// -------------------- Settings --------------------
Devvit.addSettings([
  // Title
  { type: 'string', name: 'postTitle', label: 'Post title', defaultValue: 'Banned Users List (Auto-updated)' },

  // Schedule
  { type: 'boolean', name: 'scheduleEnabled', label: 'Enable auto-update schedule', defaultValue: true },
  { type: 'string', name: 'scheduleCron', label: 'Auto-update cron (UNIX cron)', defaultValue: '*/2 * * * *' },

  // Fallback policy when active post is NOT editable
  {
    type: 'string',
    name: 'fallbackOnUneditable_cron',
    label: 'CRON fallback when active post uneditable: "do_nothing" | "create_new"',
    defaultValue: 'do_nothing',
  },
  {
    type: 'string',
    name: 'fallbackOnUneditable_manualUpdate',
    label: 'MANUAL UPDATE fallback when active post uneditable: "do_nothing" | "create_new"',
    defaultValue: 'create_new',
  },
  {
    type: 'boolean',
    name: 'setNewPostAsActive',
    label: 'When creating a new post via fallback, set it as active',
    defaultValue: true,
  },

  // Reason source
  {
    type: 'string',
    name: 'reasonSource',
    label: 'Reason source: "modlog_banuser" | "mod_note" | "modlog_then_modnote"',
    defaultValue: 'modlog_banuser',
  },

  // Mapping
  {
    type: 'string',
    name: 'mappingJson',
    label: 'Mapping rules (JSON) — maps keywords to a label',
    defaultValue: JSON.stringify(
      [
        { label: 'Scamming', keywords: ['scam', 'scamming', 'scammer', 'fraud', 'no scamming'] },
        { label: 'Selling accounts/services', keywords: ['selling', 'sell', 'account', 'service', 'pilot', 'boost'] },
        { label: 'Harassment/Discrimination', keywords: ['harass', 'bully', 'slur', 'racist', 'homophobic', 'transphobic', 'sexist'] },
      ],
      null,
      2
    ),
  },

  // Defaults / Output
  { type: 'string', name: 'defaultLabel', label: 'Default category label (when no mapping match)', defaultValue: 'Banned' },
  { type: 'string', name: 'postIdKey', label: 'Post key (tracks which post to update)', defaultValue: 'banned-users-list' },

  { type: 'boolean', name: 'showCategory', label: 'Show category column', defaultValue: false },
  { type: 'boolean', name: 'showReason', label: 'Show ban reason/rule column', defaultValue: true },
  { type: 'string', name: 'outputMode', label: 'Output mode: "table" or "bullets"', defaultValue: 'table' },

  // Mapping affects displayed reason prefix too
  {
    type: 'boolean',
    name: 'applyMappingToReasonPrefix',
    label: 'Apply mapping label to the reason prefix (e.g. "Scamming: permanent" -> "Scamming Brother: permanent")',
    defaultValue: false,
  },

  // ✅ NEW: only rewrite reason prefix if mapping matched
  {
    type: 'boolean',
    name: 'reasonPrefixOnlyIfMapped',
    label: 'If mapping reason prefix, only replace prefix when mapping matched; else keep original reason',
    defaultValue: true,
  },

  { type: 'string', name: 'sortOrder', label: 'Sort: "username_asc" | "username_desc"', defaultValue: 'username_asc' },

  // Filters
  { type: 'string', name: 'excludeIfReasonContains', label: 'Exclude if reason contains (case-insensitive, comma-separated)', defaultValue: 'usl ban:' },

  // ModNotes fallback
  { type: 'number', name: 'modNotesPerUser', label: 'How many mod notes to fetch per user (1 is fastest)', defaultValue: 1 },

  // Modlog scanning
  { type: 'number', name: 'modlogLookbackLimit', label: 'How many modlog entries to scan (banuser)', defaultValue: 5000 },

  // Ban list size
  { type: 'number', name: 'banListLimit', label: 'Max banned users to list (up to 1000)', defaultValue: 1000 },

  // Post size control
  { type: 'number', name: 'maxRowsInPost', label: 'Max rows to include in the post (avoid size limits)', defaultValue: 1000 },

  // Debug
  { type: 'boolean', name: 'debugVerbose', label: 'Verbose logs', defaultValue: true },
]);

// -------------------- Config --------------------
type SettingsConfig = {
  title: string;
  idKey: string;

  scheduleEnabled: boolean;
  scheduleCron: string;

  fallbackCron: FallbackBehavior;
  fallbackManualUpdate: FallbackBehavior;
  setNewPostAsActive: boolean;

  reasonSource: ReasonSource;

  defaultLabel: string;
  showCategory: boolean;
  showReason: boolean;
  outputMode: OutputMode;

  applyMappingToReasonPrefix: boolean;
  reasonPrefixOnlyIfMapped: boolean;

  sort: 'username_asc' | 'username_desc';

  mappingRules: MappingRule[];
  mappingParseError?: string;

  excludeNeedles: string[];
  modNotesPerUser: number;

  modlogLookbackLimit: number;
  banListLimit: number;
  maxRowsInPost: number;

  debugVerbose: boolean;
};

function normalizeFallback(v: string, def: FallbackBehavior): FallbackBehavior {
  const s = (v ?? '').trim().toLowerCase();
  if (s === 'create_new') return 'create_new';
  if (s === 'do_nothing') return 'do_nothing';
  return def;
}

function normalizeReasonSource(v: string): ReasonSource {
  const s = (v ?? '').trim().toLowerCase();
  if (s === 'mod_note') return 'mod_note';
  if (s === 'modlog_then_modnote') return 'modlog_then_modnote';
  return 'modlog_banuser';
}

function normalizeOutputMode(v: string): OutputMode {
  const s = (v ?? '').trim().toLowerCase();
  return s === 'bullets' ? 'bullets' : 'table';
}

function safeParseMappings(raw: string): { rules: MappingRule[]; error?: string } {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { rules: [], error: 'mappingJson must be a JSON array.' };

    const rules = parsed
      .map((r: any) => ({
        label: String(r?.label ?? '').trim(),
        keywords: Array.isArray(r?.keywords) ? r.keywords.map((k: any) => String(k).toLowerCase().trim()).filter(Boolean) : [],
      }))
      .filter((r: MappingRule) => r.label.length > 0 && r.keywords.length > 0);

    return { rules };
  } catch (e: any) {
    return { rules: [], error: `Invalid mappingJson: ${e?.message ?? 'parse error'}` };
  }
}

async function getCfg(ctx: Context): Promise<SettingsConfig> {
  const title = String((await ctx.settings.get('postTitle')) ?? 'Banned Users List (Auto-updated)');
  const idKey = String((await ctx.settings.get('postIdKey')) ?? 'banned-users-list');

  const scheduleEnabled = Boolean(await ctx.settings.get('scheduleEnabled'));
  const scheduleCron = String((await ctx.settings.get('scheduleCron')) ?? '*/2 * * * *');

  const fbCronRaw = String((await ctx.settings.get('fallbackOnUneditable_cron')) ?? 'do_nothing');
  const fbManualRaw = String((await ctx.settings.get('fallbackOnUneditable_manualUpdate')) ?? 'create_new');
  const fallbackCron = normalizeFallback(fbCronRaw, 'do_nothing');
  const fallbackManualUpdate = normalizeFallback(fbManualRaw, 'create_new');

  const setNewPostAsActive = Boolean(await ctx.settings.get('setNewPostAsActive'));

  const reasonSourceRaw = String((await ctx.settings.get('reasonSource')) ?? 'modlog_banuser');
  const reasonSource = normalizeReasonSource(reasonSourceRaw);

  const defaultLabel = String((await ctx.settings.get('defaultLabel')) ?? 'Banned');
  const showCategory = Boolean(await ctx.settings.get('showCategory'));
  const showReason = Boolean(await ctx.settings.get('showReason'));
  const outputMode = normalizeOutputMode(String((await ctx.settings.get('outputMode')) ?? 'table'));

  const applyMappingToReasonPrefix = Boolean(await ctx.settings.get('applyMappingToReasonPrefix'));
  const reasonPrefixOnlyIfMapped = Boolean(await ctx.settings.get('reasonPrefixOnlyIfMapped'));

  const sortRaw = String((await ctx.settings.get('sortOrder')) ?? 'username_asc');
  const sort: 'username_asc' | 'username_desc' = sortRaw === 'username_desc' ? 'username_desc' : 'username_asc';

  const mappingJson = String((await ctx.settings.get('mappingJson')) ?? '[]');
  const parsed = safeParseMappings(mappingJson);

  const excludeRaw = String((await ctx.settings.get('excludeIfReasonContains')) ?? '');
  const excludeNeedles = excludeRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  const modNotesPerUser = Math.max(1, Number((await ctx.settings.get('modNotesPerUser')) ?? 1) || 1);
  const modlogLookbackLimit = Math.max(50, Number((await ctx.settings.get('modlogLookbackLimit')) ?? 5000) || 5000);

  const banListLimit = Math.min(1000, Math.max(1, Number((await ctx.settings.get('banListLimit')) ?? 1000) || 1000));
  const maxRowsInPost = Math.min(2000, Math.max(1, Number((await ctx.settings.get('maxRowsInPost')) ?? 1000) || 1000));

  const debugVerbose = Boolean(await ctx.settings.get('debugVerbose'));

  return {
    title,
    idKey,
    scheduleEnabled,
    scheduleCron,
    fallbackCron,
    fallbackManualUpdate,
    setNewPostAsActive,
    reasonSource,
    defaultLabel,
    showCategory,
    showReason,
    outputMode,
    applyMappingToReasonPrefix,
    reasonPrefixOnlyIfMapped,
    sort,
    mappingRules: parsed.rules,
    mappingParseError: parsed.error,
    excludeNeedles,
    modNotesPerUser,
    modlogLookbackLimit,
    banListLimit,
    maxRowsInPost,
    debugVerbose,
  };
}

function decideFallback(cfg: SettingsConfig, actor: Actor): FallbackBehavior {
  if (actor === 'cron') return cfg.fallbackCron;
  if (actor === 'manual_update') return cfg.fallbackManualUpdate;
  return 'do_nothing';
}

// -------------------- KV keys/helpers --------------------
const kvPostKey = (sub: string, idKey: string) => `${KV_POST_PREFIX}${sub}:${idKey}`;
const kvDebugKey = (sub: string, idKey: string) => `${KV_DEBUG_PREFIX}${sub}:${idKey}`;
const kvCronKey = (sub: string, idKey: string) => `${KV_CRON_PREFIX}${sub}:${idKey}`;
const kvJobIdKey = (sub: string, idKey: string) => `${KV_JOBID_PREFIX}${sub}:${idKey}`;

async function readStoredPostRef(ctx: Context, idKey: string): Promise<StoredPostRef | null> {
  const raw = await ctx.kvStore.get(kvPostKey(ctx.subredditName!, idKey));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredPostRef;
  } catch {
    return null;
  }
}

async function writeStoredPostRef(ctx: Context, idKey: string, postId: string): Promise<void> {
  const value: StoredPostRef = { postId, updatedAt: new Date().toISOString(), idKey };
  await ctx.kvStore.put(kvPostKey(ctx.subredditName!, idKey), JSON.stringify(value));
}

async function writeDebug(ctx: Context, idKey: string, report: DebugReport): Promise<void> {
  await ctx.kvStore.put(kvDebugKey(ctx.subredditName!, idKey), JSON.stringify(report, null, 2));
}

async function readDebug(ctx: Context, idKey: string): Promise<DebugReport | null> {
  const raw = await ctx.kvStore.get(kvDebugKey(ctx.subredditName!, idKey));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DebugReport;
  } catch {
    return null;
  }
}

// -------------------- Post editability checks --------------------
function toBoolStrict(v: any): boolean {
  if (v === true) return true;
  if (v === false) return false;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  if (typeof v === 'number') {
    if (v === 1) return true;
    if (v === 0) return false;
  }
  return false;
}

async function getEditability(reddit: RedditAPIClient, postId: string): Promise<{
  fetchOk: boolean;
  archivedRaw: any;
  archived: boolean;
  lockedRaw: any;
  locked: boolean;
  canEdit: boolean;
  reasonIfNot: string | null;
}> {
  try {
    const post = await reddit.getPostById(postId);
    const archivedRaw = (post as any)?.isArchived ?? (post as any)?.archived;
    const lockedRaw = (post as any)?.isLocked ?? (post as any)?.locked;

    const archived = toBoolStrict(archivedRaw);
    const locked = toBoolStrict(lockedRaw);

    if (archived) return { fetchOk: true, archivedRaw, archived, lockedRaw, locked, canEdit: false, reasonIfNot: 'archived' };
    if (locked) return { fetchOk: true, archivedRaw, archived, lockedRaw, locked, canEdit: false, reasonIfNot: 'locked' };

    return { fetchOk: true, archivedRaw, archived, lockedRaw, locked, canEdit: true, reasonIfNot: null };
  } catch {
    return {
      fetchOk: false,
      archivedRaw: undefined,
      archived: false,
      lockedRaw: undefined,
      locked: false,
      canEdit: false,
      reasonIfNot: 'fetch_failed_deleted_removed_or_missing',
    };
  }
}

// -------------------- Mapping + output --------------------
function mapTextToLabelWithMatch(text: string, rules: MappingRule[], defaultLabel: string): { label: string; matched: boolean } {
  const r = (text ?? '').toLowerCase();
  for (const rule of rules) {
    if (rule.keywords.some((kw) => kw && r.includes(kw))) return { label: rule.label, matched: true };
  }
  return { label: defaultLabel, matched: false };
}

function escapeMd(text: string): string {
  return (text ?? '').replaceAll('|', '\\|').trim();
}

function applyMappedPrefixToReason(reason: string, mappedLabel: string): string {
  const s = String(reason ?? '').trim();
  const idx = s.indexOf(':');
  if (idx > 0) {
    const suffix = s.slice(idx); // includes ": ..."
    return `${mappedLabel}${suffix}`;
  }
  return mappedLabel ? `${mappedLabel}${s ? `: ${s}` : ''}` : s;
}

function buildMarkdown(sub: string, rows: Row[], cfg: SettingsConfig): string {
  const updated = new Date().toISOString();
  const header =
    `# Banned Users List\n\n` +
    `**Subreddit:** r/${sub}\n` +
    `**Last updated:** ${updated}\n\n`;

  if (!rows.length) return `${header}_No banned users found (or app lacks permission)._`;

  const showCategory = cfg.showCategory;
  const showReason = cfg.showReason;

  if (cfg.outputMode === 'bullets' || (!showCategory && !showReason)) {
    const lines = rows.map((r) => {
      if (showCategory && showReason) return `- ${r.user} — **${escapeMd(r.category)}** — ${escapeMd(r.reason)}`;
      if (showCategory && !showReason) return `- ${r.user} — **${escapeMd(r.category)}**`;
      if (!showCategory && showReason) return `- ${r.user} — ${escapeMd(r.reason)}`;
      return `- ${r.user}`;
    });
    return `${header}${lines.join('\n')}\n`;
  }

  const cols: string[] = ['User'];
  if (showCategory) cols.push('Category');
  if (showReason) cols.push('Ban reason / rule');

  const sep = `| ${cols.join(' | ')} |\n| ${cols.map(() => '---').join(' | ')} |`;

  const body = rows
    .map((r) => {
      const parts: string[] = [escapeMd(r.user)];
      if (showCategory) parts.push(escapeMd(r.category));
      if (showReason) parts.push(escapeMd(r.reason));
      return `| ${parts.join(' | ')} |`;
    })
    .join('\n');

  return `${header}${sep}\n${body}\n`;
}

// -------------------- Fetch banned users (up to 1000) --------------------
async function fetchBannedUsernames(ctx: Context, subredditName: string, limit: number, verbose: boolean): Promise<string[]> {
  // @ts-ignore
  const listing = await ctx.reddit.getBannedUsers({ subredditName, limit, pageSize: 100 });
  // @ts-ignore
  const users = await listing.all();

  const names = (users ?? [])
    .map((u: any) => String(u?.name ?? u?.username ?? '').trim())
    .filter(Boolean);

  if (verbose) console.log(`[banlist] getBannedUsers -> ${names.length} users (limit=${limit})`);
  return names;
}

// -------------------- Fetch ban reasons via modlog (banuser) --------------------
type ReasonHit = { reason: string; createdAt?: string; mod?: string };

function pickReasonFromModAction(ma: any): string {
  const desc = String(ma?.description ?? '').trim();
  const det = String(ma?.details ?? '').trim();
  if (det && desc) return `${desc}: ${det}`;
  if (det) return det;
  if (desc) return desc;
  return '';
}

async function buildReasonMapFromModlog(
  reddit: RedditAPIClient,
  subredditName: string,
  lookbackLimit: number,
  verbose: boolean,
  report: DebugReport
): Promise<Map<string, ReasonHit>> {
  // @ts-ignore
  const listing = await reddit.getModerationLog({
    subredditName,
    type: 'banuser',
    limit: lookbackLimit,
    pageSize: Math.min(100, lookbackLimit),
  });
  // @ts-ignore
  const actions = await listing.all();

  report.modlog.fetched = (actions ?? []).length;
  if (verbose) console.log(`[banlist] getModerationLog(type=banuser) fetched=${report.modlog.fetched} lookbackLimit=${lookbackLimit}`);

  const map = new Map<string, ReasonHit>();

  let sampleEntryKeys: string[] = [];
  let sampleTargetKeys: string[] = [];

  for (const a of actions ?? []) {
    if (!sampleEntryKeys.length) sampleEntryKeys = Object.keys(a ?? {});
    const target = (a as any)?.target;
    if (target && !sampleTargetKeys.length) sampleTargetKeys = Object.keys(target ?? {});
    const author = String(target?.author ?? '').trim();
    if (!author) continue;

    const reason = pickReasonFromModAction(a);
    const createdAt = (a as any)?.createdAt ? String((a as any).createdAt) : undefined;
    const mod = String((a as any)?.moderatorName ?? '').trim() || undefined;

    if (!map.has(author)) map.set(author, { reason, createdAt, mod });
  }

  report.modlog.sampleEntryKeys = sampleEntryKeys;
  report.modlog.sampleTargetKeys = sampleTargetKeys;

  if (verbose) {
    console.log('[banlist] modlog sample entry keys=', sampleEntryKeys);
    console.log('[banlist] modlog sample target keys=', sampleTargetKeys);
    console.log(`[banlist] modlog reason map size=${map.size}`);
  }

  return map;
}

// -------------------- Mod notes fallback --------------------
async function fetchLatestModNoteText(
  reddit: RedditAPIClient,
  subredditName: string,
  username: string,
  limit: number,
  verbose: boolean
): Promise<{ note: string; error?: string }> {
  try {
    // @ts-ignore
    const listing = await reddit.getModNotes({
      subreddit: subredditName,
      user: username,
      limit: Math.max(1, limit),
    });
    // @ts-ignore
    const notes = await listing.all();
    const first = (notes ?? [])[0];

    const text = (first as any)?.note ?? (first as any)?.text ?? (first as any)?.body ?? '';
    const note = String(text ?? '').trim();

    if (verbose) console.log(`[banlist] getModNotes(u/${username}) count=${(notes ?? []).length} note="${note.slice(0, 160)}"`);
    return { note };
  } catch (e: any) {
    const msg = e?.cause?.details ?? e?.message ?? String(e);
    if (verbose) console.log(`[banlist] getModNotes failed u/${username}: ${msg}`);
    return { note: '', error: msg };
  }
}

// -------------------- Scheduler: schedule ONLY if needed --------------------
async function ensureSingleCronScheduled(ctx: Context, cfg: SettingsConfig, report: DebugReport): Promise<void> {
  const sub = ctx.subredditName!;
  const cronKey = kvCronKey(sub, cfg.idKey);
  const jobKey = kvJobIdKey(sub, cfg.idKey);

  report.scheduler.kvCronKey = cronKey;
  report.scheduler.kvJobIdKey = jobKey;
  report.scheduler.prevCron = await ctx.kvStore.get(cronKey);
  report.scheduler.prevJobId = await ctx.kvStore.get(jobKey);

  report.scheduler.cancelAttempted = false;
  report.scheduler.scheduleAttempted = false;

  if (!cfg.scheduleEnabled) {
    report.scheduler.note.push('scheduleEnabled=false -> clearing stored cron/job');
    const prevJobId = report.scheduler.prevJobId ?? null;
    if (prevJobId && typeof (ctx.scheduler as any)?.cancelJob === 'function') {
      report.scheduler.cancelAttempted = true;
      try {
        await (ctx.scheduler as any).cancelJob(prevJobId);
        report.scheduler.cancelSucceeded = true;
      } catch (e: any) {
        report.scheduler.cancelSucceeded = false;
        report.scheduler.note.push(`cancelJob failed: ${e?.message ?? String(e)}`);
      }
    }
    await ctx.kvStore.delete(cronKey);
    await ctx.kvStore.delete(jobKey);
    return;
  }

  const prevCron = report.scheduler.prevCron ?? null;
  const prevJobId = report.scheduler.prevJobId ?? null;

  // ✅ do NOT reschedule if unchanged + have jobId (prevents cron limit)
  if (prevCron === cfg.scheduleCron && prevJobId) {
    report.scheduler.note.push('cron unchanged + have jobId -> not rescheduling (avoids cron limit)');
    return;
  }

  // cancel stored jobId best-effort
  if (prevJobId && typeof (ctx.scheduler as any)?.cancelJob === 'function') {
    report.scheduler.cancelAttempted = true;
    try {
      await (ctx.scheduler as any).cancelJob(prevJobId);
      report.scheduler.cancelSucceeded = true;
      report.scheduler.note.push(`canceled previous jobId=${prevJobId}`);
    } catch (e: any) {
      report.scheduler.cancelSucceeded = false;
      report.scheduler.note.push(`cancelJob failed (continuing): ${e?.message ?? String(e)}`);
    }
  }

  report.scheduler.scheduleAttempted = true;
  try {
    const newJobId = await ctx.scheduler.runJob({
      name: JOB_NAME,
      cron: cfg.scheduleCron,
      data: { idKey: cfg.idKey },
    } as any);

    const jobIdStr = String(newJobId);
    await ctx.kvStore.put(jobKey, jobIdStr);
    await ctx.kvStore.put(cronKey, cfg.scheduleCron);

    report.scheduler.scheduleSucceeded = true;
    report.scheduler.scheduleJobId = jobIdStr;
    report.scheduler.note.push(`scheduled jobId=${jobIdStr} cron=${cfg.scheduleCron}`);
  } catch (e: any) {
    const msg = e?.cause?.details ?? e?.message ?? String(e);
    report.scheduler.scheduleSucceeded = false;
    report.scheduler.scheduleError = msg;
    report.scheduler.note.push(`schedule failed: ${msg}`);
  }
}

// -------------------- Manual PURGE + reschedule (best-effort) --------------------
async function purgeOldCronsAndReschedule(ctx: Context, cfg: SettingsConfig, report: DebugReport): Promise<string[]> {
  const sub = ctx.subredditName!;
  const jobKey = kvJobIdKey(sub, cfg.idKey);
  const cronKey = kvCronKey(sub, cfg.idKey);

  const canceled: string[] = [];
  report.scheduler.purgeAttempted = true;

  const canList = typeof (ctx.scheduler as any)?.listJobs === 'function';
  const canCancel = typeof (ctx.scheduler as any)?.cancelJob === 'function';

  const storedJobId = await ctx.kvStore.get(jobKey);
  const storedCron = await ctx.kvStore.get(cronKey);

  if (cfg.debugVerbose) {
    console.log(`[banlist] PURGE start idKey=${cfg.idKey} storedJobId=${storedJobId ?? 'none'} storedCron=${storedCron ?? 'none'}`);
    console.log(`[banlist] scheduler supports listJobs=${canList} cancelJob=${canCancel}`);
  }

  // Cancel stored jobId first (best-effort)
  if (canCancel && storedJobId) {
    try {
      await (ctx.scheduler as any).cancelJob(storedJobId);
      canceled.push(storedJobId);
      if (cfg.debugVerbose) console.log(`[banlist] PURGE canceled stored jobId=${storedJobId}`);
    } catch (e: any) {
      if (cfg.debugVerbose) console.log(`[banlist] PURGE cancel stored jobId failed: ${e?.message ?? String(e)}`);
    }
  }

  // If listJobs exists, cancel all cron jobs for this app job name + (idKey if available)
  if (canList && canCancel) {
    try {
      const jobs = await (ctx.scheduler as any).listJobs();
      if (cfg.debugVerbose) console.log(`[banlist] PURGE listJobs -> ${jobs?.length ?? 0}`);

      for (const j of jobs ?? []) {
        const isCron = typeof j?.cron === 'string' && j.cron.length > 0;
        const isSameName = j?.name === JOB_NAME;

        const dataIdKey = j?.data?.idKey ? String(j.data.idKey) : null;
        const matchesIdKey = dataIdKey ? dataIdKey === cfg.idKey : true;

        if (isCron && isSameName && matchesIdKey) {
          try {
            const jid = String(j.id);
            await (ctx.scheduler as any).cancelJob(jid);
            canceled.push(jid);
            if (cfg.debugVerbose) console.log(`[banlist] PURGE canceled jobId=${jid} cron=${j.cron} dataIdKey=${dataIdKey ?? 'none'}`);
          } catch (e: any) {
            if (cfg.debugVerbose) console.log(`[banlist] PURGE cancel jobId=${j?.id} failed: ${e?.message ?? String(e)}`);
          }
        }
      }
    } catch (e: any) {
      if (cfg.debugVerbose) console.log(`[banlist] PURGE listJobs failed: ${e?.message ?? String(e)}`);
      report.scheduler.note.push(`PURGE listJobs failed: ${e?.message ?? String(e)}`);
    }
  } else {
    report.scheduler.note.push('PURGE: listJobs/cancelJob not supported in this runtime; canceled stored jobId only (if any)');
  }

  report.scheduler.purgeCanceledJobIds = canceled;

  // Clear KV so ensureSingleCronScheduled schedules cleanly
  await ctx.kvStore.delete(jobKey);
  await ctx.kvStore.delete(cronKey);

  // Now schedule ONE fresh cron using normal safe logic
  await ensureSingleCronScheduled(ctx, cfg, report);

  return canceled;
}

// -------------------- Build final rows --------------------
async function buildRows(ctx: Context, cfg: SettingsConfig, report: DebugReport): Promise<Row[]> {
  const sub = ctx.subredditName!;
  const verbose = cfg.debugVerbose;

  const bannedUsernames = await fetchBannedUsernames(ctx, sub, cfg.banListLimit, verbose);
  report.bannedUsers.count = bannedUsernames.length;
  report.bannedUsers.sample = bannedUsernames.slice(0, 10);

  const reasonMap = await buildReasonMapFromModlog(ctx.reddit, sub, cfg.modlogLookbackLimit, verbose, report);

  let modNotesAttempts = 0;
  let modNotesFailures = 0;

  let excludedCount = 0;
  let mappedFromModlog = 0;
  let missingFromModlog = 0;

  const rows: Row[] = [];

  for (const u of bannedUsernames) {
    let reason = '';
    const hit = reasonMap.get(u);
    if (hit?.reason) {
      reason = hit.reason;
      mappedFromModlog += 1;
    } else {
      missingFromModlog += 1;
    }

    if (!reason && (cfg.reasonSource === 'mod_note' || cfg.reasonSource === 'modlog_then_modnote')) {
      modNotesAttempts += 1;
      const { note, error } = await fetchLatestModNoteText(ctx.reddit, sub, u, cfg.modNotesPerUser, verbose);
      if (error) modNotesFailures += 1;
      reason = note ?? '';
    }

    const reasonLower = (reason ?? '').toLowerCase();
    const excluded = cfg.excludeNeedles.some((n) => n && reasonLower.includes(n));
    if (excluded) {
      excludedCount += 1;
      continue;
    }

    // Mapping with match flag
    const mapped = mapTextToLabelWithMatch(reason, cfg.mappingRules, cfg.defaultLabel);
    const category = mapped.label;

    // ✅ Prefix rewrite behavior you requested
    if (cfg.applyMappingToReasonPrefix && reason) {
      if (!cfg.reasonPrefixOnlyIfMapped || mapped.matched) {
        reason = applyMappedPrefixToReason(reason, category);
      }
      // else: keep original reason unchanged
    }

    rows.push({ user: `u/${u}`, category, reason });
  }

  report.modlog.mapped = mappedFromModlog;
  report.modlog.missing = missingFromModlog;
  report.modNotes.attempts = modNotesAttempts;
  report.modNotes.failures = modNotesFailures;

  report.rows.excludedCount = excludedCount;

  rows.sort((a, b) => a.user.localeCompare(b.user));

  // Cap rows in post (safety)
  let truncated = false;
  let finalRows = rows;
  if (rows.length > cfg.maxRowsInPost) {
    truncated = true;
    finalRows = rows.slice(0, cfg.maxRowsInPost);
  }

  report.rows.finalCount = finalRows.length;
  report.rows.truncated = truncated;
  report.rows.sample = finalRows.slice(0, 10);

  if (verbose) {
    console.log(
      `[banlist] rows final=${finalRows.length} excluded=${excludedCount} modlogMapped=${mappedFromModlog} modlogMissing=${missingFromModlog} truncated=${truncated}`
    );
  }

  return finalRows;
}

// -------------------- Publish --------------------
async function runPublish(ctx: Context, actor: Actor, mode: DebugReport['post']['mode']) {
  const sub = ctx.subredditName!;
  const cfg = await getCfg(ctx);

  const report: DebugReport = {
    ts: new Date().toISOString(),
    subreddit: sub,
    idKey: cfg.idKey,
    actor,

    settings: {
      title: cfg.title,
      scheduleEnabled: cfg.scheduleEnabled,
      scheduleCron: cfg.scheduleCron,
      fallbackCron: cfg.fallbackCron,
      fallbackManualUpdate: cfg.fallbackManualUpdate,
      setNewPostAsActive: cfg.setNewPostAsActive,
      reasonSource: cfg.reasonSource,
      showCategory: cfg.showCategory,
      showReason: cfg.showReason,
      outputMode: cfg.outputMode,
      applyMappingToReasonPrefix: cfg.applyMappingToReasonPrefix,
      reasonPrefixOnlyIfMapped: cfg.reasonPrefixOnlyIfMapped,
      sort: cfg.sort,
      excludeNeedles: cfg.excludeNeedles,
      modNotesPerUser: cfg.modNotesPerUser,
      modlogLookbackLimit: cfg.modlogLookbackLimit,
      banListLimit: cfg.banListLimit,
      maxRowsInPost: cfg.maxRowsInPost,
      mappingRulesCount: cfg.mappingRules.length,
      debugVerbose: cfg.debugVerbose,
    },

    bannedUsers: { count: 0, sample: [] },
    modlog: { fetched: 0, mapped: 0, missing: 0, sampleEntryKeys: [], sampleTargetKeys: [] },
    modNotes: { attempts: 0, failures: 0 },
    rows: { finalCount: 0, excludedCount: 0, truncated: false, sample: [] },

    post: { kvPostKey: kvPostKey(sub, cfg.idKey), storedPostId: null, mode },

    scheduler: {
      kvCronKey: kvCronKey(sub, cfg.idKey),
      kvJobIdKey: kvJobIdKey(sub, cfg.idKey),
      prevCron: null,
      prevJobId: null,
      cancelAttempted: false,
      scheduleAttempted: false,
      note: [],
    },

    notes: [],
  };

  if (cfg.mappingParseError) {
    report.notes.push(`mappingJson parse error: ${cfg.mappingParseError}`);
    console.log(`[banlist] mappingJson parse error: ${cfg.mappingParseError}`);
  }

  console.log(`[banlist] START actor=${actor} mode=${mode} sub=${sub} idKey=${cfg.idKey}`);

  const rows = await buildRows(ctx, cfg, report);
  const body = buildMarkdown(sub, rows, cfg);

  // Manual create modes
  if (mode === 'create_new_and_set_active' || mode === 'create_new_no_change_active') {
    report.post.createAttempted = true;
    const created = await ctx.reddit.submitPost({ subredditName: sub, title: cfg.title, text: body });
    report.post.createSucceeded = true;
    report.post.createdPostId = created.id;

    if (mode === 'create_new_and_set_active') {
      await writeStoredPostRef(ctx, cfg.idKey, created.id);
      report.post.didSetNewActive = true;
      report.post.finalActivePostId = created.id;
    } else {
      const stored = await readStoredPostRef(ctx, cfg.idKey);
      report.post.didSetNewActive = false;
      report.post.finalActivePostId = stored?.postId ?? null;
    }

    await writeDebug(ctx, cfg.idKey, report);
    return { ok: true, created: true, postId: created.id, rows: rows.length };
  }

  // update_existing_only
  const stored = await readStoredPostRef(ctx, cfg.idKey);
  report.post.storedPostId = stored?.postId ?? null;

  if (!stored?.postId) {
    const fb = decideFallback(cfg, actor === 'cron' ? 'cron' : 'manual_update');
    report.post.fallbackChosen = fb;

    if (fb === 'do_nothing') {
      report.post.skipped = true;
      report.post.skippedReason = 'No stored postId; configured to do nothing.';
      await writeDebug(ctx, cfg.idKey, report);
      return { ok: true, created: false, skipped: true, postId: null, rows: rows.length };
    }

    report.post.createAttempted = true;
    const created = await ctx.reddit.submitPost({ subredditName: sub, title: cfg.title, text: body });
    report.post.createSucceeded = true;
    report.post.createdPostId = created.id;

    if (cfg.setNewPostAsActive) {
      await writeStoredPostRef(ctx, cfg.idKey, created.id);
      report.post.didSetNewActive = true;
      report.post.finalActivePostId = created.id;
    } else {
      report.post.didSetNewActive = false;
      report.post.finalActivePostId = null;
    }

    await writeDebug(ctx, cfg.idKey, report);
    return { ok: true, created: true, postId: created.id, rows: rows.length };
  }

  // Check editability
  const ed = await getEditability(ctx.reddit, stored.postId);
  report.post.fetchOk = ed.fetchOk;
  report.post.archivedRaw = ed.archivedRaw;
  report.post.archivedParsed = ed.archived;
  report.post.lockedRaw = ed.lockedRaw;
  report.post.lockedParsed = ed.locked;
  report.post.canEdit = ed.canEdit;
  report.post.notEditableReason = ed.reasonIfNot;

  if (!ed.canEdit) {
    const fb = decideFallback(cfg, actor === 'cron' ? 'cron' : 'manual_update');
    report.post.fallbackChosen = fb;

    if (fb === 'do_nothing') {
      report.post.skipped = true;
      report.post.skippedReason = `Active post not editable (${ed.reasonIfNot}); configured to do nothing.`;
      report.post.finalActivePostId = stored.postId;
      await writeDebug(ctx, cfg.idKey, report);
      return { ok: true, created: false, skipped: true, postId: stored.postId, rows: rows.length };
    }

    report.post.createAttempted = true;
    const created = await ctx.reddit.submitPost({ subredditName: sub, title: cfg.title, text: body });
    report.post.createSucceeded = true;
    report.post.createdPostId = created.id;

    if (cfg.setNewPostAsActive) {
      await writeStoredPostRef(ctx, cfg.idKey, created.id);
      report.post.didSetNewActive = true;
      report.post.finalActivePostId = created.id;
    } else {
      report.post.didSetNewActive = false;
      report.post.finalActivePostId = stored.postId;
    }

    await writeDebug(ctx, cfg.idKey, report);
    return { ok: true, created: true, postId: created.id, rows: rows.length };
  }

  // Editable -> edit existing post
  report.post.editAttempted = true;
  try {
    const post = await ctx.reddit.getPostById(stored.postId);
    await post.edit({ text: body });

    report.post.editSucceeded = true;
    report.post.finalActivePostId = stored.postId;

    await writeDebug(ctx, cfg.idKey, report);
    return { ok: true, created: false, postId: stored.postId, rows: rows.length };
  } catch (e: any) {
    const msg = e?.cause?.details ?? e?.message ?? String(e);
    report.post.editSucceeded = false;
    report.post.editError = msg;

    report.post.skipped = true;
    report.post.skippedReason = `Edit failed; not creating fallback post automatically: ${msg}`;

    await writeDebug(ctx, cfg.idKey, report);
    return { ok: false, created: false, skipped: true, postId: stored.postId, rows: rows.length };
  }
}

// -------------------- Scheduler job --------------------
Devvit.addSchedulerJob({
  name: JOB_NAME,
  onRun: async (_event, ctx) => {
    console.log(`[banlist] Scheduler fired job=${JOB_NAME}`);
    const cfg = await getCfg(ctx);
    if (!cfg.scheduleEnabled) return;
    await runPublish(ctx, 'cron', 'update_existing_only');
  },
});

// -------------------- Triggers --------------------
Devvit.addTrigger({
  events: ['AppInstall', 'AppUpgrade'],
  onEvent: async (_event, ctx) => {
    const cfg = await getCfg(ctx);

    const report: DebugReport = {
      ts: new Date().toISOString(),
      subreddit: ctx.subredditName!,
      idKey: cfg.idKey,
      actor: 'schedule_action',
      settings: { scheduleEnabled: cfg.scheduleEnabled, scheduleCron: cfg.scheduleCron },
      bannedUsers: { count: 0, sample: [] },
      modlog: { fetched: 0, mapped: 0, missing: 0, sampleEntryKeys: [], sampleTargetKeys: [] },
      modNotes: { attempts: 0, failures: 0 },
      rows: { finalCount: 0, excludedCount: 0, truncated: false, sample: [] },
      post: {
        kvPostKey: kvPostKey(ctx.subredditName!, cfg.idKey),
        storedPostId: (await readStoredPostRef(ctx, cfg.idKey))?.postId ?? null,
        mode: 'update_existing_only',
        finalActivePostId: (await readStoredPostRef(ctx, cfg.idKey))?.postId ?? null,
      },
      scheduler: {
        kvCronKey: kvCronKey(ctx.subredditName!, cfg.idKey),
        kvJobIdKey: kvJobIdKey(ctx.subredditName!, cfg.idKey),
        prevCron: null,
        prevJobId: null,
        cancelAttempted: false,
        scheduleAttempted: false,
        note: [],
      },
      notes: [],
    };

    // schedule (safe: only if needed)
    await ensureSingleCronScheduled(ctx, cfg, report);
    await writeDebug(ctx, cfg.idKey, report);

    // run once on install/upgrade
    await runPublish(ctx, 'install_or_upgrade', 'update_existing_only');
  },
});

// -------------------- Mod menu items --------------------
Devvit.addMenuItem({
  label: 'Ban List: Update active post (safe)',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, ctx) => {
    const res = await runPublish(ctx, 'manual_update', 'update_existing_only');
    if ((res as any).skipped) ctx.ui.showToast(`Skipped. Rows=${res.rows} (check debug/logs)`);
    else ctx.ui.showToast(res.created ? `Created new post. Rows=${res.rows}` : `Updated active post. Rows=${res.rows}`);
  },
});

Devvit.addMenuItem({
  label: 'Ban List: Create NEW post (set active)',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, ctx) => {
    const res = await runPublish(ctx, 'manual_create', 'create_new_and_set_active');
    ctx.ui.showToast(`Created new active post. Rows=${res.rows}`);
  },
});

Devvit.addMenuItem({
  label: 'Ban List: Create NEW post (do NOT set active)',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, ctx) => {
    const res = await runPublish(ctx, 'manual_create', 'create_new_no_change_active');
    ctx.ui.showToast(`Created post (not active). Rows=${res.rows}`);
  },
});

Devvit.addMenuItem({
  label: 'Ban List: Refresh schedule (only if needed)',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, ctx) => {
    const cfg = await getCfg(ctx);

    const report: DebugReport = {
      ts: new Date().toISOString(),
      subreddit: ctx.subredditName!,
      idKey: cfg.idKey,
      actor: 'schedule_action',
      settings: { scheduleEnabled: cfg.scheduleEnabled, scheduleCron: cfg.scheduleCron },
      bannedUsers: { count: 0, sample: [] },
      modlog: { fetched: 0, mapped: 0, missing: 0, sampleEntryKeys: [], sampleTargetKeys: [] },
      modNotes: { attempts: 0, failures: 0 },
      rows: { finalCount: 0, excludedCount: 0, truncated: false, sample: [] },
      post: {
        kvPostKey: kvPostKey(ctx.subredditName!, cfg.idKey),
        storedPostId: (await readStoredPostRef(ctx, cfg.idKey))?.postId ?? null,
        mode: 'update_existing_only',
        finalActivePostId: (await readStoredPostRef(ctx, cfg.idKey))?.postId ?? null,
      },
      scheduler: {
        kvCronKey: kvCronKey(ctx.subredditName!, cfg.idKey),
        kvJobIdKey: kvJobIdKey(ctx.subredditName!, cfg.idKey),
        prevCron: await ctx.kvStore.get(kvCronKey(ctx.subredditName!, cfg.idKey)),
        prevJobId: await ctx.kvStore.get(kvJobIdKey(ctx.subredditName!, cfg.idKey)),
        cancelAttempted: false,
        scheduleAttempted: false,
        note: [],
      },
      notes: [],
    };

    await ensureSingleCronScheduled(ctx, cfg, report);
    await writeDebug(ctx, cfg.idKey, report);

    if (report.scheduler.scheduleError) ctx.ui.showToast(`Schedule error: ${report.scheduler.scheduleError}`);
    else ctx.ui.showToast(`Schedule OK (or unchanged).`);
  },
});

// ✅ Manual purge
Devvit.addMenuItem({
  label: 'Ban List: PURGE old crons + reschedule',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, ctx) => {
    const cfg = await getCfg(ctx);

    const report: DebugReport = {
      ts: new Date().toISOString(),
      subreddit: ctx.subredditName!,
      idKey: cfg.idKey,
      actor: 'schedule_action',
      settings: { scheduleEnabled: cfg.scheduleEnabled, scheduleCron: cfg.scheduleCron },
      bannedUsers: { count: 0, sample: [] },
      modlog: { fetched: 0, mapped: 0, missing: 0, sampleEntryKeys: [], sampleTargetKeys: [] },
      modNotes: { attempts: 0, failures: 0 },
      rows: { finalCount: 0, excludedCount: 0, truncated: false, sample: [] },
      post: {
        kvPostKey: kvPostKey(ctx.subredditName!, cfg.idKey),
        storedPostId: (await readStoredPostRef(ctx, cfg.idKey))?.postId ?? null,
        mode: 'update_existing_only',
        finalActivePostId: (await readStoredPostRef(ctx, cfg.idKey))?.postId ?? null,
      },
      scheduler: {
        kvCronKey: kvCronKey(ctx.subredditName!, cfg.idKey),
        kvJobIdKey: kvJobIdKey(ctx.subredditName!, cfg.idKey),
        prevCron: await ctx.kvStore.get(kvCronKey(ctx.subredditName!, cfg.idKey)),
        prevJobId: await ctx.kvStore.get(kvJobIdKey(ctx.subredditName!, cfg.idKey)),
        cancelAttempted: false,
        scheduleAttempted: false,
        note: [],
      },
      notes: [],
    };

    const canceled = await purgeOldCronsAndReschedule(ctx, cfg, report);
    await writeDebug(ctx, cfg.idKey, report);

    const msg =
      report.scheduler.scheduleError
        ? `Purge done. Canceled ${canceled.length}. Schedule error: ${report.scheduler.scheduleError}`
        : `Purge done. Canceled ${canceled.length}. Scheduled OK (or unchanged).`;

    ctx.ui.showToast(msg);
  },
});

Devvit.addMenuItem({
  label: 'Ban List: Debug — print last report to logs',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, ctx) => {
    const cfg = await getCfg(ctx);
    const dbg = await readDebug(ctx, cfg.idKey);
    if (!dbg) {
      ctx.ui.showToast('No debug report yet.');
      return;
    }
    console.log(`[banlist] DEBUG REPORT:\n${JSON.stringify(dbg, null, 2)}`);
    ctx.ui.showToast(`Last report ${dbg.ts} rows=${dbg.rows.finalCount} banned=${dbg.bannedUsers.count}`);
  },
});

// -------------------- Capabilities --------------------
Devvit.configure({
  redditAPI: true,
  kvStore: true,
  scheduler: true,
});

export default Devvit;
