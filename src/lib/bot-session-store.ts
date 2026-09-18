import fs from 'fs';
import path from 'path';
import os from 'os';

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

function getDataDir(): string {
  try {
    const localDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    const testFile = path.join(localDir, '.write_test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    return localDir;
  } catch {
    const tmpDir = path.join(os.tmpdir(), 'spacematch_data');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    return tmpDir;
  }
}

function getSessionsFile(): string {
  return path.join(getDataDir(), 'bot_sessions.json');
}

function getDraftsFile(): string {
  return path.join(getDataDir(), 'pending_space_drafts.json');
}

export function getSession(telegramId: number): BotSession {
  const sessionsFile = getSessionsFile();
  if (!fs.existsSync(sessionsFile)) {
    return { telegram_id: telegramId, step: 'idle', draft_data: {}, updated_at: new Date().toISOString() };
  }
  try {
    const raw = fs.readFileSync(sessionsFile, 'utf-8');
    const sessions: Record<string, BotSession> = JSON.parse(raw);
    return sessions[String(telegramId)] || { telegram_id: telegramId, step: 'idle', draft_data: {}, updated_at: new Date().toISOString() };
  } catch {
    return { telegram_id: telegramId, step: 'idle', draft_data: {}, updated_at: new Date().toISOString() };
  }
}

export function saveSession(session: BotSession): void {
  const sessionsFile = getSessionsFile();
  let sessions: Record<string, BotSession> = {};
  if (fs.existsSync(sessionsFile)) {
    try {
      sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
    } catch {}
  }
  session.updated_at = new Date().toISOString();
  sessions[String(session.telegram_id)] = session;
  try {
    fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save session to disk:', err);
  }
}

export function clearSession(telegramId: number): void {
  saveSession({ telegram_id: telegramId, step: 'idle', draft_data: {}, updated_at: new Date().toISOString() });
}

export function saveDraft(draft: SpaceDraft): void {
  const draftsFile = getDraftsFile();
  let drafts: Record<string, SpaceDraft> = {};
  if (fs.existsSync(draftsFile)) {
    try {
      drafts = JSON.parse(fs.readFileSync(draftsFile, 'utf-8'));
    } catch {}
  }
  draft.updated_at = new Date().toISOString();
  drafts[draft.id] = draft;
  try {
    fs.writeFileSync(draftsFile, JSON.stringify(drafts, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save draft to disk:', err);
  }
}

export function getDraft(draftId: string): SpaceDraft | null {
  const draftsFile = getDraftsFile();
  if (!fs.existsSync(draftsFile)) return null;
  try {
    const drafts: Record<string, SpaceDraft> = JSON.parse(fs.readFileSync(draftsFile, 'utf-8'));
    return drafts[draftId] || null;
  } catch {
    return null;
  }
}
