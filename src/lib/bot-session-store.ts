import fs from 'fs';
import path from 'path';

export interface BotSession {
  telegram_id: number;
  step: string;
  draft_data: Record<string, any>;
  updated_at: string;
}

export interface SpaceDraft {
  id: string;
  homeowner_telegram_id: number;
  homeowner_name: string;
  homeowner_username: string | null;
  title: string;
  neighborhood: string;
  price_per_month: number;
  description: string;
  exact_address: string;
  contact_phone: string;
  photo_file_id: string | null;
  photo_url: string | null;
  status: 'pending' | 'approved' | 'rejected';
  rejection_reason?: string | null;
  created_at: string;
  updated_at: string;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'bot_sessions.json');
const DRAFTS_FILE = path.join(DATA_DIR, 'pending_space_drafts.json');

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function getSession(telegramId: number): BotSession {
  ensureDataDir();
  if (!fs.existsSync(SESSIONS_FILE)) {
    return { telegram_id: telegramId, step: 'idle', draft_data: {}, updated_at: new Date().toISOString() };
  }
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
    const sessions: Record<string, BotSession> = JSON.parse(raw);
    return sessions[String(telegramId)] || { telegram_id: telegramId, step: 'idle', draft_data: {}, updated_at: new Date().toISOString() };
  } catch {
    return { telegram_id: telegramId, step: 'idle', draft_data: {}, updated_at: new Date().toISOString() };
  }
}

export function saveSession(session: BotSession): void {
  ensureDataDir();
  let sessions: Record<string, BotSession> = {};
  if (fs.existsSync(SESSIONS_FILE)) {
    try {
      sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
    } catch {}
  }
  session.updated_at = new Date().toISOString();
  sessions[String(session.telegram_id)] = session;
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf-8');
}

export function clearSession(telegramId: number): void {
  saveSession({ telegram_id: telegramId, step: 'idle', draft_data: {}, updated_at: new Date().toISOString() });
}

export function saveDraft(draft: SpaceDraft): void {
  ensureDataDir();
  let drafts: Record<string, SpaceDraft> = {};
  if (fs.existsSync(DRAFTS_FILE)) {
    try {
      drafts = JSON.parse(fs.readFileSync(DRAFTS_FILE, 'utf-8'));
    } catch {}
  }
  draft.updated_at = new Date().toISOString();
  drafts[draft.id] = draft;
  fs.writeFileSync(DRAFTS_FILE, JSON.stringify(drafts, null, 2), 'utf-8');
}

export function getDraft(draftId: string): SpaceDraft | null {
  ensureDataDir();
  if (!fs.existsSync(DRAFTS_FILE)) return null;
  try {
    const drafts: Record<string, SpaceDraft> = JSON.parse(fs.readFileSync(DRAFTS_FILE, 'utf-8'));
    return drafts[draftId] || null;
  } catch {
    return null;
  }
}
