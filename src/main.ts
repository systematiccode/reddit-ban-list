import { Devvit, Context, RedditAPIClient } from '@devvit/public-api';

const JOB_POST = 'banlist_post_update';
const JOB_POST_LEGACY = 'simple_banned_list_update';

const KV_POST_PREFIX = 'banlist_post:';
const KV_CRON_PREFIX = 'banlist_cron:';
const KV_JOBID_PREFIX = 'banlist_jobid:';
const KV_DEBUG_PREFIX = 'banlist_debug:';

const KV_DB_INDEX_PREFIX = 'banlist_db_index:';
const KV_DB_USER_PREFIX = 'banlist_db_user:';
const KV_IMPORT_STATUS_PREFIX = 'banlist_import_status:';

type ModNoteType =
  | 'BAN'
  | 'NOTE'
  | 'APPROVAL'
  | 'REMOVAL'
  | 'MUTE'
  | 'INVITE'
  | 'SPAM'
  | 'CONTENT_CHANGE'
  | 'MOD_ACTION'
  | 'ALL';

type MappingRule = { label: string; keywords: string[] };
type OutputSort = 'reason_asc' | 'user_asc';

type Config = {
  postTitle: string;
  postIdKey: string;

  postScheduleEnabled: boolean;
  postScheduleCron: string;

  maxRowsInPost: number;

  excludeIfTextContains: string[];
  excludeIfMappedLabelIn: string[];

  mappingRules: MappingRule[];
  defaultLabel: string;

  sortBy: OutputSort;

  createNewOnEditFail: boolean;
  setNewPostAsActive: boolean;

  debugVerbose: boolean;

  modLogLookupLimit: number;
  modLogMatchWindowSeconds: number;

  modNotesLookupLimit: number;

  footerEnabled: boolean;
  footerText: string;
  footerLink: string;
  footerLinkLabel: string;

  postOnlyMappedReasons: boolean;
};

type StoredPostRef = { postId: string; updatedAt: string; idKey: string };

type BanRecord = {
  u: string;
  reason: string;
  raw?: string;
  updatedAt: string;
};

type ImportStatus = {
  lastImportedAt?: string;
  lastImportedUser?: string;
  totalImported?: number;
  totalSkipped?: number;
  lastChunkTotal?: number;
  lastChunkImported?: number;
  lastChunkSkipped?: number;
};

type DebugSnapshot = {
  ts: string;
  subreddit: string;
  idKey: string;
  actor:
    | 'cron_post'
    | 'manual_post'
    | 'install_or_upgrade'
    | 'schedule_action'
    | 'import'
    | 'db_clear'
    | 'mod_action';
  cfg: Record<string, any>;
  db: { total: number; sample: Array<{ u: string; reason: string }> };
  import?: ImportStatus;
  modAction: {
    action?: string | null;
    targetUser?: string | null;
    isPermanent?: boolean | null;
    raw?: string | null;
    mapped?: string | null;
    skippedByText?: boolean;
    skippedByLabel?: boolean;
    note: string[];
    error?: string | null;
  };
  post: {
    storedPostId?: string | null;
    action: string;
    finalPostId?: string | null;
    error?: string;
  };
  scheduler: {
    note: string[];
    prevCron?: string | null;
    prevJobId?: string | null;
    newJobId?: string | null;
    error?: string | null;
  };
};

Devvit.addSettings([
  {
    type: 'group',
    label: 'Posting',
    fields: [
      { type: 'string', name: 'postTitle', label: 'Post title', defaultValue: 'Banned Users List (Auto-updated)' },
      { type: 'string', name: 'postIdKey', label: 'Post key (tracks which post to update)', defaultValue: 'banned-users-list' },
      { type: 'number', name: 'maxRowsInPost', label: 'Max rows in post (avoid size limits)', defaultValue: 2000 },
      { type: 'string', name: 'sortBy', label: 'Sort: "reason_asc" or "user_asc"', defaultValue: 'reason_asc' },
      { type: 'boolean', name: 'postOnlyMappedReasons', label: 'Only include mapped reasons (exclude default/unmapped)', defaultValue: false },
    ],
  },

  {
    type: 'group',
    label: 'Scheduler',
    fields: [
      { type: 'boolean', name: 'postScheduleEnabled', label: 'Enable post update schedule', defaultValue: true },
      { type: 'string', name: 'postScheduleCron', label: 'Post update cron (UNIX cron)', defaultValue: '*/30 * * * *' },
      { type: 'boolean', name: 'createNewOnEditFail', label: 'If editing active post fails, create a new post', defaultValue: true },
      { type: 'boolean', name: 'setNewPostAsActive', label: 'When creating a new post, set it as active', defaultValue: true },
    ],
  },

  {
    type: 'group',
    label: 'Mapping & Filtering',
    fields: [
      { type: 'string', name: 'excludeIfTextContains', label: 'Exclude if text contains', defaultValue: 'usl ban:,usl ban from,usl ban' },
      { type: 'string', name: 'excludeIfMappedLabelIn', label: 'Exclude if mapped label is', defaultValue: 'USL Ban' },
      { type: 'string', name: 'mappingJson', label: 'Mapping rules JSON', defaultValue: '[]' },
      { type: 'string', name: 'defaultLabel', label: 'Default label if no mapping match', defaultValue: 'Banned' },
    ],
  },

  {
    type: 'group',
    label: 'Footer',
    fields: [
      { type: 'boolean', name: 'footerEnabled', label: 'Enable footer note', defaultValue: true },
      { type: 'string', name: 'footerText', label: 'Footer text (markdown allowed)', defaultValue: 'If any issues with bot contact u/raypogo. If any issues with ban list, contact the mods.' },
      { type: 'string', name: 'footerLink', label: 'Footer link (optional)', defaultValue: '' },
      { type: 'string', name: 'footerLinkLabel', label: 'Footer link label (optional)', defaultValue: 'More info' },
    ],
  },

  {
    type: 'group',
    label: 'Reason Sources',
    fields: [
      { type: 'number', name: 'modLogLookupLimit', label: 'Modlog lookup limit per ban', defaultValue: 50 },
      { type: 'number', name: 'modLogMatchWindowSeconds', label: 'Modlog match time window (seconds)', defaultValue: 600 },
      { type: 'number', name: 'modNotesLookupLimit', label: 'Mod notes lookup limit per ban', defaultValue: 5 },
    ],
  },

  {
    type: 'group',
    label: 'Debug',
    fields: [
      { type: 'boolean', name: 'debugVerbose', label: 'Verbose logs', defaultValue: true },
    ],
  },
]);

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

  const postScheduleEnabled = Boolean(await ctx.settings.get('postScheduleEnabled'));
  const postScheduleCron = String((await ctx.settings.get('postScheduleCron')) ?? '*/30 * * * *');

  const maxRowsInPost = Math.min(5000, Math.max(1, Number((await ctx.settings.get('maxRowsInPost')) ?? 2000) || 2000));

  const excludeIfTextContains = parseCsvLower(String((await ctx.settings.get('excludeIfTextContains')) ?? ''));
  const excludeIfMappedLabelIn = parseCsvLower(String((await ctx.settings.get('excludeIfMappedLabelIn')) ?? ''));

  const mappingJson = String((await ctx.settings.get('mappingJson')) ?? '[]');
  const mappingRules = safeParseMappings(mappingJson);

  const defaultLabel = String((await ctx.settings.get('defaultLabel')) ?? 'Banned').trim() || 'Banned';

  const sortByRaw = String((await ctx.settings.get('sortBy')) ?? 'reason_asc').trim().toLowerCase();
  const sortBy: OutputSort = sortByRaw === 'user_asc' ? 'user_asc' : 'reason_asc';

  const createNewOnEditFail = Boolean(await ctx.settings.get('createNewOnEditFail'));
  const setNewPostAsActive = Boolean(await ctx.settings.get('setNewPostAsActive'));

  const debugVerbose = Boolean(await ctx.settings.get('debugVerbose'));

  const modLogLookupLimit = Math.min(100, Math.max(1, Number((await ctx.settings.get('modLogLookupLimit')) ?? 50) || 50));
  const modLogMatchWindowSeconds = Math.min(3600, Math.max(30, Number((await ctx.settings.get('modLogMatchWindowSeconds')) ?? 600) || 600));
  const modNotesLookupLimit = Math.min(25, Math.max(1, Number((await ctx.settings.get('modNotesLookupLimit')) ?? 5) || 5));

  const footerEnabled = Boolean(await ctx.settings.get('footerEnabled'));
  
  const footerText = String((await ctx.settings.get('footerText')) ?? '');
  const footerLink = String((await ctx.settings.get('footerLink')) ?? '');
  const footerLinkLabel = String((await ctx.settings.get('footerLinkLabel')) ?? 'More info');

  const postOnlyMappedReasons = Boolean(await ctx.settings.get('postOnlyMappedReasons'));

    return {
    postTitle,
    postIdKey,
    postScheduleEnabled,
    postScheduleCron,
    maxRowsInPost,
    excludeIfTextContains,
    excludeIfMappedLabelIn,
    mappingRules,
    defaultLabel,
    sortBy,
    createNewOnEditFail,
    setNewPostAsActive,
    debugVerbose,

    footerEnabled,
    footerText,
    footerLink,
    footerLinkLabel,
    postOnlyMappedReasons,

    modLogLookupLimit,
    modLogMatchWindowSeconds,
    modNotesLookupLimit,
  };
}

function kvPostKey(sub: string, idKey: string): string {
  return `${KV_POST_PREFIX}${sub}:${idKey}`;
}
function kvCronKey(sub: string, idKey: string): string {
  return `${KV_CRON_PREFIX}${sub}:${idKey}:post`;
}
function kvJobIdKey(sub: string, idKey: string): string {
  return `${KV_JOBID_PREFIX}${sub}:${idKey}:post`;
}
function kvDebugKey(sub: string, idKey: string): string {
  return `${KV_DEBUG_PREFIX}${sub}:${idKey}`;
}
function kvDbIndexKey(sub: string): string {
  return `${KV_DB_INDEX_PREFIX}${sub}`;
}
function kvDbUserKey(sub: string, uLower: string): string {
  return `${KV_DB_USER_PREFIX}${sub}:${uLower}`;
}
function kvImportStatusKey(sub: string): string {
  return `${KV_IMPORT_STATUS_PREFIX}${sub}`;
}

async function writeDebug(ctx: Context, idKey: string, snap: DebugSnapshot): Promise<void> {
  const sub = ctx.subredditName!;
  try {
    await ctx.kvStore.put(kvDebugKey(sub, idKey), JSON.stringify(snap, null, 2));
  } catch {}
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

function escapeMd(s: string): string {
  return String(s ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

function mapTextToLabel(text: string, rules: MappingRule[], defaultLabel: string): { label: string; matched: boolean } {
  const t = String(text ?? '').toLowerCase();
  for (const rule of rules) {
    if (rule.keywords.some((kw) => kw && t.includes(kw))) return { label: rule.label, matched: true };
  }
  return { label: defaultLabel, matched: false };
}

function normalizeReason(
  raw: string,
  cfg: Config
): { reason: string; skippedByText: boolean; skippedByLabel: boolean; mappedLabel: string } {
  const rawText = String(raw ?? '').trim();
  const combinedLower = rawText.toLowerCase();

  const skippedByText = cfg.excludeIfTextContains.some((needle) => needle && combinedLower.includes(needle));
  if (skippedByText) return { reason: '', skippedByText: true, skippedByLabel: false, mappedLabel: '' };

  const mapped = rawText
    ? mapTextToLabel(rawText, cfg.mappingRules, cfg.defaultLabel)
    : { label: cfg.defaultLabel, matched: false };

  const label = String(mapped.label || cfg.defaultLabel).trim() || cfg.defaultLabel;

  const skippedByLabel = cfg.excludeIfMappedLabelIn.some((l) => l && l === label.toLowerCase());
  if (skippedByLabel) return { reason: '', skippedByText: false, skippedByLabel: true, mappedLabel: label };

  return { reason: label, skippedByText: false, skippedByLabel: false, mappedLabel: label };
}

function formatTorontoTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

async function iterateListingFirstString(listing: any, extractor: (x: any) => string): Promise<string> {
  if (!listing) return '';
  try {
    if (typeof listing?.all === 'function') {
      const items = await listing.all();
      for (const item of items ?? []) {
        const v = extractor(item);
        if (v) return v;
      }
      return '';
    }
    if (typeof listing?.[Symbol.asyncIterator] === 'function') {
      for await (const item of listing) {
        const v = extractor(item);
        if (v) return v;
      }
      return '';
    }
    const children = listing?.data?.children ?? listing?.children;
    if (Array.isArray(children)) {
      for (const item of children) {
        const v = extractor(item);
        if (v) return v;
      }
    }
  } catch {}
  return '';
}

// ---------------- KV DB ----------------
async function dbReadIndex(ctx: Context): Promise<string[]> {
  const sub = ctx.subredditName!;
  const raw = await ctx.kvStore.get(kvDbIndexKey(sub));
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map((x: any) => String(x ?? '')).filter(Boolean);
  } catch {
    return [];
  }
}

async function dbWriteIndex(ctx: Context, users: string[]): Promise<void> {
  const sub = ctx.subredditName!;
  const uniq = Array.from(new Set(users.map((u) => String(u).trim()).filter(Boolean)));
  uniq.sort((a, b) => a.localeCompare(b));
  await ctx.kvStore.put(kvDbIndexKey(sub), JSON.stringify(uniq));
}

async function dbUpsert(ctx: Context, username: string, reason: string, raw?: string): Promise<void> {
  const sub = ctx.subredditName!;
  const u = String(username ?? '').trim().replace(/^u\//i, '');
  if (!u) return;
  const uLower = u.toLowerCase();

  const finalReason = String(reason ?? '').trim() || 'Banned';

  const rec: BanRecord = {
    u,
    reason: finalReason,
    raw: raw ? String(raw).trim() : undefined,
    updatedAt: new Date().toISOString(),
  };

  await ctx.kvStore.put(kvDbUserKey(sub, uLower), JSON.stringify(rec));

  const idx = await dbReadIndex(ctx);
  if (!idx.some((x) => x.toLowerCase() === uLower)) {
    idx.push(u);
    await dbWriteIndex(ctx, idx);
  }
}

async function dbDelete(ctx: Context, username: string): Promise<void> {
  const sub = ctx.subredditName!;
  const u = String(username ?? '').trim().replace(/^u\//i, '');
  if (!u) return;
  const uLower = u.toLowerCase();

  try {
    await ctx.kvStore.delete(kvDbUserKey(sub, uLower));
  } catch {}

  const idx = await dbReadIndex(ctx);
  const next = idx.filter((x) => x.toLowerCase() !== uLower);
  if (next.length !== idx.length) await dbWriteIndex(ctx, next);
}

async function dbReadAll(ctx: Context): Promise<BanRecord[]> {
  const sub = ctx.subredditName!;
  const idx = await dbReadIndex(ctx);
  const out: BanRecord[] = [];
  for (const u of idx) {
    const raw = await ctx.kvStore.get(kvDbUserKey(sub, u.toLowerCase()));
    if (!raw) continue;
    try {
      const rec = JSON.parse(raw) as BanRecord;
      if (rec?.u) out.push(rec);
    } catch {}
  }
  return out;
}

async function dbClearAll(ctx: Context): Promise<{ deletedUsers: number }> {
  const sub = ctx.subredditName!;
  const idx = await dbReadIndex(ctx);

  let deletedUsers = 0;
  for (const u of idx) {
    const uLower = String(u ?? '').toLowerCase();
    if (!uLower) continue;
    try {
      await ctx.kvStore.delete(kvDbUserKey(sub, uLower));
      deletedUsers++;
    } catch {}
  }

  try {
    await ctx.kvStore.delete(kvDbIndexKey(sub));
  } catch {}

  return { deletedUsers };
}

// ---------------- Import status ----------------
async function readImportStatus(ctx: Context): Promise<ImportStatus> {
  const sub = ctx.subredditName!;
  const raw = await ctx.kvStore.get(kvImportStatusKey(sub));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ImportStatus;
  } catch {
    return {};
  }
}

async function writeImportStatus(ctx: Context, patch: ImportStatus): Promise<void> {
  const sub = ctx.subredditName!;
  const prev = await readImportStatus(ctx);
  const next: ImportStatus = {
    ...prev,
    ...patch,
    totalImported: (prev.totalImported ?? 0) + (patch.lastChunkImported ?? 0),
    totalSkipped: (prev.totalSkipped ?? 0) + (patch.lastChunkSkipped ?? 0),
  };
  await ctx.kvStore.put(kvImportStatusKey(sub), JSON.stringify(next));
}

// ---------------- Markdown ----------------
function buildMarkdownFromDb(
  sub: string,
  title: string,
  rows: Array<{ u: string; reason: string }>,
  maxRows: number,
  cfg: Config
): string {
  const updatedIso = new Date().toISOString();
  const updated = formatTorontoTime(updatedIso);

  const header =
    `# ${escapeMd(title)}\n\n` +
    `**Subreddit:** r/${escapeMd(sub)}\n` +
    `**Last updated:** ${escapeMd(updated)}\n\n`;

  if (!rows.length) {
    let out = `${header}_No entries in DB yet._`;
    out += buildFooter(cfg);
    return out;
  }

  const MAX_BODY_CHARS = 39000;
  let out = header + `| Name | Reason |\n|------|--------|\n`;

  let added = 0;
  let truncated = false;

  for (const r of rows.slice(0, maxRows)) {
    const line = `| u/${escapeMd(r.u)} | ${escapeMd(r.reason)} |\n`;
    if (out.length + line.length + 400 > MAX_BODY_CHARS) {
      truncated = true;
      break;
    }
    out += line;
    added++;
  }

  if (truncated) out += `\n_Truncated to ${added} rows due to Reddit post size limits._\n`;

  out += buildFooter(cfg);
  return out;
}

function buildFooter(cfg: any): string {
  if (!cfg?.footerEnabled) return '';

  let out = `\n---\n`;

  const text = String(cfg.footerText ?? '').trim();
  if (text) out += `${text}\n`;

  const link = String(cfg.footerLink ?? '').trim();
  const label = String(cfg.footerLinkLabel ?? 'More info').trim() || 'More info';
  if (link) out += `\n[${escapeMd(label)}](${link})\n`;
  return out;
}

// ---------------- Post editability ----------------
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

// ---------------- Scheduler control ----------------
async function ensureSinglePostCronScheduled(ctx: Context, cfg: Config, snap: DebugSnapshot): Promise<void> {
  const sub = ctx.subredditName!;
  const cronKey = kvCronKey(sub, cfg.postIdKey);
  const jobKey = kvJobIdKey(sub, cfg.postIdKey);

  const prevCron = (await ctx.kvStore.get(cronKey)) ?? null;
  const prevJobId = (await ctx.kvStore.get(jobKey)) ?? null;

  snap.scheduler.prevCron = prevCron;
  snap.scheduler.prevJobId = prevJobId;

  if (!cfg.postScheduleEnabled) {
    snap.scheduler.note.push('postScheduleEnabled=false');
    return;
  }

  if (prevCron === cfg.postScheduleCron && prevJobId) {
    snap.scheduler.note.push('post cron unchanged');
    return;
  }

  if (prevJobId && typeof (ctx.scheduler as any)?.cancelJob === 'function') {
    try {
      await (ctx.scheduler as any).cancelJob(prevJobId);
      snap.scheduler.note.push(`canceled post jobId=${prevJobId}`);
    } catch (e: any) {
      snap.scheduler.note.push(`cancelJob failed: ${e?.message ?? String(e)}`);
    }
  }

  try {
    const newJobId = await ctx.scheduler.runJob({
      name: JOB_POST,
      cron: cfg.postScheduleCron,
      data: { idKey: cfg.postIdKey },
    } as any);

    const newJobIdStr = String(newJobId);
    await ctx.kvStore.put(jobKey, newJobIdStr);
    await ctx.kvStore.put(cronKey, cfg.postScheduleCron);

    snap.scheduler.newJobId = newJobIdStr;
    snap.scheduler.note.push(`scheduled post jobId=${newJobIdStr} cron=${cfg.postScheduleCron}`);
  } catch (e: any) {
    const msg = e?.cause?.details ?? e?.message ?? String(e);
    snap.scheduler.error = msg;
    snap.scheduler.note.push(`schedule failed: ${msg}`);
  }
}

// ---------------- Modlog + Modnotes ----------------
function extractTargetUserFromEvent(ev: any): string {
  return String(ev?.targetUser?.name ?? '').trim();
}

function actionedAtMs(ev: any): number {
  const s = String(ev?.actionedAt ?? '').trim();
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : Date.now();
}

function modlogTargetUsername(item: any): string {
  return String(
    item?.targetUser?.name ??
      item?.targetAuthor?.name ??
      item?.target?.author ??
      item?.target?.name ??
      item?.target ??
      ''
  ).trim();
}

function extractReasonFromModlog(item: any): string {
  return String(item?.description ?? '').trim();
}

function extractDetailsFromModlog(item: any): string {
  return String(item?.details ?? '').trim();
}

function looksTemporaryFromText(text: string): boolean {
  const t = String(text ?? '').toLowerCase();
  if (!t) return false;
  if (/\btemporary\b/.test(t)) return true;
  if (/\b\d+\s*(day|days|week|weeks|month|months)\b/.test(t)) return true;
  if (/\bfor\s+\d+\b/.test(t) && /\b(day|days|week|weeks|month|months)\b/.test(t)) return true;
  return false;
}

function looksPermanentFromText(text: string): boolean {
  const t = String(text ?? '').toLowerCase();
  if (!t) return false;
  if (/\bpermanent\b/.test(t)) return true;
  if (/\bperm\b/.test(t)) return true;
  return false;
}

function isPermanentFromModlog(item: any): boolean {
  const details = extractDetailsFromModlog(item);
  const t = String(details ?? '').toLowerCase().trim();

  if (!t) return true; // default to permanent

  if (looksTemporaryFromText(t)) return false;

  if (looksPermanentFromText(t)) return true;

  return true; // unknown wording → assume permanent
}

async function fetchLatestBanModlogEntry(
  ctx: Context,
  subredditName: string,
  userName: string,
  actedAt: number,
  cfg: Config
): Promise<any | null> {
  const targetLower = userName.toLowerCase();
  const windowMs = cfg.modLogMatchWindowSeconds * 1000;

  let listing: any;
  try {
    listing = await (ctx.reddit as any).getModerationLog({
      subredditName,
      type: 'banuser',
      limit: cfg.modLogLookupLimit,
    });
  } catch {
    return null;
  }

  const score = (item: any) => {
    const ts =
      Date.parse(String(item?.actionedAt ?? '')) ||
      Date.parse(String(item?.createdAt ?? '')) ||
      Date.parse(String(item?.created ?? '')) ||
      actedAt;
    const delta = Math.abs(ts - actedAt);
    return delta <= windowMs ? delta : Number.POSITIVE_INFINITY;
  };

  let best: any | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  try {
    if (typeof listing?.all === 'function') {
      const items = await listing.all();
      for (const item of items ?? []) {
        const t = modlogTargetUsername(item);
        if (!t || t.toLowerCase() !== targetLower) continue;
        const s = score(item);
        if (s < bestScore) {
          bestScore = s;
          best = item;
        }
      }
    } else if (typeof listing?.[Symbol.asyncIterator] === 'function') {
      for await (const item of listing) {
        const t = modlogTargetUsername(item);
        if (!t || t.toLowerCase() !== targetLower) continue;
        const s = score(item);
        if (s < bestScore) {
          bestScore = s;
          best = item;
        }
      }
    }
  } catch {}

  if (!best || !Number.isFinite(bestScore)) return null;
  return best;
}

function extractNoteFromModNoteEntry(n: any): string {
  const candidates = [
    n?.note,
    n?.text,
    n?.body,
    n?.description,
    n?.userNote?.note,
    n?.userNote?.text,
    n?.userNote?.body,
    n?.userNote?.description,
    n?.label,
    n?.userNote?.label,
  ];
  for (const c of candidates) {
    const s = String(c ?? '').trim();
    if (s) return s;
  }
  return '';
}

async function fetchLatestModNoteText(
  reddit: RedditAPIClient,
  subredditName: string,
  username: string,
  limit: number,
  verbose: boolean,
  filter: ModNoteType = 'BAN'
): Promise<{ note: string; filterUsed: ModNoteType | null; error?: string }> {
  const sub = String(subredditName ?? '').trim().replace(/^r\//i, '');
  const user = String(username ?? '').trim().replace(/^u\//i, '');

  if (!sub || !user) return { note: '', filterUsed: null };

  const read = async (f: ModNoteType) => {
    const opts: any = {
      subreddit: sub,
      user,
      filter: f,
      limit: Math.max(1, limit),
    };

    if (verbose) console.log('[banlist] getModNotes req:', JSON.stringify(opts));

    // @ts-ignore
    const listing = await (reddit as any).getModNotes(opts);
    return await iterateListingFirstString(listing, (x) => extractNoteFromModNoteEntry(x));
  };

  try {
    const primary = String(await read(filter)).trim();
    if (primary) return { note: primary, filterUsed: filter };

    if (filter !== 'ALL') {
      const fallback = String(await read('ALL')).trim();
      if (fallback) return { note: fallback, filterUsed: 'ALL' };
    }

    return { note: '', filterUsed: null };
  } catch (e: any) {
    const msg = e?.cause?.details ?? e?.message ?? String(e);
    if (msg.includes('USER_DOESNT_EXIST')) {
      if (verbose) console.log('[banlist] getModNotes: USER_DOESNT_EXIST');
      return { note: '', filterUsed: null };
    }
    return { note: '', filterUsed: null, error: msg };
  }
}

async function fetchBanReason(
  ctx: Context,
  subredditName: string,
  username: string,
  actedMs: number,
  cfg: Config,
  snap?: DebugSnapshot
): Promise<{ rawReason: string; isPermanent: boolean | null; source: 'modlog' | 'modnotes' | 'none'; modlog?: any | null }> {
  const user = String(username ?? '').trim().replace(/^u\//i, '');
  if (!user) return { rawReason: '', isPermanent: null, source: 'none', modlog: null };

  const modlog = await fetchLatestBanModlogEntry(ctx, subredditName, user, actedMs, cfg);

  if (modlog) {
    const isPermanent = isPermanentFromModlog(modlog);
    if (isPermanent === false) {
      snap?.modAction.note.push('temp_ban_ignored');
      return { rawReason: '', isPermanent: false, source: 'none', modlog };
    }

    const reason = extractReasonFromModlog(modlog); // uses description
    if (reason) {
      snap?.modAction.note.push('modlog_reason_used');
      return { rawReason: reason, isPermanent: true, source: 'modlog', modlog };
    }

    snap?.modAction.note.push('modlog_reason_empty');
    // fall through to modnotes fallback
  } else {
    snap?.modAction.note.push('modlog_no_match');
  }

  const mn = await fetchLatestModNoteText(ctx.reddit, subredditName, user, cfg.modNotesLookupLimit, cfg.debugVerbose, 'BAN');
  if (mn.note) {
    snap?.modAction.note.push(`modnotes_used:${mn.filterUsed}`);
    return { rawReason: mn.note, isPermanent: modlog ? isPermanentFromModlog(modlog) : null, source: 'modnotes', modlog };
  }

  if (mn.error) snap?.modAction.note.push(`modnotes_error:${mn.error}`);
  else snap?.modAction.note.push('modnotes_empty');

  return { rawReason: '', isPermanent: modlog ? isPermanentFromModlog(modlog) : null, source: 'none', modlog };
}

// ---------------- Publishing ----------------
type RunMode = 'update_existing_only' | 'create_new_and_set_active' | 'create_new_no_change_active';

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
      postScheduleEnabled: cfg.postScheduleEnabled,
      postScheduleCron: cfg.postScheduleCron,
      maxRowsInPost: cfg.maxRowsInPost,
      excludeIfTextContains: cfg.excludeIfTextContains,
      excludeIfMappedLabelIn: cfg.excludeIfMappedLabelIn,
      mappingRulesCount: cfg.mappingRules.length,
      defaultLabel: cfg.defaultLabel,
      sortBy: cfg.sortBy,
      createNewOnEditFail: cfg.createNewOnEditFail,
      setNewPostAsActive: cfg.setNewPostAsActive,
      modLogLookupLimit: cfg.modLogLookupLimit,
      modLogMatchWindowSeconds: cfg.modLogMatchWindowSeconds,
      modNotesLookupLimit: cfg.modNotesLookupLimit,
    },
    db: { total: 0, sample: [] },
    import: await readImportStatus(ctx),
    modAction: { note: [] },
    post: { storedPostId: null, action: 'none', finalPostId: null },
    scheduler: { note: [], prevCron: null, prevJobId: null, newJobId: null, error: null },
  };

  const all = await dbReadAll(ctx);

  let rows = all

    .map((r) => ({
      u: r.u,
      reason: String(r.reason ?? '').trim() || cfg.defaultLabel || 'Banned',
    }))
    .filter((r) => r.u);
  if (cfg.postOnlyMappedReasons) {
    const defaultLower = (cfg.defaultLabel ?? 'Banned').toLowerCase().trim();
    rows = rows.filter(r => r.reason.toLowerCase().trim() !== defaultLower);
  }
  if (cfg.sortBy === 'reason_asc') rows.sort((a, b) => a.reason.localeCompare(b.reason) || a.u.localeCompare(b.u));
  else rows.sort((a, b) => a.u.localeCompare(b.u));

  snap.db.total = rows.length;
  snap.db.sample = rows.slice(0, 10);

  const body = buildMarkdownFromDb(sub, cfg.postTitle, rows, cfg.maxRowsInPost, cfg);

  const stored = await readStoredPostRef(ctx, cfg.postIdKey);
  snap.post.storedPostId = stored?.postId ?? null;

  if (mode === 'create_new_and_set_active' || mode === 'create_new_no_change_active') {
    const created = await ctx.reddit.submitPost({ subredditName: sub, title: cfg.postTitle, text: body });
    snap.post.action = mode === 'create_new_and_set_active' ? 'created_set_active' : 'created_not_active';
    snap.post.finalPostId = created.id;

    if (mode === 'create_new_and_set_active') await writeStoredPostRef(ctx, cfg.postIdKey, created.id);

    await writeDebug(ctx, cfg.postIdKey, snap);
    return { rows: rows.length, postId: created.id, action: snap.post.action };
  }

  if (!stored?.postId) {
    const created = await ctx.reddit.submitPost({ subredditName: sub, title: cfg.postTitle, text: body });
    await writeStoredPostRef(ctx, cfg.postIdKey, created.id);
    snap.post.action = 'created_no_stored_active_set';
    snap.post.finalPostId = created.id;

    await writeDebug(ctx, cfg.postIdKey, snap);
    return { rows: rows.length, postId: created.id, action: snap.post.action };
  }

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

// ---------------- Manual import ----------------
function parseBackfillJsonToEntries(input: string): Array<{ u: string; raw: string }> {
  const txt = String(input ?? '').trim();
  if (!txt) return [];

  let parsed: any;
  try {
    parsed = JSON.parse(txt);
  } catch {
    return [];
  }

  const out: Array<{ u: string; raw: string }> = [];

  const pushOne = (u: any, raw: any) => {
    const name = String(u ?? '').trim().replace(/^u\//i, '');
    if (!name) return;
    out.push({ u: name, raw: String(raw ?? '').trim() });
  };

  const walk = (node: any) => {
    if (!node) return;

    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }

    if (typeof node === 'string') {
      pushOne(node, '');
      return;
    }

    if (typeof node === 'object') {
      const maybeChildren = node?.data?.children ?? node?.children;
      if (Array.isArray(maybeChildren)) {
        walk(maybeChildren);
        return;
      }

      const u = node?.u ?? node?.user ?? node?.username ?? node?.name ?? node?.data?.name ?? node?.data?.username ?? node?.data?.user;
      const raw = node?.raw ?? node?.reason ?? node?.note ?? node?.ban_note ?? node?.banNote ?? node?.data?.note ?? node?.data?.reason;

      if (u) pushOne(u, raw);
      return;
    }
  };

  walk(parsed);
  return out;
}

async function runImport(ctx: Context, jsonText: string): Promise<{ imported: number; skipped: number; total: number; lastUser?: string }> {
  const cfg = await getCfg(ctx);
  const entries = parseBackfillJsonToEntries(jsonText);

  let imported = 0;
  let skipped = 0;
  let lastUser: string | undefined;

  for (const e of entries) {
    lastUser = e.u;

    const raw = String(e.raw ?? '').trim();
    const normalized = normalizeReason(raw, cfg);

    if (normalized.skippedByText || normalized.skippedByLabel) {
      skipped++;
      continue;
    }

    const reason = (normalized.reason || cfg.defaultLabel || 'Banned').trim() || 'Banned';
    await dbUpsert(ctx, e.u, reason, raw);
    imported++;
  }

  await writeImportStatus(ctx, {
    lastImportedAt: new Date().toISOString(),
    lastImportedUser: lastUser,
    lastChunkTotal: entries.length,
    lastChunkImported: imported,
    lastChunkSkipped: skipped,
  });

  return { imported, skipped, total: entries.length, lastUser };
}

// ---------------- ModAction trigger ----------------
Devvit.addTrigger({
  event: 'ModAction',
  onEvent: async (event: any, ctx: Context) => {
    const sub = ctx.subredditName;
    if (!sub) return;

    let cfg: Config;
    try {
      cfg = await getCfg(ctx);
    } catch {
      return;
    }

    const snap: DebugSnapshot = {
      ts: new Date().toISOString(),
      subreddit: sub,
      idKey: cfg.postIdKey,
      actor: 'mod_action',
      cfg: {
        excludeIfTextContains: cfg.excludeIfTextContains,
        excludeIfMappedLabelIn: cfg.excludeIfMappedLabelIn,
        mappingRulesCount: cfg.mappingRules.length,
        defaultLabel: cfg.defaultLabel,
        modLogLookupLimit: cfg.modLogLookupLimit,
        modLogMatchWindowSeconds: cfg.modLogMatchWindowSeconds,
        modNotesLookupLimit: cfg.modNotesLookupLimit,
      },
      db: { total: 0, sample: [] },
      import: await readImportStatus(ctx),
      modAction: { action: null, targetUser: null, isPermanent: null, raw: null, mapped: null, note: [] },
      post: { storedPostId: (await readStoredPostRef(ctx, cfg.postIdKey))?.postId ?? null, action: 'none', finalPostId: null },
      scheduler: { note: [], prevCron: null, prevJobId: null, newJobId: null, error: null },
    };

    try {
      const action = String(event?.action ?? '').toLowerCase();
      snap.modAction.action = action;

      if (action !== 'banuser' && action !== 'unbanuser') return;

      const targetUser = extractTargetUserFromEvent(event);
      snap.modAction.targetUser = targetUser || null;
      if (!targetUser) return;

      if (action === 'unbanuser') {
        await dbDelete(ctx, targetUser);
        snap.modAction.note.push('deleted_from_db');
        await writeDebug(ctx, cfg.postIdKey, snap);
        return;
      }

      const actedMs = actionedAtMs(event);

      const res = await fetchBanReason(ctx, sub, targetUser, actedMs, cfg, snap);

      snap.modAction.isPermanent = res.isPermanent;
      if (res.isPermanent === false) {
        await writeDebug(ctx, cfg.postIdKey, snap);
        return;
      }

      let rawReason = String(res.rawReason ?? '').trim();
      snap.modAction.raw = rawReason || null;

      const normalized = normalizeReason(rawReason, cfg);
      snap.modAction.mapped = normalized.mappedLabel || null;
      snap.modAction.skippedByText = normalized.skippedByText;
      snap.modAction.skippedByLabel = normalized.skippedByLabel;

      if (normalized.skippedByText) {
        snap.modAction.note.push('skipped_by_text_contains');
        await writeDebug(ctx, cfg.postIdKey, snap);
        return;
      }
      if (normalized.skippedByLabel) {
        snap.modAction.note.push('skipped_by_mapped_label');
        await writeDebug(ctx, cfg.postIdKey, snap);
        return;
      }

      const finalReason = (normalized.reason || cfg.defaultLabel || 'Banned').trim() || 'Banned';
      await dbUpsert(ctx, targetUser, finalReason, rawReason);
      snap.modAction.note.push(`upserted_to_db_source=${res.source}`);

      await writeDebug(ctx, cfg.postIdKey, snap);
    } catch (e: any) {
      snap.modAction.error = e?.cause?.details ?? e?.message ?? String(e);
      try {
        await writeDebug(ctx, cfg.postIdKey, snap);
      } catch {}
    }
  },
});

// ---------------- Scheduler jobs ----------------
Devvit.addSchedulerJob({
  name: JOB_POST,
  onRun: async (_event, ctx) => {
    try {
      await runPublish(ctx, 'cron_post', 'update_existing_only');
    } catch (e: any) {
      console.log('[banlist] post cron failed', e?.message ?? String(e));
    }
  },
});

Devvit.addSchedulerJob({
  name: JOB_POST_LEGACY,
  onRun: async (_event, ctx) => {
    try {
      await runPublish(ctx, 'cron_post', 'update_existing_only');
    } catch (e: any) {
      console.log('[banlist] legacy post cron failed', e?.message ?? String(e));
    }
  },
});

// ---------------- Install/Upgrade ----------------
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
      db: { total: 0, sample: [] },
      import: await readImportStatus(ctx),
      modAction: { note: [] },
      post: { storedPostId: null, action: 'install', finalPostId: null },
      scheduler: { note: [], prevCron: null, prevJobId: null, newJobId: null, error: null },
    };

    try {
      const cfg = await getCfg(ctx);
      snap.idKey = cfg.postIdKey;
      snap.cfg = { postScheduleEnabled: cfg.postScheduleEnabled, postScheduleCron: cfg.postScheduleCron };
      await ensureSinglePostCronScheduled(ctx, cfg, snap);
      await writeDebug(ctx, cfg.postIdKey, snap);
    } catch (e: any) {
      snap.scheduler.error = e?.message ?? String(e);
      try {
        await writeDebug(ctx, snap.idKey === 'unknown' ? 'banned-users-list' : snap.idKey, snap);
      } catch {}
    }
  },
});

// ---------------- Forms + Menu ----------------
const importForm = Devvit.createForm(
  () => ({
    title: 'Import backlog JSON (chunked)',
    fields: [
      {
        name: 'json',
        label: 'Paste JSON chunk. Run multiple times for large files.',
        type: 'string',
        multiline: true,
        defaultValue: '',
      },
    ],
    acceptLabel: 'Import',
    cancelLabel: 'Cancel',
  }),
  async (event: any, ctx: Context) => {
    const jsonText = String(event?.values?.json ?? '').trim();
    if (!jsonText) {
      ctx.ui.showToast('Nothing pasted.');
      return;
    }
    try {
      const res = await runImport(ctx, jsonText);
      ctx.ui.showToast(`Imported ${res.imported}/${res.total}. Skipped ${res.skipped}.`);
    } catch (e: any) {
      ctx.ui.showToast(`Import failed: ${e?.message ?? String(e)}`);
    }
  }
);

const clearDbForm = Devvit.createForm(
  () => ({
    title: 'Clear banned-user DB',
    fields: [
      {
        name: 'confirm',
        label: 'Type DELETE to confirm',
        type: 'string',
        defaultValue: '',
      },
    ],
    acceptLabel: 'Clear DB',
    cancelLabel: 'Cancel',
  }),
  async (event: any, ctx: Context) => {
    const confirm = String(event?.values?.confirm ?? '').trim().toUpperCase();
    if (confirm !== 'DELETE') {
      ctx.ui.showToast('Canceled.');
      return;
    }

    try {
      const res = await dbClearAll(ctx);
      ctx.ui.showToast(`DB cleared. Deleted ${res.deletedUsers} users.`);
    } catch (e: any) {
      ctx.ui.showToast(`DB clear failed: ${e?.message ?? String(e)}`);
    }
  }
);

Devvit.addMenuItem({
  label: 'Ban List: Import backlog JSON (manual)',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, ctx) => {
    ctx.ui.showForm(importForm);
  },
});

Devvit.addMenuItem({
  label: 'Ban List: DB Clear ALL (danger)',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, ctx) => {
    ctx.ui.showForm(clearDbForm);
  },
});

Devvit.addMenuItem({
  label: 'Ban List: Update active post (safe)',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, ctx) => {
    try {
      const res = await runPublish(ctx, 'manual_post', 'update_existing_only');
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
      const res = await runPublish(ctx, 'manual_post', 'create_new_and_set_active');
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
      const res = await runPublish(ctx, 'manual_post', 'create_new_no_change_active');
      ctx.ui.showToast(`Created post (not active). Rows=${res.rows}`);
    } catch (e: any) {
      ctx.ui.showToast(`Create failed: ${e?.message ?? String(e)}`);
    }
  },
});

Devvit.addMenuItem({
  label: 'Ban List: Refresh post schedule',
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
        cfg: { postScheduleEnabled: cfg.postScheduleEnabled, postScheduleCron: cfg.postScheduleCron },
        db: { total: 0, sample: [] },
        import: await readImportStatus(ctx),
        modAction: { note: [] },
        post: {
          storedPostId: (await readStoredPostRef(ctx, cfg.postIdKey))?.postId ?? null,
          action: 'schedule_refresh',
          finalPostId: null,
        },
        scheduler: { note: [], prevCron: null, prevJobId: null, newJobId: null, error: null },
      };

      await ensureSinglePostCronScheduled(ctx, cfg, snap);
      await writeDebug(ctx, cfg.postIdKey, snap);

      if (snap.scheduler.error) ctx.ui.showToast(`Schedule error: ${snap.scheduler.error}`);
      else ctx.ui.showToast('Schedule OK (or unchanged).');
    } catch (e: any) {
      ctx.ui.showToast(`Schedule refresh failed: ${e?.message ?? String(e)}`);
    }
  },
});

Devvit.addMenuItem({
  label: 'Ban List: Debug snapshot (prints)',
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
      ctx.ui.showToast(`Debug printed. db=${snap.db.total}`);
    } catch (e: any) {
      ctx.ui.showToast(`Debug failed: ${e?.message ?? String(e)}`);
    }
  },
});

// ---------------- Capabilities ----------------
Devvit.configure({
  redditAPI: true,
  kvStore: true,
  scheduler: true,
});

export default Devvit;