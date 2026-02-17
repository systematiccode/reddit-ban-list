import { Devvit, Context, RedditAPIClient } from '@devvit/public-api';

/**
 * Banned List Poster — "Simple but Full‑Featured"
 *
 * ✅ Uses ONLY /about/banned listing via ctx.reddit.getBannedUsers (no modlog, no modnotes)
 * ✅ Extracts NOTE + REASON defensively (supports u.data nesting + multiple key aliases)
 * ✅ Mapping -> short labels (configurable JSON)
 * ✅ Exclusions (configurable):
 *    - excludeIfTextContains (needle match across raw note+reason)
 *    - excludeIfMappedLabelIn (label match after mapping)
 *
 * ✅ Full mod tooling UX retained:
 *    - Update active post (safe)
 *    - Create NEW post (set active)
 *    - Create NEW post (do NOT set active)
 *    - Refresh schedule (only if needed)
 *    - PURGE old crons + reschedule (best effort)
 *
 * ✅ Scheduler:
 *    - New job name + legacy job name supported (avoids "Job not found")
 *    - Stored jobId + cron in KV to avoid cron limits
 *
 * ✅ Install/Upgrade:
 *    - Best-effort schedule only, never fails installation
 */

const JOB_NAME_NEW = 'simple_banned_list_update';
const JOB_NAME_LEGACY = 'update_banned_list_post'; // absorb old scheduled jobs safely

// KV keys
const KV_POST_PREFIX = 'banlist_post:';     // active post ref
const KV_CRON_PREFIX = 'banlist_cron:';     // stored cron string
const KV_JOBID_PREFIX = 'banlist_jobid:';   // stored scheduler jobId
const KV_DEBUG_PREFIX = 'banlist_debug:';   // debug snapshot

type MappingRule = { label: string; keywords: string[] };

type OutputSort = 'note_asc' | 'user_asc';

type Config = {
  postTitle: string;
  postIdKey: string;

  scheduleEnabled: boolean;
  scheduleCron: string;

  banListLimit: number;
  maxRowsInPost: number;

  // Exclusions
  excludeIfTextContains: string[];   // needles, lowercase
  excludeIfMappedLabelIn: string[];  // labels, lowercase

  // Mapping
  mappingRules: MappingRule[];
  defaultLabel: string;

  // Formatting
  maskUsernamesInNote: boolean;
  sortBy: OutputSort;

  // Behavior
  createNewOnEditFail: boolean;
  setNewPostAsActive: boolean;

  // Debug
  debugVerbose: boolean;
};

type StoredPostRef = { postId: string; updatedAt: string; idKey: string };

type BannedListingRow = {
  name: string;   // username, no "u/"
  note: string;   // NOTE column
  reason: string; // REASON column
  raw: string;    // note||reason
};

type RunMode = 'update_existing_only' | 'create_new_and_set_active' | 'create_new_no_change_active';

type DebugSnapshot = {
  ts: string;
  subreddit: string;
  idKey: string;
  actor: 'cron' | 'manual' | 'install_or_upgrade' | 'schedule_action';
  cfg: Record<string, any>;
  bans: { total: number; sample: any[]; sampleKeys: string[]; sampleDataKeys: string[] };
  rows: { out: number; excludedByText: number; excludedByLabel: number; sample: Array<{ u: string; raw: string; label: string }> };
  post: { storedPostId?: string | null; action: string; finalPostId?: string | null; error?: string };
  scheduler: { note: string[]; prevCron?: string | null; prevJobId?: string | null; newJobId?: string | null; error?: string | null };
};

// -------------------- Settings --------------------
Devvit.addSettings([
  { type: 'string', name: 'postTitle', label: 'Post title', defaultValue: 'Banned Users List (Auto-updated)' },
  { type: 'string', name: 'postIdKey', label: 'Post key (tracks which post to update)', defaultValue: 'banned-users-list' },

  { type: 'boolean', name: 'scheduleEnabled', label: 'Enable auto-update schedule', defaultValue: true },
  { type: 'string', name: 'scheduleCron', label: 'Auto-update cron (UNIX cron)', defaultValue: '*/30 * * * *' },

  { type: 'number', name: 'banListLimit', label: 'Max banned users to list (up to 1000)', defaultValue: 1000 },
  { type: 'number', name: 'maxRowsInPost', label: 'Max rows in post (avoid size limits)', defaultValue: 1000 },

  // Exclusion controls (fully configurable)
  { type: 'string', name: 'excludeIfTextContains', label: 'Exclude if text contains (comma-separated, case-insensitive)', defaultValue: 'usl ban:,usl ban from,usl ban' },
  { type: 'string', name: 'excludeIfMappedLabelIn', label: 'Exclude if mapped label is (comma-separated, case-insensitive)', defaultValue: 'USL Ban' },

  // Mapping rules (JSON)
  {
    type: 'string',
    name: 'mappingJson',
    label: 'Mapping rules JSON (maps note/reason text to short labels)',
    defaultValue: JSON.stringify(
      [
        { label: 'Ban Evasion', keywords: ['ban evasion'] },
        { label: 'Harassment, Bullying or Discrimination', keywords: ['behaviour', 'no harassment', 'harassment', 'bully', 'discrimination', 'dox', 'doxx', 'doxxing', 'slur', 'racist', 'homophobic', 'transphobic', 'sexist', 'nude', 'nudes'] },
        { label: 'Scamming', keywords: ['scamming', 'scam', 'scammer', '#scammer', 'fraud'] },
        { label: 'Selling of accounts, Pokémon, or services', keywords: ['selling', 'buying', 'advertising', 'service', 'services', 'coins', 'raid service', 'pilot', 'boost'] },
        { label: 'Threatening, harassing, or inciting violence', keywords: ['threat', 'threatening', 'inciting violence', 'violence'] },
        { label: 'Spamming', keywords: ['spam', 'no spam', 'posting frequency', 'off-topic', 'advert'] },

        // Optional: map USL explicitly so label-exclusion can hide it cleanly
        { label: 'USL Ban', keywords: ['usl ban'] },
      ],
      null,
      2
    ),
  },
  { type: 'string', name: 'defaultLabel', label: 'Default label if no mapping match / empty', defaultValue: 'No reason provided' },

  // Formatting
  { type: 'boolean', name: 'maskUsernamesInNote', label: 'Mask usernames inside note (u/******)', defaultValue: true },
  { type: 'string', name: 'sortBy', label: 'Sort: "note_asc" or "user_asc"', defaultValue: 'note_asc' },

  // Behavior
  { type: 'boolean', name: 'createNewOnEditFail', label: 'If editing active post fails, create a new post', defaultValue: true },
  { type: 'boolean', name: 'setNewPostAsActive', label: 'When creating a new post, set it as active', defaultValue: true },

  // Debug
  { type: 'boolean', name: 'debugVerbose', label: 'Verbose logs', defaultValue: true },
]);

// -------------------- Helpers: parsing --------------------
function userToPlain(u: any): any {
  if (!u) return u;
  try {
    if (typeof u.toJSON === 'function') return u.toJSON();
  } catch {}
  const out: any = {};
  const fields = [
    'id','username','createdAt','linkKarma','commentKarma','nsfw','isAdmin','modPermissions',
    'url','permalink','hasVerifiedEmail','displayName','about'
  ];
  for (const f of fields) {
    try { out[f] = (u as any)[f]; } catch {}
  }
  // Include any enumerable own props too
  try {
    for (const k of Object.keys(u)) out[k] = (u as any)[k];
  } catch {}
  return out;
}

function parseCsvLower(v: string): string[] {
  return String(v ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function safeParseMappings(raw: string): MappingRule[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((r: any) => ({
        label: String(r?.label ?? '').trim(),
        keywords: Array.isArray(r?.keywords)
          ? r.keywords.map((k: any) => String(k ?? '').toLowerCase().trim()).filter(Boolean)
          : [],
      }))
      .filter((r: MappingRule) => r.label.length > 0 && r.keywords.length > 0);
  } catch {
    return [];
  }
}

async function getCfg(ctx: Context): Promise<Config> {
  const postTitle = String((await ctx.settings.get('postTitle')) ?? 'Banned Users List (Auto-updated)');
  const postIdKey = String((await ctx.settings.get('postIdKey')) ?? 'banned-users-list');

  const scheduleEnabled = Boolean(await ctx.settings.get('scheduleEnabled'));
  const scheduleCron = String((await ctx.settings.get('scheduleCron')) ?? '*/30 * * * *');

  const banListLimit = Math.min(1000, Math.max(1, Number((await ctx.settings.get('banListLimit')) ?? 1000) || 1000));
  const maxRowsInPost = Math.min(2000, Math.max(1, Number((await ctx.settings.get('maxRowsInPost')) ?? 1000) || 1000));

  const excludeIfTextContains = parseCsvLower(String((await ctx.settings.get('excludeIfTextContains')) ?? ''));
  const excludeIfMappedLabelIn = parseCsvLower(String((await ctx.settings.get('excludeIfMappedLabelIn')) ?? ''));

  const mappingJson = String((await ctx.settings.get('mappingJson')) ?? '[]');
  const mappingRules = safeParseMappings(mappingJson);

  const defaultLabel = String((await ctx.settings.get('defaultLabel')) ?? 'No reason provided').trim() || 'No reason provided';

  const maskUsernamesInNote = Boolean(await ctx.settings.get('maskUsernamesInNote'));
  const sortByRaw = String((await ctx.settings.get('sortBy')) ?? 'note_asc').trim().toLowerCase();
  const sortBy: OutputSort = sortByRaw === 'user_asc' ? 'user_asc' : 'note_asc';

  const createNewOnEditFail = Boolean(await ctx.settings.get('createNewOnEditFail'));
  const setNewPostAsActive = Boolean(await ctx.settings.get('setNewPostAsActive'));

  const debugVerbose = Boolean(await ctx.settings.get('debugVerbose'));

  return {
    postTitle,
    postIdKey,
    scheduleEnabled,
    scheduleCron,
    banListLimit,
    maxRowsInPost,
    excludeIfTextContains,
    excludeIfMappedLabelIn,
    mappingRules,
    defaultLabel,
    maskUsernamesInNote,
    sortBy,
    createNewOnEditFail,
    setNewPostAsActive,
    debugVerbose,
  };
}

// -------------------- Helpers: KV keys --------------------
function kvPostKey(sub: string, idKey: string): string {
  return `${KV_POST_PREFIX}${sub}:${idKey}`;
}
function kvCronKey(sub: string, idKey: string): string {
  return `${KV_CRON_PREFIX}${sub}:${idKey}`;
}
function kvJobIdKey(sub: string, idKey: string): string {
  return `${KV_JOBID_PREFIX}${sub}:${idKey}`;
}
function kvDebugKey(sub: string, idKey: string): string {
  return `${KV_DEBUG_PREFIX}${sub}:${idKey}`;
}

// -------------------- Helpers: KV read/write --------------------
async function readStoredPostRef(ctx: Context, idKey: string): Promise<StoredPostRef | null> {
  const sub = ctx.subredditName!;
  const raw = await ctx.kvStore.get(kvPostKey(sub, idKey));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredPostRef;
  } catch {
    return null;
  }
}

async function writeStoredPostRef(ctx: Context, idKey: string, postId: string): Promise<void> {
  const sub = ctx.subredditName!;
  const value: StoredPostRef = { postId, updatedAt: new Date().toISOString(), idKey };
  await ctx.kvStore.put(kvPostKey(sub, idKey), JSON.stringify(value));
}

async function writeDebug(ctx: Context, idKey: string, snap: DebugSnapshot): Promise<void> {
  const sub = ctx.subredditName!;
  try {
    await ctx.kvStore.put(kvDebugKey(sub, idKey), JSON.stringify(snap, null, 2));
  } catch {
    // ignore
  }
}

async function readDebug(ctx: Context, idKey: string): Promise<DebugSnapshot | null> {
  const sub = ctx.subredditName!;
  try {
    const raw = await ctx.kvStore.get(kvDebugKey(sub, idKey));
    if (!raw) return null;
    return JSON.parse(raw) as DebugSnapshot;
  } catch {
    return null;
  }
}

// -------------------- Mapping + formatting --------------------
function maskUsernamesInsideNote(noteRaw: string): string {
  return String(noteRaw ?? '').replace(/u\/\S+/g, 'u/******');
}

function mapTextToLabel(text: string, rules: MappingRule[], defaultLabel: string): { label: string; matched: boolean } {
  const t = String(text ?? '').toLowerCase();
  for (const rule of rules) {
    if (rule.keywords.some((kw) => kw && t.includes(kw))) return { label: rule.label, matched: true };
  }
  return { label: defaultLabel, matched: false };
}

function escapeMd(s: string): string {
  return String(s ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

function buildMarkdown(sub: string, title: string, rows: Array<{ name: string; note: string }>, maxRows: number): string {
  const updated = new Date().toISOString();
  const header =
    `# ${escapeMd(title)}\n\n` +
    `**Subreddit:** r/${escapeMd(sub)}\n` +
    `**Last updated:** ${escapeMd(updated)}\n\n`;

  if (!rows.length) return `${header}_No banned users found (or missing permissions)._`;

  const MAX_BODY_CHARS = 39000;
  let out = header + `| Name | Note |\n|------|------|\n`;

  let added = 0;
  let truncated = false;

  for (const r of rows.slice(0, maxRows)) {
    const line = `| u/${escapeMd(r.name)} | ${escapeMd(r.note)} |\n`;
    if (out.length + line.length + 200 > MAX_BODY_CHARS) {
      truncated = true;
      break;
    }
    out += line;
    added++;
  }

  if (truncated) out += `\n_⚠️ Truncated to ${added} rows due to Reddit post size limits._\n`;
  return out;
}


function logBanUserDebug(u: any, idx: number, extracted: { name: string; note: string; reason: string; raw: string }, mapping: { label: string; matched: boolean }, excluded: { byText: boolean; byLabel: boolean }, cfg: { maskUsernamesInNote: boolean }): void {
  const topKeys = Object.keys(u ?? {});
  const dataKeys = Object.keys((u?.data ?? {}) ?? {});
  console.log('[banlist] banned_user_debug', {
    idx,
    topKeys,
    dataKeys,
    extracted,
    mapping,
    excluded,
    cfg,
    raw: userToPlain(u),
  });
}

// -------------------- Ban listing extraction (defensive) --------------------
function pickBanName(u: any): string {
  return String(u?.name ?? u?.username ?? u?.data?.name ?? u?.data?.username ?? '').trim();
}

function pickBanNote(u: any): string {
  const src = u?.data ?? u;
  const noteRaw =
    src?.note ??
    src?.ban_note ??
    src?.banNote ??
    src?.mod_note ??
    src?.modNote ??
    src?.user_note ??
    src?.userNote ??
    src?.note_text ??
    src?.noteText ??
    src?.note_markdown ??
    src?.noteMarkdown ??
    src?.ban_note_markdown ??
    src?.banNoteMarkdown;
  return String(noteRaw ?? '').trim();
}

function pickBanReason(u: any): string {
  const src = u?.data ?? u;
  const reasonRaw =
    src?.reason ??
    src?.ban_reason ??
    src?.banReason ??
    src?.rule_reason ??
    src?.reason_text ??
    src?.reasonText ??
    src?.rule ??
    src?.ban_rule ??
    src?.banRule;
  return String(reasonRaw ?? '').trim();
}

async function fetchBannedUsers(ctx: Context, subredditName: string, limit: number, verbose: boolean): Promise<{ rows: BannedListingRow[]; sampleObj: any; sampleKeys: string[]; sampleDataKeys: string[] }> {
  const pageSize = 100;
  const out: BannedListingRow[] = [];
  const seen = new Set<string>();

  // @ts-ignore
  const listing: any = await ctx.reddit.getBannedUsers({ subredditName, limit: Math.min(pageSize, limit), pageSize });
  const hasPrivateFetch = typeof listing?._fetch === 'function';

  const extractChildren = (pageObj: any): any[] =>
    (pageObj?.children as any[]) ?? (pageObj?.data?.children as any[]) ?? [];

  let sampleObj: any = null;
  let sampleKeys: string[] = [];
  let sampleDataKeys: string[] = [];

  const addUsers = (users: any[]) => {
    for (const u of users ?? []) {
      if (!sampleObj) {
        sampleObj = u;
        sampleKeys = Object.keys(u ?? {});
        sampleDataKeys = Object.keys((u?.data ?? {}) ?? {});
      }

      const name = pickBanName(u);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const note = pickBanNote(u);
      const reason = pickBanReason(u);
      const raw = (note || reason || '').trim();

      out.push({ name, note, reason, raw });
      if (out.length >= limit) break;
    }
  };

  if (verbose) console.log('[banlist] fetchBannedUsers start', { hasPrivateFetch, limit });

  if (hasPrivateFetch) {
    let after: string | null = null;
    let loops = 0;

    while (out.length < limit && loops < 300) {
      loops++;

      // @ts-ignore
      const pageObj = await listing._fetch({
        subredditName,
        limit: Math.min(pageSize, Math.max(0, limit - out.length)),
        pageSize,
        after: after ?? undefined,
      });

      const users = extractChildren(pageObj);
      addUsers(users);

      const nextAfter: string | null =
        (typeof pageObj?.after === 'string' ? pageObj.after : null) ??
        (typeof pageObj?.data?.after === 'string' ? pageObj.data.after : null);

      if (!users || users.length === 0) break;
      if (nextAfter && nextAfter !== after) {
        after = nextAfter;
        continue;
      }
      if (users.length < pageSize) break;
      break;
    }

    if (verbose) console.log('[banlist] fetchBannedUsers done', { total: out.length, loops });
    return { rows: out, sampleObj, sampleKeys, sampleDataKeys };
  }

  // fallback: try listing children or .all()
  let users: any[] = extractChildren(listing);
  if ((!users || users.length === 0) && typeof listing?.all === 'function') {
    // @ts-ignore
    users = (await listing.all()) ?? [];
  }
  addUsers(users);

  if (verbose) console.log('[banlist] fetchBannedUsers done (fallback)', { total: out.length });
  return { rows: out, sampleObj, sampleKeys, sampleDataKeys };
}

// -------------------- Post editability helpers --------------------
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

async function canEditPost(reddit: RedditAPIClient, postId: string): Promise<{ ok: boolean; canEdit: boolean; reason?: string }> {
  try {
    const post = await reddit.getPostById(postId);
    const archivedRaw = (post as any)?.isArchived ?? (post as any)?.archived;
    const lockedRaw = (post as any)?.isLocked ?? (post as any)?.locked;
    const archived = toBoolStrict(archivedRaw);
    const locked = toBoolStrict(lockedRaw);
    if (archived) return { ok: true, canEdit: false, reason: 'archived' };
    if (locked) return { ok: true, canEdit: false, reason: 'locked' };
    return { ok: true, canEdit: true };
  } catch {
    return { ok: false, canEdit: false, reason: 'fetch_failed' };
  }
}

// -------------------- Scheduler control (avoid cron limit) --------------------
async function ensureSingleCronScheduled(ctx: Context, cfg: Config, snap: DebugSnapshot): Promise<void> {
  const sub = ctx.subredditName!;
  const cronKey = kvCronKey(sub, cfg.postIdKey);
  const jobKey = kvJobIdKey(sub, cfg.postIdKey);

  const prevCron = (await ctx.kvStore.get(cronKey)) ?? null;
  const prevJobId = (await ctx.kvStore.get(jobKey)) ?? null;

  snap.scheduler.prevCron = prevCron;
  snap.scheduler.prevJobId = prevJobId;

  if (!cfg.scheduleEnabled) {
    snap.scheduler.note.push('scheduleEnabled=false -> not scheduling');
    return;
  }

  // If unchanged and we have a jobId, do nothing.
  if (prevCron === cfg.scheduleCron && prevJobId) {
    snap.scheduler.note.push('cron unchanged + jobId exists -> not rescheduling');
    return;
  }

  // Cancel previous job if possible
  if (prevJobId && typeof (ctx.scheduler as any)?.cancelJob === 'function') {
    try {
      await (ctx.scheduler as any).cancelJob(prevJobId);
      snap.scheduler.note.push(`canceled previous jobId=${prevJobId}`);
    } catch (e: any) {
      snap.scheduler.note.push(`cancelJob failed (continuing): ${e?.message ?? String(e)}`);
    }
  }

  // Schedule new
  try {
    const newJobId = await ctx.scheduler.runJob({
      name: JOB_NAME_NEW,
      cron: cfg.scheduleCron,
      data: { idKey: cfg.postIdKey },
    } as any);

    const newJobIdStr = String(newJobId);
    await ctx.kvStore.put(jobKey, newJobIdStr);
    await ctx.kvStore.put(cronKey, cfg.scheduleCron);

    snap.scheduler.newJobId = newJobIdStr;
    snap.scheduler.note.push(`scheduled jobId=${newJobIdStr} cron=${cfg.scheduleCron}`);
  } catch (e: any) {
    const msg = e?.cause?.details ?? e?.message ?? String(e);
    snap.scheduler.error = msg;
    snap.scheduler.note.push(`schedule failed: ${msg}`);
  }
}

async function purgeOldCronsAndReschedule(ctx: Context, cfg: Config, snap: DebugSnapshot): Promise<string[]> {
  const sub = ctx.subredditName!;
  const jobKey = kvJobIdKey(sub, cfg.postIdKey);
  const cronKey = kvCronKey(sub, cfg.postIdKey);

  const canceled: string[] = [];
  const canList = typeof (ctx.scheduler as any)?.listJobs === 'function';
  const canCancel = typeof (ctx.scheduler as any)?.cancelJob === 'function';

  const storedJobId = (await ctx.kvStore.get(jobKey)) ?? null;
  if (canCancel && storedJobId) {
    try {
      await (ctx.scheduler as any).cancelJob(storedJobId);
      canceled.push(storedJobId);
      snap.scheduler.note.push(`purge canceled stored jobId=${storedJobId}`);
    } catch (e: any) {
      snap.scheduler.note.push(`purge cancel stored jobId failed: ${e?.message ?? String(e)}`);
    }
  }

  if (canList && canCancel) {
    try {
      const jobs = await (ctx.scheduler as any).listJobs();
      for (const j of jobs ?? []) {
        const isCron = typeof j?.cron === 'string' && j.cron.length > 0;
        const isOurName = j?.name === JOB_NAME_NEW || j?.name === JOB_NAME_LEGACY;
        if (!isCron || !isOurName) continue;

        // If data.idKey exists, match it; otherwise cancel anyway (best effort cleanup)
        const dataIdKey = j?.data?.idKey ? String(j.data.idKey) : null;
        if (dataIdKey && dataIdKey !== cfg.postIdKey) continue;

        try {
          const jid = String(j.id);
          await (ctx.scheduler as any).cancelJob(jid);
          canceled.push(jid);
        } catch {
          // ignore
        }
      }
      snap.scheduler.note.push(`purge listJobs canceled=${canceled.length}`);
    } catch (e: any) {
      snap.scheduler.note.push(`purge listJobs failed: ${e?.message ?? String(e)}`);
    }
  } else {
    snap.scheduler.note.push('purge: listJobs/cancelJob not available; only stored jobId attempted');
  }

  // Clear KV schedule tracking
  try { await ctx.kvStore.delete(jobKey); } catch {}
  try { await ctx.kvStore.delete(cronKey); } catch {}

  // Reschedule
  await ensureSingleCronScheduled(ctx, cfg, snap);

  return canceled;
}

// -------------------- Build rows --------------------
async function buildRows(ctx: Context, cfg: Config, snap: DebugSnapshot): Promise<Array<{ name: string; note: string; raw: string; label: string }>> {
  const sub = ctx.subredditName!;
  const verbose = cfg.debugVerbose;

  const fetched = await fetchBannedUsers(ctx, sub, cfg.banListLimit, verbose);
  const banned = fetched.rows;

  snap.bans.total = banned.length;
  snap.bans.sample = fetched.sampleObj ? [fetched.sampleObj] : [];
  snap.bans.sampleKeys = fetched.sampleKeys;
  snap.bans.sampleDataKeys = fetched.sampleDataKeys;

  let excludedByText = 0;
  let excludedByLabel = 0;

  const out: Array<{ name: string; note: string; raw: string; label: string }> = [];

  for (const u of banned) {
    const combinedText = `${u.note} ${u.reason}`.toLowerCase();
    const excludedText = cfg.excludeIfTextContains.some((needle) => needle && combinedText.includes(needle));
    if (excludedText) {
      excludedByText += 1;
      continue;
    }

    // bookmarklet-style: use NOTE; fallback to REASON
    const baseRaw = (u.note || u.reason || '').trim();
    const maybeMasked = cfg.maskUsernamesInNote ? maskUsernamesInsideNote(baseRaw) : baseRaw;

    const mapped = maybeMasked
      ? mapTextToLabel(maybeMasked, cfg.mappingRules, cfg.defaultLabel)
      : { label: cfg.defaultLabel, matched: false };

    const label = (mapped.label || cfg.defaultLabel).trim() || cfg.defaultLabel;
    const labelLower = label.toLowerCase();

    const excludedLabel = cfg.excludeIfMappedLabelIn.some((l) => l && l === labelLower);
    if (excludedLabel) {
      excludedByLabel += 1;
      continue;
    }

    out.push({ name: u.name, note: label, raw: baseRaw, label });
  }

  if (cfg.sortBy === 'note_asc') out.sort((a, b) => a.note.localeCompare(b.note));
  else out.sort((a, b) => a.name.localeCompare(b.name));

  snap.rows.excludedByText = excludedByText;
  snap.rows.excludedByLabel = excludedByLabel;

  snap.rows.sample = out.slice(0, 10).map((r) => ({ u: `u/${r.name}`, raw: r.raw, label: r.label }));

  return out;
}

// -------------------- Core run --------------------
async function runPublish(ctx: Context, actor: DebugSnapshot['actor'], mode: RunMode): Promise<{ rows: number; postId: string | null; action: string }> {
  const sub = ctx.subredditName;
  if (!sub) return { rows: 0, postId: null, action: 'no_subreddit' };

  const cfg = await getCfg(ctx);

  const snap: DebugSnapshot = {
    ts: new Date().toISOString(),
    subreddit: sub,
    idKey: cfg.postIdKey,
    actor,
    cfg: {
      scheduleEnabled: cfg.scheduleEnabled,
      scheduleCron: cfg.scheduleCron,
      banListLimit: cfg.banListLimit,
      maxRowsInPost: cfg.maxRowsInPost,
      excludeIfTextContains: cfg.excludeIfTextContains,
      excludeIfMappedLabelIn: cfg.excludeIfMappedLabelIn,
      mappingRulesCount: cfg.mappingRules.length,
      defaultLabel: cfg.defaultLabel,
      maskUsernamesInNote: cfg.maskUsernamesInNote,
      sortBy: cfg.sortBy,
      createNewOnEditFail: cfg.createNewOnEditFail,
      setNewPostAsActive: cfg.setNewPostAsActive,
    },
    bans: { total: 0, sample: [], sampleKeys: [], sampleDataKeys: [] },
    rows: { out: 0, excludedByText: 0, excludedByLabel: 0, sample: [] },
    post: { storedPostId: null, action: 'none', finalPostId: null },
    scheduler: { note: [], prevCron: null, prevJobId: null, newJobId: null, error: null },
  };

  if (cfg.debugVerbose) console.log('[banlist] runPublish', { actor, mode, sub, idKey: cfg.postIdKey });

  const built = await buildRows(ctx, cfg, snap);
  const rows = built.map((r) => ({ name: r.name, note: r.note }));
  snap.rows.out = rows.length;

  const body = buildMarkdown(sub, cfg.postTitle, rows, cfg.maxRowsInPost);

  const stored = await readStoredPostRef(ctx, cfg.postIdKey);
  snap.post.storedPostId = stored?.postId ?? null;

  // Create modes
  if (mode === 'create_new_and_set_active' || mode === 'create_new_no_change_active') {
    const created = await ctx.reddit.submitPost({ subredditName: sub, title: cfg.postTitle, text: body });
    snap.post.action = mode === 'create_new_and_set_active' ? 'created_set_active' : 'created_not_active';
    snap.post.finalPostId = created.id;

    if (mode === 'create_new_and_set_active') {
      await writeStoredPostRef(ctx, cfg.postIdKey, created.id);
    }

    await writeDebug(ctx, cfg.postIdKey, snap);
    return { rows: rows.length, postId: created.id, action: snap.post.action };
  }

  // Update existing only
  if (!stored?.postId) {
    // No stored post -> create and set active (always)
    const created = await ctx.reddit.submitPost({ subredditName: sub, title: cfg.postTitle, text: body });
    await writeStoredPostRef(ctx, cfg.postIdKey, created.id);
    snap.post.action = 'created_no_stored_active_set';
    snap.post.finalPostId = created.id;

    await writeDebug(ctx, cfg.postIdKey, snap);
    return { rows: rows.length, postId: created.id, action: snap.post.action };
  }

  // Try edit active post
  const editable = await canEditPost(ctx.reddit, stored.postId);
  if (!editable.canEdit) {
    if (!cfg.createNewOnEditFail) {
      snap.post.action = `skipped_not_editable_${editable.reason ?? 'unknown'}`;
      snap.post.finalPostId = stored.postId;
      await writeDebug(ctx, cfg.postIdKey, snap);
      return { rows: rows.length, postId: stored.postId, action: snap.post.action };
    }

    const created = await ctx.reddit.submitPost({ subredditName: sub, title: cfg.postTitle, text: body });
    snap.post.action = `created_on_uneditable_${editable.reason ?? 'unknown'}`;
    snap.post.finalPostId = created.id;

    if (cfg.setNewPostAsActive) await writeStoredPostRef(ctx, cfg.postIdKey, created.id);

    await writeDebug(ctx, cfg.postIdKey, snap);
    return { rows: rows.length, postId: created.id, action: snap.post.action };
  }

  try {
    const post = await ctx.reddit.getPostById(stored.postId);
    await post.edit({ text: body });

    snap.post.action = 'edited_active';
    snap.post.finalPostId = stored.postId;

    await writeDebug(ctx, cfg.postIdKey, snap);
    return { rows: rows.length, postId: stored.postId, action: snap.post.action };
  } catch (e: any) {
    const msg = e?.cause?.details ?? e?.message ?? String(e);
    snap.post.error = msg;

    if (!cfg.createNewOnEditFail) {
      snap.post.action = 'edit_failed_no_fallback';
      snap.post.finalPostId = stored.postId;
      await writeDebug(ctx, cfg.postIdKey, snap);
      return { rows: rows.length, postId: stored.postId, action: snap.post.action };
    }

    const created = await ctx.reddit.submitPost({ subredditName: sub, title: cfg.postTitle, text: body });
    snap.post.action = 'edit_failed_created_fallback';
    snap.post.finalPostId = created.id;

    if (cfg.setNewPostAsActive) await writeStoredPostRef(ctx, cfg.postIdKey, created.id);

    await writeDebug(ctx, cfg.postIdKey, snap);
    return { rows: rows.length, postId: created.id, action: snap.post.action };
  }
}

// -------------------- Scheduler jobs --------------------
Devvit.addSchedulerJob({
  name: JOB_NAME_NEW,
  onRun: async (_event, ctx) => {
    try {
      await runPublish(ctx, 'cron', 'update_existing_only');
    } catch (e: any) {
      console.log('[banlist] cron run failed (swallowed)', e?.message ?? String(e));
    }
  },
});

// Legacy handler to prevent "Job not found" spam from older scheduled jobs
Devvit.addSchedulerJob({
  name: JOB_NAME_LEGACY,
  onRun: async (_event, ctx) => {
    try {
      await runPublish(ctx, 'cron', 'update_existing_only');
    } catch (e: any) {
      console.log('[banlist] legacy cron run failed (swallowed)', e?.message ?? String(e));
    }
  },
});

// -------------------- Install/Upgrade trigger (never fail install) --------------------
Devvit.addTrigger({
  events: ['AppInstall', 'AppUpgrade'],
  onEvent: async (_event, ctx) => {
    const sub = ctx.subredditName;
    if (!sub) return;

    const snap: DebugSnapshot = {
      ts: new Date().toISOString(),
      subreddit: sub,
      idKey: 'unknown',
      actor: 'install_or_upgrade',
      cfg: {},
      bans: { total: 0, sample: [], sampleKeys: [], sampleDataKeys: [] },
      rows: { out: 0, excludedByText: 0, excludedByLabel: 0, sample: [] },
      post: { storedPostId: null, action: 'install', finalPostId: null },
      scheduler: { note: [], prevCron: null, prevJobId: null, newJobId: null, error: null },
    };

    try {
      const cfg = await getCfg(ctx);
      snap.idKey = cfg.postIdKey;
      snap.cfg = { scheduleEnabled: cfg.scheduleEnabled, scheduleCron: cfg.scheduleCron };

      // Best-effort schedule only; don't generate posts here.
      await ensureSingleCronScheduled(ctx, cfg, snap);

      await writeDebug(ctx, cfg.postIdKey, snap);
    } catch (e: any) {
      // Swallow anything so installation doesn't fail
      snap.scheduler.error = e?.message ?? String(e);
      snap.scheduler.note.push('install trigger error swallowed');
      try { await writeDebug(ctx, snap.idKey === 'unknown' ? 'banned-users-list' : snap.idKey, snap); } catch {}
      console.log('[banlist] install/upgrade failed (swallowed)', e?.message ?? String(e));
    }
  },
});

// -------------------- Menu items --------------------

Devvit.addMenuItem({
  label: 'Ban List: Debug dump banned user payloads (first 10)',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, ctx) => {
    try {
      const cfg = await getCfg(ctx);
      const sub = ctx.subredditName!;
      const fetched = await fetchBannedUsers(ctx, sub, Math.min(1000, cfg.banListLimit), cfg.debugVerbose);

      const banned = fetched.rows;
      const limit = Math.min(10, banned.length);

      for (let i = 0; i < limit; i++) {
        const u = banned[i];
        const baseRaw = (u.note || u.reason || '').trim();
        const maybeMasked = cfg.maskUsernamesInNote ? maskUsernamesInsideNote(baseRaw) : baseRaw;

        const mapped = maybeMasked
          ? mapTextToLabel(maybeMasked, cfg.mappingRules, cfg.defaultLabel)
          : { label: cfg.defaultLabel, matched: false };

        const combinedText = `${u.note} ${u.reason}`.toLowerCase();
        const excludedByText = cfg.excludeIfTextContains.some((needle) => needle && combinedText.includes(needle));
        const excludedByLabel = cfg.excludeIfMappedLabelIn.some((l) => l && l === (mapped.label || cfg.defaultLabel).toLowerCase());

        logBanUserDebug(
          banned[i],
          i,
          { name: u.name, note: u.note, reason: u.reason, raw: baseRaw },
          mapped,
          { byText: excludedByText, byLabel: excludedByLabel },
          { maskUsernamesInNote: cfg.maskUsernamesInNote }
        );
      }

      ctx.ui.showToast(`Dumped ${limit} banned user payloads to console.`);
    } catch (e: any) {
      ctx.ui.showToast(`Dump failed: ${e?.message ?? String(e)}`);
    }
  },
});

Devvit.addMenuItem({
  label: 'Ban List: Update active post (safe)',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, ctx) => {
    try {
      const res = await runPublish(ctx, 'manual', 'update_existing_only');
      ctx.ui.showToast(`Done: ${res.action}. Rows=${res.rows}`);
    } catch (e: any) {
      ctx.ui.showToast(`Update failed: ${e?.message ?? String(e)}`);
    }
  },
});

Devvit.addMenuItem({
  label: 'Ban List: Create NEW post (set active)',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, ctx) => {
    try {
      const res = await runPublish(ctx, 'manual', 'create_new_and_set_active');
      ctx.ui.showToast(`Created new active post. Rows=${res.rows}`);
    } catch (e: any) {
      ctx.ui.showToast(`Create failed: ${e?.message ?? String(e)}`);
    }
  },
});

Devvit.addMenuItem({
  label: 'Ban List: Create NEW post (do NOT set active)',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, ctx) => {
    try {
      const res = await runPublish(ctx, 'manual', 'create_new_no_change_active');
      ctx.ui.showToast(`Created post (not active). Rows=${res.rows}`);
    } catch (e: any) {
      ctx.ui.showToast(`Create failed: ${e?.message ?? String(e)}`);
    }
  },
});

Devvit.addMenuItem({
  label: 'Ban List: Refresh schedule (only if needed)',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, ctx) => {
    try {
      const cfg = await getCfg(ctx);
      const sub = ctx.subredditName!;
      const snap: DebugSnapshot = {
        ts: new Date().toISOString(),
        subreddit: sub,
        idKey: cfg.postIdKey,
        actor: 'schedule_action',
        cfg: { scheduleEnabled: cfg.scheduleEnabled, scheduleCron: cfg.scheduleCron },
        bans: { total: 0, sample: [], sampleKeys: [], sampleDataKeys: [] },
        rows: { out: 0, excludedByText: 0, excludedByLabel: 0, sample: [] },
        post: { storedPostId: (await readStoredPostRef(ctx, cfg.postIdKey))?.postId ?? null, action: 'schedule_refresh', finalPostId: null },
        scheduler: { note: [], prevCron: null, prevJobId: null, newJobId: null, error: null },
      };

      await ensureSingleCronScheduled(ctx, cfg, snap);
      await writeDebug(ctx, cfg.postIdKey, snap);

      if (snap.scheduler.error) ctx.ui.showToast(`Schedule error: ${snap.scheduler.error}`);
      else ctx.ui.showToast('Schedule OK (or unchanged).');
    } catch (e: any) {
      ctx.ui.showToast(`Schedule refresh failed: ${e?.message ?? String(e)}`);
    }
  },
});

Devvit.addMenuItem({
  label: 'Ban List: PURGE old crons + reschedule',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, ctx) => {
    try {
      const cfg = await getCfg(ctx);
      const sub = ctx.subredditName!;
      const snap: DebugSnapshot = {
        ts: new Date().toISOString(),
        subreddit: sub,
        idKey: cfg.postIdKey,
        actor: 'schedule_action',
        cfg: { scheduleEnabled: cfg.scheduleEnabled, scheduleCron: cfg.scheduleCron },
        bans: { total: 0, sample: [], sampleKeys: [], sampleDataKeys: [] },
        rows: { out: 0, excludedByText: 0, excludedByLabel: 0, sample: [] },
        post: { storedPostId: (await readStoredPostRef(ctx, cfg.postIdKey))?.postId ?? null, action: 'schedule_purge', finalPostId: null },
        scheduler: { note: [], prevCron: null, prevJobId: null, newJobId: null, error: null },
      };

      const canceled = await purgeOldCronsAndReschedule(ctx, cfg, snap);
      await writeDebug(ctx, cfg.postIdKey, snap);

      if (snap.scheduler.error) ctx.ui.showToast(`Purge done. Canceled ${canceled.length}. Schedule error: ${snap.scheduler.error}`);
      else ctx.ui.showToast(`Purge done. Canceled ${canceled.length}. Scheduled OK (or unchanged).`);
    } catch (e: any) {
      ctx.ui.showToast(`Purge failed: ${e?.message ?? String(e)}`);
    }
  },
});

Devvit.addMenuItem({
  label: 'Ban List: Debug (show last snapshot)',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, ctx) => {
    try {
      const cfg = await getCfg(ctx);
      const snap = await readDebug(ctx, cfg.postIdKey);
      if (!snap) {
        ctx.ui.showToast('No debug snapshot yet.');
        return;
      }
      console.log('[banlist] DEBUG SNAPSHOT:\n' + JSON.stringify(snap, null, 2));
      ctx.ui.showToast(`Debug printed. bans=${snap.bans.total} rows=${snap.rows.out}`);
    } catch (e: any) {
      ctx.ui.showToast(`Debug failed: ${e?.message ?? String(e)}`);
    }
  },
});

// -------------------- Capabilities --------------------
Devvit.configure({
  redditAPI: true,
  kvStore: true,
  scheduler: true,
});

export default Devvit;
