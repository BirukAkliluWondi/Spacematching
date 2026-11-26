import fs from 'fs';
import path from 'path';
import nodeCrypto from 'crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-server';
import {
 BoundedLRUCache,
 getAdminTelegramIds,
 invalidateAdminIdsCache,
 getSession,
 saveSession,
 clearSession,
 getDraft,
 saveDraft,
 getRoommateDraft,
 saveRoommateDraft,
 getAllSpaceDrafts,
 getAllRoommateDrafts,
 preloadSession,
 getUserLanguage,
 setUserLanguage,
 SpaceDraft,
 RoommateProfileDraft,
 getManagedChannels,
 saveManagedChannel,
 removeManagedChannel,
 ManagedChannel,
 getNextSpmarbrCode,
 getUserMembershipStatus,
 activateUserMembership,
 invalidateMembershipCache,
 MembershipStatus,
 deduplicateUpdate,
 acquireActionLock,
 releaseActionLock,
} from '@/lib/bot-session-store';
import { signAdminToken } from '@/lib/admin-auth';
import { verifyTelebirrPayment, extractTransactionReference, normalizeCanonicalTransactionRef } from '@/lib/verify-et';
import { extractTransactionReferenceFromImage } from '@/lib/receipt-extractor';
import {
 broadcastListingToChannel,
 broadcastRoommateProfileToChannel,
 closeChannelPost,
 extractUserDescription,
 postCustomToChannel,
} from '@/lib/telegram-broadcast';
import {
 sendMessage as tgSend,
 updateChannelPostAsMatched,
 parseNumericInput,
 parseBudgetRangeInput,
 formatBudgetRangeLabel,
 extractHouseRulesFromTraits,
 escapeHtml,
 setChatMenuButton,
 deleteMessage,
 formatRoommatePost,
 formatSpacePost,
 generatePostHashtags,
 sanitizeContactDossier,
 truncateTelegramHtml,
} from '@/lib/telegram';
import {
 handleOnboardingCallback,
 handleOnboardingMessage,
 isOnboardingCallback,
 isOnboardingSession,
} from '@/lib/bot/onboarding';
import { persistFaydaVerification } from '@/lib/fayda-verification';
import {
 verifyFaydaPhotoUpload,
 extractMediaFileFromMessage,
 downloadTelegramFile,
 FAYDA_ERROR_GUIDANCE,
 type FaydaVerificationResult,
 type FaydaSuccessResult,
} from '@/lib/bot/fayda-photo-verifier';
import { getLanguage, I18N, SupportedLang } from '@/lib/bot-i18n';
import {
  generateStartCardPng,
  generatePostBranchCardPng,
  generateMembershipCardPng,
  generateFaydaCardPng,
  generateSearchCardPng,
  generateMyListingsCardPng,
  generateCongratulationsCardPng,
} from '@/lib/dynamic-card-generator';

const ALL_SUBCITIES = [
 'Bole',
 'Kazanchis',
 'CMC',
 'Sarbet',
 'Megenagna',
 'Piassa',
 '4 Kilo',
 'Arada',
 'Kirkos',
 'Akaki Kality',
 'Nifas Silk',
 'Kolfe Keraniyo',
 'Gullele',
 'Lideta',
];

// Serverless timeout headroom for OCR, QR decoding, dynamic PNG generation, and bank API polling
export const maxDuration = 60;

// Module-level cache for admin IDs
export function invalidateAdminCache() {
 invalidateAdminIdsCache();
}

// Module-level Telegram CDN file_id cache across serverless invocations
const _telegramFileIdCache = new BoundedLRUCache<string, string>(500, 24 * 60 * 60 * 1000);

// Module-level cache for Fayda verification status to eliminate repeated database round-trips
const _faydaStatusCache = new Map<number, { isVerified: boolean; expiresAt: number }>();
export function setFaydaStatusCache(chatId: number, isVerified: boolean) {
 const ttl = isVerified ? 60 * 60 * 1000 : 30 * 1000;
 if (_faydaStatusCache.size >= 5000) {
 const now = Date.now();
 for (const [id, entry] of _faydaStatusCache.entries()) {
 if (now > entry.expiresAt || _faydaStatusCache.size >= 5000) {
 _faydaStatusCache.delete(id);
 }
 }
 }
 _faydaStatusCache.set(chatId, { isVerified, expiresAt: Date.now() + ttl });
}
export function invalidateFaydaStatusCache(chatId: number) {
 _faydaStatusCache.delete(chatId);
}

// Module-level deduplication lock to guarantee idempotent match contact unlocks under rapid concurrent clicks
const _activeMatchUnlocks = new Set<string>();

// Feature Flag: Toggle dynamic start card image banner (set to 'false' to revert to classic text card)
export const ENABLE_DYNAMIC_START_IMAGE = process.env.ENABLE_DYNAMIC_START_IMAGE !== 'false';

export async function POST(request: Request) {
 try {
 const webhookSecret = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
 if (webhookSecret) {
 const headerSecret = request.headers.get('x-telegram-bot-api-secret-token') || '';
 const a = Buffer.from(headerSecret, 'utf8');
 const b = Buffer.from(webhookSecret, 'utf8');
 const valid = a.length === b.length && nodeCrypto.timingSafeEqual(a, b);
 if (!valid) {
 return NextResponse.json({ ok: false, error: 'Unauthorized webhook' }, { status: 401 });
 }
 }
 const update = await request.json();
 if (update?.update_id && !(await deduplicateUpdate(update.update_id))) {
 return NextResponse.json({ ok: true, duplicate: true });
 }
 const botToken = process.env.TELEGRAM_BOT_TOKEN;
 const rawBotUsername = process.env.NEXT_PUBLIC_BOT_USERNAME || 'Spacematchaddis_bot';
 const botUsername = rawBotUsername.replace('@', '');
 // [DISABLED - Mini App not ready] const appName = process.env.NEXT_PUBLIC_TELEGRAM_APP_NAME || 'roommatch';
 const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://spacematch1-flax.vercel.app';
 const receiverPhone = process.env.TELEBIRR_RECEIVER_PHONE || '0987310978';
 const abyssiniaAccount = process.env.ABYSSINIA_ACCOUNT_NUMBER || '256861771';
 const dashenAccount = process.env.DASHEN_ACCOUNT_NUMBER || '2922175078411';
 const cbeAccount = process.env.CBE_ACCOUNT_NUMBER || '1000054066094';
 const paymentAccountHolder = process.env.PAYMENT_ACCOUNT_HOLDER || 'Wahid';

 const buildChannelPostUrl = (channelIdOrHandle: string | number | null | undefined, msgId?: number | string | null): string => {
   if (!channelIdOrHandle || !msgId) return '';
   const rawCh = String(channelIdOrHandle).trim();
   if (rawCh.startsWith('-100')) {
     return `https://t.me/c/${rawCh.slice(4)}/${msgId}`;
   }
   if (/^-\d+$/.test(rawCh)) {
     return '';
   }
   const handle = rawCh.replace(/^@/, '');
   return handle ? `https://t.me/${handle}/${msgId}` : '';
 };

 // Helper to send requests to Telegram API with keep-alive and network timeout guard
 const sendTelegram = async (method: string, payload: Record<string, any>) => {
 if (!botToken) return null;
 if (process.env.MOCK_TELEGRAM_API === 'true') {
 return { ok: true, result: { message_id: 9999 } };
 }
 try {
 const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 'Connection': 'keep-alive',
 },
 body: JSON.stringify(payload),
 signal: AbortSignal.timeout(8000),
 });
 return await res.json();
 } catch (err) {
 console.error(`Telegram API error (${method}):`, err);
 return null;
 }
 };

  // Uses module-level _telegramFileIdCache (~40ms hits vs ~2000ms multipart re-upload)

  // Helper to load official Fayda backside sample photo
  const getFaydaBacksideSampleBuffer = (): Buffer => {
    const candidates = [
      path.join(process.cwd(), 'public', 'images', 'fayda_sample_back.png'),
      path.join(process.cwd(), 'public', 'fayda_sample_back.png'),
      path.join(process.cwd(), 'public', 'fayda-sample-back.jpg'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(/*turbopackIgnore: true*/ p)) {
        return fs.readFileSync(/*turbopackIgnore: true*/ p);
      }
    }
    return Buffer.alloc(0);
  };

  // Helper to send photo buffer with file_id caching, keep-alive and network timeout guard
  const sendTelegramPhotoBuffer = async (
    chatId: number,
    photoBuffer: Buffer,
    caption?: string,
    keyboard?: any[][],
    cacheKey?: string
  ): Promise<{ ok: boolean; result?: { message_id: number } } | null> => {
    if (!botToken) return null;
    if (process.env.MOCK_TELEGRAM_API === 'true') {
      return { ok: true, result: { message_id: 9999 } };
    }

    // 1. Ultra-fast path: If cached Telegram file_id exists, send via lightweight JSON (~40-60ms)
    if (cacheKey && _telegramFileIdCache.has(cacheKey)) {
      const cachedFileId = _telegramFileIdCache.get(cacheKey)!;
      try {
        const payload: Record<string, any> = {
          chat_id: chatId,
          photo: cachedFileId,
          parse_mode: 'HTML',
        };
        if (caption) payload.caption = caption;
        if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
        const res = await sendTelegram('sendPhoto', payload);
        if (res?.ok) return res;
      } catch (e) {
        console.warn('[sendTelegramPhotoBuffer] Fast-path file_id send failed, retrying upload:', e);
      }
    }

    // 2. Upload photo buffer via multipart/form-data
    try {
      const formData = new FormData();
      formData.append('chat_id', String(chatId));
      formData.append('photo', new Blob([new Uint8Array(photoBuffer)], { type: 'image/png' }), 'card.png');
      if (caption) {
        formData.append('caption', caption);
        formData.append('parse_mode', 'HTML');
      }
      if (keyboard) {
        formData.append('reply_markup', JSON.stringify({ inline_keyboard: keyboard }));
      }

      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();
      if (data?.ok && data.result?.photo && cacheKey) {
        const largestPhoto = data.result.photo.at(-1);
        if (largestPhoto?.file_id) {
          _telegramFileIdCache.set(cacheKey, largestPhoto.file_id);
        }
      }
      return data;
    } catch (err) {
      console.error('sendTelegramPhotoBuffer error:', err);
      return null;
    }
  };

 // Helper to get Admin Telegram IDs (Super-Admins + DB Admins + Channel Admins)
 const getAdminIds = async (): Promise<number[]> => {
 return await getAdminTelegramIds();
 };

 // Helper to get persistent registered admin usernames
 const getPendingAdminUsernames = async (): Promise<string[]> => {
 try {
 const { data } = await supabaseAdmin
 .from('bot_sessions')
 .select('draft_data')
 .eq('telegram_id', 1)
 .maybeSingle();
 if (data?.draft_data?.admin_usernames && Array.isArray(data.draft_data.admin_usernames)) {
 return data.draft_data.admin_usernames;
 }
 } catch {}
 return [];
 };

 // Helper to register an admin username permanently
 const registerAdminUsername = async (username: string): Promise<void> => {
 const clean = username.replace('@', '').toLowerCase().trim();
 if (!clean) return;
 const current = await getPendingAdminUsernames();
 if (!current.includes(clean)) {
 const updated = [...current, clean];
 await supabaseAdmin
 .from('bot_sessions')
 .upsert({
 telegram_id: 1,
 step: 'system_admin_usernames',
 draft_data: { admin_usernames: updated },
 updated_at: new Date().toISOString(),
 }, { onConflict: 'telegram_id' });
 }
 };

 const removePendingAdminUsername = async (username: string): Promise<void> => {
 const clean = username.replace('@', '').toLowerCase().trim();
 if (!clean) return;
 const current = await getPendingAdminUsernames();
 const updated = current.filter((u) => u.toLowerCase() !== clean);
 if (updated.length !== current.length) {
 await supabaseAdmin
 .from('bot_sessions')
 .upsert({
 telegram_id: 1,
 step: 'system_admin_usernames',
 draft_data: { admin_usernames: updated },
 updated_at: new Date().toISOString(),
 }, { onConflict: 'telegram_id' });
 }
 };

 // Helper to check gender preference compatibility between applicant and target listing
 const checkGenderPreferenceMatch = (
 targetPreferredGender: string | null | undefined,
 targetRoommateTraits: string | null | undefined,
 requesterGender: string | null | undefined
 ): { allowed: boolean; targetPrefFormattedEn: string; targetPrefFormattedAm: string } => {
 let pref = (targetPreferredGender || '').trim();
 if (!pref || pref.toLowerCase() === 'any') {
 if (targetRoommateTraits) {
 const pgm = targetRoommateTraits.match(/Prefers?[:\s]+(Male|Female|Any)/i);
 if (pgm) pref = pgm[1].trim();
 }
 }

 const prefLower = pref.toLowerCase();
 const isPrefFemale = prefLower.includes('female') || prefLower.includes('ሴት');
 const isPrefMale = !isPrefFemale && (prefLower.includes('male') || prefLower.includes('ወንድ'));

 if (!isPrefFemale && !isPrefMale) {
 return { allowed: true, targetPrefFormattedEn: 'Any Gender', targetPrefFormattedAm: 'ማንኛውም ጾታ' };
 }

 const reqLower = (requesterGender || '').trim().toLowerCase();
 const isReqFemale = reqLower.includes('female') || reqLower.includes('ሴት') || reqLower === 'f';
 const isReqMale = !isReqFemale && (reqLower.includes('male') || reqLower.includes('ወንድ') || reqLower === 'm');

 if (isPrefFemale && !isReqFemale) {
 return { allowed: false, targetPrefFormattedEn: 'Female Only', targetPrefFormattedAm: 'ሴት ብቻ' };
 }

 if (isPrefMale && !isReqMale) {
 return { allowed: false, targetPrefFormattedEn: 'Male Only', targetPrefFormattedAm: 'ወንድ ብቻ' };
 }

 return {
 allowed: true,
 targetPrefFormattedEn: isPrefFemale ? 'Female Only' : 'Male Only',
 targetPrefFormattedAm: isPrefFemale ? 'ሴት ብቻ' : 'ወንድ ብቻ',
 };
 };

 const getGenderMismatchCard = (
 _isAm: boolean,
 targetCode: string,
 targetPrefEn: string,
 targetPrefAm: string,
 reqGender: string
 ) => {
 const isFemale = /female|ሴት/i.test(reqGender);
 const isMale = /\bmale\b|ወንድ/i.test(reqGender);
 const reqGenderEn = isFemale ? 'Female' : isMale ? 'Male' : (reqGender || 'Member');
 const reqGenderAm = isFemale ? 'ሴት' : isMale ? 'ወንድ' : 'አባል';

 const text = `<b>Gender Preference Mismatch / የተመራጭ ጾታ አለመጣጣም</b>\n\nRoommate <b>#${targetCode}</b> has specified a preference for <b>${targetPrefEn} (${targetPrefAm})</b> roommates.\nየክፍል ጓደኛ <b>#${targetCode}</b> የመረጡት <b>${targetPrefAm} (${targetPrefEn})</b> የቤት ጓደኛ ነው።\n\nSince your profile is registered as <b>${reqGenderEn} / ${reqGenderAm}</b>, this listing cannot accept connection requests.\nየእርስዎ መገለጫ የተመዘገበው <b>${reqGenderAm} / ${reqGenderEn}</b> ስለሆነ፣ ይህ ማስታወቂያ ጥያቄ መቀበል አይችልም።\n\n<blockquote>You can discover other compatible roommates in Addis Ababa below:\nከእርስዎ ጋር የሚስማሙ ሌሎች የተረጋገጡ የቤት ጓደኞችን ከታች ማግኘት ይችላሉ:</blockquote>`;

 const keyboard = [
 [{ text: 'Find Compatible Roommates / ሌሎች ጓደኞችን ፈልግ', callback_data: 'matchmaker_start' }],
 [{ text: 'Edit My Profile / መገለጫዬን አስተካክል', callback_data: 'post_profile_start' }],
 [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ];

 return { text, keyboard };
 };

 // Helper to get the primary channel or active channels for broadcasting
 const getPrimaryChannel = async (): Promise<string> => {
 try {
 const channels = await getManagedChannels();
 const active = channels.filter((c) => c.is_active);
 if (active.length > 0) {
 return String(active[0].channel_id || active[0].channel_username || process.env.TELEGRAM_CHANNEL_ID || "-1002947887634");
 }
 } catch (err) {
 console.error('getPrimaryChannel error:', err);
 }
 return String(process.env.TELEGRAM_CHANNEL_ID || '-1002947887634');
 };

 const getAllActiveChannels = async (): Promise<(string | number)[]> => {
 try {
 const channels = await getManagedChannels();
 const active = channels.filter((c) => c.is_active);
 if (active.length > 0) {
 return active.map((c) => c.channel_username || c.channel_id);
 }
 } catch (err) {
 console.error('getAllActiveChannels error:', err);
 }
 return [process.env.TELEGRAM_CHANNEL_ID || '@roommate_addis'];
 };

 // Helper to close a channel listing manually or automatically
 const executeChannelPostClose = async (
 targetIdentifier: string,
 closedByChatId: number
 ): Promise<{ success: boolean; message: string; displayCode?: string; messageId?: number }> => {
 let rawClean = targetIdentifier.trim().replace(/^#/, '');
 // Extract from URL if full link was provided (e.g. https://t.me/roommatch_addis/1542)
 const linkMatch = rawClean.match(/(?:t\.me\/[^\/]+\/|message_id=)(\d+)/);
 if (linkMatch) {
 rawClean = linkMatch[1];
 }

 // 1. Find profile in DB
 let targetProfile: any = null;
 let channelMsgId: number | null = null;
 let displayCode: string = rawClean.toUpperCase();

 const { data: pCode } = await supabaseAdmin
 .from('profiles')
 .select('*')
 .ilike('display_code', rawClean)
 .maybeSingle();

 if (pCode) {
 targetProfile = pCode;
 channelMsgId = pCode.channel_message_id;
 displayCode = pCode.display_code;
 } else {
 const { data: rmCode } = await supabaseAdmin
 .from('roommate_profiles')
 .select('*')
 .ilike('display_code', rawClean)
 .maybeSingle();

 if (rmCode) {
 targetProfile = rmCode;
 channelMsgId = rmCode.channel_message_id;
 displayCode = rmCode.display_code || rawClean.toUpperCase();
 }
 }

 // If not found by display_code, check if rawClean is a channel_message_id
 const parsedNum = parseInt(rawClean.replace(/^post_|^RM/i, ''), 10);
 if (!channelMsgId && !isNaN(parsedNum) && parsedNum > 0) {
 channelMsgId = parsedNum;
 if (!targetProfile) {
 const { data: pMsg } = await supabaseAdmin
 .from('profiles')
 .select('*')
 .eq('channel_message_id', parsedNum)
 .maybeSingle();
 if (pMsg) {
 targetProfile = pMsg;
 displayCode = pMsg.display_code;
 }
 }
 }

 if (!channelMsgId) {
 return {
 success: false,
 message: `Could not find a channel post corresponding to <b>${escapeHtml(rawClean)}</b>. Please provide a valid #RM code, message ID, or channel link.`,
 };
 }

 // 2. Call updateChannelPostAsMatched
 const primaryCh = await getPrimaryChannel();
 const closedSuccess = await updateChannelPostAsMatched(channelMsgId, displayCode, undefined, primaryCh);

 // 3. Mark DB as closed / matched using valid Postgres enums
 try {
 const safeCode = displayCode.replace(/[^a-zA-Z0-9_-]/g, '');
 if (safeCode && safeCode !== 'CHANNEL_POST') {
 await supabaseAdmin
 .from('profiles')
 .update({ status: 'matched' })
 .or(`display_code.ilike.${safeCode},channel_message_id.eq.${channelMsgId}`);
 } else {
 await supabaseAdmin
 .from('profiles')
 .update({ status: 'matched' })
 .eq('channel_message_id', channelMsgId);
 }

 await supabaseAdmin
 .from('roommate_profiles')
 .update({
 status: 'archived',
 updated_at: new Date().toISOString(),
 })
 .eq('channel_message_id', channelMsgId);

 if (safeCode && safeCode !== 'CHANNEL_POST') {
 await supabaseAdmin
 .from('pending_roommate_drafts')
 .update({
 status: 'archived',
 updated_at: new Date().toISOString(),
 })
 .or(`id.ilike.${safeCode},display_code.ilike.${safeCode},channel_message_id.eq.${channelMsgId}`);
 } else if (channelMsgId) {
 await supabaseAdmin
 .from('pending_roommate_drafts')
 .update({
 status: 'archived',
 updated_at: new Date().toISOString(),
 })
 .eq('channel_message_id', channelMsgId);
 }
 } catch (dbErr) {
 console.error('Error updating profile status to closed in DB:', dbErr);
 }

 if (closedSuccess) {
 return {
 success: true,
 message: `Post <b>#${displayCode}</b> (Channel Message ID: <code>${channelMsgId}</code>) is now marked as <b>_____CLOSED_____</b> in the channel!`,
 displayCode,
 messageId: channelMsgId,
 };
 } else {
 return {
 success: false,
 message: `Database marked as closed, but Telegram message <code>${channelMsgId}</code> could not be updated in the channel. Please verify the bot's channel edit permissions.`,
 displayCode,
 messageId: channelMsgId,
 };
 }
 };

 // Helper: Admin Search Post by Code (#SPMARBR... / #SPMARWR...)
 const executeAdminPostSearch = async (
 chatId: number,
 rawQuery: string,
 messageIdToEdit?: number
 ) => {
 const clean = rawQuery.trim().replace(/^#/, '');
 const candidates: string[] = [clean.toUpperCase()];
 if (/^\d+$/.test(clean)) {
 candidates.unshift(`SPMARBR${clean}`);
 candidates.unshift(`SPMARWR${clean}`);
 }
 if (!clean.toUpperCase().startsWith('SPMARBR') && !clean.toUpperCase().startsWith('SPMARWR')) {
 candidates.push(`SPMARBR${clean.toUpperCase()}`);
 candidates.push(`SPMARWR${clean.toUpperCase()}`);
 }

 let targetProfile: any = null;
 for (const code of candidates) {
 const { data } = await supabaseAdmin
 .from('profiles')
 .select('*')
 .ilike('display_code', code)
 .maybeSingle();
 if (data) {
 targetProfile = data;
 break;
 }
 }

 if (!targetProfile) {
 const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean);
 if (isUuid) {
 const { data } = await supabaseAdmin.from('profiles').select('*').eq('id', clean).maybeSingle();
 if (data) targetProfile = data;
 }
 }

 if (!targetProfile) {
 const num = parseInt(clean.replace(/\D/g, ''), 10);
 if (!isNaN(num) && num > 0) {
 const { data } = await supabaseAdmin.from('profiles').select('*').eq('channel_message_id', num).maybeSingle();
 if (data) targetProfile = data;
 }
 }

 if (!targetProfile) {
 for (const code of candidates) {
 const draft = await getRoommateDraft(code);
 if (draft) {
 targetProfile = {
 display_code: draft.display_code || code,
 status: draft.status || 'pending_approval',
 gender: draft.my_gender,
 preferred_gender: draft.preferred_gender,
 budget_max: draft.budget_max,
 locations: draft.preferred_subcity,
 roommate_traits: draft.lifestyle_bio,
 full_name: draft.user_name,
 telegram_username: draft.username,
 phone_number: draft.contact_phone,
 };
 break;
 }
 }
 }

 if (!targetProfile) {
 await sendOrEditCard(
 chatId,
 `<b>Post Not Found</b>\n\nNo active or historical post was found matching code <code>${escapeHtml(rawQuery)}</code>.\n\nPlease check the code (e.g. <code>SPMARBR5</code>, <code>SPMARWR1</code>, or <code>5</code>) and try again.`,
 [
 [{ text: 'Search Another Code', callback_data: 'admin_search_code_prompt' }],
 [{ text: 'Back to Admin Menu', callback_data: 'admin_menu' }],
 ],
 messageIdToEdit
 );
 return;
 }

 const code = (targetProfile.display_code || clean).toUpperCase().replace(/^#/, '');
 const isClosed = targetProfile.status === 'closed' || targetProfile.status === 'matched';
 const isPending = targetProfile.status === 'pending_approval' || targetProfile.status === 'paused';
 const statusBadge = isClosed ? 'Closed / የተዘጋ' : isPending ? 'Pending Review / በመጠባበቅ ላይ' : 'Active & Published / ክፍት እና የተለቀቀ';
 const isSpace = targetProfile.listing_category === 'space_available' || Boolean(targetProfile.space_rent) || code.startsWith('SPMARWR');
 const listingType = isSpace ? ' Space Available (Roommate With Room)' : ' Roommate Search (Roommate Before Room)';

 const targetChannel = await getPrimaryChannel();
 const postLink = buildChannelPostUrl(targetChannel, targetProfile.channel_message_id);

 const sanitizedContact = sanitizeContactDossier({
 fullName: targetProfile.full_name,
 phoneNumber: targetProfile.phone_number,
 telegramUsername: targetProfile.telegram_username,
 telegramId: targetProfile.telegram_id,
 isConcierge: targetProfile.is_concierge,
 });

 const candName = sanitizedContact.fullName;
 const candPhone = sanitizedContact.phoneNumber;
 const candUser = sanitizedContact.telegramUsername ? `@${sanitizedContact.telegramUsername}` : (targetProfile.telegram_id && targetProfile.telegram_id > 0 ? `ID: ${targetProfile.telegram_id}` : 'Via Coordinator');
 const candSex = targetProfile.gender || 'Any';
 const candPrefSex = targetProfile.preferred_gender || 'Any';
 const candLocations = Array.isArray(targetProfile.locations) ? targetProfile.locations.join(', ') : (Array.isArray(targetProfile.preferred_subcity) ? targetProfile.preferred_subcity.join(', ') : 'Addis Ababa');
 const candBudget = (targetProfile.budget_min || targetProfile.budget_max)
   ? formatBudgetRangeLabel(targetProfile.budget_min, targetProfile.budget_max, 'Negotiable')
   : (targetProfile.space_rent ? `${Number(targetProfile.space_rent).toLocaleString()} ETB / month` : 'Negotiable');
 const candDesc = extractUserDescription(targetProfile.roommate_traits || targetProfile.lifestyle_bio || targetProfile.description) || 'None provided';

 const dossierText = `<b>SpaceMatch Admin · Post Dossier #${code} / የመረጃ ማህደር</b>

• <b>Listing Type / የማስታወቂያ አይነት:</b> ${listingType}
• <b>Status / ሁኔታ:</b> <b>${statusBadge}</b>
• <b>Display Code / የመለያ ኮድ:</b> <code>#${code}</code>
${postLink ? `• <b>Channel Link / የቻናል ማስፈንጠሪያ:</b> <a href="${postLink}">Open Post in Channel / ቻናል ላይ ክፈት ↗</a>\n` : ''}
<b>Candidate Information / የመረጃ ባለቤት:</b>
• <b>Name / ሙሉ ስም:</b> ${escapeHtml(candName)}
• <b>Phone / ስልክ ቁጥር:</b> <code>${escapeHtml(candPhone)}</code>
• <b>Telegram / ቴሌግራም:</b> ${candUser.startsWith('@') ? `<a href="https://t.me/${candUser.replace('@', '')}">${candUser}</a>` : candUser}
• <b>Sex / ጾታ:</b> ${escapeHtml(candSex)}
• <b>Preferred Sex / የሚፈልጉት ጾታ:</b> ${escapeHtml(candPrefSex)}
• <b>${isSpace ? 'Monthly Rent' : 'Budget'} / በጀት:</b> <code>${candBudget}</code>
• <b>Locations / አካባቢዎች:</b> <code>${escapeHtml(candLocations)}</code>
<b>Description / Notes / ተጨማሪ መግለጫ:</b>
<blockquote>${escapeHtml(candDesc)}</blockquote>
<b>Ideal Match / Housemate / ተስማሚ የቤት አጋር:</b>
<blockquote>Clean, respectful, and compatible housemate. / ጽዱ፣ ጨዋ እና ተስማሚ የቤት አጋር።</blockquote>
 `.trim();

 const dossierButtons: any[] = [];
 if (!isClosed && targetProfile.channel_message_id) {
 dossierButtons.push([{ text: `Mark #${code} as CLOSED / ማስታወቂያውን ዝጋ`, callback_data: `admin_close:${code}` }]);
 }
 if (postLink) {
 dossierButtons.push([{ text: 'View Channel Post / የቻናል ማስታወቂያ ተመልከት >', url: postLink }]);
 }
 if (sanitizedContact.telegramUrl) {
 dossierButtons.push([{ text: `Direct Message Candidate / መልእክት ላክ >`, url: sanitizedContact.telegramUrl }]);
 }
 dossierButtons.push([{ text: 'Search Another Code / ሌላ ኮድ ፈልግ', callback_data: 'admin_search_code_prompt' }]);
 dossierButtons.push([{ text: 'Back to Admin Menu / ወደ ዋና ማውጫ ተመለስ', callback_data: 'admin_menu' }]);

 await sendOrEditCard(chatId, dossierText, dossierButtons, messageIdToEdit);
 };

 // Helper: Render full Fayda & identity dossier for an admin
 const renderAdminUserDossier = async (
 chatId: number,
 targetTelegramId: number,
 messageIdToEdit?: number
 ) => {
 const [userRes, profRes] = await Promise.all([
 supabaseAdmin.from('users').select('*').eq('telegram_id', targetTelegramId).maybeSingle(),
 supabaseAdmin.from('profiles').select('*').eq('telegram_id', targetTelegramId).maybeSingle(),
 ]);

 const user = userRes.data;
 const prof = profRes.data;

 if (!user && !prof) {
 await sendOrEditCard(
 chatId,
 `<b>User Not Found</b>\n\nNo user account or profile was found with Telegram ID <code>${targetTelegramId}</code>.`,
 [
 [{ text: 'Search Another User', callback_data: 'admin_search_user_prompt' }],
 [{ text: 'Back to Admin Menu', callback_data: 'admin_menu' }],
 ],
 messageIdToEdit
 );
 return;
 }

 // Parse rich Fayda metadata if stored in fayda_document_url
 let faydaMeta: any = null;
 if (user?.fayda_document_url && typeof user.fayda_document_url === 'string' && user.fayda_document_url.startsWith('{')) {
 try {
 faydaMeta = JSON.parse(user.fayda_document_url);
 } catch {}
 }

 const isVerified = user?.fayda_status === 'verified' || prof?.kyc_status === 'verified';
 const isPending = user?.fayda_status === 'pending' || prof?.kyc_status === 'pending';
 const faydaStatusBadge = isVerified
 ? 'VERIFIED (Cryptographic NIDP RS256)'
 : isPending
 ? 'Pending Review / በመጠባበቅ ላይ'
 : ' UNVERIFIED';

 const officialName =
 faydaMeta?.full_name ||
 prof?.full_name ||
 [user?.first_name, user?.last_name].filter(Boolean).join(' ') ||
 'Not provided';

 const telegramName = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || 'N/A';
 const fanNumber = faydaMeta?.fan || user?.fayda_id_number || 'None on file';
 const gender = faydaMeta?.gender || prof?.gender || user?.gender || 'Not specified';
 const dob = faydaMeta?.date_of_birth || faydaMeta?.dob || 'Not captured / Pre-V4';

 let verifiedDate = 'N/A';
 const rawVerifiedAt = user?.fayda_verified_at || faydaMeta?.verified_at;
 if (rawVerifiedAt) {
 try {
 verifiedDate = new Date(rawVerifiedAt).toLocaleString('en-US', {
 timeZone: 'Africa/Addis_Ababa',
 dateStyle: 'medium',
 timeStyle: 'short',
 }) + ' EAT';
 } catch {
 verifiedDate = String(rawVerifiedAt);
 }
 } else if (isVerified) {
 verifiedDate = 'Verified';
 }

 const verificationSource = faydaMeta?.verified_source
 ? (faydaMeta.verified_source.includes('qr')
 ? 'Offline RS256 Digital Signature (NIDP Public Key)'
 : 'Fayda Verhoeff Checksum Engine')
 : (isVerified ? 'Fayda Verification Engine' : 'Unverified');

 const tgUsername = user?.username
 ? `@${user.username}`
 : prof?.telegram_username
 ? `@${prof.telegram_username.replace('@', '')}`
 : 'No @username';

 const rawHandle = tgUsername.startsWith('@') ? tgUsername.slice(1) : '';
 const tgHandleDisplay = rawHandle
 ? `<a href="https://t.me/${rawHandle}">@${rawHandle}</a>`
 : 'None';

 const phoneNumber = prof?.phone_number || user?.phone_number || 'Not provided';
 const systemRole = user?.role === 'admin' ? 'Administrator' : 'Resident / Renter';
 const displayCode = prof?.display_code ? `#${prof.display_code.toUpperCase().replace(/^#/, '')}` : 'No listing code';
 const accountStatus = prof?.status ? prof.status.toUpperCase() : 'REGISTERED';
 const locations = Array.isArray(prof?.locations) && prof.locations.length > 0
 ? prof.locations.join(', ')
 : 'Addis Ababa';
 const budget = (prof?.budget_min || prof?.budget_max)
 ? `${Number(prof?.budget_min || 0).toLocaleString()} - ${Number(prof?.budget_max || 0).toLocaleString()} ETB / mo`
 : 'Not configured';

 const memberSince = (user?.created_at || prof?.created_at)
 ? new Date(user?.created_at || prof?.created_at).toLocaleDateString('en-US', { dateStyle: 'medium' })
 : 'Unknown';

 const dossierText = `<b>SpaceMatch Admin · Fayda Resident Dossier</b>

━━━━━━━━━━━━━━━━━━━━━
<b>OFFICIAL RESIDENT IDENTITY</b>
• <b>Full Name:</b> <b>${escapeHtml(officialName)}</b>
• <b>Telegram Name:</b> ${escapeHtml(telegramName)}
• <b>Official Gender:</b> ${escapeHtml(gender)}
• <b>Date of Birth:</b> <code>${escapeHtml(dob)}</code>

━━━━━━━━━━━━━━━━━━━━━
<b>FAYDA NATIONAL ID RECORD</b>
• <b>Fayda Status:</b> <b>${faydaStatusBadge}</b>
• <b>Fayda FAN (16-Digit):</b> <code>${escapeHtml(fanNumber)}</code>
• <b>Verification Method:</b> ${escapeHtml(verificationSource)}
• <b>Verified Date:</b> <code>${escapeHtml(verifiedDate)}</code>

━━━━━━━━━━━━━━━━━━━━━
<b>ACCOUNT & CONTACT DETAILS</b>
• <b>Telegram ID:</b> <code>${targetTelegramId}</code>
• <b>Telegram Handle:</b> ${tgHandleDisplay}
• <b>Direct Chat:</b> <a href="tg://user?id=${targetTelegramId}">Open Direct Telegram Chat ↗</a>
• <b>Phone Number:</b> <code>${escapeHtml(phoneNumber)}</code>
• <b>System Role:</b> ${systemRole}

━━━━━━━━━━━━━━━━━━━━━
<b>SPACEMATCH ACTIVITY & PREFERENCES</b>
• <b>Listing Code:</b> <code>${displayCode}</code>
• <b>Account Status:</b> <b>${accountStatus}</b>
• <b>Preferred Locations:</b> <code>${escapeHtml(locations)}</code>
• <b>Budget Range:</b> <code>${escapeHtml(budget)}</code>
• <b>Member Since:</b> <code>${escapeHtml(memberSince)}</code>
 `.trim();

 const dossierButtons: any[] = [];
 if (rawHandle && /^[a-zA-Z0-9_]{5,32}$/.test(rawHandle)) {
 dossierButtons.push([{ text: `Direct Message @${rawHandle} / መልእክት ላክ >`, url: `https://t.me/${rawHandle}` }]);
 }

 if (prof?.display_code) {
 dossierButtons.push([{ text: `View Listing #${prof.display_code.toUpperCase().replace(/^#/, '')} / ማስታወቂያ ተመልከት`, callback_data: `admin_search_code:${prof.display_code}` }]);
 }

 dossierButtons.push([{ text: 'Search Another User / ሌላ ተጠቃሚ ፈልግ', callback_data: 'admin_search_user_prompt' }]);
 dossierButtons.push([{ text: 'Back to Admin Menu / ወደ ዋና ማውጫ ተመለስ', callback_data: 'admin_menu' }]);

 await sendOrEditCard(chatId, dossierText, dossierButtons, messageIdToEdit);
 };

 // Helper: Execute Admin User & Fayda Search
 const executeAdminUserSearch = async (
 chatId: number,
 rawQuery: string,
 messageIdToEdit?: number
 ) => {
 const cleanText = rawQuery.trim().replace(/^[@#]/, '').trim();
 if (!cleanText) {
 await sendOrEditCard(
 chatId,
 `<b>Please provide a name, username, or Fayda ID to search.</b>`,
 [
 [{ text: 'Search User', callback_data: 'admin_search_user_prompt' }],
 [{ text: 'Back to Admin Menu', callback_data: 'admin_menu' }],
 ],
 messageIdToEdit
 );
 return;
 }

 const cleanDigits = cleanText.replace(/[\s-]/g, '');
 const digitOnly = cleanText.replace(/\D/g, '');
 const isNumeric = /^\d+$/.test(cleanDigits);
 const tokens = cleanText.split(/\s+/).filter(Boolean);

 const userQueries: any[] = [];
 const profileQueries: any[] = [];

 // Sanitize query tokens before PostgREST .or() filter interpolation
 const safeText = cleanText.replace(/[,()":*]/g, ' ').replace(/\s+/g, ' ').trim();
 const safeTokens = tokens.map((t) => t.replace(/[,()":*]/g, '').trim()).filter((t) => t.length >= 2);

 // 1. Full text / phrase match across users
 if (safeText) {
 userQueries.push(
 supabaseAdmin
 .from('users')
 .select('*')
 .or(`first_name.ilike.%${safeText}%,last_name.ilike.%${safeText}%,username.ilike.%${safeText}%,fayda_document_url.ilike.%${safeText}%`)
 .limit(25)
 );
 }

 // 2. Unspaced / stripped FAN digits search (>= 3 digits)
 if (cleanDigits.length >= 3 && /\d{3,}/.test(cleanDigits)) {
 userQueries.push(
 supabaseAdmin
 .from('users')
 .select('*')
 .or(`fayda_id_number.ilike.%${cleanDigits}%,fayda_document_url.ilike.%${cleanDigits}%`)
 .limit(25)
 );
 }
 if (digitOnly.length >= 3 && digitOnly !== cleanDigits) {
 userQueries.push(
 supabaseAdmin
 .from('users')
 .select('*')
 .or(`fayda_id_number.ilike.%${digitOnly}%,fayda_document_url.ilike.%${digitOnly}%`)
 .limit(25)
 );
 }

 // 3. Multi-word name token search across first_name, last_name, fayda_document_url
 if (safeTokens.length > 1) {
 for (const token of safeTokens.slice(0, 4)) {
 userQueries.push(
 supabaseAdmin
 .from('users')
 .select('*')
 .or(`first_name.ilike.%${token}%,last_name.ilike.%${token}%,fayda_document_url.ilike.%${token}%`)
 .limit(20)
 );
 }
 }

 // 4. Exact / numeric telegram_id search (guard against 16-digit Fayda FAN precision loss)
 if (isNumeric && cleanDigits.length <= 15) {
 const num = Number(cleanDigits);
 if (Number.isSafeInteger(num)) {
 userQueries.push(
 supabaseAdmin.from('users').select('*').eq('telegram_id', num).limit(5)
 );
 profileQueries.push(
 supabaseAdmin.from('profiles').select('*').eq('telegram_id', num).limit(5)
 );
 }
 }

 // 5. Profiles search: full_name, telegram_username, display_code
 if (safeText) {
 profileQueries.push(
 supabaseAdmin
 .from('profiles')
 .select('*')
 .or(`full_name.ilike.%${safeText}%,telegram_username.ilike.%${safeText}%,display_code.ilike.%${safeText}%`)
 .limit(25)
 );
 }

 // 6. Profiles search with multi-word tokens
 if (safeTokens.length > 1) {
 for (const token of safeTokens.slice(0, 4)) {
 profileQueries.push(
 supabaseAdmin
 .from('profiles')
 .select('*')
 .or(`full_name.ilike.%${token}%,telegram_username.ilike.%${token}%,display_code.ilike.%${token}%`)
 .limit(20)
 );
 }
 }

 if (digitOnly.length >= 3) {
 profileQueries.push(
 supabaseAdmin
 .from('profiles')
 .select('*')
 .ilike('display_code', `%${digitOnly}%`)
 .limit(20)
 );
 }

 const [userResults, profileResults] = await Promise.all([
 Promise.all(userQueries),
 Promise.all(profileQueries),
 ]);

 const map = new Map<number, { user?: any; profile?: any }>();

 for (const res of userResults) {
 if (res?.data && Array.isArray(res.data)) {
 for (const u of res.data) {
 if (u?.telegram_id) {
 const tgId = Number(u.telegram_id);
 const existing = map.get(tgId) || {};
 existing.user = u;
 map.set(tgId, existing);
 }
 }
 }
 }

 for (const res of profileResults) {
 if (res?.data && Array.isArray(res.data)) {
 for (const p of res.data) {
 if (p?.telegram_id) {
 const tgId = Number(p.telegram_id);
 const existing = map.get(tgId) || {};
 existing.profile = p;
 map.set(tgId, existing);
 }
 }
 }
 }

 // Fetch missing half (missing users or profiles) for all discovered entries
 const missingUserTgIds: number[] = [];
 const missingProfileTgIds: number[] = [];
 for (const [tgId, data] of map.entries()) {
 if (!data.user) missingUserTgIds.push(tgId);
 if (!data.profile) missingProfileTgIds.push(tgId);
 }

 if (missingUserTgIds.length > 0) {
 const { data: fetchedUsers } = await supabaseAdmin
 .from('users')
 .select('*')
 .in('telegram_id', missingUserTgIds.slice(0, 50));
 if (fetchedUsers) {
 for (const u of fetchedUsers) {
 const entry = map.get(Number(u.telegram_id));
 if (entry) entry.user = u;
 }
 }
 }

 if (missingProfileTgIds.length > 0) {
 const { data: fetchedProfiles } = await supabaseAdmin
 .from('profiles')
 .select('*')
 .in('telegram_id', missingProfileTgIds.slice(0, 50));
 if (fetchedProfiles) {
 for (const p of fetchedProfiles) {
 const entry = map.get(Number(p.telegram_id));
 if (entry) entry.profile = p;
 }
 }
 }

 if (map.size === 0) {
 await sendOrEditCard(
 chatId,
 `<b>No Users Found</b>\n\nNo resident or Fayda record was found matching <code>${escapeHtml(rawQuery)}</code>.\n\n Try searching by first name, last name, Telegram @username, or 16-digit Fayda FAN.`,
 [
 [{ text: 'Search Another Name', callback_data: 'admin_search_user_prompt' }],
 [{ text: 'Back to Admin Menu', callback_data: 'admin_menu' }],
 ],
 messageIdToEdit
 );
 return;
 }

 // If exactly 1 match found, directly render their dossier!
 if (map.size === 1) {
 const onlyTgId = Array.from(map.keys())[0];
 await renderAdminUserDossier(chatId, onlyTgId, messageIdToEdit);
 return;
 }

 // If multiple matches, show selection list
 const matches = Array.from(map.entries()).slice(0, 10);
 let listText = `<b>Matching Users for "${escapeHtml(rawQuery)}" (${map.size} found)</b>\n\nSelect a resident below to view their complete Fayda dossier:\n\n`;

 const buttons: any[] = [];
 for (const [tgId, data] of matches) {
 let docFullName: string | null = null;
 if (data.user?.fayda_document_url && typeof data.user.fayda_document_url === 'string' && data.user.fayda_document_url.startsWith('{')) {
 try {
 docFullName = JSON.parse(data.user.fayda_document_url).full_name;
 } catch {}
 }

 const name =
 data.profile?.full_name ||
 docFullName ||
 [data.user?.first_name, data.user?.last_name].filter(Boolean).join(' ') ||
 `ID: ${tgId}`;

 const handle = data.user?.username
 ? `@${data.user.username}`
 : data.profile?.telegram_username
 ? `@${data.profile.telegram_username.replace('@', '')}`
 : `<code>${tgId}</code>`;

 const isVerified = data.user?.fayda_status === 'verified' || data.profile?.kyc_status === 'verified';
 const badge = isVerified ? 'Verified' : 'Pending';

 listText += `• <b>${escapeHtml(name)}</b> (${handle}) — ${badge}\n`;
 buttons.push([
 {
 text: `${name.slice(0, 22)} (${badge})`,
 callback_data: `admin_user_dossier:${tgId}`,
 },
 ]);
 }

 buttons.push([{ text: 'Search Another Name', callback_data: 'admin_search_user_prompt' }]);
 buttons.push([{ text: 'Back to Admin Menu', callback_data: 'admin_menu' }]);

 await sendOrEditCard(chatId, listText.trim(), buttons, messageIdToEdit);
 };

 // Helper: 24-Hour Automated Follow-Up Check-in Protocol
 // Automated 24-hour push notifications disabled; users check remaining days and listing status on-demand via the bot menu button
 const checkPending24hCheckins = async () => {
 return;
 };

 // Helper to send or edit in-place cards seamlessly
 const sendOrEditCard = async (
 chatId: number,
 text: string,
 keyboard: any[][],
 messageIdToEdit?: number
 ): Promise<number | undefined> => {
 if (messageIdToEdit) {
 const editRes = await sendTelegram('editMessageText', {
 chat_id: chatId,
 message_id: messageIdToEdit,
 text,
 parse_mode: 'HTML',
 reply_markup: { inline_keyboard: keyboard },
 });
 if (editRes?.ok || editRes?.description?.includes('message is not modified')) {
 return messageIdToEdit;
 }
 // If edit failed (e.g. messageIdToEdit was a photo card), delete it asynchronously without blocking
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: messageIdToEdit }).catch(() => {});
 }

 const sendRes = await sendTelegram('sendMessage', {
 chat_id: chatId,
 text,
 parse_mode: 'HTML',
 reply_markup: { inline_keyboard: keyboard },
 });
 return sendRes?.result?.message_id;
 };

 // Helper to check if a user is verified via Fayda
 const isUserFaydaVerified = async (chatId: number): Promise<boolean> => {
 // Only negative synthetic concierge profile IDs (-1...-99999999) can ever be DB-verified; never auto-bypass Telegram group chat IDs
 if (chatId <= 0) return false;
 const now = Date.now();
 const cached = _faydaStatusCache.get(chatId);
 if (cached) {
 if (cached.expiresAt > now) {
 return cached.isVerified;
 }
 _faydaStatusCache.delete(chatId);
 }

 try {
 const userRes = await supabaseAdmin
 .from('users')
 .select('fayda_status, fayda_id_number')
 .eq('telegram_id', chatId)
 .maybeSingle();

 const isVerified = userRes.data?.fayda_status === 'verified' && Boolean(userRes.data?.fayda_id_number?.trim());
 // Never cache negative unverified status: user may verify immediately via Mini App / separate Lambda
 if (isVerified) {
   setFaydaStatusCache(chatId, true);
 }
 return isVerified;
 } catch (err) {
 console.error('Error checking Fayda verification status:', err);
 }
 return false;
 };

 // Helper: Sanitized Draft Builder (Prevents stale target_id / foreign flow fields leaking across workflows)
  const buildCleanFlowDraft = (
    chatId: number,
    existingDraft: Record<string, any> = {},
    extra: Record<string, any> = {}
  ): Record<string, any> => {
    const lang = getLanguage(existingDraft, chatId);
    return {
      lang,
      ...(existingDraft.full_name ? { full_name: existingDraft.full_name } : {}),
      ...(existingDraft.card_msg_id ? { card_msg_id: existingDraft.card_msg_id } : {}),
      ...extra,
    };
  };

 // Helper: Universal Fayda Gate Card
  const sendFaydaGateCard = async (
    chatId: number,
    targetAction: string,
    messageIdToEdit?: number,
    contextOverride?: Record<string, any>
  ): Promise<number | undefined> => {
    const session = getSession(chatId);
    const lang = getLanguage(session.draft_data, chatId);
    const mergedDraft: Record<string, any> = {
      ...(session.draft_data || {}),
      ...(contextOverride || {}),
      card_msg_id: messageIdToEdit || session.draft_data?.card_msg_id,
      target_action: targetAction,
      why_fayda_return: 'standalone_gate',
    };

    await saveSession({
      telegram_id: chatId,
      step: 'awaiting_standalone_fayda_fan',
      draft_data: mergedDraft,
      updated_at: new Date().toISOString(),
    }, true);

    const gateText = `<b>Upload Back of Fayda ID / የፋይዳ ካርድዎን ጀርባ ይላኩ</b>\n\n<blockquote>Like shown in the sample photo above, please upload a clear photo of the BACK of your Fayda card showing the official QR code.\n\nከላይ በምስሉ ላይ እንደሚታየው፣ ይፋዊው የQR ኮድ የሚገኝበትን የፋይዳ ካርድዎን ጀርባ ፎቶ አንስተው ይላኩ።</blockquote>\n\n⚡ <b>Verified instantly via QR · Zero documents stored</b>\n⚡ <b>በQR ወዲያው ይረጋገጣል · ምንም አይነት ፎቶ በሲስተሙ አይቀመጥም</b>`;

    // Strict Grid Symmetry: 2-Column Action Grid
    const inlineKeyboard = [
      [
        { text: 'Why Fayda? / ለምን ፋይዳ?', callback_data: 'why_fayda_id' },
        { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
      ],
    ];

    let activeId: number | null | undefined = null;

    if (ENABLE_DYNAMIC_START_IMAGE) {
      try {
        const sampleBuffer = getFaydaBacksideSampleBuffer();
        const sendBuffer = sampleBuffer && sampleBuffer.length > 0 ? sampleBuffer : await generateFaydaCardPng();
        if (messageIdToEdit) {
          sendTelegram('deleteMessage', { chat_id: chatId, message_id: messageIdToEdit }).catch(() => {});
        }
        const photoRes = await sendTelegramPhotoBuffer(chatId, sendBuffer, gateText, inlineKeyboard, 'fayda_sample_card_back_v2');
        if (photoRes?.ok && photoRes.result?.message_id) {
          activeId = photoRes.result.message_id;
        }
      } catch (err) {
        console.warn('Sample image send failed for Fayda gate:', err);
      }
    }

    if (!activeId) {
      activeId = await sendOrEditCard(chatId, gateText, inlineKeyboard, messageIdToEdit);
    }

    if (activeId && activeId !== messageIdToEdit) {
      await saveSession({
        telegram_id: chatId,
        step: 'awaiting_standalone_fayda_fan',
        draft_data: { ...mergedDraft, card_msg_id: activeId },
        updated_at: new Date().toISOString(),
      }, true);
    }

    return activeId;
 };

 const calculateAgeFromDob = (dobStr?: string | null): number | null => {
 if (!dobStr) return null;
 const clean = dobStr.trim();
 let birthDate: Date | null = null;
 if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(clean)) {
 const parts = clean.split(/[-/.]/);
 birthDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
 } else if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}/.test(clean)) {
 const parts = clean.split(/[-/.]/);
 const p0 = parseInt(parts[0], 10);
 const p1 = parseInt(parts[1], 10);
 const year = parseInt(parts[2], 10);
 if (p1 > 12 && p0 <= 12) {
 birthDate = new Date(year, p0 - 1, p1);
 } else {
 birthDate = new Date(year, p1 - 1, p0);
 }
 } else {
 const parsed = Date.parse(clean);
 if (!isNaN(parsed)) birthDate = new Date(parsed);
 }
 if (!birthDate || isNaN(birthDate.getTime())) return null;
 const today = new Date();
 let age = today.getFullYear() - birthDate.getFullYear();
 const m = today.getMonth() - birthDate.getMonth();
 if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
 age--;
 }
 return age >= 0 && age < 130 ? age : null;
 };

 const sendVerifiedFaydaDossierCard = async (
 chatId: number,
 lang: string = 'en',
 messageIdToEdit?: number
 ): Promise<number | undefined> => {
 const isAm = lang === 'am';

 const [userRes, profileRes] = await Promise.all([
 supabaseAdmin
 .from('users')
 .select('fayda_id_number, fayda_status, fayda_document_url, gender, first_name, last_name')
 .eq('telegram_id', chatId)
 .maybeSingle(),
 supabaseAdmin
 .from('profiles')
 .select('full_name, gender, age')
 .eq('telegram_id', chatId)
 .maybeSingle(),
 ]);

 const user = userRes.data;
 const prof = profileRes.data;

 // Strict Database Guard: Do not display verified card unless row exists in database with verified status and non-empty FAN
 if (!user || user.fayda_status !== 'verified' || !user.fayda_id_number?.trim()) {
 console.warn(`[sendVerifiedFaydaDossierCard] Refusing to render verified card for unverified or unpersisted user tgId ${chatId}`);
 return await sendFaydaGateCard(chatId, 'access all SpaceMatch verified features', messageIdToEdit);
 }

 let faydaMeta: any = null;
 if (user?.fayda_document_url && typeof user.fayda_document_url === 'string' && user.fayda_document_url.startsWith('{')) {
 try {
 faydaMeta = JSON.parse(user.fayda_document_url);
 } catch {}
 }

 const officialName =
 faydaMeta?.full_name ||
 prof?.full_name ||
 [user?.first_name, user?.last_name].filter(Boolean).join(' ') ||
 'Verified Resident / የተረጋገጠ ነዋሪ';

 const rawDob = faydaMeta?.date_of_birth || faydaMeta?.dob;
 const computedAge = calculateAgeFromDob(rawDob);
 const effectiveAge = computedAge !== null ? computedAge : (prof?.age || null);
 let dobDisplay = 'Not recorded / ያልተገለጸ';
 if (rawDob && effectiveAge !== null) {
 dobDisplay = `${rawDob} (Age ${effectiveAge} / ዕድሜ ${effectiveAge})`;
 } else if (rawDob) {
 dobDisplay = rawDob;
 } else if (effectiveAge !== null) {
 dobDisplay = `Age ${effectiveAge} / ዕድሜ ${effectiveAge}`;
 }

 const rawGender = faydaMeta?.gender || prof?.gender || user?.gender || '';
 let genderDisplay = 'Not specified / ያልተገለጸ';
 if (rawGender) {
 const gLow = rawGender.toLowerCase();
 if (gLow.startsWith('m') || gLow.startsWith('ወ')) {
 genderDisplay = 'Male / ወንድ';
 } else if (gLow.startsWith('f') || gLow.startsWith('ሴ')) {
 genderDisplay = 'Female / ሴት';
 } else {
 genderDisplay = rawGender;
 }
 }

 const rawFan = (faydaMeta?.fan || user?.fayda_id_number || '').replace(/\D/g, '');
 let maskedFan = '•••• •••• ••••';
 if (rawFan.length >= 8) {
 maskedFan = `${rawFan.slice(0, 4)} •••• •••• ${rawFan.slice(-4)}`;
 } else if (rawFan.length >= 4) {
 maskedFan = `•••• •••• ${rawFan.slice(-4)}`;
 } else if (rawFan) {
 maskedFan = rawFan;
 }

 const cardText = `<b>Fayda Verified / ፋይዳዎ ተረጋግጧል</b>\n\n<blockquote>Photo verified in RAM and deleted immediately.\nፎቶው በሚሞሪ ተረጋግጦ ወዲያውኑ ተሰርዟል።</blockquote>\n\n• <b>Name / ስም:</b> <b>${escapeHtml(officialName)}</b>\n• <b>FAN:</b> <code>${escapeHtml(maskedFan)}</code>\n• <b>DOB:</b> <code>${escapeHtml(dobDisplay)}</code>\n• <b>Gender / ጾታ:</b> <code>${escapeHtml(genderDisplay)}</code>`.trim();

 const inlineKeyboard = [
 [
 {
 text: 'Search Roommates / የቤት አጋር ፈልግ >',
 callback_data: 'search_roommate_start',
 },
 ],
 [
 {
 text: 'Post Profile / መረጃ ልለጥፍ',
 callback_data: 'post_profile_start',
 },
 {
 text: 'Why Fayda ID? / ለምን ፋይዳ?',
 callback_data: 'why_fayda_id',
 },
 ],
 [
 {
 text: 'Main Menu / ዋና ማውጫ',
 callback_data: 'nav_start',
 },
 ],
 ];

 return await sendOrEditCard(chatId, cardText, inlineKeyboard, messageIdToEdit);
 };

 // Helper: Unified Fayda Photo & Document Verification using fayda-photo-verifier
 const verifyFaydaMediaFromTelegram = async (message: any, targetChatId?: number): Promise<FaydaVerificationResult> => {
 const media = extractMediaFileFromMessage(message);
 if (!media) {
 return {
 success: false,
 errorCode: 'NO_QR_FOUND',
 messageAm: FAYDA_ERROR_GUIDANCE.NO_QR_FOUND.am,
 messageEn: FAYDA_ERROR_GUIDANCE.NO_QR_FOUND.en,
 message: `${FAYDA_ERROR_GUIDANCE.NO_QR_FOUND.en}\n\n${FAYDA_ERROR_GUIDANCE.NO_QR_FOUND.am}`,
 error: 'No photo or document found in message.',
 };
 }
 if ('error' in media) {
 return {
 success: false,
 errorCode: media.error,
 messageAm: media.messageAm,
 messageEn: media.messageEn,
 message: `${media.messageEn}\n\n${media.messageAm}`,
 error: media.messageEn,
 };
 }
 try {
 const buffer = await downloadTelegramFile(media.fileId);
 return await verifyFaydaPhotoUpload(buffer, targetChatId);
 } catch (err: any) {
 console.error('[verifyFaydaMediaFromTelegram] download or verify error:', err);
 if (err?.message === 'FILE_TOO_LARGE') {
 return {
 success: false,
 errorCode: 'FILE_TOO_LARGE',
 messageAm: FAYDA_ERROR_GUIDANCE.FILE_TOO_LARGE.am,
 messageEn: FAYDA_ERROR_GUIDANCE.FILE_TOO_LARGE.en,
 message: FAYDA_ERROR_GUIDANCE.FILE_TOO_LARGE.bilingual,
 };
 }
 return {
 success: false,
 errorCode: 'QR_UNREADABLE',
 messageAm: FAYDA_ERROR_GUIDANCE.QR_UNREADABLE.am,
 messageEn: FAYDA_ERROR_GUIDANCE.QR_UNREADABLE.en,
 message: FAYDA_ERROR_GUIDANCE.QR_UNREADABLE.bilingual,
 error: err?.message,
 };
 }
 };

 // Helper: Instant Pure QR Fayda Verification (Zero Biometrics / Zero Admin Wait)
 const finalizeFaydaVerification = async (
 chatId: number,
 photoResult: FaydaSuccessResult,
 originStep: string,
 currentDraft: Record<string, any> = {},
 activeMsgId?: number,
 extraParams: Record<string, any> = {},
 fromUser?: any
 ): Promise<number | void | undefined> => {
 const lang = getLanguage(currentDraft, chatId);

 const cleanFan = String(photoResult.fan || '').replace(/[\s-]/g, '').trim();
 const fullName = photoResult.fullName || '';

 await persistFaydaVerification(chatId, cleanFan, fullName, {
 gender: photoResult.gender,
 dob: photoResult.dob,
 verifiedSource: photoResult.verifiedSource || 'telegram_qr_rs256_pure',
 from: fromUser,
 });

 // Strict Database Read-Back Guard
 const cleanExpectedFan = cleanFan.replace(/\D/g, '');
 const { data: dbCheck } = await supabaseAdmin
 .from('users')
 .select('fayda_status, fayda_id_number')
 .eq('telegram_id', chatId)
 .maybeSingle();

 const dbFan = (dbCheck?.fayda_id_number || '').replace(/\D/g, '');
 const isReadBackValid = dbCheck?.fayda_status === 'verified' && dbFan === cleanExpectedFan;

 if (!isReadBackValid) {
 console.error(`[Fayda] DB read-back failed for tgId ${chatId}. Expected ${cleanExpectedFan}, got ${dbFan}, status: ${dbCheck?.fayda_status}`);
 return await sendOrEditCard(
 chatId,
 `<b>Verification Registry Failed / የማረጋገጫ ምዝገባ አልተሳካም</b>\n\n<blockquote>Your Fayda verification could not be confirmed in the database. Please try again. / የፋይዳ መረጃዎ በስርዓቱ ውስጥ ሊረጋገጥ አልቻለም። እባክዎ እንደገና ይሞክሩ።</blockquote>`,
 [[{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }]],
 activeMsgId
 );
 }

 setFaydaStatusCache(chatId, true);

 // Always deliver an explicit visible confirmation that Fayda verification succeeded before continuing
 if (originStep !== 'universal_photo' && originStep !== 'idle') {
 const maskedFaydaFan = cleanFan.length >= 4 ? `•••• •••• ${cleanFan.slice(-4)}` : 'Verified';
 await tgSend(
 chatId,
 `✅ <b>Fayda Verification Successful! / የፋይዳ መታወቂያዎ በተሳካ ሁኔታ ተረጋግጧል!</b>\n\n<blockquote>• <b>Status / ሁኔታ:</b> Verified Resident / የተረጋገጠ ነዋሪ${fullName ? `\n• <b>Name / ስም:</b> ${escapeHtml(fullName)}` : ''}\n• <b>ID / መለያ:</b> <code>${escapeHtml(maskedFaydaFan)}</code></blockquote>`
 );
 }

 const targetMatchId = extraParams.target_match_id || currentDraft.target_match_id || currentDraft.match_id;
 if (targetMatchId) {
 await clearSession(chatId);
 const { data: match } = await supabaseAdmin
 .from('matches')
 .select('*, requester:requester_id(telegram_id, gender, budget_min, budget_max, locations, display_code), target:target_id(telegram_id, display_code)')
 .eq('id', targetMatchId)
 .single();

 if (!match || match.status !== 'pending_acceptance') {
 return await sendOrEditCard(
 chatId,
 `<b>Fayda Verified / ፋይዳ ተረጋግጧል</b>\n\n<blockquote>However, this match request is no longer pending. / ነገር ግን ይህ የግንኙነት ጥያቄ በአሁኑ ሰዓት ክፍት አይደለም።</blockquote>`,
 [[{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }]],
 activeMsgId
 );
 }

 const targetOwnerTgId = Number((match.target as any)?.telegram_id || 0);
 const adminList = await getAdminIds();
 if (!adminList.includes(chatId) && (targetOwnerTgId <= 0 || targetOwnerTgId !== chatId)) {
 return await sendOrEditCard(
 chatId,
 `<b>Unauthorized / ያልተፈቀደ</b>\n\n<blockquote>Only the recipient of this request can accept it. / ይህንን የግንኙነት ጥያቄ መቀበል የሚችለው ተቀባዩ ብቻ ነው።</blockquote>`,
 [[{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }]],
 activeMsgId
 );
 }

 // Enforce Invariant 8: Requester must hold an active 100 ETB 3-Month Pass (fail closed if missing)
 const reqTgId = Number((match.requester as any)?.telegram_id || 0);
 const reqMem = reqTgId > 0 ? await getUserMembershipStatus(reqTgId) : { isActive: false };
 if (!reqMem.isActive) {
 return await sendOrEditCard(
 chatId,
 `<b>Fayda Verified / ፋይዳ ተረጋግጧል</b>\n\n<blockquote>The requesting member has not yet activated their 3-Month Membership Pass. Contacts cannot be revealed until their pass is active.\n\nይህንን ጥያቄ የላከው አባል እስካሁን የአባልነት ክፍያውን ስላላጠናቀቀ አድራሻዎችን መክፈት አይቻልም።</blockquote>`,
 [[{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }]],
 activeMsgId
 );
 }

 return await revealMutualMatchContacts(targetMatchId, chatId, activeMsgId);
 }

 const isSeekerFlow =
 extraParams.is_seeker_wizard ||
 currentDraft.is_seeker_wizard ||
 originStep === 'dyn_card_fayda_fan' ||
 (originStep === 'awaiting_seeker_fayda_upload' && (currentDraft.budget_min || currentDraft.locations || currentDraft.age));

 if (isSeekerFlow) {
 const updatedSeekerDraft = {
 ...currentDraft,
 ...extraParams,
 lang,
 fayda_number: cleanFan,
 fayda_status: 'verified',
 full_name: fullName || currentDraft.full_name,
 gender: photoResult.gender || currentDraft.gender,
 };
 return await completeSeekerOnboarding(chatId, updatedSeekerDraft, activeMsgId, fromUser);
 }

 const returnFlow = extraParams.return_flow || currentDraft.return_flow;
 const returnMeta = extraParams.return_meta || currentDraft.return_meta || {};

 if (returnFlow === 'post_seeker') {
   const cleanSeekerDraft = buildCleanFlowDraft(chatId, currentDraft, {
     mode: 'post_to_channel',
     listing_category: 'seeker',
     full_name: fullName || currentDraft.full_name,
     fayda_number: cleanFan,
     fayda_status: 'verified',
   });
   await sendDynamicCardStep1Age(chatId, cleanSeekerDraft, activeMsgId);
   return activeMsgId;
 }
 if (returnFlow === 'req_connect' && returnMeta.targetId) {
   const { data: myP } = await supabaseAdmin.from('profiles').select('*').eq('telegram_id', chatId).maybeSingle();
   const seededReqDraft = {
     ...(myP || {}),
     target_id: returnMeta.targetId,
     target_code: returnMeta.targetCode,
     target_locations: returnMeta.targetLocations,
     target_budget: returnMeta.targetBudgetStr,
     lang,
     full_name: fullName || myP?.full_name || currentDraft.full_name,
     fayda_number: cleanFan,
     fayda_status: 'verified',
   };
   await routeNextMissingSeekerStep(chatId, seededReqDraft, activeMsgId, fromUser);
   return activeMsgId;
 }
 if (returnFlow === 'post_space') {
   const cleanSpaceDraft = buildCleanFlowDraft(chatId, currentDraft, { mode: 'post_space', full_name: fullName || currentDraft.full_name });
   await sendSpaceStep1Type(chatId, cleanSpaceDraft, activeMsgId);
   return activeMsgId;
 }
 if (returnFlow === 'post_space_prop') {
   await sendPropertyTypePrompt(chatId, activeMsgId);
   return activeMsgId;
 }
 if (returnFlow === 'prop_type' && returnMeta.resolvedSpaceType) {
   const cleanSpaceDraft = buildCleanFlowDraft(chatId, currentDraft, {
     mode: 'post_space',
     property_type: returnMeta.propType,
     space_type: returnMeta.resolvedSpaceType,
     full_name: fullName || currentDraft.full_name,
   });
   await sendSpaceStep2Location(chatId, cleanSpaceDraft, activeMsgId);
   return activeMsgId;
 }
 if (returnFlow === 'unlock_contact' && returnMeta.targetId) {
   await clearSession(chatId);
   await sendUnlockPaywallCard(chatId, returnMeta.targetId, returnMeta.targetType === 'space_listing' ? 'space_listing' : 'roommate_profile', activeMsgId);
   return activeMsgId;
 }
 if (returnFlow === 'search_unlock_contact' && returnMeta.targetProfileId) {
   await routeNextMissingSeekerStep(chatId, { ...currentDraft, target_id: returnMeta.targetProfileId }, activeMsgId, fromUser);
   return activeMsgId;
 }
 if (returnFlow === 'confirm_match' && returnMeta.targetProfileId) {
   await clearSession(chatId);
   const pass = await getUserMembershipStatus(chatId);
   if (!pass.isActive) {
     await sendMembershipPaywallCard(chatId, 'connect_request', { targetProfileId: returnMeta.targetProfileId, targetDisplayCode: returnMeta.targetDisplayCode }, activeMsgId);
   } else {
     await executeDirectMatchRequest(chatId, returnMeta.targetProfileId, activeMsgId);
   }
   return activeMsgId;
 }

 // Resume pending paid action (when an unverified user paid 100 ETB pass first and just completed Fayda verification)
 const pendingPurpose = currentDraft.membership_purpose;
 const pendingMeta = currentDraft.membership_metadata || {};
 if (pendingPurpose) {
 const activePass = await getUserMembershipStatus(chatId);
 if (activePass.isActive) {
 if (pendingPurpose === 'post_channel') {
 if (pendingMeta.category === 'space_available' || pendingMeta.isSpace) {
 await submitSpaceListingToAdmin(chatId, { ...pendingMeta, full_name: fullName || pendingMeta.full_name }, activeMsgId, fromUser);
 } else {
 await submitSeekerListingToAdmin(chatId, { ...pendingMeta, full_name: fullName || pendingMeta.full_name }, activeMsgId, fromUser);
 }
 return activeMsgId;
 }
 const targetId = pendingMeta.targetProfileId || pendingMeta.target_id;
 if (pendingPurpose === 'connect_request' && targetId) {
 await clearSession(chatId);
 await executeDirectMatchRequest(chatId, targetId, activeMsgId);
 return activeMsgId;
 }
 } else if (returnFlow === 'submit_space') {
   await sendMembershipPaywallCard(chatId, 'post_channel', { ...pendingMeta, category: 'space_available', isSpace: true }, activeMsgId);
   return activeMsgId;
 } else if (returnFlow === 'submit_seeker') {
   await sendMembershipPaywallCard(chatId, 'post_channel', { ...pendingMeta, category: 'seeker' }, activeMsgId);
   return activeMsgId;
 }
 }

 // Standalone or universal photo: clear session and display verified dossier card
 await clearSession(chatId);
 return await sendVerifiedFaydaDossierCard(chatId, lang, activeMsgId);
 };

 // Helper to format dynamic context header
 const getDynamicContextHeader = (draft: Record<string, any>) => {
 if (draft.target_code) {
 return `<b>Connect with #${draft.target_code}</b>\n\n`;
 }
 return '';
 };

 // Step 1: Age (Open Numeric Input)
 const sendDynamicCardStep1Age = async (
    chatId: number,
    draft: Record<string, any> = {},
    messageIdToEdit?: number,
    errorMsg?: string
  ) => {
    const activeMsgId = messageIdToEdit || draft.card_msg_id;
    const lang = getLanguage(draft, chatId);
    const cleanCode = (draft.target_code || '').replace(/^#/, '');
    const header = cleanCode
      ? `<b>Connect with Roommate #${cleanCode} / ከቤት አጋር ጋር ይገናኙ</b>\n\n`
      : '';
    const question = '<b>Your Age / እድሜዎ</b>\n\n<blockquote>Enter your age (e.g. 24):\nእድሜዎን በቁጥር ያስገቡ:</blockquote>';
    const errBlock = errorMsg ? (/</.test(errorMsg) ? errorMsg : `<b>${escapeHtml(errorMsg)}</b>`) : '';
    const text = `${header}${errBlock ? `${errBlock}\n\n` : ''}${question}`.trim();

 const inlineKeyboard = [
 ...(draft.target_code
 ? [[{ text: 'Post Profile / መረጃዬን ልለጥፍ >', callback_data: 'post_profile_start' }]]
 : []),
 [{ text: 'Cancel / ሰርዝ', callback_data: 'nav_start' }],
 ];

 const newMsgId = await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 await saveSession({
 telegram_id: chatId,
 step: 'dyn_card_age',
 draft_data: { ...draft, lang, card_msg_id: newMsgId || activeMsgId },
 updated_at: new Date().toISOString(),
 });
 };

 // Step 2: Gender
 const sendDynamicCardStep2Gender = async (
    chatId: number,
    draft: Record<string, any>,
    messageIdToEdit?: number
  ) => {
    const activeMsgId = messageIdToEdit || draft.card_msg_id;
    const lang = getLanguage(draft, chatId);

    await saveSession({
      telegram_id: chatId,
      step: 'dyn_card_gender',
      draft_data: { ...draft, lang, card_msg_id: activeMsgId },
      updated_at: new Date().toISOString(),
    });

    const text = '<b>Select Gender / ጾታዎን ይምረጡ</b>\n\n<blockquote>Select your gender:\nጾታዎን ይምረጡ:</blockquote>';

 const inlineKeyboard = [
 [
 { text: 'Male / ወንድ', callback_data: 'dyn_gender:Male' },
 { text: 'Female / ሴት', callback_data: 'dyn_gender:Female' },
 ],
 [
 { text: 'Back / ተመለስ', callback_data: 'dyn_back_to_age' },
 { text: 'Cancel / ሰርዝ', callback_data: 'nav_start' },
 ],
 ];

 await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 };

 // Step 3: Religion
 const sendDynamicCardStep3Religion = async (
    chatId: number,
    draft: Record<string, any>,
    messageIdToEdit?: number
  ) => {
    const activeMsgId = messageIdToEdit || draft.card_msg_id;
    const lang = getLanguage(draft, chatId);

    await saveSession({
      telegram_id: chatId,
      step: 'dyn_card_religion',
      draft_data: { ...draft, lang, card_msg_id: activeMsgId },
      updated_at: new Date().toISOString(),
    });

    const text = '<b>Select Religion / እምነትዎን ይምረጡ</b>\n\n<blockquote>Select your religion:\nእምነትዎን ይምረጡ:</blockquote>';

 const inlineKeyboard = [
 [
 { text: 'Orthodox / ኦርቶዶክስ', callback_data: 'dyn_religion:Orthodox' },
 { text: 'Muslim / ሙስሊም', callback_data: 'dyn_religion:Muslim' },
 ],
 [
 { text: 'Protestant / ፕሮቴስታንት', callback_data: 'dyn_religion:Protestant' },
 { text: 'Other / Any / ሌላ ወይም ማንኛውም', callback_data: 'dyn_religion:Other' },
 ],
 [
 { text: 'Back / ተመለስ', callback_data: 'dyn_back_to_gender' },
 { text: 'Cancel / ሰርዝ', callback_data: 'nav_start' },
 ],
 ];

 await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 };

 // Step 4: Job / Occupation (Text Input)
 const sendDynamicCardStep4Job = async (
    chatId: number,
    draft: Record<string, any>,
    messageIdToEdit?: number,
    errorMsg?: string
  ) => {
    const activeMsgId = messageIdToEdit || draft.card_msg_id;
    const lang = getLanguage(draft, chatId);

    await saveSession({
      telegram_id: chatId,
      step: 'dyn_card_job',
      draft_data: { ...draft, lang, card_msg_id: activeMsgId },
      updated_at: new Date().toISOString(),
    });

    const promptText = '<b>Your Occupation / ሙያ</b>\n\n<blockquote>Enter your occupation (e.g. Accountant):\nየስራ ሁኔታዎን ወይም ሙያዎን ያስገቡ:</blockquote>';
    const errBlock = errorMsg ? (/</.test(errorMsg) ? errorMsg : `<b>${escapeHtml(errorMsg)}</b>`) : '';
    const text = `${errBlock ? `${errBlock}\n\n` : ''}${promptText}`.trim();

 const inlineKeyboard = [
 [
 { text: 'Back / ተመለስ', callback_data: 'dyn_back_to_religion' },
 { text: 'Cancel / ሰርዝ', callback_data: 'nav_start' },
 ],
 ];

 await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 };

 // Dedicated Interstitial Transition Card (Personal Profile -> Roommate Preferences)
 const sendPersonalRegistrationSuccessCard = async (
    chatId: number,
    draft: Record<string, any>,
    messageIdToEdit?: number
  ) => {
    const activeMsgId = messageIdToEdit || draft.card_msg_id;
    const lang = getLanguage(draft, chatId);

    await saveSession({
      telegram_id: chatId,
      step: 'dyn_card_interstitial',
      draft_data: { ...draft, lang, card_msg_id: activeMsgId },
      updated_at: new Date().toISOString(),
    });

    const text = '<b>Profile Saved / መረጃዎ ተመዝግቧል</b>\n\n<blockquote>Set your roommate preferences (budget and areas).\nየሚፈልጉትን የቤት አጋር እና በጀት ይወስኑ።</blockquote>';

 const inlineKeyboard = [
 [
 {
 text: 'Continue / ወደ ምርጫዎች ቀጥል >',
 callback_data: 'dyn_card_to_preferences',
 },
 ],
 [
 { text: 'Back / ተመለስ', callback_data: 'dyn_back_to_job' },
 { text: 'Cancel / ሰርዝ', callback_data: 'nav_start' },
 ],
 ];

 await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 };

 // Step 5: Monthly Budget Range (Custom Min - Max or Step-by-Step Min -> Max)
 const sendDynamicCardStep5Budget = async (
    chatId: number,
    draft: Record<string, any>,
    messageIdToEdit?: number,
    errorMsg?: string
  ) => {
    const activeMsgId = messageIdToEdit || draft.card_msg_id;
    const lang = getLanguage(draft, chatId);

    const { pending_budget_min: _ignoredMin, ...cleanDraft } = draft || {};
    await saveSession({
      telegram_id: chatId,
      step: 'dyn_card_budget',
      draft_data: { ...cleanDraft, lang, card_msg_id: activeMsgId },
      updated_at: new Date().toISOString(),
    });

    const promptText = '<b>Monthly Budget Range / ወርሃዊ የበጀት ክልል</b>\n\n<blockquote>Enter your minimum and maximum monthly budget in ETB (e.g. <code>5000 - 12000</code>),\nor type your MINIMUM budget first (e.g. <code>5000</code>):\n\nዝቅተኛውን እና ከፍተኛውን ወርሃዊ በጀት በብር ያስገቡ (ምሳሌ: <code>5000 - 12000</code>)\nወይም መጀመሪያ ዝቅተኛውን ብቻ ይጻፉ (ምሳሌ: <code>5000</code>):</blockquote>';
    const errBlock = errorMsg ? (/</.test(errorMsg) ? errorMsg : `<b>${escapeHtml(errorMsg)}</b>`) : '';
    const text = `${errBlock ? `${errBlock}\n\n` : ''}${promptText}`.trim();

 const inlineKeyboard = [
 [
 { text: 'Back / ተመለስ', callback_data: 'dyn_back_to_interstitial' },
 { text: 'Cancel / ሰርዝ', callback_data: 'nav_start' },
 ],
 ];

 const newMsgId = await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 if (newMsgId && newMsgId !== activeMsgId) {
   await saveSession({ telegram_id: chatId, step: 'dyn_card_budget', draft_data: { ...cleanDraft, lang, card_msg_id: newMsgId }, updated_at: new Date().toISOString() });
 }
 };

 // Step 5b: Maximum Monthly Budget (when user entered minimum first)
 const sendDynamicCardStep5BudgetMax = async (
    chatId: number,
    draft: Record<string, any>,
    minAmount: number,
    messageIdToEdit?: number,
    errorMsg?: string
  ) => {
    const activeMsgId = messageIdToEdit || draft.card_msg_id;
    const lang = getLanguage(draft, chatId);
    const suggestedMax = Math.min(1000000, Math.round(minAmount * 1.5));

    await saveSession({
      telegram_id: chatId,
      step: 'dyn_card_budget_max',
      draft_data: { ...draft, pending_budget_min: minAmount, lang, card_msg_id: activeMsgId },
      updated_at: new Date().toISOString(),
    });

    const promptText = `<b>Maximum Monthly Budget / ከፍተኛ ወርሃዊ በጀት</b>\n\n<blockquote>Minimum saved: <b>${minAmount.toLocaleString()} ETB/mo</b>\nNow enter your MAXIMUM monthly budget in ETB (e.g. <code>${suggestedMax.toLocaleString()}</code>):\n\nዝቅተኛ በጀት ተይዟል: <b>${minAmount.toLocaleString()} ብር</b>\nአሁን ከፍተኛውን ወርሃዊ በጀት በብር ያስገቡ:</blockquote>`;
    const errBlock = errorMsg ? (/</.test(errorMsg) ? errorMsg : `<b>${escapeHtml(errorMsg)}</b>`) : '';
    const text = `${errBlock ? `${errBlock}\n\n` : ''}${promptText}`.trim();

 const inlineKeyboard = [
 [
 { text: 'Change Minimum / ዝቅተኛውን ቀይር', callback_data: 'dyn_back_to_budget_min' },
 { text: 'Cancel / ሰርዝ', callback_data: 'nav_start' },
 ],
 ];

 const newMsgId = await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 if (newMsgId && newMsgId !== activeMsgId) {
   await saveSession({ telegram_id: chatId, step: 'dyn_card_budget_max', draft_data: { ...draft, pending_budget_min: minAmount, lang, card_msg_id: newMsgId }, updated_at: new Date().toISOString() });
 }
 };

 // Step 6: Preferred Sex (Gender)
 const sendDynamicCardStep6PrefGender = async (
    chatId: number,
    draft: Record<string, any>,
    messageIdToEdit?: number
  ) => {
    const activeMsgId = messageIdToEdit || draft.card_msg_id;
    const lang = getLanguage(draft, chatId);

    await saveSession({
      telegram_id: chatId,
      step: 'dyn_card_pref_gender',
      draft_data: { ...draft, lang, card_msg_id: activeMsgId },
      updated_at: new Date().toISOString(),
    });

    const text = '<b>Preferred Roommate / የአጋር ጾታ</b>\n\n<blockquote>Who do you prefer to live with?\nአብሮዎት የሚኖረው ሰው ጾታ:</blockquote>';

 const inlineKeyboard = [
 [
 { text: 'Male Only / ወንድ ብቻ', callback_data: 'dyn_pref_gender:Male' },
 { text: 'Female Only / ሴት ብቻ', callback_data: 'dyn_pref_gender:Female' },
 { text: 'Any Gender / ማንኛውም ጾታ', callback_data: 'dyn_pref_gender:Any' },
 ],
 [
 { text: 'Back / ተመለስ', callback_data: 'dyn_back_to_budget' },
 { text: 'Cancel / ሰርዝ', callback_data: 'nav_start' },
 ],
 ];

 await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 };

 // Step 7: Preferred Type of Person / Lifestyle (Text Input)
 const sendDynamicCardStep7Traits = async (
    chatId: number,
    draft: Record<string, any>,
    messageIdToEdit?: number,
    errorMsg?: string
  ) => {
    const activeMsgId = messageIdToEdit || draft.card_msg_id;
    const lang = getLanguage(draft, chatId);

    await saveSession({
      telegram_id: chatId,
      step: 'dyn_card_traits',
      draft_data: { ...draft, lang, card_msg_id: activeMsgId },
      updated_at: new Date().toISOString(),
    });

    const promptText = '<b>Roommate Preferences / ተጨማሪ መስፈርቶች</b>\n\n<blockquote>Describe habits (e.g. clean, quiet, non-smoker):\nስለ አኗኗር ወይም ተጨማሪ መስፈርቶች በአጭሩ ይግለጹ:</blockquote>';
    const errBlock = errorMsg ? (/</.test(errorMsg) ? errorMsg : `<b>${escapeHtml(errorMsg)}</b>`) : '';
    const text = `${errBlock ? `${errBlock}\n\n` : ''}${promptText}`.trim();

 const inlineKeyboard = [
 [
 { text: 'Back / ተመለስ', callback_data: 'dyn_back_to_pref_gender' },
 { text: 'Cancel / ሰርዝ', callback_data: 'nav_start' },
 ],
 ];

 await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 };

 // Step 7b: House Rules (Quick Tap or Custom Text Input)
 const sendDynamicCardStepHouseRules = async (
    chatId: number,
    draft: Record<string, any>,
    messageIdToEdit?: number,
    errorMsg?: string
  ) => {
    const activeMsgId = messageIdToEdit || draft.card_msg_id;
    const lang = getLanguage(draft, chatId);

    await saveSession({
      telegram_id: chatId,
      step: 'dyn_card_house_rules',
      draft_data: { ...draft, lang, card_msg_id: activeMsgId },
      updated_at: new Date().toISOString(),
    });

    const promptText = '<b>House Rules / የቤት ህጎች</b>\n\n<blockquote>Tap a common house rule below or type your own (e.g. Clean, no smoking, quiet after 10 PM, no guests):\nየቤት ህጎችዎን ከታች ይምረጡ ወይም ይጻፉ (ምሳሌ: ንጹህ፣ ሲጋራ አይፈቀድም፣ ከምሽቱ 4 ሰዓት በኋላ ጸጥታ):</blockquote>';
    const errBlock = errorMsg ? (/</.test(errorMsg) ? errorMsg : `<b>${escapeHtml(errorMsg)}</b>`) : '';
    const text = `${errBlock ? `${errBlock}\n\n` : ''}${promptText}`.trim();

 const inlineKeyboard = [
 [
 { text: 'Clean & Quiet / ንጹህና ጸጥተኛ', callback_data: 'dyn_house_rules:Clean, quiet & respectful' },
 { text: 'No Smoking / ሲጋራ ክልክል', callback_data: 'dyn_house_rules:No smoking, clean & tidy' },
 ],
 [
 { text: 'No Parties / ጫጫታ የሌለበት', callback_data: 'dyn_house_rules:Quiet hours after 10 PM, no parties' },
 ],
 [
 { text: 'Back / ተመለስ', callback_data: 'dyn_back_to_traits' },
 { text: 'Cancel / ሰርዝ', callback_data: 'nav_start' },
 ],
 ];

 await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 };

 // Step 8: Sub-cities Multi-Select Grid
 const sendDynamicCardStep8Subcities = async (
    chatId: number,
    draft: Record<string, any>,
    messageIdToEdit?: number
  ) => {
    const activeMsgId = messageIdToEdit || draft.card_msg_id;
    const lang = getLanguage(draft, chatId);
    const selectedList: string[] = Array.isArray(draft.preferred_subcity) ? draft.preferred_subcity : [];
    const isAllSelected = ALL_SUBCITIES.length > 0 && ALL_SUBCITIES.every((s) => selectedList.includes(s));

    await saveSession({
      telegram_id: chatId,
      step: 'dyn_card_subcities',
      draft_data: { ...draft, lang, preferred_subcity: selectedList, card_msg_id: activeMsgId },
      updated_at: new Date().toISOString(),
    }, true);

    const gridRows: any[] = [];
    gridRows.push([
      {
        text: isAllSelected
          ? '✅ All Selected / ሁሉም ተመርጠዋል'
          : 'Select All Areas / ሁሉንም ምረጥ',
        callback_data: 'dyn_sub_all',
      },
    ]);

    for (let i = 0; i < ALL_SUBCITIES.length; i += 2) {
      const row = [];
      const item1 = ALL_SUBCITIES[i];
      const isSel1 = selectedList.includes(item1);
      row.push({
        text: `${isSel1 ? '✅ ' : ''}${item1}`,
        callback_data: `dyn_sub_toggle:${item1}`,
      });

      if (i + 1 < ALL_SUBCITIES.length) {
        const item2 = ALL_SUBCITIES[i + 1];
        const isSel2 = selectedList.includes(item2);
        row.push({
          text: `${isSel2 ? '✅ ' : ''}${item2}`,
          callback_data: `dyn_sub_toggle:${item2}`,
        });
      }
      gridRows.push(row);
    }

    gridRows.push([
      { text: 'Proceed / ቀጥል >', callback_data: 'dyn_sub_proceed' },
    ]);
    gridRows.push([
      { text: 'Back / ተመለስ', callback_data: 'dyn_back_to_house_rules' },
      { text: 'Cancel / ሰርዝ', callback_data: 'nav_start' },
    ]);

    const text = `<b>Preferred Areas / የሚመርጡት አካባቢ</b>\n\n<blockquote>Selected / የተመረጡ: <b>${selectedList.join(', ')}</b></blockquote>`;

 await sendOrEditCard(chatId, text, gridRows, activeMsgId);
 };

 // Dedicated Preferences Registration Success Interstitial (Roommate Criteria -> Next Step)
 const sendPreferencesRegistrationSuccessCard = async (
    chatId: number,
    draft: Record<string, any>,
    messageIdToEdit?: number
  ) => {
    const activeMsgId = messageIdToEdit || draft.card_msg_id;
    const lang = getLanguage(draft, chatId);

    await saveSession({
      telegram_id: chatId,
      step: 'dyn_card_pref_interstitial',
      draft_data: { ...draft, lang, card_msg_id: activeMsgId, preferences_seen: true },
      updated_at: new Date().toISOString(),
    });

    const header = '<b>Preferences Saved / ምርጫዎችዎ ተመዝግበዋል</b>';
    const budgetSummaryStr = formatBudgetRangeLabel(draft.budget_min, draft.budget_max, 'Not set / አልተገለጸም');
    const prefG = draft.preferred_gender || 'Any / ማንኛውም';
    const houseRulesPreview = draft.house_rules || extractHouseRulesFromTraits(draft.roommate_traits) || 'Clean, quiet & respectful';
    const subs = Array.isArray(draft.preferred_subcity) ? draft.preferred_subcity.join(', ') : (draft.preferred_subcity || 'Addis Ababa / አዲስ አበባ');

    const summary = `<blockquote>• <b>Budget / በጀት:</b> <b>${escapeHtml(budgetSummaryStr)}</b>\n• <b>Gender / ጾታ:</b> <b>${prefG}</b>\n• <b>House Rules / የቤት ህጎች:</b> ${escapeHtml(houseRulesPreview)}\n• <b>Areas / አካባቢ:</b> <b>${subs}</b></blockquote>`;
    const prompt = 'Tap below to continue / ለመቀጠል ከታች ይጫኑ:';

    const isVerified = await isUserFaydaVerified(chatId);
 const nextBtnText = !isVerified
      ? 'Proceed to Fayda Verification / ወደ ፋይዳ ማረጋገጫ ቀጥል >'
      : draft.mode === 'post_to_channel'
      ? 'Proceed to Profile Review / ወደ መረጃ ክለሳ ቀጥል >'
      : 'Continue to Connect / ለመገናኘት ቀጥል >';

    const inlineKeyboard = [
      [
        {
          text: nextBtnText,
          callback_data: 'dyn_pref_to_next',
        },
      ],
      [
        { text: 'Back / ተመለስ', callback_data: 'dyn_back_to_subs' },
        { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
      ],
    ];

    await sendOrEditCard(chatId, `${header}\n\n${summary}\n\n${prompt}`, inlineKeyboard, activeMsgId);
 };

 // Step 9: Fayda FAN Verification (Dual-Mode: Type or Camera Scan)
  const sendDynamicCardStep9FaydaFan = async (
    chatId: number,
    draft: Record<string, any>,
    messageIdToEdit?: number,
    errorMsg?: string
  ) => {
    const activeMsgId = messageIdToEdit || draft.card_msg_id;
    const lang = getLanguage(draft, chatId);

    await saveSession({
      telegram_id: chatId,
      step: 'dyn_card_fayda_fan',
      draft_data: { ...draft, lang, card_msg_id: activeMsgId, why_fayda_return: 'dyn_card_fayda_fan' },
      updated_at: new Date().toISOString(),
    });

    const promptText = '<b>Upload Back of Fayda ID / የፋይዳ ካርድዎን ጀርባ ይላኩ</b>\n\n<blockquote>Like shown in the sample photo above, please upload a clear photo of the BACK of your Fayda card showing the official QR code.\n\nከላይ በምስሉ ላይ እንደሚታየው፣ ይፋዊው የQR ኮድ የሚገኝበትን የፋይዳ ካርድዎን ጀርባ ፎቶ አንስተው ይላኩ።</blockquote>\n\n⚡ <b>Verified instantly via QR · Zero documents stored</b>\n⚡ <b>በQR ወዲያው ይረጋገጣል · ምንም አይነት ፎቶ በሲስተሙ አይቀመጥም</b>';
    const errBlock = errorMsg ? (/</.test(errorMsg) ? errorMsg : `<b>${escapeHtml(errorMsg)}</b>`) : '';
    const text = `${errBlock ? `${errBlock}\n\n` : ''}${promptText}`.trim();

    // Strict Grid Symmetry: 2-Column Action Grid
    const inlineKeyboard = [
      [
        { text: 'Why Fayda? / ለምን ፋይዳ?', callback_data: 'why_fayda_id' },
        { text: 'Back / ተመለስ', callback_data: 'dyn_back_to_subs' },
      ],
      [
        { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
      ],
    ];

    let activeId: number | null | undefined = null;

    if (ENABLE_DYNAMIC_START_IMAGE) {
      try {
        const sampleBuffer = getFaydaBacksideSampleBuffer();
        const sendBuffer = sampleBuffer && sampleBuffer.length > 0 ? sampleBuffer : await generateFaydaCardPng();
        if (activeMsgId) {
          sendTelegram('deleteMessage', { chat_id: chatId, message_id: activeMsgId }).catch(() => {});
        }
        const photoRes = await sendTelegramPhotoBuffer(chatId, sendBuffer, truncateTelegramHtml(text, 1024), inlineKeyboard, 'fayda_sample_card_back_v2');
        if (photoRes?.ok && photoRes.result?.message_id) {
          activeId = photoRes.result.message_id;
        }
      } catch (err) {
        console.warn('Sample image send failed for Fayda fan step:', err);
      }
    }

    if (!activeId) {
      activeId = await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
    }

    if (activeId && activeId !== activeMsgId) {
      await saveSession({
        telegram_id: chatId,
        step: 'dyn_card_fayda_fan',
        draft_data: { ...draft, lang, card_msg_id: activeId },
        updated_at: new Date().toISOString(),
      }, true);
    }
 };

 // Helper: Final Preview Card before publishing to channel
 const sendChannelPublishPreviewCard = async (
    chatId: number,
    profileData: Record<string, any>,
    messageIdToEdit?: number
  ) => {
    const codeDisplay = profileData.display_code ? `#${profileData.display_code.replace(/^#/, '')}` : '#PENDING';
    const targetIdentifier = profileData.display_code || profileData.id;
    const areasDisplay = Array.isArray(profileData.locations || profileData.preferred_subcity)
      ? (profileData.locations || profileData.preferred_subcity).join(', ')
      : 'Addis Ababa';
    const budgetDisplay = formatBudgetRangeLabel(profileData.budget_min, profileData.budget_max || profileData.budget, 'Flexible');
    const myGender = profileData.gender || profileData.my_gender || 'Any';
    const myGenderDisplay = myGender === 'Female' ? 'Female / ሴት' : myGender === 'Male' ? 'Male / ወንድ' : myGender;
    const prefGender = profileData.preferred_gender || 'Any';
    const prefGenderDisplay = prefGender === 'Female' ? 'Female Only / ሴት ብቻ' : prefGender === 'Male' ? 'Male Only / ወንድ ብቻ' : 'Any Gender / ማንኛውም ጾታ';
    const religionLine = profileData.religion ? `\n• <b>Religion / እምነት:</b> ${escapeHtml(String(profileData.religion))}` : '';
    const jobLine = profileData.job ? `\n• <b>Occupation / ሙያ:</b> ${escapeHtml(String(profileData.job))}` : '';
    const rawTraits = profileData.details || profileData.lifestyle_bio || profileData.description || profileData.roommate_traits || '';
    const extractedBio = rawTraits ? (extractUserDescription(String(rawTraits)) || String(rawTraits)) : '';
    const userBio = (extractedBio || 'Compatible roommate looking for a room in Addis Ababa.').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const houseRulesPreview = profileData.house_rules || extractHouseRulesFromTraits(String(rawTraits)) || 'Clean, quiet & respectful';

    const text = `<b>SpaceMatch Profile Review / የመረጃ ክለሳ</b>
<code>${codeDisplay}</code> · <b>Ready to Submit / ለግምገማ ዝግጁ</b>

<blockquote>• <b>Target Areas / አካባቢ:</b> <b>${escapeHtml(areasDisplay)}</b>
• <b>Budget Cap / በጀት:</b> <b>${escapeHtml(budgetDisplay)}</b>
• <b>Candidate / ተፈላጊ:</b> ${escapeHtml(myGenderDisplay)}${religionLine}${jobLine}</blockquote>

<b>ABOUT ME / ስለ እኔ</b>
<blockquote>${userBio}</blockquote>

<b>ROOMMATE PREFERENCES / የቤት አጋር ምርጫ</b>
<blockquote>• <b>Looking For / የሚፈልጉት:</b> ${escapeHtml(prefGenderDisplay)}
• <b>House Rules / የቤት ህጎች:</b> ${escapeHtml(String(houseRulesPreview))}</blockquote>

<blockquote>🔒 <b>Privacy Shield / ሚስጥራዊነት:</b> Age stays hidden on channel posts and reveals only upon connection requests. Contacts reveal strictly under double-blind consent.
ዕድሜ በቻናሉ ላይ አይታይም፤ ስልክ እና አድራሻዎም በጋራ ፈቃድ ብቻ ይገለጣሉ።</blockquote>
    `.trim();

    const inlineKeyboard = [
      [
        {
          text: 'Submit for Admin Approval / ለአድሚን ማረጋገጫ ላክ >',
          callback_data: `dyn_submit_channel:${targetIdentifier}`,
        },
      ],
      [
        { text: 'Edit Details / መረጃ አሻሽል', callback_data: 'dyn_edit_menu' },
        { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
      ],
    ];

    const newMsgId = await sendOrEditCard(chatId, text, inlineKeyboard, messageIdToEdit);
    const currSess = getSession(chatId);
    await saveSession({
      telegram_id: chatId,
      step: 'dyn_card_preview',
      draft_data: {
        ...(currSess.draft_data || {}),
        ...profileData,
        edit_return_preview: false,
        card_msg_id: newMsgId || messageIdToEdit || currSess.draft_data?.card_msg_id,
      },
      updated_at: new Date().toISOString(),
    }, true);
  };

 // Helper: Complete seeker onboarding and route to Branch A (connection) or Branch B (channel post)
 const completeSeekerOnboarding = async (
 chatId: number,
 draft: Record<string, any>,
 activeMsgId?: number,
 fromUser?: { first_name?: string; last_name?: string; username?: string }
 ) => {
 let displayCode = draft.display_code;
 let existingProfStatus: string | null = null;
 let existingProfCode: string | null = null;
 try {
 const { data: existingProf } = await supabaseAdmin
 .from('profiles')
 .select('display_code, status')
 .eq('telegram_id', chatId)
 .maybeSingle();
 existingProfStatus = existingProf?.status || null;
 existingProfCode = existingProf?.display_code || null;
 if (!displayCode || !displayCode.toUpperCase().startsWith('SPMARBR')) {
   if (existingProf?.display_code && existingProf.display_code.toUpperCase().startsWith('SPMARBR')) {
     displayCode = existingProf.display_code;
   } else {
     displayCode = await getNextSpmarbrCode('seeker');
   }
 }
 } catch {
 if (!displayCode || !displayCode.toUpperCase().startsWith('SPMARBR')) {
   displayCode = await getNextSpmarbrCode('seeker');
 }
 }

 const preferredSubs = draft.preferred_subcity || ['Bole'];
 const userAge = draft.age || 24;
 const userGender = draft.gender || 'Member';
 const userReligion = draft.religion || 'Any';
 const userJob = draft.job || 'Professional';
 const userPrefGender = draft.preferred_gender || 'Any';
 const userBudgetMin = Number(draft.budget_min || 0);
 const userBudgetMax = Number(draft.budget_max || 10000);
 const userTraits = draft.description || draft.details || draft.roommate_traits || draft.lifestyle_bio || 'Seeking compatible housemate in Addis Ababa.';
 const userHouseRules = (draft.house_rules || extractHouseRulesFromTraits(userTraits) || 'Clean, quiet & respectful').trim();
 const targetId = draft.target_id;
 const targetCode = draft.target_code;

 const cleanUserTraits = extractUserDescription(userTraits) || userTraits;
 const formattedTraits = `Job: ${userJob} | Religion: ${userReligion} | Prefers: ${userPrefGender} | Rules: ${userHouseRules} | ${cleanUserTraits}`;
 const tgFullName = [fromUser?.first_name, fromUser?.last_name].filter(Boolean).join(' ') || 'Verified Member';
 const resolvedProfileFullName = (draft.full_name || '').trim() || tgFullName;

 // 1 & 2. Upsert user record and profile in parallel for maximum speed
 const nameParts = resolvedProfileFullName.trim().split(/\s+/);
 const resolvedFirstName = nameParts[0] || fromUser?.first_name || 'Resident';
 const resolvedLastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : (fromUser?.last_name || null);
 const userUpsertObj: Record<string, any> = {
 telegram_id: chatId,
 first_name: resolvedFirstName,
 last_name: resolvedLastName,
 username: fromUser?.username || null,
 fayda_status: 'verified',
 updated_at: new Date().toISOString(),
 };
 if (draft.fayda_number) {
 userUpsertObj.fayda_id_number = String(draft.fayda_number).replace(/\D/g, '');
 }

 const isChannelDraftOnly = draft.mode === 'post_to_channel';
 const preservedProfileCode =
 existingProfCode && existingProfCode.toUpperCase().startsWith('SPMARWR') && isChannelDraftOnly
 ? existingProfCode
 : displayCode;
 const profileStatusForSave = isChannelDraftOnly
 ? (existingProfStatus === 'active' ? 'active' : 'paused')
 : 'active';
 const profileOnboardingStepForSave = isChannelDraftOnly && existingProfStatus !== 'active'
 ? 'draft'
 : 'completed';

 const profilePayload: Record<string, any> = {
 telegram_id: chatId,
 display_code: preservedProfileCode,
 onboarding_step: profileOnboardingStepForSave,
 gender: userGender,
 locations: preferredSubs,
 budget_min: userBudgetMin,
 budget_max: userBudgetMax,
 roommate_traits: formattedTraits,
 full_name: resolvedProfileFullName,
 telegram_username: fromUser?.username || null,
 kyc_status: 'verified',
 status: profileStatusForSave,
 age: userAge,
 job: userJob,
 religion: userReligion,
 preferred_gender: userPrefGender,
 };

 let savedProfile: any = null;
 try {
 const [_, profRes] = await Promise.all([
 supabaseAdmin.from('users').upsert(userUpsertObj, { onConflict: 'telegram_id' }),
 supabaseAdmin
 .from('profiles')
 .upsert(profilePayload, { onConflict: 'telegram_id' })
 .select('id, display_code, age, gender, job, religion, preferred_gender, locations, budget_min, budget_max, roommate_traits')
 .single(),
 ]);

 if (profRes.error) {
 delete profilePayload.age;
 delete profilePayload.job;
 delete profilePayload.religion;
 delete profilePayload.preferred_gender;
 const { data: fbData, error: fbErr } = await supabaseAdmin
 .from('profiles')
 .upsert(profilePayload, { onConflict: 'telegram_id' })
 .select('id, display_code, gender, locations, budget_min, budget_max, roommate_traits')
 .single();
 if (fbErr) {
 console.error('[completeSeekerOnboarding] fallback profile upsert error:', fbErr);
 }
 savedProfile = fbData;
 } else {
 savedProfile = profRes.data;
 }
 } catch (profileErr) {
 console.error('[completeSeekerOnboarding] parallel upsert error:', profileErr);
 }

 // 3. Upsert into roommate_profiles (no UNIQUE constraint on user_telegram_id in schema — select + update/insert)
 try {
 const lowerGender = String(userGender).toLowerCase();
 const normalizedMyGender = lowerGender.startsWith('f') ? 'Female' : lowerGender.startsWith('m') ? 'Male' : 'Any';
 const normalizedPrefGender = ['Male', 'Female', 'Any'].includes(String(userPrefGender)) ? userPrefGender : 'Any';
 const rmPayload: Record<string, any> = {
 user_telegram_id: chatId,
 my_gender: normalizedMyGender,
 preferred_gender: normalizedPrefGender,
 preferred_subcity: preferredSubs,
 budget_min: userBudgetMin,
 budget_max: userBudgetMax,
 lifestyle_bio: formattedTraits,
 unlock_fee: 100,
 status: 'draft',
 updated_at: new Date().toISOString(),
 };
 const { data: existingRm } = await supabaseAdmin
 .from('roommate_profiles')
 .select('id')
 .eq('user_telegram_id', chatId)
 .order('created_at', { ascending: false })
 .limit(1)
 .maybeSingle();
 if (existingRm?.id) {
 const { error: rmUpdateErr } = await supabaseAdmin
 .from('roommate_profiles')
 .update(rmPayload)
 .eq('id', existingRm.id);
 if (rmUpdateErr) console.warn('[completeSeekerOnboarding] roommate_profiles update warning:', rmUpdateErr);
 } else {
 const { error: rmInsertErr } = await supabaseAdmin
 .from('roommate_profiles')
 .insert(rmPayload);
 if (rmInsertErr) console.warn('[completeSeekerOnboarding] roommate_profiles insert warning:', rmInsertErr);
 }
 } catch (rmErr) {
 console.warn('[completeSeekerOnboarding] roommate_profiles sync warning:', rmErr);
 }

 // 4. Save roommate draft cache (stays draft until explicit Submit + Pass)
 await saveRoommateDraft({
 id: displayCode,
 display_code: displayCode,
 user_telegram_id: chatId,
 user_name: resolvedProfileFullName,
 username: fromUser?.username || null,
 preferred_subcity: preferredSubs,
 my_gender: userGender,
 age: userAge,
 job: userJob,
 religion: userReligion,
 preferred_gender: userPrefGender,
 budget_min: userBudgetMin,
 budget_max: userBudgetMax,
 house_rules: userHouseRules,
 lifestyle_bio: formattedTraits,
 unlock_fee: 100,
 fayda_status: 'verified',
 status: 'pending_approval',
 created_at: new Date().toISOString(),
 updated_at: new Date().toISOString(),
 });

 // ── Branch 1: User requested connection with a channel post target ──
 if (targetId || targetCode) {
 let targetProfile: any = null;
 if (targetId) {
 const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetId);
 if (isUuid) {
 const { data: p } = await supabaseAdmin.from('profiles').select('*').eq('id', targetId).maybeSingle();
 targetProfile = p;
 }
 if (!targetProfile) {
 const { data: p } = await supabaseAdmin.from('profiles').select('*').ilike('display_code', targetId.replace(/^#/, '')).maybeSingle();
 targetProfile = p;
 }
 }
 if (!targetProfile && targetCode) {
 const cleanTargetCode = targetCode.replace(/^#/, '').trim();
 const { data: p } = await supabaseAdmin.from('profiles').select('*').ilike('display_code', cleanTargetCode).maybeSingle();
 targetProfile = p;
 }
 if (!targetProfile && targetId) {
 const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetId);
 if (isUuid) {
 const { data: rm } = await supabaseAdmin.from('roommate_profiles').select('*').eq('id', targetId).maybeSingle();
 if (rm) {
 targetProfile = {
 telegram_id: rm.user_telegram_id,
 gender: rm.my_gender,
 locations: rm.preferred_subcity,
 budget_min: rm.budget_min,
 budget_max: rm.budget_max,
 roommate_traits: rm.lifestyle_bio,
 };
 }
 }
 }

 if (!targetProfile && (targetCode || targetId)) {
 const rawLookup = (targetCode || targetId || '').replace(/^#/, '').trim();
 const draft = await getRoommateDraft(rawLookup);
 if (draft) {
 const codeDigits = parseInt(rawLookup.replace(/\D/g, ''), 10) || Math.floor(Math.random() * 1000000);
 const syntheticTgId = draft.user_telegram_id || -(1000000000 + codeDigits);
 const { data: createdFromDraft } = await supabaseAdmin
 .from('profiles')
 .upsert({
 telegram_id: syntheticTgId,
 display_code: (draft.display_code || rawLookup).toUpperCase().replace(/^#/, ''),
 gender: draft.my_gender || 'Member',
 locations: Array.isArray(draft.preferred_subcity) ? draft.preferred_subcity : ['Addis Ababa'],
 budget_min: Number(draft.budget_min || 0),
 budget_max: Number(draft.budget_max || 10000),
 roommate_traits: draft.lifestyle_bio || 'Channel Roommate Listing',
 kyc_status: 'verified',
 status: 'active',
 onboarding_step: 'completed',
 telegram_username: draft.username || null,
 full_name: draft.user_name || 'Verified Channel Listing',
 }, { onConflict: 'display_code' })
 .select('*')
 .maybeSingle();
 if (createdFromDraft) targetProfile = createdFromDraft;
 }
 }

 if (!targetProfile) {
 await sendOrEditCard(
 chatId,
 `<b>Fayda Verified / ፋይዳ ተረጋግጧል</b>\n\nHowever, the roommate listing (#${targetCode || 'RM'}) is no longer active.`,
 [
 [{ text: 'Find Other Roommates >', callback_data: 'matchmaker_start' }],
 [{ text: 'Main Menu', callback_data: 'nav_start' }],
 ],
 activeMsgId
 );
 await clearSession(chatId);
 return;
 }

 // Ensure target is represented in profiles table with valid UUID
 if (targetProfile && targetProfile.telegram_id) {
 const { data: pExisting } = await supabaseAdmin
 .from('profiles')
 .select('*')
 .eq('telegram_id', targetProfile.telegram_id)
 .maybeSingle();

 if (pExisting) {
 targetProfile = pExisting;
 } else {
 const { data: createdTarget } = await supabaseAdmin
 .from('profiles')
 .upsert({
 telegram_id: targetProfile.telegram_id,
 display_code: targetProfile.display_code || targetCode || `RM${String(targetProfile.telegram_id).slice(-4)}`,
 gender: targetProfile.gender || 'Member',
 locations: targetProfile.locations || targetProfile.preferred_subcity || ['Addis Ababa'],
 budget_min: targetProfile.budget_min || 0,
 budget_max: targetProfile.budget_max || 10000,
 roommate_traits: targetProfile.roommate_traits || 'Channel Roommate Listing',
 kyc_status: 'verified',
 status: 'active',
 onboarding_step: 'completed',
 }, { onConflict: 'telegram_id' })
 .select('*')
 .single();
 if (createdTarget) targetProfile = createdTarget;
 }
 }

 // Self-request check
 if (String(targetProfile.telegram_id) === String(chatId)) {
 await sendOrEditCard(
 chatId,
 `<b>This is your own listing!</b>\n\nYou cannot send a match request to yourself.`,
 [[{ text: 'Main Menu', callback_data: 'nav_start' }]],
 activeMsgId
 );
 await clearSession(chatId);
 return;
 }

 let myProfileId = savedProfile?.id;
 if (!myProfileId) {
 const { data: myP } = await supabaseAdmin.from('profiles').select('id').eq('telegram_id', chatId).maybeSingle();
 myProfileId = myP?.id;
 }

 // Closed-listing guard BEFORE 100 ETB Paywall or duplicate check
 const targetStatusLower = String(targetProfile.status || '').toLowerCase();
 if (['matched', 'closed', 'archived', 'rejected', 'rented'].includes(targetStatusLower)) {
 await sendOrEditCard(
 chatId,
 `<b>Listing Closed / ማስታወቂያው ተዘግቷል</b>\n\n<blockquote>This listing is already closed/matched.\nይህ ማስታወቂያ ቀድሞውኑ ተዘግቷል።</blockquote>`,
 [[{ text: 'Browse Open Matches / ሌሎችን እይ', callback_data: 'matchmaker_start' }], [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }]],
 activeMsgId
 );
 await clearSession(chatId);
 return;
 }

 // Check gender preference match
 const genderCheck = checkGenderPreferenceMatch(
 targetProfile.preferred_gender,
 targetProfile.roommate_traits,
 userGender
 );
 if (!genderCheck.allowed) {
 const lang = getLanguage(draft, chatId);
 const isAm = lang === 'am';
 const { text: mismatchText, keyboard: mismatchKb } = getGenderMismatchCard(
 isAm,
 targetProfile.display_code || targetCode || 'Listing',
 genderCheck.targetPrefFormattedEn,
 genderCheck.targetPrefFormattedAm,
 userGender
 );
 await sendOrEditCard(chatId, mismatchText, mismatchKb, activeMsgId);
 await clearSession(chatId);
 return;
 }

 // Check 3-Month Unified Membership Pass FIRST (Invariant 8)
 const mem = await getUserMembershipStatus(chatId);
 if (!mem.isActive) {
 await sendMembershipPaywallCard(
 chatId,
 'connect_request',
 {
 targetProfileId: targetProfile.id,
 targetDisplayCode: targetProfile.display_code || targetCode,
 targetProfile,
 },
 activeMsgId
 );
 return;
 }

 // Check if match already requested (only after active membership confirmed)
 const { data: existingMatch } = await supabaseAdmin
 .from('matches')
 .select('id, status')
 .eq('requester_id', myProfileId)
 .eq('target_id', targetProfile.id)
 .maybeSingle();

 if (existingMatch) {
 await sendOrEditCard(
 chatId,
 `You already sent a match request to Roommate <b>#${targetProfile.display_code}</b>.\nStatus: <b>${existingMatch.status.replace('_', ' ')}</b>`,
 [[{ text: 'Find Other Roommates', callback_data: 'matchmaker_start' }], [{ text: 'Main Menu', callback_data: 'nav_start' }]],
 activeMsgId
 );
 await clearSession(chatId);
 return;
 }

 await executeDirectMatchRequest(chatId, targetProfile.id, activeMsgId);
 await clearSession(chatId);
 return;
 }

 // ── Branch 2: Post to Channel flow ──
 const profileForReview = {
 ...(savedProfile || {}),
 display_code: displayCode,
 gender: userGender,
 age: userAge,
 job: userJob,
 religion: userReligion,
 preferred_gender: userPrefGender,
 budget_min: userBudgetMin,
 budget_max: userBudgetMax,
 locations: preferredSubs,
 house_rules: userHouseRules,
 roommate_traits: userTraits,
 };

 await sendChannelPublishPreviewCard(chatId, profileForReview, activeMsgId);
 };

 // Helper: Streamlined Seeker Step Router (Eliminates Duplicate Prompts & Loops)
 const routeNextMissingSeekerStep = async (
 chatId: number,
 draft: Record<string, any>,
 messageIdToEdit?: number,
 fromUser?: { first_name?: string; last_name?: string; username?: string }
 ) => {
 const isVerified = await isUserFaydaVerified(chatId);
 const activeMsgId = messageIdToEdit || draft.card_msg_id;
 const normalizedDraft: Record<string, any> = {
 ...draft,
 gender: draft.gender || draft.my_gender,
 my_gender: draft.my_gender || draft.gender,
 preferred_subcity: (Array.isArray(draft.preferred_subcity) && draft.preferred_subcity.length > 0)
 ? draft.preferred_subcity
 : (Array.isArray(draft.locations) && draft.locations.length > 0)
 ? draft.locations
 : (Array.isArray(draft.match_subcities) && draft.match_subcities.length > 0)
 ? draft.match_subcities
 : undefined,
 roommate_traits: draft.roommate_traits || draft.traits || draft.description || draft.lifestyle_bio || draft.preferred_roommate,
 house_rules: draft.house_rules || extractHouseRulesFromTraits(draft.roommate_traits || draft.lifestyle_bio),
 budget_max: draft.budget_max !== undefined ? draft.budget_max : draft.budget,
 };

 if (
 normalizedDraft.edit_return_preview &&
 normalizedDraft.age &&
 normalizedDraft.gender &&
 normalizedDraft.religion &&
 normalizedDraft.job &&
 normalizedDraft.budget_max !== undefined &&
 normalizedDraft.preferred_gender &&
 normalizedDraft.roommate_traits &&
 normalizedDraft.house_rules &&
 Array.isArray(normalizedDraft.preferred_subcity) &&
 normalizedDraft.preferred_subcity.length > 0 &&
 isVerified
 ) {
 await completeSeekerOnboarding(chatId, { ...normalizedDraft, edit_return_preview: false }, activeMsgId, fromUser);
 return;
 }

 if (!normalizedDraft.age || isNaN(Number(normalizedDraft.age)) || Number(normalizedDraft.age) < 18 || Number(normalizedDraft.age) > 99) {
 await sendDynamicCardStep1Age(chatId, normalizedDraft, activeMsgId);
 return;
 }
 if (!normalizedDraft.gender) {
 await sendDynamicCardStep2Gender(chatId, normalizedDraft, activeMsgId);
 return;
 }
 if (!normalizedDraft.religion) {
 await sendDynamicCardStep3Religion(chatId, normalizedDraft, activeMsgId);
 return;
 }
 if (!normalizedDraft.job) {
 await sendDynamicCardStep4Job(chatId, normalizedDraft, activeMsgId);
 return;
 }
 if (!normalizedDraft.interstitial_seen) {
 await sendPersonalRegistrationSuccessCard(chatId, normalizedDraft, activeMsgId);
 return;
 }
 if (normalizedDraft.budget_max === undefined || normalizedDraft.budget_max === null || normalizedDraft.budget_max === '') {
 await sendDynamicCardStep5Budget(chatId, normalizedDraft, activeMsgId);
 return;
 }
 if (!normalizedDraft.preferred_gender) {
 await sendDynamicCardStep6PrefGender(chatId, normalizedDraft, activeMsgId);
 return;
 }
 if (!normalizedDraft.roommate_traits) {
 await sendDynamicCardStep7Traits(chatId, normalizedDraft, activeMsgId);
 return;
 }
 if (!normalizedDraft.house_rules) {
 await sendDynamicCardStepHouseRules(chatId, normalizedDraft, activeMsgId);
 return;
 }
 if (!normalizedDraft.preferred_subcity || (Array.isArray(normalizedDraft.preferred_subcity) && normalizedDraft.preferred_subcity.length === 0)) {
 await sendDynamicCardStep8Subcities(chatId, normalizedDraft, activeMsgId);
 return;
 }
 if (!isVerified) {
 await sendDynamicCardStep9FaydaFan(chatId, normalizedDraft, activeMsgId);
 return;
 }

 await completeSeekerOnboarding(chatId, normalizedDraft, activeMsgId, fromUser);
 };

 // ── Helper: 2-Branch Selection: "I have a space" vs "We look for space together" ──
  const sendPostProfileBranchPrompt = async (
    chatId: number,
    messageIdToEdit?: number,
    fromUser?: { first_name?: string; last_name?: string; username?: string }
  ) => {
    const session = getSession(chatId);
    const cleanBranchDraft = buildCleanFlowDraft(chatId, session.draft_data, {
      ...(messageIdToEdit ? { card_msg_id: messageIdToEdit } : {}),
    });
    const lang = cleanBranchDraft.lang;

    await saveSession({
      telegram_id: chatId,
      step: 'post_profile_branch_select',
      draft_data: cleanBranchDraft,
      updated_at: new Date().toISOString(),
    });

    const text = '<b>Post Profile / መረጃ መለጠፊያ</b>\n\n<blockquote>Select your situation / ሁኔታዎን ይምረጡ:\n\n• <b>Need Roommate (Look Together):</b> Complete your profile & find someone to search a room with together.\n• <b>Have a Room & Need Roommate:</b> Connect directly with Admin Wahid (@WWEHID) to finish & post your room.</blockquote>';

    // Strict Grid Symmetry: Hero CTA on Top + 2-Column Action Grid
    const inlineKeyboard = [
      // Option 1: Need roommate and we will look for a room together
      [
        {
          text: 'Need Roommate (Look Together) / አብረን ቤት እንፈልግ',
          callback_data: 'post_branch_seeker',
        },
      ],
      // Option 2: Have a room -> directly handled by Admin Wahid (@WWEHID)
      [
        {
          text: 'Have a Room & Need Roommate / ክፍል አለኝ',
          callback_data: 'post_branch_space',
        },
        {
          text: 'Main Menu / ዋና ማውጫ',
          callback_data: 'nav_start',
        },
      ],
    ];

    let activeId: number | null | undefined = null;

    if (ENABLE_DYNAMIC_START_IMAGE) {
      try {
        const resolvedName = fromUser?.first_name || session.draft_data?.full_name || 'Resident';
        const pngBuffer = await generatePostBranchCardPng({ userName: resolvedName });

        if (messageIdToEdit) {
          sendTelegram('deleteMessage', { chat_id: chatId, message_id: messageIdToEdit }).catch(() => {});
        }

        const photoRes = await sendTelegramPhotoBuffer(chatId, pngBuffer, truncateTelegramHtml(text, 1024), inlineKeyboard, `post_branch_${resolvedName}`);
        if (photoRes?.ok && photoRes.result?.message_id) {
          activeId = photoRes.result.message_id;
        }
      } catch (err) {
        console.error('[sendPostProfileBranchPrompt] Dynamic image error:', err);
      }
    }

    if (!activeId) {
      activeId = await sendOrEditCard(chatId, text, inlineKeyboard, messageIdToEdit);
    }

    if (activeId && activeId !== messageIdToEdit) {
      await saveSession({
        telegram_id: chatId,
        step: 'post_profile_branch_select',
        draft_data: { ...session.draft_data, lang, card_msg_id: activeId },
        updated_at: new Date().toISOString(),
      }, true);
    }

    return activeId;
  };

  // Direct Admin Concierge Card for Space Owners ("Have a Room & Need Roommate" — Zero Questions)
  const sendHaveRoomAdminDirectCard = async (
    chatId: number,
    messageIdToEdit?: number
  ) => {
    await clearSession(chatId);
    const text = `<b>Have a Room &amp; Need a Roommate? / ክፍል አለዎት እና የቤት አጋር ይፈልጋሉ?</b>

<blockquote>Room/space listings are handled directly with Admin Wahid so your space details and photos can be reviewed and posted quickly.

የክፍል ወይም የቤት ማስታወቂያዎች በቀጥታ ከአድሚን ዋሂድ (@WWEHID) ጋር በመነጋገር ይጠናቀቃሉ። እባክዎ ከታች ያለውን ቁልፍ ተጭነው @WWEHID በቀጥታ ያነጋግሩ!</blockquote>

<b>Admin / አድሚን:</b> @WWEHID`;

    const inlineKeyboard = [
      [{ text: 'Contact Admin Wahid (@WWEHID) / አድሚን ዋሂድን ያናግሩ >', url: 'https://t.me/WWEHID' }],
      [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
    ];

    await sendOrEditCard(chatId, text, inlineKeyboard, messageIdToEdit);
  };

 // ── Branch A: Space Owner Questionnaire Helpers ─────────────────────────
 const saveSpaceStepCardId = async (chatId: number, step: string, draft: Record<string, any>, activeMsgId: number | undefined, newMsgId: number | undefined) => {
   const finalMsgId = newMsgId || activeMsgId;
   if (finalMsgId && finalMsgId !== activeMsgId) {
     await saveSession({
       telegram_id: chatId,
       step,
       draft_data: { ...draft, card_msg_id: finalMsgId },
       updated_at: new Date().toISOString(),
     }, true);
   }
   return finalMsgId;
 };

 const sendSpaceStep1Type = async (
    chatId: number,
    draft: Record<string, any> = {},
    messageIdToEdit?: number,
    errorMsg?: string
  ) => {
    const activeMsgId = messageIdToEdit || draft.card_msg_id;
    const lang = getLanguage(draft, chatId);
    const updatedDraft = { ...draft, lang, listing_category: 'space_available', card_msg_id: activeMsgId };

    await saveSession({
      telegram_id: chatId,
      step: 'space_input_type',
      draft_data: updatedDraft,
      updated_at: new Date().toISOString(),
    }, true);

    const promptText = '<b>Space Type / የክፍል አይነት</b>\n\n<blockquote>Enter space type (e.g. Master Bedroom, Studio):\nየክፍሉን አይነት ያስገቡ:</blockquote>';
 const text = `${errorMsg ? `<b>${escapeHtml(errorMsg)}</b>\n\n` : ''}${promptText}`.trim();

 const inlineKeyboard = [
 [{ text: 'Back / ተመለስ', callback_data: 'post_profile_start' }],
 [{ text: 'Cancel / ሰርዝ', callback_data: 'nav_start' }],
 ];

 const newId = await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 return await saveSpaceStepCardId(chatId, 'space_input_type', updatedDraft, activeMsgId, newId);
 };

 const sendSpaceStep2Location = async (
    chatId: number,
    draft: Record<string, any>,
    messageIdToEdit?: number
  ) => {
    const activeMsgId = messageIdToEdit || draft.card_msg_id;
    const lang = getLanguage(draft, chatId);
    const updatedDraft = { ...draft, lang, card_msg_id: activeMsgId };

    await saveSession({
      telegram_id: chatId,
      step: 'space_subcity_select',
      draft_data: updatedDraft,
      updated_at: new Date().toISOString(),
    }, true);

    const gridRows: any[] = [];
    for (let i = 0; i < ALL_SUBCITIES.length; i += 2) {
      const row = [];
      const item1 = ALL_SUBCITIES[i];
      row.push({ text: item1, callback_data: `space_subcity:${item1}` });
      if (i + 1 < ALL_SUBCITIES.length) {
        const item2 = ALL_SUBCITIES[i + 1];
        row.push({ text: item2, callback_data: `space_subcity:${item2}` });
      }
      gridRows.push(row);
    }

    gridRows.push([
      { text: 'Back / ተመለስ', callback_data: draft.property_type ? 'property_type' : 'post_branch_space' },
      { text: 'Cancel / ሰርዝ', callback_data: 'nav_start' },
    ]);

    const text = '<b>Location / አካባቢ</b>\n\n<blockquote>Select space location:\nየክፍሉን አካባቢ ይምረጡ:</blockquote>';
 const newId = await sendOrEditCard(chatId, text, gridRows, activeMsgId);
 return await saveSpaceStepCardId(chatId, 'space_subcity_select', updatedDraft, activeMsgId, newId);
 };

 const sendSpaceStep2Rent = async (
    chatId: number,
    draft: Record<string, any>,
    messageIdToEdit?: number,
    errorMsg?: string
  ) => {
    const activeMsgId = messageIdToEdit || draft.card_msg_id;
    const lang = getLanguage(draft, chatId);
    const updatedDraft = { ...draft, lang, card_msg_id: activeMsgId };

    await saveSession({
      telegram_id: chatId,
      step: 'space_input_rent',
      draft_data: updatedDraft,
      updated_at: new Date().toISOString(),
    }, true);

    const promptText = '<b>Total Rent / ጠቅላላ ኪራይ</b>\n\n<blockquote>Enter total monthly rent in ETB (e.g. 12000):\nየቤቱን ጠቅላላ ወርሃዊ ኪራይ በብር ያስገቡ:</blockquote>';
 const text = `${errorMsg ? `<b>${escapeHtml(errorMsg)}</b>\n\n` : ''}${promptText}`.trim();

 const inlineKeyboard = [
 [
 { text: 'Back / ተመለስ', callback_data: 'space_back_to_subcity' },
 { text: 'Cancel / ሰርዝ', callback_data: 'nav_start' },
 ],
 ];

 const newId = await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 return await saveSpaceStepCardId(chatId, 'space_input_rent', updatedDraft, activeMsgId, newId);
 };

 const sendSpaceStep3Share = async (
    chatId: number,
    draft: Record<string, any>,
    messageIdToEdit?: number,
    errorMsg?: string
  ) => {
    const activeMsgId = messageIdToEdit || draft.card_msg_id;
    const lang = getLanguage(draft, chatId);
    const updatedDraft = { ...draft, lang, card_msg_id: activeMsgId };

    await saveSession({
      telegram_id: chatId,
      step: 'space_input_share',
      draft_data: updatedDraft,
      updated_at: new Date().toISOString(),
    }, true);

    const rentNum = draft.space_rent || 10000;
    const halfRent = Math.round(rentNum / 2);

    const promptText = "<b>Roommate Share / የአጋር ድርሻ</b>\n\n<blockquote>Enter roommate's monthly share in ETB (e.g. 6000):\nየቤት አጋሩ የሚከፍለውን ድርሻ በብር ያስገቡ:</blockquote>";
    const text = `${errorMsg ? `<b>${escapeHtml(errorMsg)}</b>\n\n` : ''}${promptText}`.trim();

    const splitText = `50% Split (${halfRent.toLocaleString()} ETB) / እኩል ክፍፍል`;

 const inlineKeyboard = [
 [
 { text: splitText, callback_data: `space_share:${halfRent}` },
 ],
 [
 { text: 'Back / ተመለስ', callback_data: 'space_back_to_rent' },
 { text: 'Cancel / ሰርዝ', callback_data: 'nav_start' },
 ],
 ];

 const newId = await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 return await saveSpaceStepCardId(chatId, 'space_input_share', updatedDraft, activeMsgId, newId);
 };

 const sendSpaceStep4Amenities = async (
    chatId: number,
    draft: Record<string, any>,
    messageIdToEdit?: number,
    errorMsg?: string
  ) => {
    const activeMsgId = messageIdToEdit || draft.card_msg_id;
    const lang = getLanguage(draft, chatId);
    const updatedDraft = { ...draft, lang, card_msg_id: activeMsgId };

    await saveSession({
      telegram_id: chatId,
      step: 'space_input_amenities',
      draft_data: updatedDraft,
      updated_at: new Date().toISOString(),
    }, true);

    const promptText = '<b>Amenities / ግልጋሎቶች</b>\n\n<blockquote>Enter included amenities (e.g. WiFi, Kitchen, Parking):\nየሚካተቱ ግልጋሎቶችን ያስገቡ:</blockquote>';
 const text = `${errorMsg ? `<b>${escapeHtml(errorMsg)}</b>\n\n` : ''}${promptText}`.trim();

 const inlineKeyboard = [
 [
 { text: 'Back / ተመለስ', callback_data: 'space_back_to_share' },
 { text: 'Cancel / ሰርዝ', callback_data: 'nav_start' },
 ],
 ];

 const newId = await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 return await saveSpaceStepCardId(chatId, 'space_input_amenities', updatedDraft, activeMsgId, newId);
 };

 const sendSpaceStep5HostGender = async (
    chatId: number,
    draft: Record<string, any>,
    messageIdToEdit?: number
  ) => {
    const activeMsgId = messageIdToEdit || draft.card_msg_id;
    const lang = getLanguage(draft, chatId);
    const updatedDraft = { ...draft, lang, card_msg_id: activeMsgId };

    await saveSession({
      telegram_id: chatId,
      step: 'space_host_gender_select',
      draft_data: updatedDraft,
      updated_at: new Date().toISOString(),
    }, true);

    const text = '<b>Your Gender / ጾታዎ</b>\n\n<blockquote>Select your gender:\nጾታዎን ይምረጡ:</blockquote>';

 const inlineKeyboard = [
 [
 { text: 'Male / ወንድ', callback_data: 'space_host_gender:Male' },
 { text: 'Female / ሴት', callback_data: 'space_host_gender:Female' },
 ],
 [
 { text: 'Back / ተመለስ', callback_data: 'space_back_to_amenities' },
 { text: 'Cancel / ሰርዝ', callback_data: 'nav_start' },
 ],
 ];

 const newId = await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 return await saveSpaceStepCardId(chatId, 'space_host_gender_select', updatedDraft, activeMsgId, newId);
 };

 const sendSpaceStep6PrefGender = async (
    chatId: number,
    draft: Record<string, any>,
    messageIdToEdit?: number
  ) => {
    const activeMsgId = messageIdToEdit || draft.card_msg_id;
    const lang = getLanguage(draft, chatId);
    const updatedDraft = { ...draft, lang, card_msg_id: activeMsgId };

    await saveSession({
      telegram_id: chatId,
      step: 'space_pref_gender_select',
      draft_data: updatedDraft,
      updated_at: new Date().toISOString(),
    }, true);

    const text = '<b>Preferred Roommate / የአጋር ጾታ</b>\n\n<blockquote>Select preferred roommate gender:\nየቤት አጋር ጾታ ይምረጡ:</blockquote>';

 const inlineKeyboard = [
 [
 { text: 'Female Only / ሴት ብቻ', callback_data: 'space_pref_gender:Female' },
 { text: 'Male Only / ወንድ ብቻ', callback_data: 'space_pref_gender:Male' },
 ],
 [
 { text: 'Any Gender / ማንኛውም ጾታ', callback_data: 'space_pref_gender:Any' },
 ],
 [
 { text: 'Back / ተመለስ', callback_data: 'space_back_to_host_gender' },
 { text: 'Cancel / ሰርዝ', callback_data: 'nav_start' },
 ],
 ];

 const newId = await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 return await saveSpaceStepCardId(chatId, 'space_pref_gender_select', updatedDraft, activeMsgId, newId);
 };

 const sendSpaceStep7PrefRoommate = async (
    chatId: number,
    draft: Record<string, any>,
    messageIdToEdit?: number,
    errorMsg?: string
  ) => {
    const activeMsgId = messageIdToEdit || draft.card_msg_id;
    const lang = getLanguage(draft, chatId);
    const updatedDraft = { ...draft, lang, card_msg_id: activeMsgId };

    await saveSession({
      telegram_id: chatId,
      step: 'space_input_pref_roommate',
      draft_data: updatedDraft,
      updated_at: new Date().toISOString(),
    }, true);

    const promptText = '<b>About Space & Roommate Preferences / ስለ ክፍሉና የሚፈለጉት አጋር</b>\n\n<blockquote>Briefly describe the space & roommate preferences (e.g. sunny room near main road; clean, quiet roommate):\nስለ ክፍሉ እና ስለሚፈልጉት አጋር ጠባይ በአጭሩ ይግለጹ:</blockquote>';
 const text = `${errorMsg ? `<b>${escapeHtml(errorMsg)}</b>\n\n` : ''}${promptText}`.trim();

 const inlineKeyboard = [
 [
 { text: 'Back / ተመለስ', callback_data: 'space_back_to_pref_gender' },
 { text: 'Cancel / ሰርዝ', callback_data: 'nav_start' },
 ],
 ];

 const newId = await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 return await saveSpaceStepCardId(chatId, 'space_input_pref_roommate', updatedDraft, activeMsgId, newId);
 };

 const sendSpaceStep8Subcity = async (
    chatId: number,
    draft: Record<string, any>,
    messageIdToEdit?: number
  ) => {
    return await sendSpaceStep2Location(chatId, draft, messageIdToEdit);
 };

 const sendSpaceStep9Photos = async (
    chatId: number,
    draft: Record<string, any>,
    messageIdToEdit?: number
  ) => {
    const activeMsgId = messageIdToEdit || draft.card_msg_id;
    const photos: string[] = draft.space_photos || [];
    const lang = getLanguage(draft, chatId);
    const updatedDraft = { ...draft, lang, space_photos: photos, card_msg_id: activeMsgId };

    await saveSession({
      telegram_id: chatId,
      step: 'space_input_photos',
      draft_data: updatedDraft,
      updated_at: new Date().toISOString(),
    }, true);

    const uploadedNotice = photos.length > 0 ? `<b>${photos.length} photo(s) uploaded / ${photos.length} ፎቶዎች ገብተዋል</b>\n\n` : '';
    const promptText = '<b>Space Photos / የክፍሉ ፎቶዎች</b>\n\n<blockquote>Upload photos of the space or tap Skip (or type "done" / "skip").\nየክፍሉን ፎቶዎች ይላኩ ወይም እለፍ የሚለውን ይጫኑ።</blockquote>';
    const text = `${uploadedNotice}${promptText}`.trim();

    const proceedText = `Proceed with ${photos.length} Photo(s) / ቀጥል >`;
 const skipText = 'Skip Photos / ፎቶዎችን ይለፉ >';

 const inlineKeyboard = [
 ...(photos.length > 0
 ? [[{ text: proceedText, callback_data: 'space_photos_done' }]]
 : []),
 [{ text: skipText, callback_data: 'space_photos_skip' }],
 [{ text: 'Back / ተመለስ', callback_data: 'space_back_to_pref_roommate' }],
 [{ text: 'Cancel / ሰርዝ', callback_data: 'nav_start' }],
 ];

 const newId = await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 return await saveSpaceStepCardId(chatId, 'space_input_photos', updatedDraft, activeMsgId, newId);
 };

 const sendSpacePreviewCard = async (
    chatId: number,
    draft: Record<string, any>,
    messageIdToEdit?: number
  ) => {
    let displayCode = draft.display_code;
    if (!displayCode || !displayCode.toUpperCase().startsWith('SPMARWR')) {
      displayCode = await getNextSpmarbrCode('space_available');
      draft.display_code = displayCode;
    }
    const cleanDisplayCode = displayCode.replace(/^#/, '');

    const subcity = draft.preferred_subcity?.[0] || draft.location || 'Addis Ababa';
    const rentNum = Number(draft.space_rent || 0);
    const shareNum = Number(draft.space_share || 0);
    const spaceType = draft.space_type || 'Private Bedroom in Shared Flat';
    const amenitiesList = Array.isArray(draft.space_amenities) && draft.space_amenities.length > 0
      ? draft.space_amenities.join(', ')
      : (draft.space_amenities_raw || 'Standard Utilities');
    const hostGender = draft.owner_gender || draft.my_gender || draft.gender || 'Member';
    const hostGenderDisplay = hostGender === 'Female' ? 'Female / ሴት' : hostGender === 'Male' ? 'Male / ወንድ' : hostGender;
    const prefGender = draft.preferred_tenant_gender || draft.preferred_gender || 'Any';
    const prefGenderDisplay = prefGender === 'Female' ? 'Female Only / ሴት ብቻ' : prefGender === 'Male' ? 'Male Only / ወንድ ብቻ' : 'Any Gender / ማንኛውም ጾታ';
    const photosCount = Array.isArray(draft.space_photos) ? draft.space_photos.length : 0;
    const desc = (draft.description || draft.preferred_roommate || draft.roommate_traits || 'Room available for rent in Addis Ababa.').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const text = `<b>Space Listing Review / የክፍል መረጃ ክለሳ</b>
<code>#${escapeHtml(cleanDisplayCode)}</code> · <b>Ready to Submit / ለግምገማ ዝግጁ</b>

<blockquote>• <b>Sub-City / አካባቢ:</b> <b>${escapeHtml(subcity)}</b>
• <b>Space Type / አይነት:</b> ${escapeHtml(spaceType)}
• <b>Total Rent / ጠቅላላ ኪራይ:</b> <b>${rentNum > 0 ? rentNum.toLocaleString() + ' ETB/mo' : 'Contact for Rent'}</b>
• <b>Roommate Share / ድርሻ:</b> <b>${shareNum > 0 ? shareNum.toLocaleString() + ' ETB/mo' : 'Split equally'}</b>
• <b>Amenities / ግልጋሎቶች:</b> ${escapeHtml(amenitiesList)}
• <b>Host Gender / የባለቤቱ ጾታ:</b> ${escapeHtml(hostGenderDisplay)}
• <b>Preferred Roommate / አጋር:</b> ${escapeHtml(prefGenderDisplay)}
• <b>Photos Attached / ፎቶዎች:</b> ${photosCount} photo(s)</blockquote>

<b>SPACE & ROOMMATE DETAILS / ስለ ክፍሉና መስፈርቶች</b>
<blockquote>${desc}</blockquote>

<blockquote>🔒 <b>Privacy Shield / ሚስጥራዊነት:</b> Direct contacts remain strictly protected under double-blind privacy shield.
ቀጥተኛ አድራሻዎ በጋራ ፈቃድ ብቻ ሚስጥራዊ ሆኖ ይገለጣሉ።</blockquote>
    `.trim();

    const inlineKeyboard = [
      [
        {
          text: 'Submit for Admin Approval / ለአድሚን ማረጋገጫ ላክ >',
          callback_data: `space_submit_admin:${cleanDisplayCode}`,
        },
      ],
      [
        { text: 'Back to Photos / ወደ ፎቶዎች ተመለስ', callback_data: 'space_back_to_photos' },
        { text: 'Restart Space Form / እንደገና ጀምር', callback_data: 'post_branch_space' },
      ],
      [
        { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
      ],
    ];

    const activeMsgId = messageIdToEdit || draft.card_msg_id;
    const newId = await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
    await saveSession({
      telegram_id: chatId,
      step: 'space_preview',
      draft_data: { ...draft, display_code: cleanDisplayCode, card_msg_id: newId || activeMsgId },
      updated_at: new Date().toISOString(),
    }, true);
    return newId;
  };

 // ── Helper: Admin Channel Post Wizard Card Helpers ─────────────────────────
 const sendAdminPostCategoryStep = async (chatId: number, messageIdToEdit?: number) => {
 await saveSession({
 telegram_id: chatId,
 step: 'admin_post_cat',
 draft_data: { card_msg_id: messageIdToEdit },
 updated_at: new Date().toISOString(),
 });

 const targetChannel = await getPrimaryChannel();
 const text = `<b>SpaceMatch Admin · Publish Listing to Channel</b>
Select the category of the post to broadcast to ${targetChannel}:

• <b>Roommate Seeker:</b> Looking for a room or roommate to team up with.
• <b>Have a Room, Seeks Roommate:</b> Has an available room and seeks a roommate to move in.
• <b>Entire Property:</b> Full house or apartment for rent.
 `.trim();

 const inlineKeyboard = [
 [{ text: 'Roommate Seeker / የቤት አጋር ፈላጊ (Needs a Room)', callback_data: 'admin_post_cat:roommate' }],
 [{ text: 'Have a Room, Seeking Roommate / የሚከራይ ክፍል አለኝ', callback_data: 'admin_post_cat:room_avail' }],
 [{ text: 'Entire Property / ሙሉ ቤት የሚከራይ', callback_data: 'admin_post_cat:entire' }],
 [{ text: 'Cancel / ሰርዝ', callback_data: 'nav_start' }],
 ];

 return await sendOrEditCard(chatId, text, inlineKeyboard, messageIdToEdit);
 };

 const sendAdminPostSubcitiesStep = async (
 chatId: number,
 draft: Record<string, any>,
 messageIdToEdit?: number
 ) => {
 const activeMsgId = messageIdToEdit || draft.card_msg_id;
 const selectedList: string[] = draft.locations || ['Bole'];
 const isAllSelected = ALL_SUBCITIES.every((s) => selectedList.includes(s));

 await saveSession({
 telegram_id: chatId,
 step: 'admin_post_subs',
 draft_data: { ...draft, locations: selectedList, card_msg_id: activeMsgId },
 updated_at: new Date().toISOString(),
 }, true);

 const gridRows: any[] = [];
 gridRows.push([
 {
 text: isAllSelected ? '✅ All Selected' : 'Select ALL Sub-Cities',
 callback_data: 'admin_post_sub_all',
 },
 ]);

 for (let i = 0; i < ALL_SUBCITIES.length; i += 2) {
 const row = [];
 const item1 = ALL_SUBCITIES[i];
 const isSel1 = selectedList.includes(item1);
 row.push({
 text: `${isSel1 ? '✅ ' : ''}${item1}`,
 callback_data: `admin_post_sub_toggle:${item1}`,
 });

 if (i + 1 < ALL_SUBCITIES.length) {
 const item2 = ALL_SUBCITIES[i + 1];
 const isSel2 = selectedList.includes(item2);
 row.push({
 text: `${isSel2 ? '✅ ' : ''}${item2}`,
 callback_data: `admin_post_sub_toggle:${item2}`,
 });
 }
 gridRows.push(row);
 }

 gridRows.push([
 { text: 'Proceed to Price / Rent >', callback_data: 'admin_post_proceed_budget' },
 ]);
 gridRows.push([
 { text: 'Back to Category', callback_data: 'admin_post_start' },
 { text: 'Cancel', callback_data: 'nav_start' },
 ]);

 const text = `<b>SpaceMatch Admin · Step 2: Select Sub-Cities</b>
(Tap areas to toggle checkmarks, then tap Proceed)
<b>Selected:</b> <code>${selectedList.join(', ')}</code>
 `.trim();

 await sendOrEditCard(chatId, text, gridRows, activeMsgId);
 };

 const sendAdminPostBudgetStep = async (
 chatId: number,
 draft: Record<string, any>,
 messageIdToEdit?: number,
 errorMsg?: string
 ) => {
 const activeMsgId = messageIdToEdit || draft.card_msg_id;
 const { pending_budget_min: _ignoredMin, ...cleanDraft } = draft || {};
 await saveSession({
 telegram_id: chatId,
 step: 'admin_post_budget',
 draft_data: { ...cleanDraft, card_msg_id: activeMsgId },
 updated_at: new Date().toISOString(),
 });

 const text = `<b>SpaceMatch Admin · Step 3: Rent / Budget Range</b>
${errorMsg ? `<b>${errorMsg}</b>\n\n` : ''}<b>Enter monthly budget/rent range in ETB (e.g. <code>5000 - 12000</code>),</b>
or enter MINIMUM amount first (e.g. <code>5000</code>):
 `.trim();

 const inlineKeyboard = [
 [{ text: 'Back to Sub-Cities', callback_data: 'admin_post_back_to_subs' }],
 [{ text: 'Cancel', callback_data: 'nav_start' }],
 ];

 await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 };

 const sendAdminPostBudgetMaxStep = async (
 chatId: number,
 draft: Record<string, any>,
 minAmount: number,
 messageIdToEdit?: number,
 errorMsg?: string
 ) => {
 const activeMsgId = messageIdToEdit || draft.card_msg_id;
 const suggestedMax = Math.min(1000000, Math.round(minAmount * 1.5));
 await saveSession({
 telegram_id: chatId,
 step: 'admin_post_budget_max',
 draft_data: { ...draft, pending_budget_min: minAmount, card_msg_id: activeMsgId },
 updated_at: new Date().toISOString(),
 });

 const text = `<b>SpaceMatch Admin · Step 3b: Maximum Rent / Budget</b>
${errorMsg ? `<b>${errorMsg}</b>\n\n` : ''}Minimum saved: <b>${minAmount.toLocaleString()} ETB/mo</b>
Now enter the MAXIMUM monthly amount in ETB (e.g. <code>${suggestedMax.toLocaleString()}</code>):
 `.trim();

 const inlineKeyboard = [
 [{ text: 'Change Minimum', callback_data: 'admin_post_back_to_budget' }],
 [{ text: 'Cancel', callback_data: 'nav_start' }],
 ];

 await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 };

 const sendAdminPostGenderStep = async (
 chatId: number,
 draft: Record<string, any>,
 messageIdToEdit?: number
 ) => {
 const activeMsgId = messageIdToEdit || draft.card_msg_id;
 await saveSession({
 telegram_id: chatId,
 step: 'admin_post_gender',
 draft_data: { ...draft, card_msg_id: activeMsgId },
 updated_at: new Date().toISOString(),
 });

 const text = `<b>SpaceMatch Admin · Step 4: Candidate Sex</b>
Select the sex/gender of the person who is listing:
 `.trim();

 const inlineKeyboard = [
 [
 { text: 'Male Candidate', callback_data: 'admin_post_gender:Male' },
 { text: 'Female Candidate', callback_data: 'admin_post_gender:Female' },
 ],
 [{ text: 'Any / Unspecified', callback_data: 'admin_post_gender:Any' }],
 [{ text: 'Back to Price', callback_data: 'admin_post_back_to_budget' }],
 [{ text: 'Cancel', callback_data: 'nav_start' }],
 ];

 await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 };

 const sendAdminPostPrefGenderStep = async (
 chatId: number,
 draft: Record<string, any>,
 messageIdToEdit?: number
 ) => {
 const activeMsgId = messageIdToEdit || draft.card_msg_id;
 await saveSession({
 telegram_id: chatId,
 step: 'admin_post_pref_gender',
 draft_data: { ...draft, card_msg_id: activeMsgId },
 updated_at: new Date().toISOString(),
 });

 const text = `<b>SpaceMatch Admin · Step 5: Preferred Roommate Sex</b>
Select which sex is accepted/preferred to connect with this roommate:
 `.trim();

 const inlineKeyboard = [
 [
 { text: 'Female Only', callback_data: 'admin_post_pref_gender:Female' },
 { text: 'Male Only', callback_data: 'admin_post_pref_gender:Male' },
 ],
 [{ text: 'Any Gender Accepted', callback_data: 'admin_post_pref_gender:Any' }],
 [{ text: 'Back to Candidate Sex', callback_data: 'admin_post_back_to_gender' }],
 [{ text: 'Cancel', callback_data: 'nav_start' }],
 ];

 await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 };

 const sendAdminPostBioStep = async (
 chatId: number,
 draft: Record<string, any>,
 messageIdToEdit?: number
 ) => {
 const activeMsgId = messageIdToEdit || draft.card_msg_id;
 await saveSession({
 telegram_id: chatId,
 step: 'admin_post_bio',
 draft_data: { ...draft, card_msg_id: activeMsgId },
 updated_at: new Date().toISOString(),
 });

 const text = `<b>SpaceMatch Admin · Step 6: Listing Description</b>

Please reply with the description, perks, or notes for this channel post.
(Or reply with <code>default</code> to use standard description)
 `.trim();

 const inlineKeyboard = [
 [{ text: 'Use Standard Description', callback_data: 'admin_post_use_default_bio' }],
 [{ text: 'Back to Preferred Sex', callback_data: 'admin_post_back_to_pref_gender' }],
 [{ text: 'Cancel', callback_data: 'nav_start' }],
 ];

 await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 };

 const sendAdminPostHouseRulesStep = async (
 chatId: number,
 draft: Record<string, any>,
 messageIdToEdit?: number
 ) => {
 const activeMsgId = messageIdToEdit || draft.card_msg_id;
 await saveSession({
 telegram_id: chatId,
 step: 'admin_post_house_rules',
 draft_data: { ...draft, card_msg_id: activeMsgId },
 updated_at: new Date().toISOString(),
 });

 const text = `<b>SpaceMatch Admin · Step 6b: House Rules</b>

Please reply with the house rules for this post (e.g. <code>Clean, no smoking, quiet after 10 PM</code>) or tap a quick option below:
 `.trim();

 const inlineKeyboard = [
 [{ text: 'Clean, Quiet & No Smoking', callback_data: 'admin_post_house_rules:Clean, quiet & no smoking' }],
 [{ text: 'Back to Description', callback_data: 'admin_post_back_to_bio' }],
 [{ text: 'Cancel', callback_data: 'nav_start' }],
 ];

 await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 };

 const sendAdminPostContactStep = async (
 chatId: number,
 draft: Record<string, any>,
 messageIdToEdit?: number
 ) => {
 const activeMsgId = messageIdToEdit || draft.card_msg_id;
 await saveSession({
 telegram_id: chatId,
 step: 'admin_post_contact',
 draft_data: { ...draft, card_msg_id: activeMsgId },
 updated_at: new Date().toISOString(),
 });

 let adminHandle = 'WWEHID';
 try {
 const { data: adminUser } = await supabaseAdmin
 .from('users')
 .select('username')
 .eq('telegram_id', chatId)
 .maybeSingle();
 if (adminUser?.username) {
 adminHandle = adminUser.username.replace('@', '');
 }
 } catch {}

 const text = `<b>SpaceMatch Admin · Step 7: Matched Contact Setup</b>

Who should matched users contact when their connection is unlocked?

• <b>Option 1 — SpaceMatch Concierge (@${adminHandle}):</b>
Tap the button below. Matched users will be connected with you (@${adminHandle}) to coordinate room visits.

• <b>Option 2 — Resident's Real Contact:</b>
Reply in this chat with the resident's contact details:
Format: <code>&lt;Full Name&gt; | &lt;Phone Number&gt; | &lt;@username or None&gt;</code>
Example: <code>Selamawit Tadesse | 0911223344 | @selam_t</code>
 `.trim();

 const inlineKeyboard = [
 [{ text: `SpaceMatch Concierge (@${adminHandle}) / የስፔስማች አስተባባሪ`, callback_data: 'admin_post_contact_concierge' }],
 [{ text: 'Back to Description / ወደ መግለጫ ተመለስ', callback_data: 'admin_post_back_to_bio' }],
 [{ text: 'Cancel / ሰርዝ', callback_data: 'nav_start' }],
 ];

 await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
 };

 const sendAdminPostPreviewCard = async (
 chatId: number,
 draft: Record<string, any>,
 messageIdToEdit?: number
 ) => {
 const activeMsgId = messageIdToEdit || draft.card_msg_id;
 await saveSession({
 telegram_id: chatId,
 step: 'admin_post_preview',
 draft_data: { ...draft, card_msg_id: activeMsgId },
 updated_at: new Date().toISOString(),
 });
 const subcitiesStr = Array.isArray(draft.locations) && draft.locations.length > 0
 ? draft.locations.join(', ')
 : 'Addis Ababa';
 const budgetMin = Number(draft.budget_min || 0);
 const budgetNum = Number(draft.budget_max || draft.budget || 10000);
 const rawCandidate = (draft.gender && draft.gender !== 'Member' ? draft.gender : draft.my_gender) || draft.gender || 'Any';
 const rawGender = rawCandidate.toLowerCase();
 const isCandidateFemale = rawGender.includes('female') || rawGender.includes('ሴት') || rawGender === 'f';
 const isCandidateMale = rawGender.includes('male') || rawGender.includes('ወንድ') || rawGender === 'm';
 const candidateSexPreview = isCandidateFemale ? 'Female (ሴት)' : isCandidateMale ? 'Male (ወንድ)' : (rawCandidate || 'Any Gender');

 const prefGender = draft.preferred_gender || 'Any';
 const rawPrefGender = prefGender.toLowerCase();
 const isPrefFemale = rawPrefGender.includes('female') || rawPrefGender.includes('ሴት');
 const isPrefMale = rawPrefGender.includes('male') || rawPrefGender.includes('ወንድ');
 const prefSexPreview = isPrefFemale ? 'Female Only (ሴት ብቻ)' : isPrefMale ? 'Male Only (ወንድ ብቻ)' : 'Any Gender (ማንኛውም ጾታ)';

 const isSpace = draft.category === 'entire' || draft.category === 'room_avail';
 const isConcierge = draft.is_concierge !== false;
 const contactPreview = isConcierge
 ? `SpaceMatch Concierge (@${draft.contact_username || 'WWEHID'})`
 : `${draft.contact_name || 'Resident'} (${draft.contact_phone || 'N/A'}${draft.contact_username ? `, @${draft.contact_username}` : ''})`;

 const postDraft = {
 ...draft,
 display_code: draft.display_code || (isSpace ? 'SPMARWR1' : 'SPMARBR5'),
 budget_min: budgetMin,
 budget_max: budgetNum,
 space_rent: isSpace ? budgetNum : undefined,
 locations: draft.locations || ['Addis Ababa'],
 };
 const postPreview = isSpace ? formatSpacePost(postDraft) : formatRoommatePost(postDraft);

 const previewText = `<b>SpaceMatch Admin · Review Channel Post / የቻናል ማስታወቂያ ግምገማ</b>
This listing will be saved to Supabase first, then published with tracking buttons:

━━━━━━━━━━━━━━━━━━━━━
${postPreview}

• <b>Contact for Matched Users / የተዛማጆች አድራሻ:</b> <code>${escapeHtml(contactPreview)}</code>

 Personal identity & direct contact remain sealed until mutual match unlock. / ትክክለኛ ማንነት እና አድራሻ እስከ ስምምነት ድረስ ሚስጥራዊ ነው።
━━━━━━━━━━━━━━━━━━━━━
 `.trim();

 const inlineKeyboard = [
 [{ text: 'Publish to Channel Live / ቻናል ላይ ልጠፍ >', callback_data: 'admin_post_confirm' }],
 [
 { text: 'Edit Contact / አድራሻ ቀይር', callback_data: 'admin_post_proceed_contact' },
 { text: 'Cancel / ሰርዝ', callback_data: 'nav_start' },
 ],
 ];

 await sendOrEditCard(chatId, previewText, inlineKeyboard, activeMsgId);
 };

 // Helper: Send Primary Start / Main Menu Screen
 const sendLanguageSelectCard = async (chatId: number, messageIdToEdit?: number) => {
 const text = `<b>Choose your Language / ቋንቋዎን ይምረጡ:</b>

• <b>አማርኛ (Amharic):</b> የተፈጥሮና ቀጥተኛ የአማርኛ ቋንቋ
• <b>English:</b> Standard English interface
 `.trim();
 const keyboard = [
 [
 { text: 'አማርኛ (Amharic)', callback_data: 'set_lang:am' },
 { text: 'English', callback_data: 'set_lang:en' },
 ],
 [{ text: 'Cancel / ሰርዝ', callback_data: 'nav_start' }],
 ];
 return await sendOrEditCard(chatId, text, keyboard, messageIdToEdit);
 };

 // Helper: 100 ETB 3-Month Unified Membership Pass Paywall Card
 const sendMembershipPaywallCard = async (
    chatId: number,
    purpose: 'post_channel' | 'connect_request',
    metadata?: any,
    messageIdToEdit?: number
  ) => {
    const session = getSession(chatId);
    const lang = getLanguage(session.draft_data, chatId);
    const receiverPhone = process.env.TELEBIRR_RECEIVER_PHONE || '0987310978';
    const abyssiniaAccount = process.env.ABYSSINIA_ACCOUNT_NUMBER || '256861771';
    const dashenAccount = process.env.DASHEN_ACCOUNT_NUMBER || '2922175078411';
    const receiptGuideImg = 'https://plusmfmlzzumzsqtlixb.supabase.co/storage/v1/object/public/spaces-public/payment_receipt_guide.png';

    let purposeNotice = purpose === 'connect_request'
      ? `Connect with roommate${metadata?.targetDisplayCode ? ` #${metadata.targetDisplayCode}` : ''} / ከቤት አጋር ጋር ይገናኙ`
      : 'Post your listing to the channel / ማስታወቂያዎን ቻናል ላይ ይለጥፉ';

    const paywallText = `<b>3-Month Pass / የ3 ወር አባልነት (100 ETB)</b>\n\n<blockquote>${purposeNotice}</blockquote>\n\n<b>Payment Accounts (${escapeHtml(paymentAccountHolder)}):</b>\n• <b>Telebirr:</b> <code>${receiverPhone}</code>\n• <b>Abyssinia:</b> <code>${abyssiniaAccount}</code>\n• <b>Dashen:</b> <code>${dashenAccount}</code>\n• <b>CBE:</b> <code>${cbeAccount}</code>\n\n<blockquote>📸 <b>Upload your payment receipt screenshot below for instant verification!</b>\nየከፈሉበትን የደረሰኝ ስክሪንሽት (ፎቶ) ከስር ይላኩ፤ ወዲያውኑ በራስ-ሰር ይረጋገጣል!</blockquote>\n\n<b>Or send transaction code:</b> <code>/verify telebirr YOUR_REF</code>`.trim();

    const paywallKeyboard = [
      [
        { text: '📸 Upload Receipt / ደረሰኝ ላክ', callback_data: 'payment_upload_prompt' },
        { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
      ],
    ];

    let cardMessageId: number | undefined;

    if (ENABLE_DYNAMIC_START_IMAGE) {
      try {
        if (messageIdToEdit) {
          sendTelegram('deleteMessage', { chat_id: chatId, message_id: messageIdToEdit }).catch(() => {});
        }
        const pngBuffer = await generateMembershipCardPng({ isMember: false });
        const photoRes = await sendTelegramPhotoBuffer(chatId, pngBuffer, truncateTelegramHtml(paywallText, 1024), paywallKeyboard, 'membership_info');
        if (photoRes?.ok && photoRes.result?.message_id) {
          cardMessageId = photoRes.result.message_id;
        }
      } catch (err) {
        console.warn('Dynamic card generation failed for membership paywall:', err);
      }
    }

    if (!cardMessageId) {
      cardMessageId = await sendOrEditCard(chatId, paywallText, paywallKeyboard, messageIdToEdit);
    }

    await saveSession({
      telegram_id: chatId,
      step: `awaiting_payment_for_membership:${purpose}`,
      draft_data: {
        ...session.draft_data,
        membership_purpose: purpose,
        membership_metadata: metadata,
        card_msg_id: cardMessageId,
        lang,
      },
      updated_at: new Date().toISOString(),
    }, true);

 return cardMessageId;
 };

 // Helper: Instant Mutual Contact Dossier Reveal
 const revealMutualMatchContacts = async (
 matchId: string,
 triggerChatId?: number,
 messageIdToEdit?: number
 ) => {
 // Concurrency lock: prevent duplicate execution from rapid concurrent clicks across Lambdas
 if (!(await acquireActionLock(`match_unlock:${matchId}`, 15000))) return;

 try {
 const { data: match } = await supabaseAdmin
 .from('matches')
 .select('*, requester:requester_id(*), target:target_id(*)')
 .eq('id', matchId)
 .single();

 if (!match) return;

 const alreadyCompleted = match.status === 'completed';
 const requesterTgForGate = Number((match.requester as any)?.telegram_id || 0);
 if (!alreadyCompleted && requesterTgForGate > 0) {
 const gateMem = await getUserMembershipStatus(requesterTgForGate);
 if (!gateMem.isActive) {
 console.warn(`[revealMutualMatchContacts] Blocked reveal for match ${matchId}: requester ${requesterTgForGate} lacks active 100 ETB pass.`);
 return;
 }
 }

 if (!alreadyCompleted) {
 const { error: updateMatchErr } = await supabaseAdmin
 .from('matches')
 .update({
 payment_status: 'both_paid',
 status: 'completed',
 completed_at: new Date().toISOString(),
 })
 .eq('id', matchId);
 if (updateMatchErr) {
 console.error('[revealMutualMatchContacts] match update error:', updateMatchErr);
 return;
 }
 }

 const requesterData = match.requester as any;
 const targetData = match.target as any;

 const requesterTgId = requesterData?.telegram_id;
 const targetTgId = targetData?.telegram_id;

 const requesterIsAm = requesterTgId ? getUserLanguage(requesterTgId) === 'am' : false;
 const targetIsAm = targetTgId ? getUserLanguage(targetTgId) === 'am' : false;

 const resolveContactDossier = async (profile: any, _isAmUser: boolean) => {
 let cleanHandle = (profile?.telegram_username || '').replace('@', '').trim();
 let phone = (profile?.phone_number || '').trim();
 let name = (profile?.full_name || '').trim();

 // Fetch real contact details from users table for real members (telegram_id > 0)
 if (profile?.telegram_id && profile.telegram_id > 0) {
 try {
 const { data: dbUser } = await supabaseAdmin
 .from('users')
 .select('first_name, last_name, phone_number, username')
 .eq('telegram_id', profile.telegram_id)
 .maybeSingle();

 if (dbUser) {
 if (dbUser.phone_number && !/^admin[:_]/i.test(dbUser.phone_number)) {
 phone = dbUser.phone_number.trim();
 }
 if (dbUser.username && !/^admin[:_]/i.test(dbUser.username) && !dbUser.username.includes(':')) {
 cleanHandle = dbUser.username.replace('@', '').trim();
 }
 const dbName = [dbUser.first_name, dbUser.last_name].filter(Boolean).join(' ').trim();
 if (dbName && (!name || name === 'Verified Member' || name === 'የተረጋገጠ አባል')) {
 name = dbName;
 }
 }
 } catch (err) {
 console.warn('[resolveContactDossier] users lookup warning:', err);
 }
 }

 const sanitized = sanitizeContactDossier({
 fullName: name,
 phoneNumber: phone,
 telegramUsername: cleanHandle,
 telegramId: profile?.telegram_id,
 });

 const isConcierge = sanitized.isConciergeOrSynthetic;
 cleanHandle = sanitized.telegramUsername;
 const tgHandle = cleanHandle ? `@${cleanHandle}` : 'Not provided / አልተገለጸም';
 const displayPhone = sanitized.phoneNumber;
 const displayName = sanitized.fullName;

 const closingBlockquote = isConcierge && cleanHandle
 ? `<blockquote>Managed by SpaceMatch Concierge. Tap below to coordinate directly with our coordinator! / ይህ ማስታወቂያ በአስተዳዳሪ በኩል የሚስተናገድ ነው። ከታች ያለውን ቁልፍ በመጫን በቀጥታ ይገናኙ።</blockquote>`
 : `<blockquote>Good luck finding your home together! / መልካም የጋራ ኑሮ ይሁንላችሁ! </blockquote>`;

 const msg = `<b>YOU'RE MATCHED!</b>\n<b>እንኳን ደስ አላችሁ! ተዛምዳችኋል!</b>\n\n<blockquote>Membership confirmed! Your connection is complete.\nአባልነትዎ ተረጋግጧል። ግንኙነታችሁ ተጠናቋል!</blockquote>\n\n<b>MUTUAL CONTACT DETAILS / የግል መረጃ</b>\n\n• <b>Name / ስም:</b> <b>${escapeHtml(displayName)}</b>\n• <b>Phone / ስልክ:</b> <code>${escapeHtml(displayPhone)}</code>\n• <b>Telegram / ቴሌግራም:</b> ${tgHandle}\n\n${closingBlockquote}`;

 const buttonText = isConcierge
 ? ` Chat with Coordinator / ከአስተዳዳሪ ጋር አውራ (@${cleanHandle}) ↗`
 : ` Open Chat with ${displayName.split(' ')[0]} / በቴሌግራም አውራ ↗`;

 const markup = cleanHandle
 ? { inline_keyboard: [[{ text: buttonText, url: `https://t.me/${cleanHandle}` }]] }
 : undefined;

 return { text: msg, cleanHandle, markup, isConcierge };
 };

 const getDisclaimerText = (_isAmUser: boolean) =>
 `<b>Safety Notice / ማሳሰቢያ:</b>\n\n<blockquote>SpaceMatch verifies identity and facilitates verified roommate connections. Please exercise standard personal discretion when visiting shared spaces.\nየእኛ ስራ የተረጋገጡ የቤት ጓደኞችን ማገናኘት ነው። ቤቱን በአካል ሲጎበኙ አስፈላጊውን የግል ጥንቃቄ ያድርጉ።</blockquote>`;

 const targetContact = await resolveContactDossier(targetData, requesterIsAm);
 const requesterContact = await resolveContactDossier(requesterData, targetIsAm);

 const explicitAdminTg = Number((targetData?.telegram_username || '').match(/^admin[_:](\d+)$/i)?.[1] || 0);
 const targetNotifyId = (targetTgId && targetTgId > 0)
 ? targetTgId
 : (explicitAdminTg > 0 ? explicitAdminTg : ((await getAdminIds())[0] || 980853835));

 // If already completed and user re-clicked or arrived late, only update caller card without re-notifying other party
 if (alreadyCompleted) {
 if (triggerChatId && messageIdToEdit) {
 const isTarget = triggerChatId === targetNotifyId;
 const cardContact = isTarget ? requesterContact : targetContact;
 const cardIsAm = isTarget ? targetIsAm : requesterIsAm;
 const cardText = `${getDisclaimerText(cardIsAm)}\n\n${cardContact.text}`;
 const cardButtons = [
 ...(cardContact.markup ? cardContact.markup.inline_keyboard : []),
 [{ text: cardIsAm ? ' ዋና ማውጫ' : ' Main Menu', callback_data: 'nav_start' }],
 ];
 await sendOrEditCard(triggerChatId, cardText, cardButtons, messageIdToEdit);
 }
 return;
 }

 if (requesterTgId && requesterTgId > 0) {
 await tgSend(requesterTgId, getDisclaimerText(requesterIsAm));
 await tgSend(requesterTgId, targetContact.text, targetContact.markup);
 }

 if (targetNotifyId) {
 if (triggerChatId === targetNotifyId && messageIdToEdit) {
 const targetCardText = `${getDisclaimerText(targetIsAm)}\n\n${requesterContact.text}`;
 const targetCardButtons = [
 ...(requesterContact.markup ? requesterContact.markup.inline_keyboard : []),
 [{ text: targetIsAm ? ' ዋና ማውጫ' : ' Main Menu', callback_data: 'nav_start' }],
 ];
 await sendOrEditCard(targetNotifyId, targetCardText, targetCardButtons, messageIdToEdit);
 } else {
 await tgSend(targetNotifyId, getDisclaimerText(targetIsAm));
 await tgSend(targetNotifyId, requesterContact.text, requesterContact.markup);
 }
 }
 } finally {
 await releaseActionLock(`match_unlock:${matchId}`);
 }
 };

 // Helper: Submit Seeker Listing to Admin Approval
 const submitSeekerListingToAdmin = async (
 chatId: number,
 metadata?: any,
 messageIdToEdit?: number,
 fromCallbackUser?: any
 ) => {
 if (!(await isUserFaydaVerified(chatId))) {
 await sendFaydaGateCard(chatId, 'post your roommate listing on our channel', messageIdToEdit);
 return;
 }

 const session = getSession(chatId);
 const draft = session.draft_data || {};

 let prof: any = null;
 const { data: pData } = await supabaseAdmin.from('profiles').select('*').eq('telegram_id', chatId).maybeSingle();
 prof = pData;

 let displayCode = (metadata?.displayCode || prof?.display_code || draft.display_code || '').replace(/^#/, '');
 if (!displayCode || !displayCode.toUpperCase().startsWith('SPMARBR')) {
 displayCode = await getNextSpmarbrCode('seeker');
 }

 const subcities = metadata?.subcities || (Array.isArray(prof?.locations) && prof.locations.length > 0 ? prof.locations : (Array.isArray(draft.preferred_subcity) ? draft.preferred_subcity : ['Addis Ababa']));
 const subcitiesStr = Array.isArray(subcities) ? subcities.join(', ') : String(subcities);
 const budgetMin = Number(metadata?.budgetMin ?? draft.budget_min ?? prof?.budget_min ?? 0);
 const budgetNum = Number(metadata?.budgetNum ?? draft.budget_max ?? prof?.budget_max ?? 10000);
 const budgetLabel = formatBudgetRangeLabel(budgetMin, budgetNum, 'Flexible');
 const genderStr = metadata?.genderStr || (prof?.gender && prof?.gender !== 'Member' ? prof?.gender : draft.gender) || prof?.gender || 'Member';
 const prefGenderStr = metadata?.prefGenderStr || prof?.preferred_gender || draft.preferred_gender || 'Any';
 const prefGenderFormatted = prefGenderStr === 'Female' ? 'Female Only' : prefGenderStr === 'Male' ? 'Male Only' : 'Any Gender';
 const userAge = metadata?.userAge || draft.age || prof?.age || 24;
 const rawBio = metadata?.bioStr || draft.description || draft.details || prof?.roommate_traits || draft.roommate_traits || draft.lifestyle_bio || '';
 const bioStr = extractUserDescription(rawBio) || rawBio || `Seeking roommate in ${subcitiesStr}.`;
 const houseRulesStr = (metadata?.houseRules || draft.house_rules || extractHouseRulesFromTraits(rawBio) || 'Clean, quiet & respectful').trim();
 const traitsWithRules = `Prefers: ${prefGenderFormatted} | Rules: ${houseRulesStr} | ${bioStr}`;
 const ageStr = `${userAge} yrs`;

 const { error: profUpsertErr } = await supabaseAdmin.from('profiles').upsert({
 telegram_id: chatId,
 display_code: prof?.display_code && String(prof.display_code).toUpperCase().startsWith('SPMARWR') ? prof.display_code : displayCode,
 gender: genderStr,
 locations: Array.isArray(subcities) ? subcities : [subcities],
 budget_min: budgetMin,
 budget_max: budgetNum,
 roommate_traits: traitsWithRules,
 kyc_status: 'verified',
 status: 'paused',
 onboarding_step: 'pending_approval',
 }, { onConflict: 'telegram_id' });
 if (profUpsertErr) {
 console.error('[submitSeekerListingToAdmin] profiles upsert error:', profUpsertErr);
 }
 await saveSession({
   telegram_id: chatId,
   step: 'idle',
   draft_data: buildCleanFlowDraft(chatId, draft),
   updated_at: new Date().toISOString(),
 }, true);

 const userName = [fromCallbackUser?.first_name, fromCallbackUser?.last_name].filter(Boolean).join(' ') || prof?.full_name || 'Roommate Seeker';
 const username = fromCallbackUser?.username || prof?.telegram_username || null;

 await saveRoommateDraft({
 id: displayCode,
 display_code: displayCode,
 user_telegram_id: chatId,
 user_name: userName,
 username: username,
 preferred_subcity: Array.isArray(subcities) ? subcities : [subcities],
 my_gender: genderStr,
 age: userAge,
 preferred_gender: prefGenderStr,
 budget_min: budgetMin,
 budget_max: budgetNum,
 house_rules: houseRulesStr,
 lifestyle_bio: traitsWithRules,
 unlock_fee: 100,
 fayda_status: 'verified',
 status: 'pending_approval',
 created_at: new Date().toISOString(),
 updated_at: new Date().toISOString(),
 });

 const lang = getLanguage(draft, chatId);
 const isAm = lang === 'am';
 const targetChannel = await getPrimaryChannel();

 const userConfirmText = `<b>Congratulations, you have successfully registered! / እንኳን ደስ አለዎት፣ በተሳካ ሁኔታ ተመዝግበዋል!</b>
<b>Profile Submitted for Activation / መረጃዎ ለግምገማ በተሳካ ሁኔታ ደርሷል</b>

<blockquote>• <b>Listing Code / መለያ ኮድ:</b> <code>#${displayCode}</code>
• <b>Target Areas / አካባቢዎች:</b> <code>${subcitiesStr}</code>
• <b>Budget Range / በጀት:</b> <code>${escapeHtml(budgetLabel)}</code>
• <b>House Rules / የቤት ህጎች:</b> ${escapeHtml(houseRulesStr)}
• <b>Status / ሁኔታ:</b> <b>Pending Admin Review / በግምገማ ላይ</b>
• <b>Target Channel / ዒላማ ቻናል:</b> <code>${targetChannel}</code></blockquote>

<blockquote><b>Privacy Shield / ሚስጥራዊነት የተጠበቀ:</b>
Your real name, phone number, and Telegram handle remain 100% private. Once approved, your listing will be published and you will be notified immediately!
ትክክለኛ ስምዎ፣ ስልክ ቁጥርዎ እና የቴሌግራም አድራሻዎ በፍጹም አይገለጥም። አድሚኑ መረጃውን እንዳረጋገጠ ወደ ቻናሉ ይለጠፋል!</blockquote>
 `.trim();

 const userConfirmKeyboard = [
 [{ text: 'Find Matching Roommates Now / አጋሮችን አሁኑኑ ፈልግ >', callback_data: 'matchmaker_start' }],
 [
 { text: 'View My Listings / ማስታወቂያዎቼ', callback_data: 'my_listings' },
 { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
 ],
 ];

 if (ENABLE_DYNAMIC_START_IMAGE) {
 try {
 const pngBuffer = await generateCongratulationsCardPng({
 userName: fromCallbackUser?.first_name || 'Resident',
 isMember: true,
 });
 if (messageIdToEdit) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: messageIdToEdit }).catch(() => {});
 }
 const pRes = await sendTelegramPhotoBuffer(chatId, pngBuffer, truncateTelegramHtml(userConfirmText, 1024), userConfirmKeyboard);
 if (!pRes?.ok) {
 await sendOrEditCard(chatId, userConfirmText, userConfirmKeyboard);
 }
 } catch {
 await sendOrEditCard(chatId, userConfirmText, userConfirmKeyboard, messageIdToEdit);
 }
 } else {
 await sendOrEditCard(chatId, userConfirmText, userConfirmKeyboard, messageIdToEdit);
 }

 // Notify admins
 try {
 const adminIds = await getAdminIds();
 const cleanUser = (username || '').replace('@', '');
 const userIdentifier = cleanUser ? `@${cleanUser}` : `ID ${chatId}`;

 const adminApprovalCard = `<b>SpaceMatch Admin · New Profile Pending Approval!</b>

A user has requested to post their profile to the channel <code>${targetChannel}</code>:

• <b>Seeker Code:</b> <b>#${displayCode}</b>
• <b>Sex:</b> ${genderStr}
• <b>Preferred Sex:</b> ${prefGenderFormatted}
• <b>Age:</b> ${ageStr}
• <b>Budget Range:</b> <code>${escapeHtml(budgetLabel)}</code>
• <b>Target Areas:</b> <code>${subcitiesStr}</code>
• <b>House Rules:</b> ${escapeHtml(houseRulesStr)}
• <b>Description:</b> ${bioStr}
• <b>Pass Status:</b> 3-Month Pass Active 
• <b>Fayda Status:</b> Verified Resident 
<blockquote>"${bioStr}"</blockquote>

Admin Reference: User ${userIdentifier} (<code>${chatId}</code>)
 `.trim();

 const adminButtons = {
 inline_keyboard: [
 [{ text: `Approve & Broadcast #${displayCode} >`, callback_data: `admin_approve_profile:${displayCode}` }],
 [{ text: `Reject Listing #${displayCode}`, callback_data: `admin_reject_profile:${displayCode}` }],
 ],
 };

 for (const adminId of adminIds) {
 await tgSend(adminId, adminApprovalCard, adminButtons).catch(() => {});
 }
 } catch (err) {
 console.error('[submitSeekerListingToAdmin] admin notify error:', err);
 }
 };

 // Helper: Submit Space Listing to Admin Approval
 const submitSpaceListingToAdmin = async (
 chatId: number,
 metadata?: any,
 messageIdToEdit?: number,
 fromCallbackUser?: any
 ) => {
 const isVerified = await isUserFaydaVerified(chatId);
 const session = getSession(chatId);
 const draft = session.draft_data || {};

 if (!isVerified) {
 await saveSession({
 telegram_id: chatId,
 step: session.step || 'idle',
 draft_data: {
 ...draft,
 return_flow: 'submit_space',
 membership_purpose: 'post_channel',
 membership_metadata: { ...(metadata || {}), isSpace: true, category: 'space_available' },
 },
 updated_at: new Date().toISOString(),
 }, true);
 await sendFaydaGateCard(chatId, 'verify Fayda before submitting your space listing', messageIdToEdit, {
   return_flow: 'submit_space',
   membership_purpose: 'post_channel',
   membership_metadata: { ...(metadata || {}), isSpace: true, category: 'space_available' },
 });
 return;
 }

 let cleanCode = (metadata?.cleanCode || draft.display_code || '').trim().replace(/^#/, '');
 if (!cleanCode || cleanCode.startsWith('RM') || !cleanCode.toUpperCase().startsWith('SPMARWR')) {
 cleanCode = await getNextSpmarbrCode('space_available');
 }

 const subcity = metadata?.subcity || draft.preferred_subcity?.[0] || draft.location || 'Addis Ababa';
 const rentNum = Number(metadata?.rentNum ?? draft.space_rent ?? 0);
 const shareNum = Number(metadata?.shareNum ?? draft.space_share ?? 0);
 const amenities = metadata?.amenities || draft.space_amenities || [];
 const photos = metadata?.photos || draft.space_photos || [];
 const spaceType = metadata?.spaceType || draft.space_type || 'Private Bedroom in Shared Flat';
 const ownerGender = metadata?.ownerGender || draft.owner_gender || draft.gender || draft.my_gender || 'Member';
 const prefGender = metadata?.prefGender || draft.preferred_tenant_gender || draft.preferred_gender || 'Any';
 const desc = metadata?.desc || draft.description || draft.preferred_roommate || draft.roommate_traits || 'Roommate available with a room in Addis Ababa.';
 const userAge = metadata?.age || draft.age || 24;

 const [{ data: existingSpaceProf }, { data: dbUser }] = await Promise.all([
   supabaseAdmin.from('profiles').select('display_code').eq('telegram_id', chatId).maybeSingle(),
   supabaseAdmin.from('users').select('first_name, last_name, username').eq('telegram_id', chatId).maybeSingle(),
 ]);

 const resolvedOwnerName =
   [fromCallbackUser?.first_name, fromCallbackUser?.last_name].filter(Boolean).join(' ') ||
   metadata?.full_name ||
   [dbUser?.first_name, dbUser?.last_name].filter(Boolean).join(' ') ||
   'Verified Space Owner';
 const resolvedOwnerUsername = fromCallbackUser?.username || dbUser?.username || null;

 // Preserve user's existing SPMARBR Seeker row if they have one; only write Space to profiles if no active Seeker row exists
 if (!existingSpaceProf?.display_code || !String(existingSpaceProf.display_code).toUpperCase().startsWith('SPMARBR')) {
   await supabaseAdmin.from('profiles').upsert({
     telegram_id: chatId,
     display_code: cleanCode,
     gender: ownerGender,
     locations: [subcity],
     budget_min: shareNum,
     budget_max: rentNum,
     roommate_traits: `Age ${userAge} · Prefers: ${prefGender} · ${desc}`,
     kyc_status: 'verified',
     status: 'paused',
     onboarding_step: 'pending_approval',
   }, { onConflict: 'telegram_id' });
 }

 await saveRoommateDraft({
 id: cleanCode,
 user_telegram_id: chatId,
 display_code: cleanCode,
 user_name: resolvedOwnerName,
 username: resolvedOwnerUsername,
 age: userAge,
 my_gender: ownerGender,
 preferred_gender: prefGender,
 preferred_subcity: [subcity],
 budget_min: shareNum,
 budget_max: rentNum,
 lifestyle_bio: desc,
 preferred_roommate: desc,
 listing_category: 'space_available',
 space_type: spaceType,
 space_rent: rentNum,
 space_share: shareNum,
 space_amenities: amenities,
 space_photos: photos,
 status: 'pending_approval',
 unlock_fee: 100,
 fayda_status: 'verified',
 created_at: new Date().toISOString(),
 updated_at: new Date().toISOString(),
 });

 await saveSession({
   telegram_id: chatId,
   step: 'idle',
   draft_data: buildCleanFlowDraft(chatId, draft),
   updated_at: new Date().toISOString(),
 }, true);

 const lang = getLanguage(draft, chatId);
 const isAm = lang === 'am';
 const targetChannel = await getPrimaryChannel();

 const userConfirmText = `<b>Congratulations, you have successfully registered! / እንኳን ደስ አለዎት፣ በተሳካ ሁኔታ ተመዝግበዋል!</b>
<b>Space Listing Submitted for Activation / የክፍል መረጃዎ ለግምገማ በተሳካ ሁኔታ ደርሷል</b>

<blockquote>• <b>Listing Code / መለያ ኮድ:</b> <code>#${escapeHtml(cleanCode)}</code>
• <b>Space Type / አይነት:</b> ${escapeHtml(spaceType)}
• <b>Total Rent / ጠቅላላ ኪራይ:</b> <b>${rentNum > 0 ? rentNum.toLocaleString() + ' ETB/mo' : 'Contact for Rent'}</b>
• <b>Roommate Share / ድርሻ:</b> <b>${shareNum > 0 ? shareNum.toLocaleString() + ' ETB/mo' : 'Split equally'}</b>
• <b>Status / ሁኔታ:</b> <b>Pending Admin Review / በግምገማ ላይ</b>
• <b>Target Channel / ዒላማ ቻናል:</b> <code>${escapeHtml(targetChannel)}</code></blockquote>

<blockquote><b>Privacy Shield / ሚስጥራዊነት የተጠበቀ:</b>
Direct contact details stay protected. Once approved, your space listing will be published and you will be notified immediately!
ቀጥተኛ አድራሻዎ ሙሉ በሙሉ የተጠበቀ ነው። ልክ በአድሚን እንደጸደቀ ወደ ቻናሉ ይለጠፋል!</blockquote>
  `.trim();

  const userConfirmKeyboard = [
    [{ text: 'Find Matching Roommates Now / አጋሮችን አሁኑኑ ፈልግ >', callback_data: 'matchmaker_start' }],
    [
      { text: 'View My Listings / ማስታወቂያዎቼ', callback_data: 'my_listings' },
      { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
    ],
  ];

  if (ENABLE_DYNAMIC_START_IMAGE) {
    try {
      const pngBuffer = await generateCongratulationsCardPng({
        userName: fromCallbackUser?.first_name || 'Resident',
        isMember: true,
      });
      if (messageIdToEdit) {
        sendTelegram('deleteMessage', { chat_id: chatId, message_id: messageIdToEdit }).catch(() => {});
      }
      const pRes = await sendTelegramPhotoBuffer(chatId, pngBuffer, truncateTelegramHtml(userConfirmText, 1024), userConfirmKeyboard);
      if (!pRes?.ok) {
        await sendOrEditCard(chatId, userConfirmText, userConfirmKeyboard);
      }
    } catch {
      await sendOrEditCard(chatId, userConfirmText, userConfirmKeyboard, messageIdToEdit);
    }
  } else {
    await sendOrEditCard(chatId, userConfirmText, userConfirmKeyboard, messageIdToEdit);
  }

 // Notify admins
 try {
 const adminIds = await getAdminIds();
 const cleanUser = (fromCallbackUser?.username || '').replace('@', '');
 const userIdentifier = cleanUser ? `@${cleanUser}` : `ID ${chatId}`;

 const adminNotificationText = `<b>SpaceMatch Admin · Space Listing Pending Review!</b>

A user has submitted a space offering for channel <code>${targetChannel}</code>:

• <b>Listing:</b> <b>#${cleanCode}</b> (Roommate with Room)
• <b>Space Type:</b> ${spaceType}
• <b>Total Rent:</b> <code>${rentNum.toLocaleString()} ETB / mo</code>
• <b>Roommate Share:</b> <code>${shareNum.toLocaleString()} ETB / mo</code>
• <b>Location:</b> <code>${subcity}</code>
• <b>Photos:</b> ${photos.length} photo(s) attached
• <b>Sex:</b> ${ownerGender}
• <b>Preferred Sex:</b> ${prefGender}
• <b>Description:</b> ${desc}
• <b>Pass Status:</b> 3-Month Pass Active 
• <b>Resident:</b> Age ${userAge} ( Fayda Verified)

Admin Reference: User ${userIdentifier} (<code>${chatId}</code>)
 `.trim();

 const adminButtons = {
 inline_keyboard: [
 [{ text: `Approve & Broadcast #${cleanCode} >`, callback_data: `admin_approve_profile:${cleanCode}` }],
 [{ text: `Reject Listing #${cleanCode}`, callback_data: `admin_reject_profile:${cleanCode}` }],
 ],
 };

 for (const adminId of adminIds) {
 let res: any = null;
 if (photos.length > 0) {
 const photoRes = await sendTelegram('sendPhoto', {
 chat_id: adminId,
 photo: photos[0],
 caption: adminNotificationText.slice(0, 1024),
 parse_mode: 'HTML',
 reply_markup: adminButtons,
 });
 if (photoRes?.ok) res = photoRes;
 }
 if (!res) {
 await tgSend(adminId, adminNotificationText, adminButtons).catch(() => {});
 }
 }
 } catch (err) {
 console.error('[submitSpaceListingToAdmin] admin notify error:', err);
 }
 };

 // Helper: Execute Direct Match Request (Free when Pass is Active)
 const executeDirectMatchRequest = async (
 chatId: number,
 targetProfileId: string,
 messageIdToEdit?: number
 ) => {
 // Defense-in-depth: Verify Fayda ID & 3-Month Pass before sending any connection request
 if (!(await isUserFaydaVerified(chatId))) {
 await sendFaydaGateCard(chatId, 'connect with verified roommates', messageIdToEdit);
 return;
 }

 const mem = await getUserMembershipStatus(chatId);
 if (!mem.isActive) {
 await sendMembershipPaywallCard(
 chatId,
 'connect_request',
 {
 targetProfileId,
 },
 messageIdToEdit
 );
 return;
 }

 const { data: requesterProfile } = await supabaseAdmin
 .from('profiles')
 .select('*')
 .eq('telegram_id', chatId)
 .maybeSingle();

 if (!requesterProfile) {
 await sendOrEditCard(
 chatId,
 `<b>Complete Profile First / መጀመሪያ መረጃዎን ይሙሉ</b>\n\n<blockquote>Please finish your short roommate profile before sending a connection request.\nየግንኙነት ጥያቄ ከመላክዎ በፊት እባክዎ አጭር የቤት አጋር መገለጫዎን ይሙሉ።</blockquote>`,
 [
 [{ text: 'Complete Profile / መረጃ ሙላ >', callback_data: 'matchmaker_start' }],
 [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ],
 messageIdToEdit
 );
 return;
 }
 if (requesterProfile.id === targetProfileId) return;

 const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetProfileId);
 let targetProfile: any = null;
 if (isUuid) {
 const { data: pTarget } = await supabaseAdmin.from('profiles').select('*').eq('id', targetProfileId).maybeSingle();
 if (pTarget) targetProfile = pTarget;
 }
 if (!targetProfile) {
 const cleanCode = targetProfileId.replace(/^#/, '').trim();
 const { data: pTarget } = await supabaseAdmin.from('profiles').select('*').ilike('display_code', cleanCode).maybeSingle();
 if (pTarget) targetProfile = pTarget;
 }
 if (!targetProfile && isUuid) {
 const { data: rmTarget } = await supabaseAdmin.from('roommate_profiles').select('*').eq('id', targetProfileId).maybeSingle();
 if (rmTarget) {
 targetProfile = {
 id: rmTarget.id,
 telegram_id: rmTarget.user_telegram_id,
 display_code: `RM${String(rmTarget.id).slice(0, 6).toUpperCase()}`,
 gender: rmTarget.my_gender,
 preferred_gender: rmTarget.preferred_gender,
 locations: rmTarget.preferred_subcity,
 budget_min: rmTarget.budget_min,
 budget_max: rmTarget.budget_max,
 roommate_traits: rmTarget.lifestyle_bio,
 status: rmTarget.status,
 };
 }
 }
 if (!targetProfile) {
 const cleanSpaceKey = targetProfileId.replace(/^#/, '').trim();
 const spaceRow = isUuid
 ? (await supabaseAdmin.from('spaces').select('*').eq('id', cleanSpaceKey).maybeSingle()).data
 : null;
 const draftSpace = !spaceRow ? await getDraft(cleanSpaceKey) : null;
 const rmDraft = !spaceRow && !draftSpace ? await getRoommateDraft(cleanSpaceKey) : null;

 if (spaceRow) {
 targetProfile = {
 id: spaceRow.id,
 telegram_id: -(1000000000 + Math.abs(cleanSpaceKey.split('').reduce((a, c) => ((a * 31 + c.charCodeAt(0)) | 0), 7) % 900000)),
 display_code: cleanSpaceKey.slice(0, 8).toUpperCase(),
 gender: 'Any',
 preferred_gender: 'Any',
 locations: [spaceRow.neighborhood || 'Addis Ababa'],
 budget_min: 0,
 budget_max: Number(spaceRow.price_per_month || 10000),
 roommate_traits: spaceRow.description || spaceRow.title,
 full_name: spaceRow.contact_name || 'Space Host',
 phone_number: spaceRow.contact_phone || null,
 telegram_username: spaceRow.contact_telegram || null,
 status: spaceRow.status,
 };
 } else if (draftSpace) {
 targetProfile = {
 id: draftSpace.id,
 telegram_id: draftSpace.homeowner_telegram_id,
 display_code: cleanSpaceKey,
 gender: draftSpace.owner_gender || 'Any',
 preferred_gender: draftSpace.preferred_tenant_gender || 'Any',
 locations: [draftSpace.neighborhood || 'Addis Ababa'],
 budget_min: 0,
 budget_max: Number(draftSpace.price_per_month || 10000),
 roommate_traits: draftSpace.description || draftSpace.title,
 full_name: draftSpace.homeowner_name || 'Space Host',
 phone_number: draftSpace.contact_phone || null,
 telegram_username: draftSpace.homeowner_username || null,
 status: draftSpace.status,
 };
 } else if (rmDraft) {
 targetProfile = {
 id: rmDraft.id,
 telegram_id: rmDraft.user_telegram_id,
 display_code: rmDraft.display_code || cleanSpaceKey,
 gender: rmDraft.my_gender || 'Member',
 preferred_gender: rmDraft.preferred_gender || 'Any',
 locations: rmDraft.preferred_subcity || ['Addis Ababa'],
 budget_min: Number(rmDraft.budget_min || 0),
 budget_max: Number(rmDraft.budget_max || 10000),
 roommate_traits: rmDraft.lifestyle_bio || 'Channel Listing',
 full_name: rmDraft.user_name || 'Verified Member',
 phone_number: rmDraft.contact_phone || rmDraft.phone_number || null,
 telegram_username: rmDraft.username || null,
 status: rmDraft.status,
 };
 }
 }

 if (!targetProfile) {
 await sendOrEditCard(
 chatId,
 `<b>Listing Not Found / ማስታወቂያው አልተገኘም</b>\n\n<blockquote>This listing is no longer available.\nይህ ማስታወቂያ አሁን አይገኝም።</blockquote>`,
 [[{ text: 'Browse Open Matches / ሌሎችን እይ', callback_data: 'matchmaker_start' }], [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }]],
 messageIdToEdit
 );
 return;
 }

 const targetStatus = String(targetProfile.status || '').toLowerCase();
 if (['matched', 'closed', 'archived', 'rejected', 'rented'].includes(targetStatus)) {
 await sendOrEditCard(
 chatId,
 `<b>Listing Closed / ማስታወቂያው ተዘግቷል</b>\n\n<blockquote>This roommate or space listing is already closed/matched.\nይህ ማስታወቂያ ቀድሞውኑ ተዘግቷል ወይም ተዛምዷል።</blockquote>`,
 [[{ text: 'Browse Open Matches / ሌሎችን እይ', callback_data: 'matchmaker_start' }], [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }]],
 messageIdToEdit
 );
 return;
 }

 if (targetProfile.telegram_id && String(targetProfile.telegram_id) === String(chatId)) {
 await sendOrEditCard(
 chatId,
 `<b>Own Listing / የራስዎ ማስታወቂያ</b>\n\n<blockquote>You cannot send a connection request to your own listing.\nለራስዎ ማስታወቂያ የግንኙነት ጥያቄ መላክ አይችሉም።</blockquote>`,
 [[{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }]],
 messageIdToEdit
 );
 return;
 }

 if (requesterProfile.gender && requesterProfile.gender !== 'Member') {
 const gCheck = checkGenderPreferenceMatch(
 targetProfile.preferred_gender,
 targetProfile.roommate_traits,
 requesterProfile.gender
 );
 if (!gCheck.allowed) {
 const isAm = getUserLanguage(chatId) === 'am';
 const { text: mismatchText, keyboard: mismatchKb } = getGenderMismatchCard(
 isAm,
 targetProfile.id || targetProfileId,
 gCheck.targetPrefFormattedEn,
 gCheck.targetPrefFormattedAm,
 requesterProfile.gender
 );
 await sendOrEditCard(chatId, mismatchText, mismatchKb, messageIdToEdit);
 return;
 }
 } else {
 // Enforce explicit gender before connecting with a gender-specific target
 const targetPref = String(targetProfile.preferred_gender || '').toLowerCase();
 if (targetPref === 'male' || targetPref === 'female') {
 await sendOrEditCard(
 chatId,
 `<b>Gender Confirmation Required / የጾታ መረጃ ያስፈልጋል</b>\n\n<blockquote>This listing specifies a gender preference (<b>${escapeHtml(targetProfile.preferred_gender)}</b>). Please update your profile gender before connecting.\n\nይህ ማስታወቂያ የተወሰነ የጾታ ምርጫ ስላለው መጀመሪያ የጾታ መረጃዎን ያስተካክሉ።</blockquote>`,
 [[{ text: 'Edit Profile / መረጃ አሻሽል >', callback_data: 'post_profile_start' }], [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }]],
 messageIdToEdit
 );
 return;
 }
 }

 if (targetProfile && targetProfile.telegram_id) {
 const { data: pExisting } = await supabaseAdmin
 .from('profiles')
 .select('*')
 .eq('telegram_id', targetProfile.telegram_id)
 .maybeSingle();

 if (pExisting) {
 targetProfile = pExisting;
 } else {
 const { data: createdTarget } = await supabaseAdmin
 .from('profiles')
 .upsert({
 telegram_id: targetProfile.telegram_id,
 display_code: targetProfile.display_code || `RM${String(targetProfile.telegram_id).slice(-4)}`,
 gender: targetProfile.gender || targetProfile.my_gender || 'Member',
 preferred_gender: targetProfile.preferred_gender || 'Any',
 locations: targetProfile.locations || targetProfile.preferred_subcity || ['Addis Ababa'],
 budget_min: targetProfile.budget_min || 0,
 budget_max: targetProfile.budget_max || 10000,
 roommate_traits: targetProfile.roommate_traits || targetProfile.lifestyle_bio || 'Channel Roommate Listing',
 full_name: targetProfile.full_name || null,
 phone_number: targetProfile.phone_number || null,
 telegram_username: targetProfile.telegram_username || null,
 kyc_status: 'verified',
 status: 'active',
 onboarding_step: 'completed',
 }, { onConflict: 'telegram_id' })
 .select('*')
 .single();
 if (createdTarget) targetProfile = createdTarget;
 }
 }

 const { data: existingMatch } = await supabaseAdmin
 .from('matches')
 .select('id, status')
 .eq('requester_id', requesterProfile.id)
 .eq('target_id', targetProfile.id)
 .maybeSingle();

 if (existingMatch) {
 await sendOrEditCard(
 chatId,
 `You already sent a match request to Roommate <b>#${targetProfile.display_code}</b>.\nStatus: <b>${existingMatch.status.replace('_', ' ')}</b>`,
 [[{ text: 'Find Other Roommates', callback_data: 'matchmaker_start' }], [{ text: 'Main Menu', callback_data: 'nav_start' }]],
 messageIdToEdit
 );
 return;
 }

 const { data: newMatch, error: matchError } = await supabaseAdmin
 .from('matches')
 .insert({
 requester_id: requesterProfile.id,
 target_id: targetProfile.id,
 status: 'pending_acceptance',
 payment_status: 'one_paid',
 requester_paid: true,
 })
 .select('id')
 .single();

 if (matchError || !newMatch) {
 console.error('[executeDirectMatchRequest] match insert error:', matchError);
 await sendOrEditCard(
 chatId,
 `<b>Request Could Not Be Sent / ጥያቄውን መላክ አልተቻለም</b>\n\n<blockquote>Please try again in a moment.\nእባክዎ ትንሽ ቆይተው እንደገና ይሞክሩ።</blockquote>`,
 [[{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }]],
 messageIdToEdit
 );
 return;
 }

 const requesterLang = getLanguage(undefined, chatId);
 const requesterIsAm = requesterLang === 'am';

 await sendOrEditCard(
 chatId,
    `<b>Match Request Delivered! / የግንኙነት ጥያቄ ተልኳል!</b>\n\nYour request has been sent to Roommate <b>#${targetProfile.display_code}</b> (3-Month Pass active)\nጥያቄዎ ወደ የቤት አጋር <b>#${targetProfile.display_code}</b> ደርሷል (የ3 ወር አባልነት ተፈጻሚ ሆኗል)\n\n<blockquote>You will receive contact details once accepted! / እንደተቀበሉ ወዲያውኑ የስልክና ቴሌግራም አድራሻ ይደርስዎታል!</blockquote>`,
 [
 [{ text: 'Find Other Roommates / ሌሎች ፈላጊዎችን ፈልግ >', callback_data: 'matchmaker_start' }],
 [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ],
 messageIdToEdit
 );

 const requesterLocations = Array.isArray(requesterProfile.locations)
 ? requesterProfile.locations.join(', ')
 : 'Addis Ababa';
 let reqAge = requesterProfile.age;
 if (!reqAge && requesterProfile.roommate_traits) {
 const m = requesterProfile.roommate_traits.match(/Age[:\s]+(\d+)/i);
 if (m) reqAge = parseInt(m[1], 10);
 }
 if (!reqAge) reqAge = 24;

 const bMin = Number(requesterProfile.budget_min || 0);
 const bMax = Number(requesterProfile.budget_max || 10000);
 const requesterBudgetStr = bMin > 0
 ? `${bMin.toLocaleString()} – ${bMax.toLocaleString()} ETB / month`
 : `Up to ${bMax.toLocaleString()} ETB / month`;

 const cleanTraitsForMatch = extractUserDescription(requesterProfile.roommate_traits) || '';
 const reqHouseRules = requesterProfile.house_rules || extractHouseRulesFromTraits(requesterProfile.roommate_traits);
 const reqHouseRulesLine = reqHouseRules ? `\n• <b>House Rules / የቤት ህጎች:</b> ${escapeHtml(reqHouseRules)}` : '';

 const notifyText = `<b>SpaceMatch Addis · New Connection Request! / አዲስ የግንኙነት ጥያቄ!</b>

A verified roommate saw your listing and wants to connect!
አንድ የተረጋገጠ የቤት አጋር ማስታወቂያዎን አይቶ ሊገናኝዎት ይፈልጋል!

• <b>Profile / መገለጫ:</b> ${requesterProfile.gender || 'Member'} / ${requesterProfile.gender === 'Female' ? 'ሴት' : requesterProfile.gender === 'Male' ? 'ወንድ' : requesterProfile.gender || 'አባል'} (${reqAge} yrs / ዓመት)
• <b>Budget / በጀት:</b> <code>${requesterBudgetStr}</code>
• <b>Target Areas / አካባቢዎች:</b> <code>${escapeHtml(requesterLocations)}</code>${reqHouseRulesLine}
• <b>Status / ሁኔታ:</b> <b>Fayda Verified / ፋይዳ የተረጋገጠ</b>
${cleanTraitsForMatch ? `\n<blockquote>"${escapeHtml(cleanTraitsForMatch)}"</blockquote>\n` : ''}
<blockquote>Personal contact details are protected until you accept. / ስልክና አድራሻዎ ጥያቄውን እስኪቀበሉ ድረስ በሚስጥር የተጠበቀ ነው።</blockquote>
 `.trim();

 const explicitTargetAdminTg = Number((targetProfile.telegram_username || '').match(/^admin[_:](\d+)$/i)?.[1] || 0);
 const targetNotifyId = targetProfile.telegram_id > 0
 ? targetProfile.telegram_id
 : (explicitTargetAdminTg > 0 ? explicitTargetAdminTg : ((await getAdminIds())[0] || 800701176));

 if (targetNotifyId) {
 await tgSend(
 targetNotifyId,
 notifyText,
 {
 inline_keyboard: [
 [
 { text: 'Accept / ተቀበል', callback_data: `match_accept:${newMatch.id}` },
 { text: 'Decline / አልፈልግም', callback_data: `match_decline:${newMatch.id}` },
 ],
 ],
 }
 );
 }
 };

 // Helper: Send Primary Start / Main Menu Screen
  // Helper: Send Primary Start / Main Menu Screen (Supports Dynamic Graphic Card + Pure Text Fallback)
  const sendPrimaryWelcomeMenu = async (
    chatId: number,
    messageIdToEdit?: number,
    fromUser?: { first_name?: string; last_name?: string; username?: string }
  ) => {
    // Ensure the menu button in Telegram is reset to commands menu so mobile keyboards are unobstructed
    setChatMenuButton({ type: 'commands' }, chatId).catch(() => {});

    const session = getSession(chatId);
    const lang = getLanguage(session.draft_data, chatId);
    const isAm = lang === 'am';

    const mem = await getUserMembershipStatus(chatId);
    const memBadge = mem.isActive
      ? `Active (${mem.daysRemaining}d) / የሚሰራ (${mem.daysRemaining} ቀናት)`
      : `Inactive / የለም (100 ETB / 3 Months)`;

    const welcomeText = `<b>SpaceMatch Addis / ስፔስማች አዲስ</b>\n\n<blockquote>Verified Roommate Network · Addis Ababa\nየተረጋገጡ የቤት አጋሮች መፈለጊያ</blockquote>\n\n<b>Pass / አባልነት:</b> ${memBadge}`;

    const inlineKeyboard = [
      // Hero CTA on Top: Keep single most important action full-width at top
      [
        {
          text: 'Search Roommate / የቤት አጋር ፈልግ',
          callback_data: 'search_roommate_start',
        },
      ],
      // 2-Column Action Grid: Group secondary actions side-by-side
      [
        {
          text: 'Post Profile / መረጃ ልለጥፍ',
          callback_data: 'post_profile_start',
        },
        {
          text: mem.isActive
            ? `Pass Active (${mem.daysRemaining}d) / የሚሰራ (${mem.daysRemaining}ቀ)`
            : '3-Month Pass / አባልነት',
          callback_data: 'view_membership_pass',
        },
      ],
      // 2-Column Secondary / Utility Grid
      [
        {
          text: 'My Listings / ማስታወቂያዎቼ',
          callback_data: 'my_listings',
        },
        {
          text: 'Language / ቋንቋ',
          callback_data: 'open_lang_select',
        },
      ],
    ];

    let activeId: number | null | undefined = null;

    // ── Dynamic Start Card Graphic Mode (Can be toggled via ENABLE_DYNAMIC_START_IMAGE) ──
    if (ENABLE_DYNAMIC_START_IMAGE) {
      try {
        const resolvedName = fromUser?.first_name || session.draft_data?.full_name || 'Resident';
        const pngBuffer = await generateStartCardPng({
          userName: resolvedName,
          isMember: mem.isActive,
          daysRemaining: mem.daysRemaining,
          lang: isAm ? 'am' : 'bilingual',
        });

        if (messageIdToEdit) {
          // Asynchronously delete previous card to avoid duplicate messages in chat
          sendTelegram('deleteMessage', { chat_id: chatId, message_id: messageIdToEdit }).catch(() => {});
        }

        const startCacheKey = `start_card_v3_${resolvedName}_${mem.isActive ? mem.daysRemaining : 'inactive'}_${isAm ? 'am' : 'bi'}`;
        const photoRes = await sendTelegramPhotoBuffer(chatId, pngBuffer, welcomeText, inlineKeyboard, startCacheKey);
        if (photoRes?.ok && photoRes.result?.message_id) {
          activeId = photoRes.result.message_id;
        }
      } catch (err) {
        console.error('[sendPrimaryWelcomeMenu] Dynamic image error, falling back to text:', err);
      }
    }

    // ── Classic Text Fallback (Ensures 100% reliability and zero-friction restoration) ──
    if (!activeId) {
      activeId = await sendOrEditCard(chatId, welcomeText, inlineKeyboard, messageIdToEdit);
    }

    await saveSession({
      telegram_id: chatId,
      step: 'idle',
      draft_data: buildCleanFlowDraft(chatId, session.draft_data, { card_msg_id: activeId }),
      updated_at: new Date().toISOString(),
    });
  };

  const sendMyListingsScreen = async (chatId: number, messageIdToEdit?: number) => {
    const userLang = getUserLanguage(chatId);
    const session = getSession(chatId);

    const mem = await getUserMembershipStatus(chatId);
    const memBadge = mem.isActive
      ? `<b>3-Month Pass / አባልነት:</b> Active (${mem.daysRemaining} days remaining) / የሚሰራ (${mem.daysRemaining} ቀናት ቀርተዋል)\n\n`
      : '<b>3-Month Pass / አባልነት:</b> Inactive (100 ETB) / የለም (100 ብር)\n\n';

    let text = '<b>My Listings / ማስታወቂያዎቼ</b>\n\n' + memBadge;
 const buttons: any[] = [];
 let count = 0;
 const seenCodes = new Set<string>();

 const formatListingStatusBadge = (rawStatus?: string, rawStep?: string) => {
   const s = String(rawStatus || '').toLowerCase();
   const st = String(rawStep || '').toLowerCase();
   if (st === 'rejected' || s === 'rejected') return { isClosed: true, badge: 'Rejected / ተቀባይነት አላገኘም' };
   if (['matched', 'closed', 'archived', 'rented'].includes(s)) return { isClosed: true, badge: 'Closed / የተዘጋ' };
   if (s === 'paused' || s === 'pending_approval' || st === 'pending_approval' || s === 'draft') {
     return { isClosed: false, badge: 'Pending Approval / በግምገማ ላይ' };
   }
   return { isClosed: false, badge: 'Open / ክፍት' };
 };

 try {
 const [{ data: profs }, { data: rmList }, allDrafts] = await Promise.all([
   supabaseAdmin.from('profiles').select('*').eq('telegram_id', chatId).limit(5),
   supabaseAdmin.from('roommate_profiles').select('*').eq('user_telegram_id', chatId).limit(5),
   getAllRoommateDrafts(),
 ]);

 if (profs && profs.length > 0) {
 for (const p of profs) {
 count++;
 const code = String(p.display_code || `RM${String(p.id).slice(0, 6)}`).toUpperCase().replace(/^#/, '');
 seenCodes.add(code);
 const { isClosed, badge } = formatListingStatusBadge(p.status, p.onboarding_step);
 const kindLabel = code.startsWith('SPMARWR') ? 'Space' : 'Roommate';
 text += `<b>${kindLabel} #${escapeHtml(code)}</b> · ${badge}\n• <b>Areas:</b> ${escapeHtml((p.locations || []).join(', ') || 'Addis Ababa')}\n• <b>Budget:</b> ${escapeHtml(formatBudgetRangeLabel(p.budget_min, p.budget_max, 'Flexible'))}\n\n`;
 if (!isClosed) {
 buttons.push([
   { text: `Close #${code} / ዝጋ`, callback_data: `user_close_listing:${p.id}` },
   { text: `Delete #${code} / አጥፋ`, callback_data: `user_delete_listing:${code}` },
 ]);
 }
 }
 }

 if (rmList && rmList.length > 0) {
 for (const rm of rmList) {
 const code = String(rm.display_code || `RM${rm.id.slice(0, 4)}`).toUpperCase().replace(/^#/, '');
 if (seenCodes.has(code)) continue;
 seenCodes.add(code);
 count++;
 const { isClosed, badge } = formatListingStatusBadge(rm.status);
 text += `<b>Seeker Listing #${escapeHtml(code)}</b> · ${badge}\n• <b>Areas:</b> ${escapeHtml((rm.preferred_subcity || []).join(', ') || 'Addis Ababa')}\n• <b>Budget:</b> ${escapeHtml(formatBudgetRangeLabel(rm.budget_min, rm.budget_max, 'Flexible'))}\n\n`;
 if (!isClosed) {
 buttons.push([
   { text: `Close #${code} / ዝጋ`, callback_data: `user_close_listing:${rm.id}` },
   { text: `Delete #${code} / አጥፋ`, callback_data: `user_delete_listing:${rm.id}` },
 ]);
 }
 }
 }

 if (allDrafts) {
 for (const d of Object.values(allDrafts) as any[]) {
 if (!d || Number(d.user_telegram_id) !== chatId) continue;
 const code = String(d.display_code || d.id || '').toUpperCase().replace(/^#/, '');
 if (!code || seenCodes.has(code)) continue;
 seenCodes.add(code);
 count++;
 const { isClosed, badge } = formatListingStatusBadge(d.status);
 const kindLabel = d.listing_category === 'space_available' || code.startsWith('SPMARWR') ? 'Space Listing' : 'Seeker Draft';
 text += `<b>${kindLabel} #${escapeHtml(code)}</b> · ${badge}\n• <b>Areas:</b> ${escapeHtml((Array.isArray(d.preferred_subcity) ? d.preferred_subcity : []).join(', ') || 'Addis Ababa')}\n• <b>Budget:</b> ${escapeHtml(formatBudgetRangeLabel(d.budget_min, d.space_share || d.budget_max, 'Flexible'))}\n\n`;
 if (!isClosed) {
 buttons.push([
   { text: `Close #${code} / ዝጋ`, callback_data: `user_close_listing:${code}` },
   { text: `Delete #${code} / አጥፋ`, callback_data: `user_delete_listing:${code}` },
 ]);
 }
 }
 }
 } catch {}

 if (count === 0) {
 text += `<blockquote>You do not have any listings yet. Post your profile or space to broadcast to the channel! / እስካሁን ምንም ማስታወቂያ የለዎትም። መረጃዎን በመለጠፍ ቻናሉ ላይ ያሰራጩ!</blockquote>\n\n`;
      // Hero CTA on Top
      buttons.push([{ text: 'Post Profile or Space / መረጃ ልለጥፍ', callback_data: 'post_profile_start' }]);
    }

    buttons.push([{ text: 'Unlocked Contacts / የተከፈቱ አድራሻዎች', callback_data: 'my_unlocked_contacts' }]);

    // Strict Grid Symmetry: 2-Column Action Grid
    buttons.push([
      { text: 'Find Roommates / የቤት አጋር ፈልግ >', callback_data: 'search_roommate_start' },
      { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
    ]);

    let cardMessageId: number | undefined;

    if (ENABLE_DYNAMIC_START_IMAGE) {
      try {
        if (messageIdToEdit) {
          sendTelegram('deleteMessage', { chat_id: chatId, message_id: messageIdToEdit }).catch(() => {});
        }
        const pngBuffer = await generateMyListingsCardPng({
          userName: session.draft_data?.full_name,
          isMember: mem.isActive,
          daysRemaining: mem.daysRemaining,
        });
        const photoRes = await sendTelegramPhotoBuffer(chatId, pngBuffer, truncateTelegramHtml(text.trim(), 1024), buttons);
        if (photoRes?.ok && photoRes.result?.message_id) {
          cardMessageId = photoRes.result.message_id;
        }
      } catch (err) {
        console.warn('Dynamic card generation failed for my listings:', err);
      }
    }

    if (!cardMessageId) {
      cardMessageId = await sendOrEditCard(chatId, text.trim(), buttons, messageIdToEdit);
    }
 };

 // Helper: Platform Help & User Guide
 const sendHelpGuide = async (chatId: number, messageIdToEdit?: number) => {
    const guideText = `<b>User Guide / የተጠቃሚ መመሪያ</b>\n\n<blockquote>SpaceMatch connects verified roommates in Addis Ababa.\nስፔስማች በአዲስ አበባ የተረጋገጡ የቤት አጋሮችን ያገናኛል።</blockquote>\n\n<b>How it works / እንዴት ይሰራል:</b>\n1. <b>Search / ፈልግ:</b> Browse verified roommates by area and budget.\n2. <b>Post / ለጥፍ:</b> Share your profile to get matches.\n3. <b>Fayda / ፋይዳ:</b> Fast QR verification keeps the community safe.\n4. <b>Pass / አባልነት:</b> 3-month pass (100 ETB) unlocks unlimited requests.\n\n<b>Commands / ትዕዛዞች:</b>\n• /start — Welcome Menu / ዋና ማውጫ\n• /my_listings — Manage Listings / ማስታወቂያዎቼ\n• /status — Account Status / ሁኔታ\n• /cancel — Reset / ሰርዝ`.trim();

 const keyboard = [
 [
 { text: 'Find a Roommate / የቤት አጋር ፈልግ', callback_data: 'matchmaker_start' },
 { text: 'Post Profile / መረጃዬን ልለጥፍ', callback_data: 'post_profile_start' },
 ],
 [{ text: 'Back to Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ];

 await sendOrEditCard(chatId, guideText, keyboard, messageIdToEdit);
 };

 // =========================================================================
 // MATCHMAKER PREFERENCE WIZARD STEPS
 // =========================================================================

 // Matchmaker Step 1: Sub-Cities Selection (In-Place Edit)
 const sendMatchmakerSubcityStep = async (
    chatId: number,
    currentDraft: Record<string, any> = {},
    messageIdToEdit?: number
  ) => {
    const lang = getLanguage(currentDraft, chatId);
    const selectedList: string[] = currentDraft.match_subcities || [];
    const isAllSelected = ALL_SUBCITIES.every((s) => selectedList.includes(s));

    const gridRows: any[] = [];

    gridRows.push([
      {
        text: isAllSelected
          ? '✅ All Selected / ሁሉም ተመርጠዋል'
          : 'Select All Areas / ሁሉንም ምረጥ >',
        callback_data: 'match_select_all_subs',
      },
    ]);

    for (let i = 0; i < ALL_SUBCITIES.length; i += 2) {
      const row = [];
      const item1 = ALL_SUBCITIES[i];
      const isSel1 = selectedList.includes(item1);
      row.push({
        text: `${isSel1 ? '✅ ' : ''}${item1}`,
        callback_data: `match_toggle_sub:${item1}`,
      });

      if (i + 1 < ALL_SUBCITIES.length) {
        const item2 = ALL_SUBCITIES[i + 1];
        const isSel2 = selectedList.includes(item2);
        row.push({
          text: `${isSel2 ? '✅ ' : ''}${item2}`,
          callback_data: `match_toggle_sub:${item2}`,
        });
      }
      gridRows.push(row);
    }

    gridRows.push([
      {
        text: `Proceed (${selectedList.length} Selected) / ቀጥል (${selectedList.length} ተመርጠዋል) >`,
        callback_data: 'match_goto_gender',
      },
    ]);
    gridRows.push([{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }]);

    const text = '<b>Preferred Areas / የሚመርጡት አካባቢ</b>\n\n<blockquote>Select sub-cities to search, then proceed:\nየሚመርጧቸውን ክፍለ ከተሞች ይምረጡና ቀጥልን ይጫኑ:</blockquote>';

    const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
    const activeMsgId = await sendOrEditCard(chatId, text, gridRows, targetMsgId);
    if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

 await saveSession({
 telegram_id: chatId,
 step: 'awaiting_match_subcities',
 draft_data: { ...currentDraft, lang },
 updated_at: new Date().toISOString(),
 }, false);
 };

 // Matchmaker Step 2: My Gender (In-Place Edit)
 const sendMatchmakerGenderStep = async (
    chatId: number,
    currentDraft: Record<string, any> = {},
    messageIdToEdit?: number
  ) => {
    const lang = getLanguage(currentDraft, chatId);
    const text = '<b>Select Gender / ጾታዎን ይምረጡ</b>\n\n<blockquote>Select your gender to personalize matches:\nትክክለኛ አጋር ለማግኘት ጾታዎን ይምረጡ:</blockquote>';

 const keyboard = [
 [
 { text: 'Female / ሴት', callback_data: 'match_set_my_gender:Female' },
 { text: 'Male / ወንድ', callback_data: 'match_set_my_gender:Male' },
 ],
 [
 { text: 'Back to Areas / ወደ አካባቢዎች ተመለስ', callback_data: 'matchmaker_start' },
 { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
 ],
 ];

 const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
 const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
 if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

 await saveSession({
 telegram_id: chatId,
 step: 'awaiting_match_gender',
 draft_data: { ...currentDraft, lang },
 updated_at: new Date().toISOString(),
 });
 };

 // Matchmaker Step 3: My Age (Direct Numerical Input - In-Place Edit)
 const sendMatchmakerAgeStep = async (
    chatId: number,
    currentDraft: Record<string, any> = {},
    messageIdToEdit?: number,
    errorMessage?: string
  ) => {
    const lang = getLanguage(currentDraft, chatId);
    const header = errorMessage ? `<b>${errorMessage}</b>\n\n` : '';
    const text = `${header}<b>Your Age / እድሜዎ</b>\n\n<blockquote>Enter your age (e.g. 24):\nእድሜዎን በቁጥር ያስገቡ:</blockquote>`;

 const keyboard = [
 [
 { text: 'Back to Gender / ወደ ጾታ ተመለስ', callback_data: 'match_goto_gender' },
 { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
 ],
 ];

 const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
 const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
 if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

 await saveSession({
 telegram_id: chatId,
 step: 'awaiting_match_age',
 draft_data: { ...currentDraft, lang },
 updated_at: new Date().toISOString(),
 });
 };

 // Matchmaker Step 4: My Religion (In-Place Edit)
 const sendMatchmakerReligionStep = async (
    chatId: number,
    currentDraft: Record<string, any> = {},
    messageIdToEdit?: number
  ) => {
    const lang = getLanguage(currentDraft, chatId);
    const text = '<b>Select Religion / እምነትዎን ይምረጡ</b>\n\n<blockquote>Select your religion to improve compatibility matching:\nትክክለኛ የቤት አጋር ለማግኘት እምነትዎን ይምረጡ:</blockquote>';

 const keyboard = [
 [
 { text: 'Orthodox / ኦርቶዶክስ', callback_data: 'match_set_religion:Orthodox' },
 { text: 'Muslim / ሙስሊም', callback_data: 'match_set_religion:Muslim' },
 ],
 [
 { text: 'Protestant / ፕሮቴስታንት', callback_data: 'match_set_religion:Protestant' },
 { text: 'Other / Any / ሌላ ወይም ማንኛውም', callback_data: 'match_set_religion:Other' },
 ],
 [
 { text: 'Back to Age / ወደ ዕድሜ ተመለስ', callback_data: 'match_goto_age' },
 { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
 ],
 ];

 const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
 const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
 if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

 await saveSession({
 telegram_id: chatId,
 step: 'awaiting_match_religion',
 draft_data: { ...currentDraft, lang },
 updated_at: new Date().toISOString(),
 });
 };

 // Matchmaker Step 5: My Occupation / Job (In-Place Edit)
 const sendMatchmakerJobStep = async (
    chatId: number,
    currentDraft: Record<string, any> = {},
    messageIdToEdit?: number,
    errorMessage?: string
  ) => {
    const lang = getLanguage(currentDraft, chatId);
    const header = errorMessage ? `<b>${errorMessage}</b>\n\n` : '';
    const text = `${header}<b>Your Occupation / ሙያዎ</b>\n\n<blockquote>Type your occupation (e.g. Accountant, Engineer, Student) or tap a quick option below:\nሙያዎን ወይም የስራ ሁኔታዎን ይጻፉ ወይም ከታች ይምረጡ:</blockquote>`;

 const keyboard = [
 [
 { text: 'Student / ተማሪ', callback_data: 'match_set_job:Student' },
 { text: 'Employed / ተቀጣሪ', callback_data: 'match_set_job:Employed' },
 ],
 [
 { text: 'Self-Employed / የግል ስራ', callback_data: 'match_set_job:Self-Employed' },
 ],
 [
 { text: 'Back to Religion / ወደ እምነት ተመለስ', callback_data: 'match_goto_religion' },
 { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
 ],
 ];

 const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
 const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
 if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

 await saveSession({
 telegram_id: chatId,
 step: 'awaiting_match_job',
 draft_data: { ...currentDraft, lang },
 updated_at: new Date().toISOString(),
 });
 };

 // Matchmaker Step 6: Roommate Gender Preference (In-Place Edit)
 const sendMatchmakerPrefGenderStep = async (
    chatId: number,
    currentDraft: Record<string, any> = {},
    messageIdToEdit?: number
  ) => {
    const lang = getLanguage(currentDraft, chatId);
    const text = '<b>Preferred Roommate / የአጋር ጾታ</b>\n\n<blockquote>Who do you prefer to live with?\nአብሮዎት የሚኖረው ሰው ጾታ:</blockquote>';

 const keyboard = [
 [
 { text: 'Female Only / ሴት ብቻ', callback_data: 'match_set_pref_gender:Female' },
 { text: 'Male Only / ወንድ ብቻ', callback_data: 'match_set_pref_gender:Male' },
 ],
 [
 { text: 'Any Gender Compatible / ማናቸውም ጾታ', callback_data: 'match_set_pref_gender:Any' },
 ],
 [
 { text: 'Back to Occupation / ወደ ሙያ ተመለስ', callback_data: 'match_goto_job' },
 { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
 ],
 ];

 const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
 const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
 if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

 await saveSession({
 telegram_id: chatId,
 step: 'awaiting_match_pref_gender',
 draft_data: { ...currentDraft, lang },
 updated_at: new Date().toISOString(),
 });
 };

 // Matchmaker Step 7: Monthly Rent Budget Range (Custom Min - Max or Step-by-Step Min -> Max)
 const sendMatchmakerBudgetStep = async (
    chatId: number,
    currentDraft: Record<string, any> = {},
    messageIdToEdit?: number,
    errorMessage?: string
  ) => {
    const lang = getLanguage(currentDraft, chatId);
    const header = errorMessage ? `<b>${errorMessage}</b>\n\n` : '';
    const text = `${header}<b>Monthly Budget Range / ወርሃዊ የበጀት ክልል</b>\n\n<blockquote>Enter your minimum and maximum budget range in ETB (e.g. <code>5000 - 12000</code>),\nor enter your MINIMUM budget first (e.g. <code>5000</code>), or tap Any Budget:\n\nዝቅተኛውን እና ከፍተኛውን ወርሃዊ በጀት በብር ያስገቡ (ምሳሌ: <code>5000 - 12000</code>)\nወይም መጀመሪያ ዝቅተኛውን ብቻ ይጻፉ (ምሳሌ: <code>5000</code>) ወይም ማንኛውም በጀት የሚለውን ይጫኑ:</blockquote>`;

 const keyboard = [
 [
 { text: 'Any Budget (No Cap) / ማንኛውም በጀት (ገደብ የለሽ)', callback_data: 'match_set_budget:0' },
 ],
 [
 { text: 'Back to Preference / ወደ ምርጫ ተመለስ', callback_data: 'match_goto_pref_gender' },
 { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
 ],
 ];

 const { pending_budget_min: _ignoredMin, ...cleanDraft } = currentDraft || {};
 const targetMsgId = messageIdToEdit || cleanDraft.card_msg_id;
 const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
 if (activeMsgId) cleanDraft.card_msg_id = activeMsgId;

 await saveSession({
 telegram_id: chatId,
 step: 'awaiting_match_budget_input',
 draft_data: { ...cleanDraft, lang },
 updated_at: new Date().toISOString(),
 });
 };

 // Matchmaker Step 7b: Maximum Monthly Budget (when user entered minimum first)
 const sendMatchmakerBudgetMaxStep = async (
    chatId: number,
    currentDraft: Record<string, any> = {},
    minAmount: number,
    messageIdToEdit?: number,
    errorMessage?: string
  ) => {
    const lang = getLanguage(currentDraft, chatId);
    const suggestedMax = Math.min(1000000, Math.round(minAmount * 1.5));
    const header = errorMessage ? `<b>${errorMessage}</b>\n\n` : '';
    const text = `${header}<b>Maximum Monthly Budget / ከፍተኛ ወርሃዊ በጀት</b>\n\n<blockquote>Minimum saved: <b>${minAmount.toLocaleString()} ETB/mo</b>\nNow enter your MAXIMUM monthly budget in ETB (e.g. <code>${suggestedMax.toLocaleString()}</code>):\n\nዝቅተኛ በጀት ተይዟል: <b>${minAmount.toLocaleString()} ብር</b>\nአሁን ከፍተኛውን ወርሃዊ በጀት በብር ያስገቡ:</blockquote>`;

 const keyboard = [
 [
 { text: 'Change Minimum / ዝቅተኛውን ቀይር', callback_data: 'match_goto_budget' },
 { text: 'Any Budget / ማንኛውም በጀት', callback_data: 'match_set_budget:0' },
 ],
 [
 { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
 ],
 ];

 const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
 const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
 if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

 await saveSession({
 telegram_id: chatId,
 step: 'awaiting_match_budget_max',
 draft_data: { ...currentDraft, pending_budget_min: minAmount, lang },
 updated_at: new Date().toISOString(),
 });
 };

 // Matchmaker Step 8: Lifestyle & Habits (Completes all prompts BEFORE showing roommate matches)
 const sendMatchmakerTraitsStep = async (
    chatId: number,
    currentDraft: Record<string, any> = {},
    messageIdToEdit?: number,
    errorMessage?: string
  ) => {
    const lang = getLanguage(currentDraft, chatId);
    const header = errorMessage ? `<b>${errorMessage}</b>\n\n` : '';
    const text = `${header}<b>Lifestyle & Habits / ስለ አኗኗርና ተጨማሪ መስፈርቶች</b>\n\n<blockquote>Briefly describe your habits and preferences (e.g. clean, quiet, non-smoker) or tap a quick option below to see your matches:\nስለ አኗኗርዎና ስለሚፈልጉት አጋር በአጭሩ ይጻፉ ወይም ከታች ይምረጡ:</blockquote>`;

 const keyboard = [
 [
 { text: 'Clean, Quiet & Non-Smoker / ንጹህና ጸጥተኛ', callback_data: 'match_set_traits:Clean, quiet & non-smoker' },
 ],
 [
 { text: 'Friendly & Respectful / ተግባቢ እና ጨዋ', callback_data: 'match_set_traits:Friendly, clean & respectful' },
 ],
 [
 { text: 'Back to Budget / ወደ በጀት ተመለስ', callback_data: 'match_goto_budget' },
 { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
 ],
 ];

 const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
 const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
 if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

 await saveSession({
 telegram_id: chatId,
 step: 'awaiting_match_traits',
 draft_data: { ...currentDraft, lang },
 updated_at: new Date().toISOString(),
 });
 };

 // Matchmaker Step 8b: House Rules (Completed BEFORE showing roommate matches)
 const sendMatchmakerHouseRulesStep = async (
    chatId: number,
    currentDraft: Record<string, any> = {},
    messageIdToEdit?: number,
    errorMessage?: string
  ) => {
    const lang = getLanguage(currentDraft, chatId);
    const header = errorMessage ? `<b>${errorMessage}</b>\n\n` : '';
    const text = `${header}<b>House Rules / የቤት ህጎች</b>\n\n<blockquote>Tap your preferred house rules or type your own (e.g. No smoking, quiet after 10 PM) to see your matches:\nየሚፈልጉትን የቤት ህግ ከታች ይምረጡ ወይም ይጻፉ (ምሳሌ: ሲጋራ ክልክል፣ ከምሽቱ 4 ሰዓት በኋላ ጸጥታ):</blockquote>`;

 const keyboard = [
 [
 { text: 'Clean & Quiet / ንጹህና ጸጥተኛ', callback_data: 'match_set_house_rules:Clean, quiet & respectful' },
 { text: 'No Smoking / ሲጋራ ክልክል', callback_data: 'match_set_house_rules:No smoking, clean & tidy' },
 ],
 [
 { text: 'No Parties / ጫጫታ የሌለበት', callback_data: 'match_set_house_rules:Quiet hours after 10 PM, no parties' },
 ],
 [
 { text: 'Back / ወደ ኋላ', callback_data: 'match_goto_traits' },
 { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
 ],
 ];

 const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
 const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
 if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

 await saveSession({
 telegram_id: chatId,
 step: 'awaiting_match_house_rules',
 draft_data: { ...currentDraft, lang },
 updated_at: new Date().toISOString(),
 });
 };

 // =========================================================================
 // SEEKER PROFILE CREATION WIZARD STEPS
 // =========================================================================

 // Helper: Seeker Step 1 (Sub-Cities Grid Keyboard - In-Place Editing)
 const sendSeekerSubcityStep = async (
    chatId: number,
    currentDraft: Record<string, any> = {},
    messageIdToEdit?: number
  ) => {
    // Universal Gate: Fayda Verification required before posting seeker profile
    if (!(await isUserFaydaVerified(chatId))) {
      await sendFaydaGateCard(chatId, 'post a Roommate Seeker Profile', messageIdToEdit);
      return;
    }

    const lang = getLanguage(currentDraft, chatId);
    const selectedList: string[] = currentDraft.preferred_subcity || [];
    const isAllSelected = ALL_SUBCITIES.every((s) => selectedList.includes(s));

    const gridRows: any[] = [];

    gridRows.push([
      {
        text: isAllSelected
          ? '✅ All Selected / ሁሉም ተመርጠዋል'
          : 'Select All Areas / ሁሉንም ምረጥ >',
        callback_data: 'seeker_select_all_and_proceed',
      },
    ]);

    for (let i = 0; i < ALL_SUBCITIES.length; i += 2) {
      const row = [];
      const item1 = ALL_SUBCITIES[i];
      const isSel1 = selectedList.includes(item1);
      row.push({
        text: `${isSel1 ? '✅ ' : ''}${item1}`,
        callback_data: `seeker_toggle_sub:${item1}`,
      });

      if (i + 1 < ALL_SUBCITIES.length) {
        const item2 = ALL_SUBCITIES[i + 1];
        const isSel2 = selectedList.includes(item2);
        row.push({
          text: `${isSel2 ? '✅ ' : ''}${item2}`,
          callback_data: `seeker_toggle_sub:${item2}`,
        });
      }
      gridRows.push(row);
    }

    gridRows.push([
      {
        text: `Proceed (${selectedList.length} Selected) / ቀጥል (${selectedList.length} ተመርጠዋል) >`,
        callback_data: 'seeker_goto_gender',
      },
    ]);
    gridRows.push([{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }]);

    const text = '<b>Preferred Areas / የሚመርጡት አካባቢ</b>\n\n<blockquote>Select preferred sub-cities in Addis Ababa:\nየሚመርጧቸውን ክፍለ ከተሞች ይምረጡ:</blockquote>';

    const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
    const activeMsgId = await sendOrEditCard(chatId, text, gridRows, targetMsgId);
    if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

 await saveSession({
 telegram_id: chatId,
 step: 'awaiting_seeker_subcities_grid',
 draft_data: { ...currentDraft, lang },
 updated_at: new Date().toISOString(),
 }, false);
 };

 // Helper: Seeker Step 2 (My Gender)
 const sendSeekerMyGenderStep = async (chatId: number, currentDraft: Record<string, any> = {}, messageIdToEdit?: number) => {
    const lang = getLanguage(currentDraft, chatId);
    const text = '<b>Select Gender / ጾታዎን ይምረጡ</b>\n\n<blockquote>Select your gender:\nጾታዎን ይምረጡ:</blockquote>';

 const keyboard = [
 [
 { text: 'Female / ሴት', callback_data: 'seeker_my_gender:Female' },
 { text: 'Male / ወንድ', callback_data: 'seeker_my_gender:Male' },
 ],
 [{ text: 'Back to Areas / ተመለስ', callback_data: 'seeker_subcity_menu' }],
 ];

 const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
 const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
 if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

 await saveSession({
 telegram_id: chatId,
 step: 'awaiting_seeker_my_gender',
 draft_data: { ...currentDraft, lang },
 updated_at: new Date().toISOString(),
 });
 };

 // Helper: Seeker Step 3 (My Age - Direct Numerical Input)
 const sendSeekerAgeStep = async (
    chatId: number,
    currentDraft: Record<string, any> = {},
    messageIdToEdit?: number,
    errorMessage?: string
  ) => {
    const lang = getLanguage(currentDraft, chatId);
    const header = errorMessage ? `<b>${errorMessage}</b>\n\n` : '';
    const text = `${header}<b>Your Age / እድሜዎ</b>\n\n<blockquote>Enter your age (e.g. 24):\nእድሜዎን በቁጥር ያስገቡ:</blockquote>`;

 const keyboard = [
 [
 { text: 'Back to Gender / ተመለስ', callback_data: 'seeker_goto_gender' },
 { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
 ],
 ];

 const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
 const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
 if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

 await saveSession({
 telegram_id: chatId,
 step: 'awaiting_seeker_age',
 draft_data: { ...currentDraft, lang },
 updated_at: new Date().toISOString(),
 });
 };

 // Helper: Seeker Step 4 (Preferred Roommate Gender)
 const sendSeekerPrefGenderStep = async (chatId: number, currentDraft: Record<string, any> = {}, messageIdToEdit?: number) => {
    const lang = getLanguage(currentDraft, chatId);
    const text = '<b>Preferred Roommate / የአጋር ጾታ</b>\n\n<blockquote>Who do you prefer to live with?\nአብሮዎት የሚኖረው ሰው ጾታ:</blockquote>';

 const keyboard = [
 [
 { text: 'Female Only / ሴት ብቻ', callback_data: 'seeker_pref_gender:Female' },
 { text: 'Male Only / ወንድ ብቻ', callback_data: 'seeker_pref_gender:Male' },
 ],
 [
 { text: 'Any Gender Compatible / ማንኛውም ጾታ', callback_data: 'seeker_pref_gender:Any' },
 ],
 [
 { text: 'Back to Age / ተመለስ', callback_data: 'seeker_goto_age' },
 { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
 ],
 ];

 const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
 const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
 if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

 await saveSession({
 telegram_id: chatId,
 step: 'awaiting_seeker_pref_gender',
 draft_data: { ...currentDraft, lang },
 updated_at: new Date().toISOString(),
 });
 };

 // Helper: Seeker Step 5 (Budget Range Input - Custom Min - Max or Min -> Max)
 const sendSeekerBudgetStep = async (
    chatId: number,
    currentDraft: Record<string, any> = {},
    messageIdToEdit?: number,
    errorMessage?: string
  ) => {
    const lang = getLanguage(currentDraft, chatId);
    const header = errorMessage ? `<b>${errorMessage}</b>\n\n` : '';
    const text = `${header}<b>Monthly Budget Range / ወርሃዊ የበጀት ክልል</b>\n\n<blockquote>Enter your minimum and maximum monthly budget in ETB (e.g. <code>5000 - 12000</code>),\nor type your MINIMUM budget first (e.g. <code>5000</code>):\n\nዝቅተኛውን እና ከፍተኛውን ወርሃዊ በጀት በብር ያስገቡ (ምሳሌ: <code>5000 - 12000</code>)\nወይም መጀመሪያ ዝቅተኛውን ብቻ ይጻፉ (ምሳሌ: <code>5000</code>):</blockquote>`;

 const keyboard = [
 [
 { text: 'Back to Preference / ተመለስ', callback_data: 'seeker_goto_pref_gender' },
 { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
 ],
 ];

 const { pending_budget_min: _ignoredMin, ...cleanDraft } = currentDraft || {};
 const targetMsgId = messageIdToEdit || cleanDraft.card_msg_id;
 const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
 if (activeMsgId) cleanDraft.card_msg_id = activeMsgId;

 await saveSession({
 telegram_id: chatId,
 step: 'awaiting_seeker_budget_text',
 draft_data: { ...cleanDraft, lang },
 updated_at: new Date().toISOString(),
 });
 };

 const sendSeekerBudgetMaxStep = async (
    chatId: number,
    currentDraft: Record<string, any> = {},
    minAmount: number,
    messageIdToEdit?: number,
    errorMessage?: string
  ) => {
    const lang = getLanguage(currentDraft, chatId);
    const suggestedMax = Math.min(1000000, Math.round(minAmount * 1.5));
    const header = errorMessage ? `<b>${errorMessage}</b>\n\n` : '';
    const text = `${header}<b>Maximum Monthly Budget / ከፍተኛ ወርሃዊ በጀት</b>\n\n<blockquote>Minimum saved: <b>${minAmount.toLocaleString()} ETB/mo</b>\nNow enter your MAXIMUM monthly budget in ETB (e.g. <code>${suggestedMax.toLocaleString()}</code>):\n\nዝቅተኛ በጀት ተይዟል: <b>${minAmount.toLocaleString()} ብር</b>\nአሁን ከፍተኛውን ወርሃዊ በጀት በብር ያስገቡ:</blockquote>`;

 const keyboard = [
 [
 { text: 'Change Minimum / ዝቅተኛውን ቀይር', callback_data: 'seeker_goto_budget' },
 { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
 ],
 ];

 const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
 const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
 if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

 await saveSession({
 telegram_id: chatId,
 step: 'awaiting_seeker_budget_max',
 draft_data: { ...currentDraft, pending_budget_min: minAmount, lang },
 updated_at: new Date().toISOString(),
 });
 };

 // Helper: Seeker Step 6 (Lifestyle Bio - Direct Input or Skip)
 const sendSeekerBioStep = async (chatId: number, currentDraft: Record<string, any> = {}, messageIdToEdit?: number) => {
    const lang = getLanguage(currentDraft, chatId);
    const text = '<b>Lifestyle & Habits / አኗኗርና ልምዶች</b>\n\n<blockquote>Describe yourself (e.g. quiet, clean) or tap Skip:\nስለ አኗኗርዎ በአጭሩ ይግለጹ ወይም እለፍ የሚለውን ይጫኑ:</blockquote>';

 const keyboard = [
 [{ text: 'Skip Bio / ይህን እለፍ >', callback_data: 'seeker_skip_bio' }],
 [
 { text: 'Back to Budget / ተመለስ', callback_data: 'seeker_goto_budget' },
 { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
 ],
 ];

 const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
 const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
 if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

 await saveSession({
 telegram_id: chatId,
 step: 'awaiting_seeker_bio_text',
 draft_data: { ...currentDraft, lang },
 updated_at: new Date().toISOString(),
 });
 };

 // Helper: Seeker Step 7 (Phone Number - Direct Numerical Input)
 const sendSeekerPhoneStep = async (
    chatId: number,
    currentDraft: Record<string, any> = {},
    messageIdToEdit?: number,
    errorMessage?: string
  ) => {
    const lang = getLanguage(currentDraft, chatId);
    const header = errorMessage ? `<b>${errorMessage}</b>\n\n` : '';
    const text = `${header}<b>Phone Number / ስልክ ቁጥር</b>\n\n<blockquote>Enter your phone number (e.g. 0912345678):\nየስልክ ቁጥርዎን ያስገቡ:</blockquote>\n\nContacts remain private until mutual match. / ስልክዎ ፈቃድ እስካልሰጡ ድረስ ለማንም አይታይም።`;

 const keyboard = [
 [
 { text: 'Back to Bio / ተመለስ', callback_data: 'seeker_goto_bio' },
 { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
 ],
 ];

 const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
 const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
 if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

 await saveSession({
 telegram_id: chatId,
 step: 'awaiting_seeker_phone',
 draft_data: { ...currentDraft, lang },
 updated_at: new Date().toISOString(),
 });
 };

 // Helper: Seeker Review & Final Submit
 const sendSeekerFaydaStep = async (chatId: number, currentDraft: Record<string, any> = {}, messageIdToEdit?: number) => {
    const isVerified = await isUserFaydaVerified(chatId);
    if (!isVerified) {
      await sendDynamicCardStep9FaydaFan(chatId, currentDraft, messageIdToEdit);
      return;
    }

    const lang = getLanguage(currentDraft, chatId);
    const isAm = lang === 'am';

    const codeDisplay = currentDraft.display_code ? `#${currentDraft.display_code.replace(/^#/, '')}` : '#PENDING';
    const areasDisplay = Array.isArray(currentDraft.preferred_subcity) && currentDraft.preferred_subcity.length > 0
      ? currentDraft.preferred_subcity.join(', ')
      : 'Addis Ababa';
    const budgetDisplay = formatBudgetRangeLabel(currentDraft.budget_min, currentDraft.budget_max || currentDraft.budget, 'Flexible');
    const myGender = currentDraft.my_gender || currentDraft.gender || 'Any';
    const myGenderDisplay = myGender === 'Female' ? 'Female / ሴት' : myGender === 'Male' ? 'Male / ወንድ' : myGender;
    const prefGender = currentDraft.preferred_gender || 'Any';
    const prefGenderDisplay = prefGender === 'Female' ? 'Female Only / ሴት ብቻ' : prefGender === 'Male' ? 'Male Only / ወንድ ብቻ' : 'Any Gender / ማንኛውም ጾታ';
    const userAge = currentDraft.age ? `, Age ${currentDraft.age}` : '';
    const moveInDate = currentDraft.move_in_date || currentDraft.move_in || 'Immediately / አሁኑኑ';
    const userBio = (currentDraft.lifestyle_bio || currentDraft.description || currentDraft.details || 'Compatible roommate looking for a room in Addis Ababa.').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const summaryText = `<b>SpaceMatch Profile Review / የመረጃ ክለሳ</b>
<code>${codeDisplay}</code> · <b>Ready to Publish / ለስርጭት ዝግጁ</b>

<blockquote>• <b>Target Areas / አካባቢ:</b> <b>${areasDisplay}</b>
• <b>Budget Cap / በጀት:</b> <b>${budgetDisplay}</b>
• <b>Candidate / ተፈላጊ:</b> ${myGenderDisplay}${userAge}
• <b>Looking For / የሚፈልጉት:</b> ${prefGenderDisplay}
• <b>Move-in / መግቢያ:</b> ${moveInDate}</blockquote>

<b>ABOUT ME / ስለ እኔ</b>
<blockquote>${userBio}</blockquote>

<blockquote>🔒 <b>Privacy Shield / ሚስጥራዊነት:</b> Contacts remain strictly protected under double-blind privacy shield.
ስልክ እና አድራሻዎ በጋራ ፈቃድ ብቻ ሚስጥራዊ ሆነው ይገለጣሉ።</blockquote>
    `.trim();

    const keyboard = [
      [{ text: 'Publish to Channel & Matchmaker / ቻናል እና ማችሜከር ላይ ይለጠፍ >', callback_data: 'seeker_final_submit' }],
      [
        { text: 'Edit Details / መረጃ አሻሽል', callback_data: 'seeker_flow' },
        { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
      ],
    ];

    const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
    const activeMsgId = await sendOrEditCard(chatId, summaryText, keyboard, targetMsgId);
    if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

    await saveSession({
      telegram_id: chatId,
      step: 'awaiting_seeker_fayda_review',
      draft_data: { ...currentDraft, lang },
      updated_at: new Date().toISOString(),
    });
  };

 // Helper: Automated Matchmaking Engine Driven directly by User's Input Criteria (Live DB & In-Place Paginated Feed)
 const executeAutomatedMatchmaker = async (
 chatId: number,
 criteria: {
 match_subcities?: string[];
 my_gender?: string;
 age?: number;
 age_bracket?: string;
 religion?: string;
 job?: string;
 roommate_traits?: string;
 preferred_gender?: string;
 budget_min?: number;
 budget_max?: number;
 } = {},
 messageIdToEdit?: number,
 candidateIndex: number = 0
 ) => {
 const preferredSubs = criteria.match_subcities || [];
 const prefGender = criteria.preferred_gender || 'Any';
 const myGender = criteria.my_gender || '';
 const myAge = criteria.age ? Number(criteria.age) : undefined;
 const myReligion = (criteria.religion || '').trim();
 const budgetMin = criteria.budget_min !== undefined ? Number(criteria.budget_min) : 0;
 const budgetMax = criteria.budget_max !== undefined ? Number(criteria.budget_max) : 100000;
 const ageBracket = criteria.age_bracket || '';
 const lang = getLanguage(criteria, chatId);
 const isAm = lang === 'am';

 const parseTraitMeta = (rawBio: string) => {
   const parts = String(rawBio || '').split('|').map((s) => s.trim()).filter(Boolean);
   let parsedJob = '';
   let parsedReligion = '';
   let parsedRules = '';
   const bioParts: string[] = [];
   for (const part of parts) {
     if (/^Job:/i.test(part)) parsedJob = part.replace(/^Job:\s*/i, '').trim();
     else if (/^Religion:/i.test(part)) parsedReligion = part.replace(/^Religion:\s*/i, '').trim();
     else if (/^(?:House\s*)?Rules:/i.test(part)) parsedRules = part.replace(/^(?:House\s*)?Rules:\s*/i, '').trim();
     else if (/^Prefers?:/i.test(part)) continue;
     else bioParts.push(part);
   }
   return {
     job: parsedJob,
     religion: parsedReligion,
     house_rules: parsedRules,
     cleanBio: bioParts.join(' · ') || 'Seeking a compatible roommate in Addis Ababa.',
   };
 };

 // 1. Fetch live profiles from Supabase DB
 // 1, 2, 3: Fetch matching profiles in parallel for 3x lower latency
 let dbProfiles: any[] = [];
 let localDrafts: any[] = [];
 let appProfiles: any[] = [];

 try {
 const [rmRes, draftsObj, profRes] = await Promise.all([
 supabaseAdmin
 .from('roommate_profiles')
 .select('*, users(*)')
 .eq('status', 'approved')
 .order('created_at', { ascending: false })
 .limit(50),
 getAllRoommateDrafts(),
 supabaseAdmin
 .from('profiles')
 .select('*')
 .eq('status', 'active')
 .order('created_at', { ascending: false })
 .limit(50),
 ]);

 if (rmRes?.data) dbProfiles = rmRes.data;
 if (draftsObj) localDrafts = Object.values(draftsObj);
 if (profRes?.data) appProfiles = profRes.data;
 } catch (e) {
 console.error('Error fetching roommate profiles in parallel for matching:', e);
 }

 // Combine profiles without duplicates across tables (by id, telegram_id, display_code)
 const allProfiles: any[] = [];
 const seenIds = new Set<string>();
 const seenOwnerTgIds = new Set<string>();
 const seenCodes = new Set<string>();

 const registerSeen = (id: any, tgId: any, code: any): boolean => {
 const idStr = id ? String(id) : '';
 const tgStr = tgId && Number(tgId) !== 0 ? String(tgId) : '';
 const codeStr = code ? String(code).toUpperCase().replace(/^#/, '') : '';
 if ((idStr && seenIds.has(idStr)) || (tgStr && seenOwnerTgIds.has(tgStr)) || (codeStr && seenCodes.has(codeStr))) {
 return false;
 }
 if (idStr) seenIds.add(idStr);
 if (tgStr) seenOwnerTgIds.add(tgStr);
 if (codeStr) seenCodes.add(codeStr);
 return true;
 };

 for (const p of appProfiles) {
 if (p.telegram_id && String(p.telegram_id) === String(chatId)) continue;
 if (p.display_code && String(p.display_code).toUpperCase().startsWith('SPMARWR')) continue;
 if (p.status !== 'active' || (!p.gender && !p.roommate_traits)) continue;
 if (!registerSeen(p.id, p.telegram_id, p.display_code)) continue;
 const meta = parseTraitMeta(p.roommate_traits);
 allProfiles.push({
 id: p.id,
 display_code: p.display_code || undefined,
 user_name: p.full_name || 'Verified Seeker',
 username: p.telegram_username || null,
 age: p.age || undefined,
 religion: p.religion || meta.religion || undefined,
 job: p.job || meta.job || undefined,
 house_rules: meta.house_rules || undefined,
 preferred_subcity: p.locations || ['Addis Ababa'],
 my_gender: p.gender || 'Female',
 preferred_gender: p.preferred_gender || 'Any',
 budget_min: p.budget_min || 0,
 budget_max: p.budget_max || 10000,
 lifestyle_bio: meta.cleanBio || 'Looking for compatible roommate in Addis Ababa.',
 fayda_status: p.kyc_status === 'verified' ? 'verified' : 'unverified',
 unlock_fee: 100,
 source: 'Profiles',
 });
 }

 for (const p of dbProfiles) {
 const ownerTgId = p.user_telegram_id || p.users?.telegram_id;
 if (ownerTgId && String(ownerTgId) === String(chatId)) continue;
 if (!registerSeen(p.id, ownerTgId, p.display_code)) continue;
 const meta = parseTraitMeta(p.lifestyle_bio);
 allProfiles.push({
 id: p.id,
 display_code: p.display_code || undefined,
 user_name: p.users?.first_name || 'Verified Seeker',
 username: p.users?.username || null,
 age: p.age || p.users?.age || undefined,
 religion: p.religion || meta.religion || undefined,
 job: p.job || meta.job || undefined,
 house_rules: p.house_rules || meta.house_rules || undefined,
 preferred_subcity: p.preferred_subcity || ['Addis Ababa'],
 my_gender: p.my_gender || 'Female',
 preferred_gender: p.preferred_gender || 'Any',
 budget_min: p.budget_min || 0,
 budget_max: p.budget_max || 10000,
 lifestyle_bio: meta.cleanBio || 'Looking for compatible roommate in Addis Ababa.',
 fayda_status: p.users?.fayda_status || 'verified',
 unlock_fee: p.unlock_fee || 100,
 source: 'DB',
 });
 }

 for (const d of localDrafts) {
 if (d.user_telegram_id && String(d.user_telegram_id) === String(chatId)) continue;
 if (d.status !== 'approved') continue;
 if (d.listing_category === 'space_available' || (d.display_code && String(d.display_code).toUpperCase().startsWith('SPMARWR'))) continue;
 if (!registerSeen(d.id, d.user_telegram_id, d.display_code)) continue;
 const meta = parseTraitMeta(d.lifestyle_bio);
 allProfiles.push({
 id: d.id,
 display_code: d.display_code || d.id,
 user_name: d.user_name || 'Roommate Seeker',
 username: d.username || null,
 age: d.age,
 religion: d.religion || meta.religion || undefined,
 job: d.job || meta.job || undefined,
 house_rules: d.house_rules || meta.house_rules || undefined,
 preferred_subcity: d.preferred_subcity || ['Bole'],
 my_gender: d.my_gender || 'Female',
 preferred_gender: d.preferred_gender || 'Any',
 budget_min: d.budget_min || 0,
 budget_max: d.budget_max || 10000,
 lifestyle_bio: meta.cleanBio || 'Seeking a compatible roommate in Addis Ababa.',
 fayda_status: d.fayda_status || 'verified',
 unlock_fee: d.unlock_fee || 100,
 source: 'Draft',
 });
 }

 // Check empty state
 if (allProfiles.length === 0) {
 const emptyText = `<b>No Roommate Profiles Yet / ምንም የክፍል ጓደኛ አልተገኘም</b>
<blockquote>There are currently no other open roommate listings in our database.
በአሁኑ ሰዓት በመረጃ ቋታችን ውስጥ ምንም ክፍት የሆነ የክፍል ጓደኛ ማስታወቂያ የለም።</blockquote>
<b>Be Featured on Our Channel / በቻናላችን ላይ ይለጠፉ</b>
<blockquote>Post your profile now to broadcast to our Telegram community and find compatible roommates!
የራስዎን ማስታወቂያ በመለጠፍ በቻናላችን በኩል ተስማሚ የቤት አጋሮችን ያግኙ!</blockquote>
 `.trim();

 const emptyKeyboardRows = [
 [{ text: 'Post My Seeker Profile / የኔን መረጃ ቻናል ላይ ልለጥፍ', callback_data: 'post_branch_seeker' }],
 [{ text: 'Try Again / እንደገና ሞክር', callback_data: 'matchmaker_start' }],
 [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ];

 await sendOrEditCard(chatId, emptyText, emptyKeyboardRows, messageIdToEdit);
 return;
 }

 // Filter strictly compatible profiles first, then rank by Match Score
 const isBrowseAll = Boolean((criteria as any).browse_all);
 const isAllSubcitiesSelected = ALL_SUBCITIES.length > 0 && ALL_SUBCITIES.every((s) => preferredSubs.includes(s));
 const filteredProfiles = allProfiles.filter((prof) => {
 if (!isBrowseAll) {
 if (prefGender !== 'Any' && prof.my_gender && !['member', 'any'].includes(String(prof.my_gender).toLowerCase())) {
 if (String(prof.my_gender).toLowerCase() !== prefGender.toLowerCase()) return false;
 }
 if (myGender) {
 const gChk = checkGenderPreferenceMatch(prof.preferred_gender, prof.lifestyle_bio, myGender);
 if (!gChk.allowed) return false;
 }
 if (preferredSubs.length > 0 && !isAllSubcitiesSelected) {
 const profSubs: string[] = Array.isArray(prof.preferred_subcity) ? prof.preferred_subcity : [];
 const hasSubOverlap = preferredSubs.some((s) =>
 profSubs.some((ps) => {
   const a = ps.trim().toLowerCase();
   const b = s.trim().toLowerCase();
   return a === b || a.includes(b) || b.includes(a);
 })
 );
 if (!hasSubOverlap && !profSubs.some((ps) => ps.toLowerCase().includes('addis ababa'))) return false;
 }
 if (budgetMin > 0 || (budgetMax > 0 && budgetMax < 100000)) {
 const profMin = Number(prof.budget_min || 0);
 const profMax = Number(prof.budget_max || 0);
 if (budgetMax > 0 && budgetMax < 100000 && profMin > budgetMax * 1.5) {
   return false;
 }
 if (budgetMax > 0 && budgetMax < 100000 && profMin === 0 && profMax > budgetMax * 1.5) {
   return false;
 }
 if (budgetMin > 0 && profMax > 0 && profMax < budgetMin * 0.75) {
   return false;
 }
 }
 }
 return true;
 });

 // Calculate Match Score for each compatible profile
 const scoredMatches = filteredProfiles.map((prof) => {
 let score = 45;

 const profSubs: string[] = Array.isArray(prof.preferred_subcity) ? prof.preferred_subcity : [];
 if (preferredSubs.length === 0) {
 score += 20;
 } else {
 const hasSubcityOverlap = preferredSubs.some((s) =>
 profSubs.some((ps) => ps.toLowerCase() === s.toLowerCase())
 );
 if (hasSubcityOverlap) score += 25;
 }

 const profMin = Number(prof.budget_min || 0);
 const profMax = Number(prof.budget_max || 0);
 if ((!budgetMin && (!budgetMax || budgetMax === 0)) || (
   (profMax === 0 || profMax >= budgetMin * 0.85) &&
   (budgetMax === 0 || (profMin > 0 ? profMin <= budgetMax * 1.15 : profMax <= budgetMax * 1.25))
 )) {
 score += 15;
 }

 if (prefGender === 'Any' || prof.my_gender.toLowerCase() === prefGender.toLowerCase()) {
 score += 10;
 }
 if (!myGender || prof.preferred_gender === 'Any' || prof.preferred_gender.toLowerCase() === myGender.toLowerCase()) {
 score += 5;
 }

 if (
 myReligion &&
 !['other', 'any'].includes(myReligion.toLowerCase()) &&
 prof.religion &&
 String(prof.religion).trim().toLowerCase() === myReligion.toLowerCase()
 ) {
 score += 5;
 }

 if (prof.age && myAge) {
 const ageDiff = Math.abs(prof.age - myAge);
 if (ageDiff <= 2) score += 15;
 else if (ageDiff <= 5) score += 10;
 else if (ageDiff <= 8) score += 5;
 } else if (prof.age && ageBracket) {
 let ageMatch = false;
 if (ageBracket === '18-22' && prof.age >= 18 && prof.age <= 22) ageMatch = true;
 if (ageBracket === '23-27' && prof.age >= 23 && prof.age <= 27) ageMatch = true;
 if (ageBracket === '28-35' && prof.age >= 28 && prof.age <= 35) ageMatch = true;
 if (ageBracket === '36+' && prof.age >= 36) ageMatch = true;
 if (ageMatch) score += 10;
 }

 const finalScore = Math.min(Math.max(score, 40), 99);
 return { ...prof, matchScore: finalScore };
 });

 scoredMatches.sort((a, b) => b.matchScore - a.matchScore);

 if (scoredMatches.length === 0) {
 const noMatchesText = `<b>No Exact Matches Found / ምንም ተዛማጅ አልተገኘም</b>
<blockquote>We could not find an exact match for your selected filters in those specific sub-cities right now.
በመረጧቸው ክፍለ ከተሞች እና መስፈርቶች መሰረት በአሁኑ ሰዓት ምንም ተዛማጅ ሰው አልተገኘም።</blockquote>

 Try browsing all active seekers across Addis Ababa or post your seeker profile! / አዲስ አበባ ውስጥ ያሉ ሌሎች ፈላጊዎችን ይመልከቱ ወይም የራስዎን መረጃ ይለጥፉ!
 `.trim();

 const noMatchesKeyboardRows = [
 [{ text: 'Browse All Open Seekers / ሁሉንም ክፍት ፈላጊዎች እይ', callback_data: 'match_browse_all' }],
 [{ text: 'Post My Seeker Profile / የኔን መረጃ ልለጥፍ', callback_data: 'post_branch_seeker' }],
 [{ text: 'Change Filters / መስፈርቶችን ቀይር', callback_data: 'matchmaker_start' }],
 [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ];

 await sendOrEditCard(chatId, noMatchesText, noMatchesKeyboardRows, messageIdToEdit);
 return;
 }

 // Paginated Single Card Display
 const safeIndex = Math.max(0, Math.min(candidateIndex, scoredMatches.length - 1));
 const match = scoredMatches[safeIndex];
 const subcitiesStr = Array.isArray(match.preferred_subcity)
 ? match.preferred_subcity.join(', ')
 : 'Addis Ababa / አዲስ አበባ';
 const badge = match.fayda_status === 'verified'
 ? 'Verified / የተረጋገጠ'
 : 'Pending Review / በግምገማ ላይ';
 const ageDisplay = match.age ? `, Age ${match.age}` : '';
 const rawBioStr = match.lifestyle_bio || 'Seeking a compatible roommate in Addis Ababa. / በአዲስ አበባ ውስጥ ተስማሚ የቤት ጓደኛ እፈልጋለሁ።';
 const cleanMatchBio = extractUserDescription(rawBioStr) || rawBioStr;
 const bioContent = cleanMatchBio.replace(/</g, '&lt;').replace(/>/g, '&gt;');
 const matchHouseRules = match.house_rules || extractHouseRulesFromTraits(rawBioStr);
 const houseRulesLine = matchHouseRules ? `\n• <b>House Rules / የቤት ህጎች:</b> ${escapeHtml(String(matchHouseRules))}` : '';
 const genderDisplay = match.my_gender === 'Female' ? 'Female / ሴት' : match.my_gender === 'Male' ? 'Male / ወንድ' : match.my_gender;
 const prefGenderDisplay = match.preferred_gender === 'Female' ? 'Female Only / ሴት ብቻ' : match.preferred_gender === 'Male' ? 'Male Only / ወንድ ብቻ' : 'Any Gender / ማንኛውም ጾታ';
 const matchDisplayCode = match.display_code ? `#${match.display_code.replace(/^#/, '')}` : `#${safeIndex + 1}`;
 const budgetDisplay = formatBudgetRangeLabel(match.budget_min, match.budget_max, 'Flexible');
 const religionLine = match.religion ? `\n• <b>Religion / እምነት:</b> ${escapeHtml(match.religion)}` : '';
 const jobLine = match.job ? `\n• <b>Occupation / ሙያ:</b> ${escapeHtml(match.job)}` : '';

 const matchCardText = `<b>Roommate Candidate ${escapeHtml(matchDisplayCode)}</b>
<b>${match.matchScore}% Match · ${safeIndex + 1} of ${scoredMatches.length}</b>

<blockquote>• <b>Preferred Areas / አካባቢ:</b> <b>${escapeHtml(subcitiesStr)}</b>
• <b>Candidate / ተፈላጊ:</b> ${escapeHtml(genderDisplay)}${escapeHtml(ageDisplay)}${religionLine}${jobLine}
• <b>Looking For / የሚፈልጉት:</b> ${escapeHtml(prefGenderDisplay)}
• <b>Monthly Budget / በጀት:</b> <b>${escapeHtml(budgetDisplay)}</b>${houseRulesLine}
• <b>Status / ሁኔታ:</b> <b>${escapeHtml(badge)}</b></blockquote>

<b>ABOUT ME / ስለ እኔ</b>
<blockquote>${bioContent}</blockquote>

<blockquote>🔒 <b>Privacy Shield / ሚስጥራዊነት:</b> Direct contact revealed strictly upon mutual accept.
ቀጥተኛ ስልክ እና አድራሻ በጋራ ፈቃድ ብቻ ሚስጥራዊ ሆነው ይገለጣሉ።</blockquote>
 `.trim();

 const inlineKeyboardRows: any[] = [];

 // Row 1 (Hero CTA): Unlock Direct Contact
 inlineKeyboardRows.push([
 {
 text: 'Unlock Direct Contact / አድራሻቸውን ክፈት >',
 callback_data: `search_unlock_contact:${match.id}`,
 },
 ]);

 // Row 2 (Pagination Grid): Clean 2-column or 3-column pagination
 if (scoredMatches.length > 1) {
 const navRow: any[] = [];
 if (safeIndex > 0) {
 navRow.push({ text: '⬅ Prev / ወደ ኋላ', callback_data: `match_page:${safeIndex - 1}` });
 } else {
 navRow.push({ text: '• Start •', callback_data: 'match_noop' });
 }
 navRow.push({ text: `${safeIndex + 1} / ${scoredMatches.length}`, callback_data: 'match_noop' });
 if (safeIndex < scoredMatches.length - 1) {
 navRow.push({ text: 'Next / ወደ ፊት >', callback_data: `match_page:${safeIndex + 1}` });
 } else {
 navRow.push({ text: '• End •', callback_data: 'match_noop' });
 }
 inlineKeyboardRows.push(navRow);
 }

 // Row 3 (2-Column Action Grid): Refine & Main Menu
 inlineKeyboardRows.push([
 { text: 'Refine Filters / አጣራ', callback_data: 'matchmaker_start' },
 { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
 ]);

 await sendOrEditCard(chatId, matchCardText, inlineKeyboardRows, messageIdToEdit);
 };

 // Helper: Exact Direct Post Lock-On & Unified Double-Blind Consent Flow
 const sendUnlockPaywallCard = async (
 chatId: number,
 targetId: string,
 targetType: 'roommate_profile' | 'space_listing',
 messageIdToEdit?: number
 ) => {
 // Universal Gate 1: Fayda Verification required before connecting or unlocking contact info
 if (!(await isUserFaydaVerified(chatId))) {
 await sendFaydaGateCard(chatId, 'unlock verified contact information', messageIdToEdit, {
   return_flow: 'unlock_contact',
   return_meta: { targetId, targetType },
 });
 return;
 }

 const cleanCodeLookup = targetId.replace(/^#/, '').trim();
 const isUuidTarget = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanCodeLookup);
 let targetPreferredGender = '';
 let bioInfo = '';
 let codeForNotice = '';
 let targetClosed = false;
 let canonicalProfileId = '';
 let hostTgId: number | null = null;
 let hostName = '';
 let hostPhone = '';
 let hostUsername = '';
 let hostSubcity = 'Addis Ababa';
 let hostBudget = 10000;

 if (
 targetId.toUpperCase().startsWith('SPMARBR') ||
 targetId.toUpperCase().startsWith('SPMARWR') ||
 targetId.toUpperCase().startsWith('RM')
 ) {
 codeForNotice = targetId.toUpperCase().replace(/^#/, '');
 }

 if (targetType === 'roommate_profile') {
 if (isUuidTarget) {
 try {
 const { data: dbProf } = await supabaseAdmin
 .from('roommate_profiles')
 .select('*, users(*)')
 .eq('id', cleanCodeLookup)
 .maybeSingle();
 if (dbProf) {
 if (['archived', 'rejected', 'matched', 'closed'].includes(String(dbProf.status || '').toLowerCase())) {
 targetClosed = true;
 }
 targetPreferredGender = dbProf.preferred_gender || '';
 bioInfo = dbProf.lifestyle_bio || '';
 hostTgId = dbProf.user_telegram_id || dbProf.users?.telegram_id || null;
 hostName = [dbProf.users?.first_name, dbProf.users?.last_name].filter(Boolean).join(' ') || '';
 hostPhone = dbProf.users?.phone_number || '';
 hostUsername = dbProf.users?.username || '';
 hostSubcity = Array.isArray(dbProf.preferred_subcity) ? dbProf.preferred_subcity[0] : 'Addis Ababa';
 hostBudget = Number(dbProf.budget_max || 10000);
 }
 } catch {}
 }

 const draft = await getRoommateDraft(cleanCodeLookup);
 if (draft) {
 if (draft.display_code) codeForNotice = draft.display_code.toUpperCase().replace(/^#/, '');
 if (['archived', 'rejected', 'matched', 'closed'].includes(String(draft.status || '').toLowerCase())) {
 targetClosed = true;
 }
 if (!targetPreferredGender && draft.preferred_gender) targetPreferredGender = draft.preferred_gender;
 if (!bioInfo && draft.lifestyle_bio) bioInfo = draft.lifestyle_bio;
 if (!hostTgId && draft.user_telegram_id) hostTgId = draft.user_telegram_id;
 if (!hostName && draft.user_name) hostName = draft.user_name;
 if (!hostUsername && draft.username) hostUsername = draft.username;
 }

 try {
 const pQuery = isUuidTarget
 ? supabaseAdmin.from('profiles').select('*').eq('id', cleanCodeLookup).maybeSingle()
 : supabaseAdmin.from('profiles').select('*').ilike('display_code', cleanCodeLookup).maybeSingle();
 const { data: pData } = await pQuery;
 if (pData) {
 canonicalProfileId = pData.id;
 if (pData.display_code) codeForNotice = pData.display_code.toUpperCase().replace(/^#/, '');
 if (['matched', 'closed', 'archived', 'rejected'].includes(String(pData.status || '').toLowerCase())) {
 targetClosed = true;
 }
 if (!targetPreferredGender && pData.preferred_gender) targetPreferredGender = pData.preferred_gender;
 if (!bioInfo && pData.roommate_traits) bioInfo = pData.roommate_traits;
 if (!hostTgId && pData.telegram_id) hostTgId = pData.telegram_id;
 if (!hostName && pData.full_name) hostName = pData.full_name;
 if (!hostUsername && pData.telegram_username) hostUsername = pData.telegram_username;
 }
 } catch {}
 } else {
 // Space listing: resolve metadata & canonical host record for double-blind consent
 if (isUuidTarget) {
 try {
 const { data: dbSpace } = await supabaseAdmin.from('spaces').select('*').eq('id', cleanCodeLookup).maybeSingle();
 if (dbSpace) {
 if (['rented', 'archived', 'closed', 'matched'].includes(String(dbSpace.status || '').toLowerCase())) {
 targetClosed = true;
 }
 if (!targetPreferredGender && dbSpace.preferred_tenant_gender) targetPreferredGender = dbSpace.preferred_tenant_gender;
 bioInfo = dbSpace.description || '';
 hostName = dbSpace.contact_name || dbSpace.title || 'Verified Space Host';
 hostPhone = dbSpace.contact_phone || '';
 hostUsername = dbSpace.contact_telegram || '';
 hostSubcity = dbSpace.neighborhood || 'Addis Ababa';
 hostBudget = Number(dbSpace.price_per_month || 10000);
 }
 } catch {}
 }

 const spaceDraft = await getDraft(cleanCodeLookup);
 if (spaceDraft) {
 if (['archived', 'rejected', 'rented', 'closed'].includes(String(spaceDraft.status || '').toLowerCase())) {
 targetClosed = true;
 }
 if (!targetPreferredGender && spaceDraft.preferred_tenant_gender) targetPreferredGender = spaceDraft.preferred_tenant_gender;
 if (!bioInfo && spaceDraft.description) bioInfo = spaceDraft.description;
 if (!hostTgId && spaceDraft.homeowner_telegram_id) hostTgId = spaceDraft.homeowner_telegram_id;
 if (!hostUsername && spaceDraft.homeowner_username) hostUsername = spaceDraft.homeowner_username;
 if (!hostPhone && spaceDraft.contact_phone) hostPhone = spaceDraft.contact_phone;
 if (!hostName && spaceDraft.title) hostName = spaceDraft.title;
 hostSubcity = spaceDraft.neighborhood || hostSubcity;
 hostBudget = Number(spaceDraft.price_per_month || hostBudget);
 }

 const rmDraft = await getRoommateDraft(cleanCodeLookup);
 if (rmDraft) {
 if (rmDraft.display_code) codeForNotice = rmDraft.display_code.toUpperCase().replace(/^#/, '');
 if (['archived', 'rejected', 'matched', 'closed'].includes(String(rmDraft.status || '').toLowerCase())) {
 targetClosed = true;
 }
 if (!targetPreferredGender && rmDraft.preferred_gender) targetPreferredGender = rmDraft.preferred_gender;
 if (!bioInfo && rmDraft.lifestyle_bio) bioInfo = rmDraft.lifestyle_bio;
 if (!hostTgId && rmDraft.user_telegram_id) hostTgId = rmDraft.user_telegram_id;
 if (!hostName && rmDraft.user_name) hostName = rmDraft.user_name;
 if (!hostPhone && rmDraft.contact_phone) hostPhone = rmDraft.contact_phone;
 if (!hostUsername && rmDraft.username) hostUsername = rmDraft.username;
 }

 try {
 const pQuery = isUuidTarget
 ? supabaseAdmin.from('profiles').select('*').eq('id', cleanCodeLookup).maybeSingle()
 : supabaseAdmin.from('profiles').select('*').ilike('display_code', cleanCodeLookup).maybeSingle();
 const { data: pData } = await pQuery;
 if (pData) {
 canonicalProfileId = pData.id;
 if (pData.display_code) codeForNotice = pData.display_code.toUpperCase().replace(/^#/, '');
 if (['matched', 'closed', 'archived', 'rejected', 'rented'].includes(String(pData.status || '').toLowerCase())) {
 targetClosed = true;
 }
 if (!targetPreferredGender && pData.preferred_gender) targetPreferredGender = pData.preferred_gender;
 if (!bioInfo && pData.roommate_traits) bioInfo = pData.roommate_traits;
 if (!hostTgId && pData.telegram_id) hostTgId = pData.telegram_id;
 }
 } catch {}
 }

 if (targetClosed) {
 await sendOrEditCard(
 chatId,
 `<b>Listing Closed / ማስታወቂያው ተዘግቷል</b>\n\n<blockquote>This listing is no longer available.\nይህ ማስታወቂያ ቀድሞውኑ ተዘግቷል።</blockquote>`,
 [[{ text: 'Browse Open Matches / ሌሎችን እይ', callback_data: 'matchmaker_start' }], [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }]],
 messageIdToEdit
 );
 return;
 }

 if (!canonicalProfileId && !hostTgId && !codeForNotice && !bioInfo) {
 await sendOrEditCard(
 chatId,
 `<b>Listing Not Found / ማስታወቂያው አልተገኘም</b>\n\n<blockquote>This listing could not be found or has been removed.\nይህ ማስታወቂያ አልተገኘም ወይም ተሰርዟል።</blockquote>`,
 [[{ text: 'Browse Open Matches / ሌሎችን እይ', callback_data: 'matchmaker_start' }], [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }]],
 messageIdToEdit
 );
 return;
 }

 if (hostTgId && String(hostTgId) === String(chatId)) {
 await sendOrEditCard(
 chatId,
 `<b>Own Listing / የራስዎ ማስታወቂያ</b>\n\n<blockquote>You cannot unlock or send a request to your own listing.\nለራስዎ ማስታወቂያ ጥያቄ መላክ አይችሉም።</blockquote>`,
 [[{ text: 'My Listings / ማስታወቂያዎቼ', callback_data: 'my_listings' }], [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }]],
 messageIdToEdit
 );
 return;
 }

 // Gender preference check BEFORE sending or paying
 const { data: requesterProf } = await supabaseAdmin
 .from('profiles')
 .select('gender')
 .eq('telegram_id', chatId)
 .maybeSingle();

 if (!requesterProf?.gender || requesterProf.gender === 'Member') {
 // Need a brief seeker profile before checking/unlocking (so they don't pay 100 ETB and get blocked later!)
 await routeNextMissingSeekerStep(chatId, { target_id: canonicalProfileId || targetId, target_code: codeForNotice }, messageIdToEdit);
 return;
 }

 const genderCheck = checkGenderPreferenceMatch(
 targetPreferredGender,
 bioInfo,
 requesterProf.gender
 );
 if (!genderCheck.allowed) {
 const userLang = getUserLanguage(chatId);
 const isAm = userLang === 'am';
 const { text: mismatchText, keyboard: mismatchKb } = getGenderMismatchCard(
 isAm,
 targetId,
 genderCheck.targetPrefFormattedEn,
 genderCheck.targetPrefFormattedAm,
 requesterProf.gender
 );
 await sendOrEditCard(chatId, mismatchText, mismatchKb, messageIdToEdit);
 return;
 }

 // Universal Gate 2: Mandatory 100 ETB 3-Month Membership Pass
 const mem = await getUserMembershipStatus(chatId);
 if (!mem.isActive) {
 await sendMembershipPaywallCard(
 chatId,
 'connect_request',
 {
 targetProfileId: canonicalProfileId || targetId,
 targetDisplayCode: codeForNotice,
 targetType,
 },
 messageIdToEdit
 );
 return;
 }

 // Active Pass Held: route BOTH Roommate Seekers & Space Hosts through Double-Blind Mutual Consent!
 if (!canonicalProfileId && hostTgId) {
 const { data: existingHostProf } = await supabaseAdmin
 .from('profiles')
 .select('id')
 .eq('telegram_id', hostTgId)
 .maybeSingle();
 if (existingHostProf?.id) {
 canonicalProfileId = existingHostProf.id;
 }
 }

 if (!canonicalProfileId && targetType === 'space_listing') {
 // Create synthetic host profile for spaces uploaded via Mini App / Admin Concierge
 let syntheticHash = 0;
 for (let i = 0; i < cleanCodeLookup.length; i++) {
 syntheticHash = ((syntheticHash << 5) - syntheticHash + cleanCodeLookup.charCodeAt(i)) | 0;
 }
 const hostTelegramId = hostTgId && hostTgId !== 0 ? hostTgId : -(2000000000 + Math.abs(syntheticHash || 1001));
 const safeDisplayCode = (codeForNotice || `SPACE${cleanCodeLookup.slice(0, 8)}`).toUpperCase().replace(/^#/, '');
 const { data: createdSpaceHost } = await supabaseAdmin
 .from('profiles')
 .upsert({
 telegram_id: hostTelegramId,
 display_code: safeDisplayCode,
 gender: 'Any',
 preferred_gender: targetPreferredGender || 'Any',
 locations: [hostSubcity],
 budget_min: 0,
 budget_max: hostBudget,
 roommate_traits: bioInfo || 'Available Space Listing',
 full_name: hostName || 'SpaceMatch Host',
 phone_number: hostPhone || null,
 telegram_username: hostUsername || (hostTelegramId < 0 ? 'admin:concierge' : null),
 kyc_status: 'verified',
 status: 'active',
 onboarding_step: 'completed',
 }, { onConflict: 'telegram_id' })
 .select('id')
 .maybeSingle();
 if (createdSpaceHost?.id) {
 canonicalProfileId = createdSpaceHost.id;
 }
 }

 await executeDirectMatchRequest(chatId, canonicalProfileId || targetId, messageIdToEdit);
 };

 // Helper: Homeowner Space Prompts
 const sendPropertyTypePrompt = async (chatId: number, messageIdToEdit?: number) => {
 // Universal Gate: Fayda Verification required before listing spaces for rent
 if (!(await isUserFaydaVerified(chatId))) {
 await sendFaydaGateCard(chatId, 'list a property or space for rent', messageIdToEdit);
 return;
 }

 await saveSession({
 telegram_id: chatId,
 step: 'awaiting_property_type',
 draft_data: messageIdToEdit ? { card_msg_id: messageIdToEdit } : {},
 updated_at: new Date().toISOString(),
 });

 const text = `<b>List Your Space / ክፍልዎን ያስተዋውቁ</b>\n\n<blockquote>What type of space are you renting out?\nምን አይነት ቦታ ነው የሚያከራዩት?</blockquote>`.trim();

 const inlineKeyboard = [
 [{ text: 'Shared Room / የጋራ መኖሪያ ክፍል', callback_data: 'prop_type:shared' }],
 [{ text: 'Entire House / Apartment / ሙሉ ቤት ወይም አፓርታማ', callback_data: 'prop_type:entire' }],
 [{ text: 'Office / Commercial Space / ቢሮ', callback_data: 'prop_type:office' }],
 [{ text: 'Shop / Commercial Venue / ሱቅ ወይም ንግድ ቦታ', callback_data: 'prop_type:shop' }],
 [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ];

 await sendOrEditCard(chatId, text, inlineKeyboard, messageIdToEdit);
 };

 // -------------------------------------------------------------------------
 // -1. HANDLE BOT CHAT MEMBER UPDATES (Bot added / removed as admin in any channel)
 // -------------------------------------------------------------------------
 if (update.my_chat_member) {
 const mcm = update.my_chat_member;
 const chat = mcm.chat;
 const newStatus = mcm.new_chat_member?.status;
 const addedBy = mcm.from?.id;

 if (chat && (chat.type === 'channel' || chat.type === 'supergroup')) {
 const channelId = chat.id;
 const channelTitle = chat.title || 'Channel';
 const channelUsername = chat.username ? `@${chat.username}` : null;

 if (newStatus === 'administrator') {
 const knownAdminIds = await getAdminTelegramIds();
 const envPrimaryCh = process.env.CHANNEL_ID || process.env.NEXT_PUBLIC_CHANNEL_ID || '';
 const isAuthorizedAdder = Boolean(addedBy && knownAdminIds.includes(addedBy));
 const isPrimaryChannel = Boolean(
 envPrimaryCh &&
 (String(channelId) === String(envPrimaryCh) ||
 (channelUsername && channelUsername.toLowerCase() === envPrimaryCh.toLowerCase()))
 );

 if (!isAuthorizedAdder && !isPrimaryChannel) {
 console.warn(`[webhook] Ignoring untrusted channel admin addition: ${channelId} (${channelTitle}) by ${addedBy}`);
 return NextResponse.json({ ok: true });
 }

 await saveManagedChannel({
 channel_id: channelId,
 channel_title: channelTitle,
 channel_username: channelUsername,
 added_by: addedBy,
 is_active: true,
 added_at: new Date().toISOString(),
 updated_at: new Date().toISOString(),
 });

 // Invalidate admin cache so newly discovered channel's admins are recognized immediately
 invalidateAdminIdsCache();

 console.log(`[webhook] Bot added as admin to channel: ${channelTitle} (${channelId}) by user ${addedBy}`);

 // Notify the administrator who added the bot
 if (addedBy) {
 await sendTelegram('sendMessage', {
 chat_id: addedBy,
 text: `<b>Channel Successfully Connected to SpaceMatch!</b>\n\nSpaceMatch Bot is now an active administrator of <b>${escapeHtml(channelTitle)}</b> (${escapeHtml(String(channelUsername || channelId))}).\n\n• All administrators of this channel can now manage, approve, and close roommate listings via the bot.\n• Approved roommate listings will automatically broadcast to this channel with interactive 2-button cards!`,
 parse_mode: 'HTML',
 });
 }
 } else if (newStatus === 'left' || newStatus === 'kicked') {
 await removeManagedChannel(channelId);
 invalidateAdminIdsCache();
 console.log(`[webhook] Bot removed from channel: ${channelTitle} (${channelId})`);
 }
 }

 return NextResponse.json({ ok: true });
 }

 // -------------------------------------------------------------------------
 // 0. HANDLE CHANNEL POSTS & EDITED CHANNEL POSTS (Bot acts as Channel Admin)
 // -------------------------------------------------------------------------
 const channelPost = update.channel_post || update.edited_channel_post;
 if (channelPost && channelPost.chat) {
 const channelId = channelPost.chat.id;
 const messageId = channelPost.message_id;
 const postText = (channelPost.text || channelPost.caption || '').trim();

 // Only update managed channel metadata if channel is already trusted or configured primary channel
 try {
 const existingManaged = await getManagedChannels();
 const envPrimaryCh = process.env.CHANNEL_ID || process.env.NEXT_PUBLIC_CHANNEL_ID || '';
 const isTrustedChannel = existingManaged.some((c) => c.channel_id === channelId) ||
 (envPrimaryCh && (String(channelId) === String(envPrimaryCh) || `@${channelPost.chat.username || ''}`.toLowerCase() === envPrimaryCh.toLowerCase()));
 if (isTrustedChannel) {
 await saveManagedChannel({
 channel_id: channelId,
 channel_title: channelPost.chat.title || 'Connected Channel',
 channel_username: channelPost.chat.username ? `@${channelPost.chat.username}` : null,
 is_active: true,
 added_at: new Date().toISOString(),
 updated_at: new Date().toISOString(),
 });
 }
 } catch (chErr) {
 console.warn('[webhook] channelPost auto-registration warning:', chErr);
 }

 // Skip if post is already marked as matched or closed
 if (postText.includes('MATCHED') || postText.includes('CLOSED')) {
 return NextResponse.json({ ok: true });
 }

 // Check if post already has the connect button
 const existingKb = channelPost.reply_markup?.inline_keyboard;
 const hasConnectBtn = existingKb?.some((row: any[]) =>
 row.some((btn: any) =>
 btn.text?.includes('Connect with') ||
 btn.text?.includes('Contact with Roommate') ||
 btn.text?.includes('Contact Host')
 )
 );

 // Check if post was forwarded from bot (Checklist 1.3: direct channel posts without the bot are unaffected)
 const isForwardedFromBot = !!(
 (channelPost as any).forward_from?.is_bot ||
 (channelPost as any).forward_from_chat ||
 (channelPost as any).forward_origin
 );

 // Extract display_code (#RM... or RM...)
 let displayCode: string | null = null;
 const rmMatch = postText.match(/#?(RM[A-Za-z0-9_-]+)/i);
 if (rmMatch) {
 displayCode = rmMatch[1].toUpperCase();
 } else {
 const tagMatch = postText.match(/#([A-Za-z0-9_-]+)/);
 if (tagMatch) {
 displayCode = tagMatch[1].toUpperCase();
 }
 }

 if (!displayCode) {
 displayCode = `RM${messageId}`;
 }

 // Link channel_message_id in DB if displayCode matches existing profile or roommate_profile
 let targetFound = false;
 try {
 const { data: pRows } = await supabaseAdmin
 .from('profiles')
 .update({ channel_message_id: messageId })
 .ilike('display_code', displayCode)
 .select('id');
 if (pRows && pRows.length > 0) targetFound = true;

 const { data: rmRows } = await supabaseAdmin
 .from('roommate_profiles')
 .update({ channel_message_id: messageId })
 .ilike('display_code', displayCode)
 .select('id');
 if (rmRows && rmRows.length > 0) targetFound = true;
 } catch (linkErr) {
 console.error('[webhook] Error linking channel_message_id:', linkErr);
 }

 // If forwarded from the bot and buttons missing, attach the 3 standard buttons
 if (isForwardedFromBot && !hasConnectBtn) {
 const buttonTitle = 'Connect with this roommate / ከዚህ አጋር ጋር ተገናኝ >';
 const connectPayload = `req_${displayCode}`;

 if (!targetFound) {
 try {
 const adminIds = await getAdminIds();
 const adminChatId = adminIds[0] || 800701176;

 const commonSubcities = [
 'Bole', 'Kazanchis', 'Sarbet', 'CMC', 'Gerji', 'Megenagna', 'Piassa',
 '4 Kilo', '22 Mazoria', 'Bisrate Gabriel', 'Summit', 'Lebu', 'Jomo',
 'Ayat', 'Torhailoch', 'Bethel', 'Gotera', 'Kera', 'Nifas Silk',
 'Kolfe Keraniyo', 'Gullele', 'Lideta'
 ];
 const matchedSubs = commonSubcities.filter((s) =>
 postText.toLowerCase().includes(s.toLowerCase())
 );

 const budgetMatch = postText.match(/(\d+[\d,]*)\s*(etb|birr|\/mo|\/month|k\b)/i);
 let parsedBudget = 0;
 if (budgetMatch) {
 const rawNum = budgetMatch[1].replace(/,/g, '');
 parsedBudget = parseInt(rawNum, 10);
 if (budgetMatch[2]?.toLowerCase() === 'k') parsedBudget *= 1000;
 }

 const isFemale = postText.toLowerCase().includes('female') || postText.toLowerCase().includes('ሴት');
 const isMale = postText.toLowerCase().includes('male') || postText.toLowerCase().includes('ወንድ');
 const genderVal = isFemale ? 'Female' : isMale ? 'Male' : 'Any';

 await supabaseAdmin.from('profiles').upsert(
 {
 telegram_id: adminChatId,
 display_code: displayCode,
 channel_message_id: messageId,
 gender: genderVal,
 locations: matchedSubs.length > 0 ? matchedSubs : ['Addis Ababa'],
 budget_min: 0,
 budget_max: parsedBudget || 10000,
 roommate_traits: postText.slice(0, 300) || 'Channel Roommate Listing',
 kyc_status: 'verified',
 status: 'active',
 onboarding_step: 'completed',
 },
 { onConflict: 'display_code' }
 );
 } catch (createErr) {
 console.error('[webhook] Error creating channel post profile placeholder:', createErr);
 }
 }

 const newButtons = [
 [{ text: buttonTitle, url: `https://t.me/${botUsername}?start=${connectPayload}` }],
 [{ text: 'Search Roommate for Me / የቤት አጋር ፈልግልኝ >', url: `https://t.me/${botUsername}?start=search_roommate` }],
 [{ text: 'Post My Profile / መረጃዬን ልለጥፍ >', url: `https://t.me/${botUsername}?start=post_profile` }],
 ];

 const updatedInlineKeyboard = existingKb && existingKb.length > 0
 ? [...existingKb, ...newButtons]
 : newButtons;

 const editRes = await sendTelegram('editMessageReplyMarkup', {
 chat_id: channelId,
 message_id: messageId,
 reply_markup: {
 inline_keyboard: updatedInlineKeyboard,
 },
 });

 console.log(`[webhook] editMessageReplyMarkup for channel post ${messageId} in ${channelId}:`, editRes?.ok ? 'SUCCESS' : editRes?.description);
 }

 return NextResponse.json({ ok: true });
 }

 // -------------------------------------------------------------------------
 // 1. HANDLE INLINE CALLBACK QUERIES
 // -------------------------------------------------------------------------
 if (update.callback_query) {
 const callback = update.callback_query;
 let callbackData: string = callback.data || '';
 const chatId: number = callback.message?.chat?.id || callback.from.id;
 const msgId: number | undefined = callback.message?.message_id;
 const fromUsername: string | undefined = callback.from?.username;

 // Immediately acknowledge callback query so the button spinner clears in <100ms
 if (callback.id) {
 sendTelegram('answerCallbackQuery', { callback_query_id: callback.id }).catch(() => {});
 }

 // Only process callbacks inside private 1:1 chats (ignore groups/channels)
 if (chatId <= 0) {
 return NextResponse.json({ ok: true });
 }

 // Concurrency guard: Double-tap / duplicate callback debounce across Lambdas
 const isCriticalAction =
 callbackData.startsWith('confirm_match:') ||
 callbackData.startsWith('match_accept:') ||
 callbackData.startsWith('match_decline:') ||
 callbackData.startsWith('search_unlock_contact:') ||
 callbackData.startsWith('admin_close') ||
 callbackData.startsWith('admin_approve_profile:') ||
 callbackData.startsWith('seeker_approve:') ||
 callbackData.startsWith('space_submit_admin:') ||
 callbackData.startsWith('dyn_publish_channel:') ||
 callbackData.startsWith('dyn_submit_channel:') ||
 callbackData.startsWith('user_close_listing:') ||
 callbackData.startsWith('owner_close_listing:') ||
 callbackData.startsWith('close_channel_post:') ||
 callbackData === 'admin_post_confirm' ||
 callbackData === 'seeker_final_submit';

 const actionLockKey = isCriticalAction ? `action_lock:${chatId}:${callbackData}` : null;
 if (actionLockKey) {
 if (!(await acquireActionLock(actionLockKey, 8000))) {
 return NextResponse.json({ ok: true, debounced: true });
 }
 }

 try {
 // Load session from Supabase before any getSession() call
 await preloadSession(chatId);

 if (callbackData === 'open_lang_select') {
 await sendLanguageSelectCard(chatId, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'set_lang:am' || callbackData === 'set_lang:en') {
 const chosenLang = callbackData.split(':')[1] as 'am' | 'en';
 setUserLanguage(chatId, chosenLang);
 const sess = getSession(chatId);
 await saveSession({
 ...sess,
 draft_data: { ...sess.draft_data, lang: chosenLang },
 updated_at: new Date().toISOString(),
 });
 await sendPrimaryWelcomeMenu(chatId, msgId, callback.from);
 return NextResponse.json({ ok: true });
 }

 // ── NEW: Onboarding callbacks (gender, location, move-in) ──────────────
 if (isOnboardingCallback(callbackData)) {
 await handleOnboardingCallback(
 callback.id,
 callbackData,
 chatId,
 fromUsername,
 msgId
 );
 return NextResponse.json({ ok: true });
 }

 // ── Admin Channel Post Wizard Callbacks ────────────────────────────────
 if (callbackData === 'admin_post_start' || callbackData.startsWith('admin_post_')) {
 const wizardAdminIds = await getAdminIds();
 if (!wizardAdminIds.includes(chatId)) {
 await tgSend(chatId, `<b>Access Denied.</b> Only SpaceMatch administrators can post to the channel.`);
 return NextResponse.json({ ok: true });
 }
 }

 if (callbackData === 'admin_post_start') {
 await sendAdminPostCategoryStep(chatId, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('admin_post_cat:')) {
 const cat = callbackData.split(':')[1];
 const session = getSession(chatId);
 const updatedDraft = { ...session.draft_data, category: cat, locations: ['Bole'] };
 await sendAdminPostSubcitiesStep(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('admin_post_sub_toggle:')) {
 const sub = callbackData.split(':')[1];
 const session = getSession(chatId);
 const currentList: string[] = session.draft_data.locations || ['Bole'];
 const newList = currentList.includes(sub)
 ? currentList.filter((s) => s !== sub)
 : [...currentList, sub];
 const updatedDraft = {
 ...session.draft_data,
 locations: newList.length > 0 ? newList : [sub],
 };
 await sendAdminPostSubcitiesStep(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'admin_post_sub_all') {
 const session = getSession(chatId);
 const updatedDraft = { ...session.draft_data, locations: [...ALL_SUBCITIES] };
 await sendAdminPostBudgetStep(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'admin_post_proceed_budget') {
 const session = getSession(chatId);
 await sendAdminPostBudgetStep(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'admin_post_back_to_subs') {
 const session = getSession(chatId);
 await sendAdminPostSubcitiesStep(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('admin_post_gender:')) {
 const gender = callbackData.split(':')[1];
 const session = getSession(chatId);
 const updatedDraft = { ...session.draft_data, gender };
 await sendAdminPostPrefGenderStep(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('admin_post_pref_gender:')) {
 const preferred_gender = callbackData.split(':')[1];
 const session = getSession(chatId);
 const updatedDraft = { ...session.draft_data, preferred_gender };
 await sendAdminPostBioStep(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'admin_post_back_to_gender') {
 const session = getSession(chatId);
 await sendAdminPostGenderStep(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'admin_post_back_to_pref_gender') {
 const session = getSession(chatId);
 await sendAdminPostPrefGenderStep(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'admin_post_back_to_budget') {
 const session = getSession(chatId);
 await sendAdminPostBudgetStep(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'admin_post_back_to_bio') {
 const session = getSession(chatId);
 await sendAdminPostBioStep(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'admin_post_proceed_contact') {
 const session = getSession(chatId);
 await sendAdminPostContactStep(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'admin_post_contact_concierge') {
 const session = getSession(chatId);
 const draft = session.draft_data || {};
 let adminUsername = 'WWEHID';
 try {
 const { data: adminUser } = await supabaseAdmin
 .from('users')
 .select('username')
 .eq('telegram_id', chatId)
 .maybeSingle();
 if (adminUser?.username) {
 adminUsername = adminUser.username.replace('@', '');
 }
 } catch {}

 const updatedDraft = {
 ...draft,
 is_concierge: true,
 contact_name: 'SpaceMatch Verified Listing (Concierge)',
 contact_phone: 'SpaceMatch Concierge',
 contact_username: adminUsername,
 };
 await saveSession({
 telegram_id: chatId,
 step: 'admin_post_preview',
 draft_data: { ...updatedDraft, card_msg_id: msgId },
 updated_at: new Date().toISOString(),
 });
 await sendAdminPostPreviewCard(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

  if (callbackData === 'admin_post_use_default_bio') {
  const session = getSession(chatId);
  const updatedDraft = {
  ...session.draft_data,
  details: 'Seeking compatible roommate in Addis Ababa.',
  description: 'Seeking compatible roommate in Addis Ababa.',
  lifestyle_bio: 'Seeking compatible roommate in Addis Ababa.',
  roommate_traits: 'Seeking compatible roommate in Addis Ababa.',
  };
  await sendAdminPostHouseRulesStep(chatId, updatedDraft, msgId);
  return NextResponse.json({ ok: true });
  }

  if (callbackData.startsWith('admin_post_house_rules:')) {
  const rulesVal = callbackData.split(':').slice(1).join(':');
  const session = getSession(chatId);
  const updatedDraft = { ...session.draft_data, house_rules: rulesVal };
  await sendAdminPostContactStep(chatId, updatedDraft, msgId);
  return NextResponse.json({ ok: true });
  }

  if (callbackData === 'admin_post_back_to_house_rules') {
  const session = getSession(chatId);
  await sendAdminPostHouseRulesStep(chatId, session.draft_data, msgId);
  return NextResponse.json({ ok: true });
  }

 if (callbackData === 'admin_post_confirm') {
 const session = getSession(chatId);
 const draft = session.draft_data || {};
 const isSpace = draft.category === 'entire' || draft.category === 'room_avail';

 const displayCode = await getNextSpmarbrCode(isSpace ? 'space_available' : 'seeker');

 const subcities = draft.locations || ['Bole'];
 const subcitiesStr = subcities.join(', ');
 const budgetMin = Number(draft.budget_min || 0);
 const budgetNum = Number(draft.budget_max || draft.budget || 10000);

 const rawCandidate = (draft.gender && draft.gender !== 'Member' ? draft.gender : draft.my_gender) || draft.gender || 'Any';
 const rawGender = rawCandidate.toLowerCase();
 const isCandidateFemale = rawGender.includes('female') || rawGender.includes('ሴት') || rawGender === 'f';
 const isCandidateMale = rawGender.includes('male') || rawGender.includes('ወንድ') || rawGender === 'm';
 const candidateSexDisplay = isCandidateFemale ? 'Female (ሴት)' : isCandidateMale ? 'Male (ወንድ)' : (rawCandidate || 'Any Gender');
 const candidateGenderWord = isCandidateFemale ? 'female' : isCandidateMale ? 'male' : 'verified';

 const prefGenderStr = draft.preferred_gender || 'Any';
 const rawPrefGender = prefGenderStr.toLowerCase();
 const isPrefFemale = rawPrefGender.includes('female') || rawPrefGender.includes('ሴት');
 const isPrefMale = rawPrefGender.includes('male') || rawPrefGender.includes('ወንድ');
 const prefGenderFormatted = isPrefFemale ? 'Female Only' : isPrefMale ? 'Male Only' : 'Any Gender';
 const preferredSexDisplay = isPrefFemale ? 'Female Only (ሴት ብቻ)' : isPrefMale ? 'Male Only (ወንድ ብቻ)' : 'Any Gender (ማንኛውም ጾታ)';
 const prefGenderWord = isPrefFemale ? 'female' : isPrefMale ? 'male' : 'compatible';

 const rawBio = (draft.details || draft.description || draft.roommate_traits || draft.lifestyle_bio || '').trim() || 'Seeking compatible roommate in Addis Ababa.';
 const cleanBio = extractUserDescription(rawBio) || rawBio.trim();
 const cleanHouseRules = (draft.house_rules || extractHouseRulesFromTraits(rawBio) || 'Clean, quiet & no smoking').trim();
 const bioStr = `Prefers: ${prefGenderFormatted} | Rules: ${cleanHouseRules} | ${cleanBio}`;

 let adminUsername = 'WWEHID';
 try {
 const { data: adminUser } = await supabaseAdmin
 .from('users')
 .select('username')
 .eq('telegram_id', chatId)
 .maybeSingle();
 if (adminUser?.username) {
 adminUsername = adminUser.username.replace('@', '');
 }
 } catch {}

 const isConcierge = draft.is_concierge !== false;
 const contactName = draft.contact_name || (isConcierge ? 'SpaceMatch Verified Listing (Concierge)' : 'Verified Resident');
 const contactPhone = draft.contact_phone || (isConcierge ? 'SpaceMatch Concierge' : 'Contact via SpaceMatch');
 const contactUsername = draft.contact_username || (isConcierge ? adminUsername : null);

 const codeDigits = parseInt(displayCode.replace(/\D/g, ''), 10) || Math.floor(Math.random() * 1000000);
 const syntheticTgId = - (1000000000 + codeDigits);

 // 1. Save to Supabase profiles with unique synthetic ID and admin tracking
 const { data: savedProfile, error: saveErr } = await supabaseAdmin
 .from('profiles')
 .upsert({
 telegram_id: syntheticTgId,
 display_code: displayCode,
 gender: draft.gender || 'Any',
 preferred_gender: prefGenderStr,
 locations: subcities,
 budget_min: budgetMin,
 budget_max: budgetNum,
 roommate_traits: bioStr,
 kyc_status: 'verified',
 status: 'active',
 onboarding_step: 'completed',
 telegram_username: contactUsername,
 phone_number: contactPhone,
 full_name: contactName,
 }, { onConflict: 'display_code' })
 .select('*')
 .single();

 if (saveErr) {
 console.error('Error saving admin post to profiles:', saveErr);
 }

 // 2. Also save to draft store so it is cached in session drafts
 await saveRoommateDraft({
 id: savedProfile?.id || displayCode,
 user_telegram_id: syntheticTgId,
 display_code: displayCode,
 user_name: contactName,
 username: contactUsername,
 age: 24,
 my_gender: draft.gender || 'Any',
 preferred_gender: prefGenderStr,
 preferred_subcity: subcities,
 budget_min: budgetMin,
 budget_max: budgetNum,
 house_rules: cleanHouseRules,
 lifestyle_bio: bioStr,
 preferred_roommate: 'Clean, respectful, and compatible housemate.',
 listing_category: isSpace ? 'space_available' : 'seeker',
 status: 'approved',
 unlock_fee: 100,
 fayda_status: 'verified',
 created_at: new Date().toISOString(),
 updated_at: new Date().toISOString(),
 });

 // 3. Broadcast to channel with the 3 mandatory buttons
 const targetChannel = await getPrimaryChannel();

 const postDraft = {
 ...draft,
 display_code: displayCode,
 locations: subcities,
 budget_min: budgetMin,
 budget_max: budgetNum,
 house_rules: cleanHouseRules,
 space_rent: isSpace ? budgetNum : undefined,
 space_type: isSpace ? (draft.space_type || 'Private Bedroom in Shared Flat') : undefined,
 lifestyle_bio: cleanBio,
 roommate_traits: cleanBio,
 gender: draft.gender || 'Any',
 preferred_gender: prefGenderStr,
 };
 const postCardText = isSpace ? formatSpacePost(postDraft) : formatRoommatePost(postDraft);

 const channelButtons = {
 inline_keyboard: [
 [{
 text: 'Connect with this roommate / ከዚህ አጋር ጋር ተገናኝ >',
 url: isSpace
 ? `https://t.me/${botUsername}?start=order_${displayCode}`
 : `https://t.me/${botUsername}?start=req_${displayCode}`,
 }],
 [{
 text: 'Search Roommate for Me / የቤት አጋር ፈልግልኝ >',
 url: `https://t.me/${botUsername}?start=search_roommate`,
 }],
 [{
 text: 'Post My Profile / መረጃዬን ልለጥፍ >',
 url: `https://t.me/${botUsername}?start=post_profile`,
 }],
 ],
 };

 const postRes = await sendTelegram('sendMessage', {
 chat_id: targetChannel,
 text: postCardText,
 parse_mode: 'HTML',
 reply_markup: channelButtons,
 });

 const channelMsgId = postRes?.result?.message_id;

 // 4. Update channel_message_id in DB
 if (channelMsgId) {
 await supabaseAdmin
 .from('profiles')
 .update({ channel_message_id: channelMsgId })
 .ilike('display_code', displayCode);
 await supabaseAdmin
 .from('pending_roommate_drafts')
 .update({ channel_message_id: channelMsgId })
 .ilike('display_code', displayCode);
 }

 await clearSession(chatId);

 // 5. Render Admin Management Card
 const postLink = buildChannelPostUrl(targetChannel, channelMsgId);

 const successText = `<b>Post #${displayCode} Published Successfully! / ማስታወቂያ #${displayCode} በተሳካ ሁኔታ ተለጥፏል!</b>

• <b>Display Code / የመለያ ኮድ:</b> <b>#${displayCode}</b>
• <b>Channel / ቻናል:</b> <code>${targetChannel}</code>
• <b>Message ID / የመልእክት ቁጥር:</b> <code>${channelMsgId || 'N/A'}</code>
• <b>Database Status / የዳታቤዝ ሁኔታ:</b> Active & Saved / የዳነ እና የሚሰራ 

When a user clicks to connect, the bot will track #${displayCode} and notify you directly.
ተጠቃሚዎች ለመገናኘት ጥያቄ ሲልኩ፣ ቦቱ #${displayCode}ን ተከታትሎ በቀጥታ ያሳውቆታል።
 `.trim();

 const adminMgmtKeyboard = [
 [{ text: `Mark #${displayCode} as CLOSED / ማስታወቂያውን ዝጋ`, callback_data: `admin_close:${displayCode}` }],
 ...(postLink ? [[{ text: 'View Post in Channel / ቻናል ላይ ተመልከት >', url: postLink }]] : []),
 [{ text: 'Post Another Listing / ሌላ ማስታወቂያ ልጠፍ', callback_data: 'admin_post_start' }],
 [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ];

 await sendOrEditCard(chatId, successText, adminMgmtKeyboard, msgId);
 return NextResponse.json({ ok: true });
 }

 // ── Admin Manual Close Callback ────────────────────────────────────────
 if (callbackData.startsWith('admin_close:')) {
 const targetIdentifier = callbackData.split(':')[1];
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await tgSend(chatId, `<b>Access Denied.</b> Only SpaceMatch administrators can mark channel listings as closed.`);
 return NextResponse.json({ ok: true });
 }

 const res = await executeChannelPostClose(targetIdentifier, chatId);

 const targetChannel = await getPrimaryChannel();
 const postLink = buildChannelPostUrl(targetChannel, res.messageId);

 const resultCard = `
${res.success ? '' : ' >'} <b>Listing #${res.displayCode || targetIdentifier}</b>

${res.message}
 `.trim();

 const resultKeyboard = [
 ...(postLink ? [[{ text: 'View Channel Post >', url: postLink }]] : []),
 [{ text: 'Post Another Listing', callback_data: 'admin_post_start' }],
 [{ text: 'Main Menu', callback_data: 'nav_start' }],
 ];

 await sendOrEditCard(chatId, resultCard, resultKeyboard, msgId);
 return NextResponse.json({ ok: true });
 }

 // ── Flow 2 & 3: Post Profile Branches & Search Roommate Callbacks ──────
 if (callbackData === 'post_profile_start') {
 await sendPostProfileBranchPrompt(chatId, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'post_branch_space') {
 await sendHaveRoomAdminDirectCard(chatId, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'post_branch_seeker') {
 if (!(await isUserFaydaVerified(chatId))) {
 await sendFaydaGateCard(chatId, 'post your roommate seeker profile', msgId, { return_flow: 'post_seeker' });
 return NextResponse.json({ ok: true });
 }
 const session = getSession(chatId);
 await sendDynamicCardStep1Age(chatId, buildCleanFlowDraft(chatId, session.draft_data, { mode: 'post_to_channel', listing_category: 'seeker', card_msg_id: msgId }), msgId);
 return NextResponse.json({ ok: true });
 }

 // Space Owner Wizard Callbacks
 if (callbackData.startsWith('space_type:')) {
 const spaceType = callbackData.replace('space_type:', '');
 const session = getSession(chatId);
 const updatedDraft = { ...session.draft_data, space_type: spaceType };
 await sendSpaceStep2Rent(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('space_rent:')) {
 const rentVal = parseInt(callbackData.split(':')[1], 10);
 const session = getSession(chatId);
 const updatedDraft = { ...session.draft_data, space_rent: rentVal };
 await sendSpaceStep3Share(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'space_back_to_rent') {
 const session = getSession(chatId);
 await sendSpaceStep2Rent(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('space_share:')) {
 const shareVal = parseInt(callbackData.split(':')[1], 10);
 const session = getSession(chatId);
 const updatedDraft = { ...session.draft_data, space_share: shareVal };
 await sendSpaceStep4Amenities(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'space_back_to_share') {
 const session = getSession(chatId);
 await sendSpaceStep3Share(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('space_amenity_toggle:')) {
 const amenity = decodeURIComponent(callbackData.replace('space_amenity_toggle:', ''));
 const session = getSession(chatId);
 const currentList: string[] = session.draft_data.space_amenities || ['WiFi', 'Kitchen'];
 const newList = currentList.includes(amenity)
 ? currentList.filter((a) => a !== amenity)
 : [...currentList, amenity];
 const updatedDraft = { ...session.draft_data, space_amenities: newList };
 await sendSpaceStep4Amenities(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'space_amenities_proceed') {
 const session = getSession(chatId);
 await sendSpaceStep5HostGender(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'space_back_to_amenities') {
 const session = getSession(chatId);
 await sendSpaceStep4Amenities(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('space_host_gender:')) {
 const hostGender = callbackData.split(':')[1];
 const session = getSession(chatId);
 const updatedDraft = { ...session.draft_data, gender: hostGender, my_gender: hostGender };
 await sendSpaceStep6PrefGender(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'space_back_to_host_gender') {
 const session = getSession(chatId);
 await sendSpaceStep5HostGender(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('space_pref_gender:')) {
 const prefGender = callbackData.split(':')[1];
 const session = getSession(chatId);
 const updatedDraft = { ...session.draft_data, preferred_gender: prefGender };
 await sendSpaceStep7PrefRoommate(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'space_back_to_pref_gender') {
 const session = getSession(chatId);
 await sendSpaceStep6PrefGender(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'space_back_to_pref_roommate') {
 const session = getSession(chatId);
 await sendSpaceStep7PrefRoommate(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('space_subcity:')) {
 const subcity = callbackData.replace('space_subcity:', '');
 const session = getSession(chatId);
 const updatedDraft = { ...session.draft_data, preferred_subcity: [subcity], location: subcity };
 await sendSpaceStep2Rent(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'space_back_to_subcity') {
 const session = getSession(chatId);
 await sendSpaceStep2Location(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'space_back_to_photos') {
 const session = getSession(chatId);
 await sendSpaceStep9Photos(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'space_photos_done' || callbackData === 'space_photos_skip') {
 const session = getSession(chatId);
 const { data: p } = await supabaseAdmin.from('profiles').select('*').eq('telegram_id', chatId).maybeSingle();
 const mergedDraft = {
 ...session.draft_data,
 age: p?.age || session.draft_data.age || 24,
 gender:
   session.draft_data.owner_gender ||
   (session.draft_data.gender && session.draft_data.gender !== 'Member' ? session.draft_data.gender : undefined) ||
   (p?.gender && p.gender !== 'Member' ? p.gender : 'Member'),
 roommate_traits: session.draft_data.preferred_roommate || session.draft_data.roommate_traits || p?.roommate_traits || 'Roommate available with a room in Addis Ababa.',
 preferred_roommate: session.draft_data.preferred_roommate || session.draft_data.roommate_traits || p?.preferred_roommate,
 };
 await sendSpacePreviewCard(chatId, mergedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('space_submit_admin:')) {
 const session = getSession(chatId);
 const draft = session.draft_data || {};
 let cleanCode = (callbackData.split(':')[1] || '').trim().replace(/^#/, '');
 if (!cleanCode || cleanCode.startsWith('RM') || !cleanCode.toUpperCase().startsWith('SPMARWR')) {
 cleanCode = await getNextSpmarbrCode('space_available');
 }
 const subcity = draft.preferred_subcity?.[0] || draft.location || 'Addis Ababa';
 const rentNum = Number(draft.space_rent || 0);
 const shareNum = Number(draft.space_share || 0);
 const amenities = draft.space_amenities || [];
 const photos = draft.space_photos || [];

 const meta = {
 cleanCode,
 subcity,
 rentNum,
 shareNum,
 amenities,
 photos,
 spaceType: draft.space_type,
 ownerGender: draft.owner_gender || draft.gender || draft.my_gender,
 prefGender: draft.preferred_tenant_gender || draft.preferred_gender,
 desc: draft.preferred_roommate || draft.roommate_traits || draft.description,
 age: draft.age || 24,
 };

 if (!(await isUserFaydaVerified(chatId))) {
 await sendFaydaGateCard(chatId, 'verify Fayda before submitting your space listing', msgId, {
   return_flow: 'submit_space',
   membership_purpose: 'post_channel',
   membership_metadata: { ...meta, category: 'space_available', isSpace: true },
 });
 return NextResponse.json({ ok: true });
 }

 const userLang = getUserLanguage(chatId);
 const isAm = userLang === 'am';

 const mem = await getUserMembershipStatus(chatId);
 if (!mem.isActive) {
 await sendMembershipPaywallCard(
 chatId,
 'post_channel',
 { ...meta, category: 'space_available', isSpace: true },
 msgId
 );
 return NextResponse.json({ ok: true });
 }

 await submitSpaceListingToAdmin(chatId, meta, msgId, callback.from);
 return NextResponse.json({ ok: true });
 }

 // Flow 3: Search Roommate Callbacks
 if (
 callbackData === 'search_roommate_start' ||
 callbackData === 'matchmaker_start' ||
 callbackData === 'execute_matchmaking'
 ) {
 const session = getSession(chatId);
 const { data: savedProf } = await supabaseAdmin
   .from('profiles')
   .select('*')
   .eq('telegram_id', chatId)
   .maybeSingle();

 const hasSavedCriteria = Boolean(
   savedProf &&
   savedProf.gender &&
   savedProf.gender !== 'Member' &&
   savedProf.age &&
   savedProf.religion &&
   savedProf.job &&
   savedProf.preferred_gender &&
   Array.isArray(savedProf.locations) &&
   savedProf.locations.length > 0
 );

 if (hasSavedCriteria && savedProf) {
   const savedDraft = buildCleanFlowDraft(chatId, session.draft_data, {
     mode: 'search_roommate',
     match_subcities: savedProf.locations,
     preferred_subcity: savedProf.locations,
     my_gender: savedProf.gender,
     gender: savedProf.gender,
     age: savedProf.age,
     religion: savedProf.religion,
     job: savedProf.job,
     preferred_gender: savedProf.preferred_gender,
     budget_min: savedProf.budget_min ?? 0,
     budget_max: savedProf.budget_max ?? 0,
     roommate_traits: savedProf.roommate_traits,
     lifestyle_bio: savedProf.roommate_traits,
     interstitial_seen: true,
     card_msg_id: msgId,
   });
   await saveSession({ telegram_id: chatId, step: 'matchmaker_saved_prompt', draft_data: savedDraft, updated_at: new Date().toISOString() }, true);
   const savedAreasStr = savedProf.locations.join(', ');
   const savedBudgetStr = formatBudgetRangeLabel(savedProf.budget_min, savedProf.budget_max, 'Any Budget');
   await sendOrEditCard(
     chatId,
     `<b>Search Roommate / የቤት አጋር ፈልግ</b>\n\n<blockquote>We found your saved profile & preferences:\n• <b>Areas / አካባቢ:</b> <b>${escapeHtml(savedAreasStr)}</b>\n• <b>Budget / በጀት:</b> <b>${escapeHtml(savedBudgetStr)}</b>\n• <b>Looking For / ምርጫ:</b> <b>${escapeHtml(savedProf.preferred_gender)}</b>\n\nበተቀመጠው መረጃዎ ወዲያውኑ ይፈልጉ ወይም መስፈርቶችዎን ያሻሽሉ:</blockquote>`,
     [
       [{ text: 'Search with Saved Preferences / በተቀመጠው መረጃ ፈልግ >', callback_data: 'match_use_saved_profile' }],
       [{ text: 'Edit Search Filters / መስፈርቶችን አሻሽል', callback_data: 'match_edit_filters' }],
       [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
     ],
     msgId
   );
   return NextResponse.json({ ok: true });
 }

 await sendMatchmakerSubcityStep(chatId, buildCleanFlowDraft(chatId, session.draft_data, { mode: 'search_roommate', card_msg_id: msgId }), msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'match_use_saved_profile') {
 const session = getSession(chatId);
 await saveSession({
   telegram_id: chatId,
   step: 'matchmaker_results',
   draft_data: session.draft_data,
   updated_at: new Date().toISOString(),
 }, true);
 await executeAutomatedMatchmaker(chatId, session.draft_data, msgId, 0);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'match_edit_filters') {
 const session = getSession(chatId);
 await sendMatchmakerSubcityStep(chatId, buildCleanFlowDraft(chatId, session.draft_data, { mode: 'search_roommate', card_msg_id: msgId }), msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('search_unlock_contact:')) {
 const targetProfileId = callbackData.split(':')[1];
 const session = getSession(chatId);
 const existingDraft = session?.draft_data || {};

 // Universal Eligibility & Fayda Gate BEFORE charging 100 ETB Pass (Decision #1)
 const [isVerified, { data: myProfile }, { data: targetRow }] = await Promise.all([
 isUserFaydaVerified(chatId),
 supabaseAdmin.from('profiles').select('*').eq('telegram_id', chatId).maybeSingle(),
 /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetProfileId)
   ? supabaseAdmin.from('profiles').select('*').eq('id', targetProfileId).maybeSingle()
   : supabaseAdmin.from('profiles').select('*').ilike('display_code', targetProfileId.replace(/^#/, '')).maybeSingle(),
 ]);

 let resolvedTarget = targetRow;
 if (!resolvedTarget && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetProfileId)) {
   const { data: rmRow } = await supabaseAdmin.from('roommate_profiles').select('*').eq('id', targetProfileId).maybeSingle();
   if (rmRow) {
     resolvedTarget = {
       id: rmRow.id,
       telegram_id: rmRow.user_telegram_id,
       preferred_gender: rmRow.preferred_gender,
       roommate_traits: rmRow.lifestyle_bio,
       status: rmRow.status,
       display_code: rmRow.display_code,
     };
   }
 }
 if (!resolvedTarget) {
   const dTarget = await getRoommateDraft(targetProfileId.replace(/^#/, ''));
   if (dTarget) {
     resolvedTarget = {
       id: dTarget.id,
       telegram_id: dTarget.user_telegram_id,
       preferred_gender: dTarget.preferred_gender,
       roommate_traits: dTarget.lifestyle_bio,
       status: dTarget.status,
       display_code: dTarget.display_code,
     };
   }
 }

 if (resolvedTarget && ['matched', 'closed', 'archived', 'rejected', 'rented'].includes(String(resolvedTarget.status || '').toLowerCase())) {
   await sendOrEditCard(
     chatId,
     `<b>Listing Closed / ማስታወቂያው ተዘግቷል</b>\n\n<blockquote>This roommate listing is already closed or matched.\nይህ ማስታወቂያ ቀድሞውኑ ተዘግቷል።</blockquote>`,
     [[{ text: 'Browse Open Matches / ሌሎችን እይ', callback_data: 'matchmaker_start' }], [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }]],
     msgId
   );
   return NextResponse.json({ ok: true });
 }

 if (resolvedTarget?.telegram_id && String(resolvedTarget.telegram_id) === String(chatId)) {
   await sendOrEditCard(
     chatId,
     `<b>Own Listing / የራስዎ ማስታወቂያ</b>\n\n<blockquote>You cannot send a connection request to yourself.\nለራስዎ ማስታወቂያ ጥያቄ መላክ አይችሉም።</blockquote>`,
     [[{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }]],
     msgId
   );
   return NextResponse.json({ ok: true });
 }

 if (!isVerified) {
 await sendFaydaGateCard(chatId, 'verify your National ID before connecting with roommates', msgId, {
   return_flow: 'search_unlock_contact',
   return_meta: { targetProfileId },
 });
 return NextResponse.json({ ok: true });
 }

 const effectiveGender = myProfile?.gender || existingDraft.my_gender || existingDraft.gender;
 if (resolvedTarget && effectiveGender && effectiveGender !== 'Member') {
   const gCheck = checkGenderPreferenceMatch(resolvedTarget.preferred_gender, resolvedTarget.roommate_traits, effectiveGender);
   if (!gCheck.allowed) {
     const isAm = getUserLanguage(chatId) === 'am';
     const { text: mismatchText, keyboard: mismatchKb } = getGenderMismatchCard(
       isAm,
       resolvedTarget.display_code || targetProfileId,
       gCheck.targetPrefFormattedEn,
       gCheck.targetPrefFormattedAm,
       effectiveGender
     );
     await sendOrEditCard(chatId, mismatchText, mismatchKb, msgId);
     return NextResponse.json({ ok: true });
   }
 }

 // Mandatory 100 ETB Pass Gate (Invariant 8 - checked AFTER eligibility & Fayda)
 const memCheck = await getUserMembershipStatus(chatId);
 if (!memCheck.isActive) {
 await sendMembershipPaywallCard(
 chatId,
 'connect_request',
 { targetProfileId },
 msgId
 );
 return NextResponse.json({ ok: true });
 }

 // Seed draft from user's existing search criteria and profile so nothing is discarded
 const seededDraft: Record<string, any> = {
 ...existingDraft,
 target_id: targetProfileId,
 age: myProfile?.age || existingDraft.age,
 gender: effectiveGender,
 my_gender: effectiveGender,
 preferred_gender: myProfile?.preferred_gender || existingDraft.preferred_gender,
 budget_max: (myProfile?.budget_max !== undefined && myProfile?.budget_max !== null)
 ? myProfile.budget_max
 : (existingDraft.budget_max !== undefined && existingDraft.budget_max !== null ? existingDraft.budget_max : 0),
 budget_min: myProfile?.budget_min || existingDraft.budget_min || 0,
 preferred_subcity: (myProfile?.locations && myProfile.locations.length > 0)
 ? myProfile.locations
 : (existingDraft.match_subcities && existingDraft.match_subcities.length > 0)
 ? existingDraft.match_subcities
 : (existingDraft.preferred_subcity && existingDraft.preferred_subcity.length > 0)
 ? existingDraft.preferred_subcity
 : ['Bole'],
 religion: myProfile?.religion || existingDraft.religion || 'Any',
 job: myProfile?.job || existingDraft.job || 'Member',
 roommate_traits: myProfile?.roommate_traits || existingDraft.roommate_traits || existingDraft.lifestyle_bio,
 interstitial_seen: true,
 };

 const hasCompleteProfile = Boolean(
 (myProfile?.preferred_gender || existingDraft.preferred_gender) &&
 (effectiveGender && effectiveGender !== 'Member') &&
 (myProfile?.age || existingDraft.age)
 );

 if (isVerified && hasCompleteProfile && myProfile) {
 // 2. Verified user with saved DB profile -> send anonymous connection request directly without re-prompting
 const syntheticCallback = `confirm_match:${targetProfileId}`;
 callbackData = syntheticCallback;
 } else {
 // Seeded profile draft saves to DB & sends match request cleanly
 await routeNextMissingSeekerStep(chatId, seededDraft, msgId, callback.from);
 return NextResponse.json({ ok: true });
 }
 }

 // 24-Hour Follow-Up: Owner closes listing after match
 if (
 callbackData.startsWith('owner_close_listing:') ||
 callbackData.startsWith('close_channel_post:')
 ) {
 const targetCode = (callbackData.split(':')[1] || '').trim().replace(/^#/, '');
 const { data: ownerCheck } = await supabaseAdmin
 .from('profiles')
 .select('telegram_id')
 .ilike('display_code', targetCode)
 .maybeSingle();
 const adminIds = await getAdminIds();
 const isAuthorized = adminIds.includes(chatId) || (ownerCheck && Number(ownerCheck.telegram_id) === chatId);
 if (!isAuthorized) {
 await tgSend(chatId, `<b>Access Denied / ፈቃድ የለም።</b> Only the listing owner or admin can close this listing.`);
 return NextResponse.json({ ok: true });
 }
 const primaryCh = await getPrimaryChannel();
 const closeRes = await executeChannelPostClose(targetCode, chatId);
 const closeMsg = closeRes.success
 ? `<b>Listing Marked as Closed / ማስታወቂያው ተዘግቷል</b>\n\n<blockquote>System Notification · ${escapeHtml(primaryCh)}\nPost <b>#${escapeHtml(targetCode)}</b> has been updated on channel with red banner and all contact buttons removed. Your direct contact details are safe.\n\nማስታወቂያ <b>#${escapeHtml(targetCode)}</b> በቻናሉ ላይ ተዘግቷል፤ የግንኙነት ቁልፎችም ተነስተዋል።</blockquote>`
 : `<b>Listing Marked Closed in App / ማስታወቂያው ተዘግቷል</b>\n\n<blockquote>Listing <b>#${escapeHtml(targetCode)}</b> is now closed for new requests, though the channel post could not be edited (${escapeHtml(closeRes.message || 'no channel message')}).\n\nማስታወቂያ <b>#${escapeHtml(targetCode)}</b> ተዘግቷል።</blockquote>`;

 await sendOrEditCard(
 chatId,
 closeMsg,
 [
 [{ text: 'Post New / አዲስ ልጠፍ', callback_data: 'post_profile_start' }],
 [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ],
 msgId
 );
 return NextResponse.json({ ok: true });
 }

 // 24-Hour Follow-Up: Owner keeps listing open
 if (
 callbackData.startsWith('owner_keep_listing:') ||
 callbackData.startsWith('keep_channel_post:')
 ) {
 const targetCode = (callbackData.split(':')[1] || '').trim().replace(/^#/, '');
 const { data: ownerCheck } = await supabaseAdmin
 .from('profiles')
 .select('telegram_id')
 .ilike('display_code', targetCode)
 .maybeSingle();
 const adminIds = await getAdminIds();
 const isAuthorized = adminIds.includes(chatId) || (ownerCheck && Number(ownerCheck.telegram_id) === chatId);
 if (!isAuthorized) {
 await tgSend(chatId, `<b>Access Denied / ፈቃድ የለም።</b>`);
 return NextResponse.json({ ok: true });
 }
 try {
 await supabaseAdmin
 .from('profiles')
 .update({ status: 'active' })
 .ilike('display_code', targetCode);
 await supabaseAdmin
 .from('pending_roommate_drafts')
 .update({ status: 'approved', updated_at: new Date().toISOString() })
 .ilike('display_code', targetCode);
 } catch {}

 const keepMsg = `<b>Listing Kept Open! / ማስታወቂያው ክፍት ሆኖ ይቀጥላል!</b>\n\n<blockquote>Your profile <b>#${escapeHtml(targetCode)}</b> remains active on the channel. We will keep directing compatible verified roommates your way!\n\nማስታወቂያዎ <b>#${escapeHtml(targetCode)}</b> በቻናሉ ላይ ክፍት ሆኖ ይቀጥላል።</blockquote>`.trim();

 await sendOrEditCard(chatId, keepMsg, [[{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }]], msgId);
 return NextResponse.json({ ok: true });
 }

 // ── Dynamic Card Wizard Callbacks ──────────────────────────────────────
 // Legacy alias – redirect to the new 2-branch post profile flow
 if (callbackData === 'post_to_channel_start') {
 await sendPostProfileBranchPrompt(chatId, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('dyn_gender:')) {
 const gender = callbackData.split(':')[1];
 const session = getSession(chatId);
 const updatedDraft: Record<string, any> = { ...session.draft_data, gender, my_gender: gender };

 // Decision #1: Fail fast on gender mismatch during /start req_... right after Step 2 instead of Step 9
 if (updatedDraft.target_id || updatedDraft.target_code) {
   try {
     let tProf: any = null;
     if (updatedDraft.target_id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(updatedDraft.target_id))) {
       const { data } = await supabaseAdmin.from('profiles').select('display_code, preferred_gender, roommate_traits').eq('id', updatedDraft.target_id).maybeSingle();
       tProf = data;
     }
     if (!tProf && updatedDraft.target_code) {
       const { data } = await supabaseAdmin.from('profiles').select('display_code, preferred_gender, roommate_traits').ilike('display_code', String(updatedDraft.target_code).replace(/^#/, '')).maybeSingle();
       tProf = data;
     }
     if (tProf) {
       const gChk = checkGenderPreferenceMatch(tProf.preferred_gender, tProf.roommate_traits, gender);
       if (!gChk.allowed) {
         const { text: mismatchText, keyboard: mismatchKb } = getGenderMismatchCard(
           false,
           tProf.display_code || updatedDraft.target_code || 'Listing',
           gChk.targetPrefFormattedEn,
           gChk.targetPrefFormattedAm,
           gender
         );
         await sendOrEditCard(chatId, mismatchText, mismatchKb, msgId);
         await clearSession(chatId);
         return NextResponse.json({ ok: true });
       }
     }
   } catch {}
 }

 if (!updatedDraft.religion) {
 await sendDynamicCardStep3Religion(chatId, updatedDraft, msgId);
 } else {
 await routeNextMissingSeekerStep(chatId, updatedDraft, msgId, callback.from);
 }
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'dyn_back_to_age') {
 const session = getSession(chatId);
 await sendDynamicCardStep1Age(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'dyn_back_to_gender') {
 const session = getSession(chatId);
 await sendDynamicCardStep2Gender(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('dyn_sub_toggle:')) {
 const sub = callbackData.split(':')[1];
 const session = getSession(chatId);
 const currentList: string[] = Array.isArray(session.draft_data.preferred_subcity) ? session.draft_data.preferred_subcity : [];
 const newList = currentList.includes(sub)
 ? currentList.filter((s) => s !== sub)
 : [...currentList, sub];
 const updatedDraft = {
 ...session.draft_data,
 preferred_subcity: newList,
 };
 await sendDynamicCardStep8Subcities(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'dyn_sub_all') {
 const session = getSession(chatId);
 const currentList: string[] = Array.isArray(session.draft_data.preferred_subcity) ? session.draft_data.preferred_subcity : [];
 const allSelected = ALL_SUBCITIES.every((s) => currentList.includes(s));
 const updatedDraft = {
   ...session.draft_data,
   preferred_subcity: allSelected ? [] : [...ALL_SUBCITIES],
 };
 await sendDynamicCardStep8Subcities(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'dyn_sub_proceed') {
 const session = getSession(chatId);
 const currentList: string[] = Array.isArray(session.draft_data.preferred_subcity) ? session.draft_data.preferred_subcity : [];
 if (currentList.length === 0) {
   await sendTelegram('answerCallbackQuery', {
     callback_query_id: callback.id,
     text: 'Please select at least 1 area first / እባክዎ ቢያንስ 1 አካባቢ ይምረጡ።',
     show_alert: true,
   }).catch(() => {});
   return NextResponse.json({ ok: true });
 }
 const updatedDraft: Record<string, any> = {
 ...session.draft_data,
 preferred_subcity: currentList,
 };
 if (updatedDraft.edit_return_preview) {
   await routeNextMissingSeekerStep(chatId, updatedDraft, msgId, callback.from);
 } else {
   await sendPreferencesRegistrationSuccessCard(chatId, updatedDraft, msgId);
 }
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'dyn_pref_to_next') {
 const session = getSession(chatId);
 const updatedDraft = { ...session.draft_data, preferences_seen: true };
 const isVerified = await isUserFaydaVerified(chatId);
 if (isVerified) {
 await completeSeekerOnboarding(chatId, updatedDraft, msgId, callback.from);
 } else {
 await sendDynamicCardStep9FaydaFan(chatId, updatedDraft, msgId);
 }
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'dyn_back_to_interstitial') {
 const session = getSession(chatId);
 await sendPersonalRegistrationSuccessCard(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'dyn_edit_menu') {
 const session = getSession(chatId);
 await sendOrEditCard(
   chatId,
   `<b>Edit Profile Details / መረጃ አሻሽል</b>\n\n<blockquote>Choose which field you want to update:\nማስተካከል የሚፈልጉትን መረጃ ይምረጡ:</blockquote>`,
   [
     [
       { text: 'Age / እድሜ', callback_data: 'dyn_edit_field:age' },
       { text: 'Gender / ጾታ', callback_data: 'dyn_edit_field:gender' },
     ],
     [
       { text: 'Religion / እምነት', callback_data: 'dyn_edit_field:religion' },
       { text: 'Occupation / ሙያ', callback_data: 'dyn_edit_field:job' },
     ],
     [
       { text: 'Budget / በጀት', callback_data: 'dyn_edit_field:budget' },
       { text: 'Pref Gender / የአጋር ጾታ', callback_data: 'dyn_edit_field:pref_gender' },
     ],
     [
       { text: 'Habits / መግለጫ', callback_data: 'dyn_edit_field:traits' },
       { text: 'House Rules / የቤት ህጎች', callback_data: 'dyn_edit_field:house_rules' },
     ],
     [
       { text: 'Areas / አካባቢዎች', callback_data: 'dyn_edit_field:subcities' },
     ],
     [{ text: 'Back to Review / ወደ ክለሳ ተመለስ', callback_data: 'dyn_pref_to_next' }],
   ],
   msgId
 );
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('dyn_edit_field:')) {
 const field = callbackData.split(':')[1];
 const session = getSession(chatId);
 const editDraft = { ...(session.draft_data || {}), edit_return_preview: true, card_msg_id: msgId };
 if (field === 'age') await sendDynamicCardStep1Age(chatId, editDraft, msgId);
 else if (field === 'gender') await sendDynamicCardStep2Gender(chatId, editDraft, msgId);
 else if (field === 'religion') await sendDynamicCardStep3Religion(chatId, editDraft, msgId);
 else if (field === 'job') await sendDynamicCardStep4Job(chatId, editDraft, msgId);
 else if (field === 'budget') await sendDynamicCardStep5Budget(chatId, editDraft, msgId);
 else if (field === 'pref_gender') await sendDynamicCardStep6PrefGender(chatId, editDraft, msgId);
 else if (field === 'traits') await sendDynamicCardStep7Traits(chatId, editDraft, msgId);
 else if (field === 'house_rules') await sendDynamicCardStepHouseRules(chatId, editDraft, msgId);
 else if (field === 'subcities') await sendDynamicCardStep8Subcities(chatId, editDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'dyn_back_to_budget' || callbackData === 'dyn_back_to_budget_min') {
 const session = getSession(chatId);
 await sendDynamicCardStep5Budget(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'dyn_back_to_subs') {
 const session = getSession(chatId);
 await sendDynamicCardStep8Subcities(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('dyn_religion:')) {
 const religion = callbackData.split(':')[1];
 const session = getSession(chatId);
 const updatedDraft: Record<string, any> = { ...session.draft_data, religion };
 if (!updatedDraft.job) {
 await sendDynamicCardStep4Job(chatId, updatedDraft, msgId);
 } else {
 await routeNextMissingSeekerStep(chatId, updatedDraft, msgId, callback.from);
 }
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'dyn_back_to_religion') {
 const session = getSession(chatId);
 await sendDynamicCardStep3Religion(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'dyn_back_to_job') {
 const session = getSession(chatId);
 await sendDynamicCardStep4Job(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'dyn_card_to_preferences') {
 const session = getSession(chatId);
 const updatedDraft: Record<string, any> = { ...session.draft_data, interstitial_seen: true };
 if (updatedDraft.budget_max === undefined || updatedDraft.budget_max === null || updatedDraft.budget_max === '') {
 await sendDynamicCardStep5Budget(chatId, updatedDraft, msgId);
 } else {
 await routeNextMissingSeekerStep(chatId, updatedDraft, msgId, callback.from);
 }
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('dyn_pref_gender:')) {
 const preferred_gender = callbackData.split(':')[1];
 const session = getSession(chatId);
 const updatedDraft: Record<string, any> = { ...session.draft_data, preferred_gender };
 if (!updatedDraft.roommate_traits && !updatedDraft.traits && !updatedDraft.description && !updatedDraft.lifestyle_bio && !updatedDraft.preferred_roommate) {
 await sendDynamicCardStep7Traits(chatId, updatedDraft, msgId);
 } else {
 await routeNextMissingSeekerStep(chatId, updatedDraft, msgId, callback.from);
 }
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'dyn_back_to_pref_gender') {
 const session = getSession(chatId);
 await sendDynamicCardStep6PrefGender(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'dyn_back_to_traits') {
 const session = getSession(chatId);
 await sendDynamicCardStep7Traits(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'dyn_back_to_house_rules') {
 const session = getSession(chatId);
 await sendDynamicCardStepHouseRules(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('dyn_house_rules:')) {
 const houseRules = callbackData.split(':').slice(1).join(':');
 const session = getSession(chatId);
 const updatedDraft = { ...session.draft_data, house_rules: houseRules };
 await routeNextMissingSeekerStep(chatId, updatedDraft, msgId, callback.from);
 return NextResponse.json({ ok: true });
 }

 // ── Roommate Profile Channel Submission & Admin Approval Workflow ────
 if (callbackData.startsWith('dyn_publish_channel:') || callbackData.startsWith('dyn_submit_channel:')) {
 const identifier = callbackData.split(':')[1] || '';
 const cleanCode = identifier.trim().replace(/^#/, '');
 const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanCode);

 // Fetch user's profile from profiles or draft sessions
 let prof: any = null;
 if (isUuid) {
 const { data } = await supabaseAdmin.from('profiles').select('*').eq('id', cleanCode).maybeSingle();
 prof = data;
 }
 if (!prof) {
 const { data } = await supabaseAdmin.from('profiles').select('*').ilike('display_code', cleanCode).maybeSingle();
 prof = data;
 }
 if (!prof) {
 const { data } = await supabaseAdmin.from('profiles').select('*').eq('telegram_id', chatId).maybeSingle();
 prof = data;
 }

 const session = getSession(chatId);
 const draft = session.draft_data || {};
 let displayCode = (draft.display_code || prof?.display_code || cleanCode || '').replace(/^#/, '');
 if (!displayCode || !displayCode.toUpperCase().startsWith('SPMARBR')) {
 displayCode = await getNextSpmarbrCode('seeker');
 }
 const subcities = (Array.isArray(draft.preferred_subcity) && draft.preferred_subcity.length > 0)
 ? draft.preferred_subcity
 : (Array.isArray(prof?.locations) && prof.locations.length > 0 ? prof.locations : ['Addis Ababa']);
 const budgetMin = Number(draft.budget_min ?? prof?.budget_min ?? 0);
 const budgetNum = draft.budget_max ?? prof?.budget_max ?? 10000;
 const rawCandidate = (draft.gender && draft.gender !== 'Member' ? draft.gender : prof?.gender) || 'Member';
 const genderStr = rawCandidate;
 const prefGenderStr = draft.preferred_gender || prof?.preferred_gender || 'Any';
 const userAge = draft.age || prof?.age || 24;
 const rawBio = draft.description || draft.details || draft.roommate_traits || draft.lifestyle_bio || prof?.roommate_traits || '';
 const bioStr = extractUserDescription(rawBio) || rawBio || `Age ${userAge} · Seeking roommate in Addis Ababa.`;

 const meta = {
 category: 'seeker',
 displayCode,
 subcities,
 budgetMin,
 budgetNum,
 genderStr,
 prefGenderStr,
 userAge,
 bioStr,
 };

 if (!(await isUserFaydaVerified(chatId))) {
 await sendFaydaGateCard(chatId, 'verify Fayda before submitting your listing to the channel', msgId, {
   return_flow: 'submit_seeker',
   membership_purpose: 'post_channel',
   membership_metadata: meta,
 });
 return NextResponse.json({ ok: true });
 }

 const userLang = getUserLanguage(chatId);
 const isAm = userLang === 'am';

 const mem = await getUserMembershipStatus(chatId);
 if (!mem.isActive) {
 await sendMembershipPaywallCard(chatId, 'post_channel', meta, msgId);
 return NextResponse.json({ ok: true });
 }

 await submitSeekerListingToAdmin(chatId, meta, msgId, callback.from);
 return NextResponse.json({ ok: true });
 }

 // Admin Action: Approve and Broadcast Roommate Profile to Channel
 if (callbackData.startsWith('admin_approve_profile:')) {
 const targetCode = callbackData.split(':')[1];
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await tgSend(chatId, `<b>Access Denied.</b> Only SpaceMatch administrators can approve listings.`);
 return NextResponse.json({ ok: true });
 }

 const res = await broadcastRoommateProfileToChannel(targetCode);
 if (!res.success) {
 const isChatNotFound = (res.message || '').includes('chat not found');
 const targetChannel = await getPrimaryChannel();
 const channelGuidance = isChatNotFound
 ? `\n\n<b>Why this happened:</b> Telegram could not deliver to <code>${targetChannel}</code>.\n\n<b>How to link your channel in seconds:</b>\n1. Add @${botUsername} as an <b>Admin</b> to your channel.\n2. Forward <b>any post</b> from your channel directly to this bot, or send:\n<code>/setchannel @your_channel_username</code>`
 : '';

 await sendOrEditCard(
 chatId,
 `<b>Broadcast Error for #${targetCode}:</b>\n${res.message}${channelGuidance}`,
 [
 [{ text: 'Retry Approval', callback_data: `admin_approve_profile:${targetCode}` }],
 [{ text: 'Manage Channels / Setup >', callback_data: 'admin_channels_setup' }],
 [{ text: 'Admin Menu', callback_data: 'admin_menu' }],
 ],
 msgId
 );
 return NextResponse.json({ ok: true });
 }

 const channelMsgId = res.telegramMessageId;
 await supabaseAdmin
 .from('profiles')
 .update({ status: 'active', channel_message_id: channelMsgId })
 .ilike('display_code', targetCode);

 // Fetch user telegram_id from profiles to notify them & update drafts
 let userTgId: number | null = null;
 try {
 const { data: p } = await supabaseAdmin
 .from('profiles')
 .select('telegram_id')
 .ilike('display_code', targetCode)
 .maybeSingle();
 if (p?.telegram_id) userTgId = Number(p.telegram_id);
 } catch {}

 if (userTgId) {
 try {
 await supabaseAdmin
 .from('roommate_profiles')
 .update({ status: 'approved', channel_message_id: channelMsgId })
 .eq('user_telegram_id', userTgId);
 } catch {}
 }

 try {
 await supabaseAdmin
 .from('pending_roommate_drafts')
 .update({ status: 'approved', channel_message_id: channelMsgId })
 .ilike('id', targetCode);
 } catch {}

 const targetChannel = await getPrimaryChannel();
 const postLink = buildChannelPostUrl(targetChannel, channelMsgId);

 const adminSuccessText = `<b>Profile #${escapeHtml(targetCode)} Approved & Published! / ማስታወቂያ #${escapeHtml(targetCode)} ጸድቆ ተለጥፏል!</b>

• <b>Channel / ቻናል:</b> <code>${escapeHtml(String(targetChannel))}</code>
• <b>Channel Post ID / የመልእክት ቁጥር:</b> <code>${channelMsgId || 'N/A'}</code>
• <b>Status / ሁኔታ:</b> Active & Live in Channel / ክፍት እና በቻናል ላይ የሚገኝ 
 `.trim();

 await sendOrEditCard(
 chatId,
 adminSuccessText,
 [
 ...(postLink ? [[{ text: 'View Post in Channel / ቻናል ላይ ተመልከት >', url: postLink }]] : []),
 [{ text: `Mark #${targetCode} as CLOSED / ማስታወቂያውን ዝጋ`, callback_data: `admin_close:${targetCode}` }],
 [{ text: 'Admin Menu / የአድሚን ማውጫ', callback_data: 'admin_menu' }],
 ],
 msgId
 );

 // Fetch user telegram_id from profiles to notify them
 if (userTgId && userTgId > 0) {
 const userCelebrationMsg = `<b>Congratulations! Your Profile is LIVE on SpaceMatch Addis! / እንኳን ደስ አለዎት! መረጃዎ በስፔስማች አዲስ ላይ ተለጥፏል!</b>

Your anonymous listing (<code>#${targetCode}</code>) has been reviewed and approved by the admin team, and is now broadcasted to the official channel!
የእርስዎ ሚስጥራዊ መረጃ (<code>#${targetCode}</code>) በአስተዳዳሪው ተረጋግጦ ወደ ዋናው ቻናል ተለጥፏል!
<blockquote>When interested roommates tap to connect with you, you will receive an instant notification here to review and accept!
ፍላጎት ያላቸው የቤት አጋሮች ለመገናኘት ሲጠይቁ፣ ወዲያውኑ እዚህ ማሳወቂያ ይደርሶዎታል!</blockquote>
 `.trim();

 await tgSend(userTgId, userCelebrationMsg, {
 inline_keyboard: [
 ...(postLink ? [[{ text: 'View Your Post on Channel / ማስታወቂያዎን በቻናል ይመልከቱ >', url: postLink }]] : []),
 [{ text: 'Find Other Roommates · Matchmaker / የቤት አጋር ፈልግ >', callback_data: 'matchmaker_start' }],
 [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ],
 });
 }

 return NextResponse.json({ ok: true });
 }

 // Admin Action: Reject Roommate Profile
 if (callbackData.startsWith('admin_reject_profile:')) {
 const targetCode = callbackData.split(':')[1];
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await tgSend(chatId, `<b>Access Denied.</b> Only SpaceMatch administrators can reject listings.`);
 return NextResponse.json({ ok: true });
 }

 let userTgId: number | null = null;
 try {
 const { data: p } = await supabaseAdmin
 .from('profiles')
 .select('telegram_id')
 .ilike('display_code', targetCode)
 .maybeSingle();
 if (p?.telegram_id) userTgId = Number(p.telegram_id);
 } catch {}

 await supabaseAdmin
 .from('profiles')
 .update({ status: 'paused', onboarding_step: 'rejected' })
 .ilike('display_code', targetCode);

 try {
 await supabaseAdmin
 .from('pending_roommate_drafts')
 .update({ status: 'rejected', updated_at: new Date().toISOString() })
 .ilike('id', targetCode);
 if (userTgId) {
 await supabaseAdmin
 .from('roommate_profiles')
 .update({ status: 'rejected', updated_at: new Date().toISOString() })
 .eq('user_telegram_id', userTgId);
 }
 } catch {}

 await sendOrEditCard(
 chatId,
 `<b>Profile #${targetCode} Rejected / መገለጫ #${targetCode} ውድቅ ተደርጓል</b>\n\n<blockquote>This listing was rejected and was not published to the channel.\nይህ ማስታወቂያ ውድቅ ተደርጓል እና ወደ ቻናሉ አልተለጠፈም።</blockquote>`,
 [[{ text: 'Admin Menu / አድሚን ማውጫ', callback_data: 'admin_menu' }]],
 msgId
 );

 if (userTgId) {
 await tgSend(
 userTgId,
 `<b>SpaceMatch · Profile Review Update / የማስታወቂያ ግምገማ</b>\n\nYour listing (<code>#${targetCode}</code>) was reviewed by our admin team and could not be approved for channel broadcast at this time.\nማስታወቂያዎ (<code>#${targetCode}</code>) በአድሚን ቡድናችን ተገምግሞ በአሁኑ ሰዓት ለቻናል ስርጭት ሊጸድቅ አልቻለም።\n\n<blockquote>You can edit your details and submit again anytime.\nመረጃዎን አስተካክለው በማንኛውም ጊዜ እንደገና መላክ ይችላሉ።</blockquote>`,
 {
 inline_keyboard: [
 [{ text: 'Edit Profile / መረጃዬን አስተካክል', callback_data: 'post_to_channel_start' }],
 [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ],
 }
 );
 }

 return NextResponse.json({ ok: true });
 }

 // ── NEW: Match request confirmation (from deep-link preview card) ──────
 if (callbackData.startsWith('confirm_match:')) {
 const targetProfileId = callbackData.split(':')[1];

 // Universal Gate: Fayda Verification required & fetch requester profile in parallel
 const [isVerified, { data: requesterProfile }] = await Promise.all([
 isUserFaydaVerified(chatId),
 supabaseAdmin
 .from('profiles')
 .select('*')
 .eq('telegram_id', chatId)
 .maybeSingle(),
 ]);

 if (!isVerified) {
 await sendFaydaGateCard(chatId, 'send mutual match requests', msgId, {
   return_flow: 'confirm_match',
   return_meta: { targetProfileId },
 });
 return NextResponse.json({ ok: true });
 }

 if (!requesterProfile) {
 await sendDynamicCardStep1Age(chatId, { target_id: targetProfileId }, msgId);
 return NextResponse.json({ ok: true });
 }

 // Prevent self-request
 if (requesterProfile.id === targetProfileId) {
 await sendOrEditCard(
 chatId,
 `<b>This is your own listing!</b>\n\nYou cannot send a match request to yourself.`,
 [[{ text: 'Main Menu', callback_data: 'nav_start' }]],
 msgId
 );
 return NextResponse.json({ ok: true });
 }

 // Get target profile
 const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetProfileId);
 let targetProfile: any = null;
 if (isUuid) {
 const { data: pTarget } = await supabaseAdmin
 .from('profiles')
 .select('*')
 .eq('id', targetProfileId)
 .maybeSingle();
 if (pTarget) targetProfile = pTarget;
 }

 if (!targetProfile) {
 const cleanCode = targetProfileId.replace(/^#/, '').trim();
 const { data: pTarget } = await supabaseAdmin
 .from('profiles')
 .select('*')
 .ilike('display_code', cleanCode)
 .maybeSingle();
 if (pTarget) targetProfile = pTarget;
 }

 // Numeric shorthand check (e.g. "5" -> SPMARBR5 / SPMARWR5)
 if (!targetProfile && /^\d+$/.test(targetProfileId.replace(/^#/, '').trim())) {
 const num = targetProfileId.replace(/^#/, '').trim();
 const { data: pBr } = await supabaseAdmin.from('profiles').select('*').ilike('display_code', `SPMARBR${num}`).maybeSingle();
 if (pBr) {
 targetProfile = pBr;
 } else {
 const { data: pWr } = await supabaseAdmin.from('profiles').select('*').ilike('display_code', `SPMARWR${num}`).maybeSingle();
 if (pWr) targetProfile = pWr;
 }
 }

 // Check pending roommate drafts cache
 if (!targetProfile) {
 const cleanCode = targetProfileId.replace(/^#/, '').trim();
 const draft = await getRoommateDraft(cleanCode);
 if (draft) {
 const codeDigits = parseInt(cleanCode.replace(/\D/g, ''), 10) || Math.floor(Math.random() * 1000000);
 const syntheticTgId = draft.user_telegram_id || -(1000000000 + codeDigits);
 const { data: createdFromDraft } = await supabaseAdmin
 .from('profiles')
 .upsert({
 telegram_id: syntheticTgId,
 display_code: (draft.display_code || cleanCode).toUpperCase().replace(/^#/, ''),
 gender: draft.my_gender || 'Member',
 locations: Array.isArray(draft.preferred_subcity) ? draft.preferred_subcity : ['Addis Ababa'],
 budget_min: Number(draft.budget_min || 0),
 budget_max: Number(draft.budget_max || 10000),
 roommate_traits: draft.lifestyle_bio || 'Channel Roommate Listing',
 kyc_status: 'verified',
 status: 'active',
 onboarding_step: 'completed',
 telegram_username: draft.username || null,
 full_name: draft.user_name || 'Verified Channel Listing',
 }, { onConflict: 'display_code' })
 .select('*')
 .maybeSingle();
 if (createdFromDraft) targetProfile = createdFromDraft;
 }
 }

 if (!targetProfile && isUuid) {
 const { data: rmTarget } = await supabaseAdmin
 .from('roommate_profiles')
 .select('*')
 .eq('id', targetProfileId)
 .maybeSingle();
 if (rmTarget) {
 targetProfile = {
 id: rmTarget.id,
 telegram_id: rmTarget.user_telegram_id,
 gender: rmTarget.my_gender,
 locations: rmTarget.preferred_subcity,
 budget_min: rmTarget.budget_min,
 budget_max: rmTarget.budget_max,
 roommate_traits: rmTarget.lifestyle_bio,
 };
 }
 }

 // Synthetic admin post fallback
 if (!targetProfile) {
 const cleanCode = targetProfileId.replace(/^#/, '').trim();
 if (cleanCode.toLowerCase().startsWith('post_') || /^SPMAR(BR|WR)/i.test(cleanCode) || /^[A-Z]{2,10}\d*$/i.test(cleanCode)) {
 const adminIds = await getAdminIds();
 const primaryAdmin = adminIds[0] || 800701176;
 const codeDigits = parseInt(cleanCode.replace(/\D/g, ''), 10) || Math.floor(Math.random() * 1000000);
 const fallbackSyntheticId = -(1000000000 + codeDigits);

 const { data: createdProfile } = await supabaseAdmin
 .from('profiles')
 .upsert({
 telegram_id: fallbackSyntheticId,
 display_code: cleanCode.toUpperCase(),
 gender: 'Any',
 locations: ['Addis Ababa'],
 budget_min: 0,
 budget_max: 10000,
 roommate_traits: 'Channel Roommate Listing in Addis Ababa.',
 kyc_status: 'verified',
 status: 'active',
 onboarding_step: 'completed',
 telegram_username: 'WWEHID',
 phone_number: 'SpaceMatch Concierge',
 full_name: 'SpaceMatch Verified Listing (Concierge)',
 }, { onConflict: 'display_code' })
 .select('*')
 .maybeSingle();
 if (createdProfile) {
 targetProfile = createdProfile;
 }
 }
 }

 if (!targetProfile) {
 await sendOrEditCard(
 chatId,
 `<b>Listing Not Found</b>\n\nThis listing is no longer available.`,
 [[{ text: 'Find Other Roommates', callback_data: 'matchmaker_start' }], [{ text: 'Main Menu', callback_data: 'nav_start' }]],
 msgId
 );
 return NextResponse.json({ ok: true });
 }

 // Guarantee target profile exists in profiles table for foreign key constraint
 if (targetProfile && targetProfile.telegram_id) {
 const { data: pExisting } = await supabaseAdmin
 .from('profiles')
 .select('*')
 .eq('telegram_id', targetProfile.telegram_id)
 .maybeSingle();

 if (pExisting) {
 targetProfile = pExisting;
 } else {
 const { data: createdTarget } = await supabaseAdmin
 .from('profiles')
 .upsert({
 telegram_id: targetProfile.telegram_id,
 display_code: targetProfile.display_code || `RM${String(targetProfile.telegram_id).slice(-4)}`,
 gender: targetProfile.gender || targetProfile.my_gender || 'Member',
 locations: targetProfile.locations || targetProfile.preferred_subcity || ['Addis Ababa'],
 budget_min: targetProfile.budget_min || 0,
 budget_max: targetProfile.budget_max || 10000,
 roommate_traits: targetProfile.roommate_traits || targetProfile.lifestyle_bio || 'Channel Roommate Listing',
 kyc_status: 'verified',
 status: 'active',
 onboarding_step: 'completed',
 }, { onConflict: 'telegram_id' })
 .select('*')
 .single();
 if (createdTarget) targetProfile = createdTarget;
 }
 }

 if (String(targetProfile.telegram_id) === String(chatId)) {
 await sendOrEditCard(
 chatId,
 `<b>This is your own listing!</b>\n\nYou cannot send a match request to yourself.`,
 [[{ text: 'Main Menu', callback_data: 'nav_start' }]],
 msgId
 );
 return NextResponse.json({ ok: true });
 }

 const confirmTargetStatus = String(targetProfile.status || '').toLowerCase();
 if (['matched', 'closed', 'archived', 'rejected', 'rented'].includes(confirmTargetStatus)) {
 await sendOrEditCard(
 chatId,
 `<b>Listing Closed / ማስታወቂያው ተዘግቷል</b>\n\n<blockquote>This roommate or space listing is already closed/matched.\nይህ ማስታወቂያ ቀድሞውኑ ተዘግቷል።</blockquote>`,
 [[{ text: 'Browse Open Matches / ሌሎችን እይ', callback_data: 'matchmaker_start' }], [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }]],
 msgId
 );
 return NextResponse.json({ ok: true });
 }

 // Enforce gender preference
 const genderCheck = checkGenderPreferenceMatch(
 targetProfile.preferred_gender,
 targetProfile.roommate_traits,
 requesterProfile.gender
 );

 if (!genderCheck.allowed) {
 const reqLang = getUserLanguage(chatId);
 const reqIsAm = reqLang === 'am';
 const { text: mismatchText, keyboard: mismatchKb } = getGenderMismatchCard(
 reqIsAm,
 targetProfile.display_code || 'Listing',
 genderCheck.targetPrefFormattedEn,
 genderCheck.targetPrefFormattedAm,
 requesterProfile.gender
 );
 await sendOrEditCard(chatId, mismatchText, mismatchKb, msgId);
 return NextResponse.json({ ok: true });
 }

 // Mandatory 100 ETB Pass Gate (Invariant 8) - Check FIRST!
 const userLang = getUserLanguage(chatId);
 const isAm = userLang === 'am';

 const mem = await getUserMembershipStatus(chatId);
 if (!mem.isActive) {
 await sendMembershipPaywallCard(
 chatId,
 'connect_request',
 {
 targetProfileId: targetProfile.id,
 targetDisplayCode: targetProfile.display_code,
 targetProfile,
 },
 msgId
 );
 return NextResponse.json({ ok: true });
 }

 // Check for existing match (only after membership pass verified)
 const { data: existingMatch } = await supabaseAdmin
 .from('matches')
 .select('id, status')
 .eq('requester_id', requesterProfile.id)
 .eq('target_id', targetProfile.id)
 .maybeSingle();

 if (existingMatch) {
 await sendOrEditCard(
 chatId,
 `You already sent a match request to Roommate <b>#${targetProfile.display_code}</b>.\nStatus: <b>${existingMatch.status.replace('_', ' ')}</b>`,
 [[{ text: 'Find Other Roommates', callback_data: 'matchmaker_start' }], [{ text: 'Main Menu', callback_data: 'nav_start' }]],
 msgId
 );
 return NextResponse.json({ ok: true });
 }

 await executeDirectMatchRequest(chatId, targetProfile.id, msgId);
 return NextResponse.json({ ok: true });
 }

 // ── NEW: Match Accept (Instant Mutual Contact Reveal with 3-Month Pass) ──
 if (callbackData.startsWith('match_accept:')) {
 const matchId = callbackData.split(':')[1];
 const acceptLang = getUserLanguage(chatId);

 // Ensure target user is Fayda verified before accepting
 if (!(await isUserFaydaVerified(chatId))) {
 await saveSession({
 telegram_id: chatId,
 step: `awaiting_target_fayda_fan:${matchId}`,
 draft_data: { match_id: matchId, target_match_id: matchId, card_msg_id: msgId, lang: acceptLang },
 updated_at: new Date().toISOString(),
 });

 const gateText = `<b>Fayda ID Verification Required / የፋይዳ መታወቂያ ማረጋገጫ ያስፈልጋል</b>

<blockquote>Before accepting this roommate connection, both parties must be Fayda verified. Upload a clear photo of the back of your Fayda ID card showing the QR code.\n\nይህንን የክፍል ጓደኝነት ለመቀበል ሁለቱም ወገኖች በፋይዳ መረጋገጥ አለባቸው። እባክዎ የQR ኮዱ የሚታይበትን የመታወቂያዎን ጀርባ ፎቶ ይላኩ።</blockquote>`.trim();

 const inlineKeyboard = [
 [{ text: 'Cancel / ሰርዝ', callback_data: 'nav_start' }],
 ];

 await sendOrEditCard(chatId, gateText, inlineKeyboard, msgId);
 return NextResponse.json({ ok: true });
 }

 const { data: match } = await supabaseAdmin
 .from('matches')
 .select('*, requester:requester_id(telegram_id, gender, budget_min, budget_max, locations, display_code), target:target_id(telegram_id, display_code)')
 .eq('id', matchId)
 .single();

 if (!match || match.status !== 'pending_acceptance') {
 await tgSend(chatId, `This match request is no longer pending. / ይህ የግንኙነት ጥያቄ በአሁኑ ሰዓት ክፍት አይደለም።`);
 return NextResponse.json({ ok: true });
 }

 const targetOwnerId = Number((match.target as any)?.telegram_id || 0);
 const adminIdsList = await getAdminIds();
 if (!adminIdsList.includes(chatId) && (targetOwnerId <= 0 || targetOwnerId !== chatId)) {
 await tgSend(chatId, `Unauthorized: Only the recipient can accept this request. / ይህንን ጥያቄ መቀበል የሚችለው ተቀባዩ ብቻ ነው።`);
 return NextResponse.json({ ok: true });
 }

 // Enforce Invariant 8: Requester must hold an active 100 ETB 3-Month Pass (fail closed if missing)
 const requesterTgId = Number((match.requester as any)?.telegram_id || 0);
 const reqMem = requesterTgId > 0 ? await getUserMembershipStatus(requesterTgId) : { isActive: false };
 if (!reqMem.isActive) {
 await supabaseAdmin
 .from('matches')
 .update({ status: 'pending_payment' })
 .eq('id', matchId);
 await sendOrEditCard(
 chatId,
 `<b>Waiting for Requester Pass / የጠያቂው ክፍያ እየተጠበቀ ነው</b>\n\n<blockquote>The requesting roommate has not yet activated their 100 ETB 3-Month Membership Pass. We have notified them to activate their pass—contacts will reveal automatically once they complete payment.\n\nይህንን ጥያቄ የላከው አባል እስካሁን የ100 ብር የአባልነት ፓስ ስላላጠናቀቀ አድራሻዎችን መክፈት አይቻልም። እንዲከፍል ማሳወቂያ ተልኮለታል።</blockquote>`,
 [[{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }]],
 msgId
 );
 if (requesterTgId > 0) {
 const tCode = (match.target as any)?.display_code || 'Listing';
 await tgSend(
 requesterTgId,
 `<b>Pass Required to Complete Match / አባልነት ያስፈልጋል</b>\n\n<blockquote>Roommate <b>#${escapeHtml(tCode)}</b> attempted to accept your request, but your 100 ETB 3-Month Pass is inactive. Activate your pass to reveal mutual contacts!\n\nአባል <b>#${escapeHtml(tCode)}</b> ጥያቄዎን ለመቀበል ሞክሯል፤ ነገር ግን የ100 ብር የ3 ወር አባልነት ፓስዎ አልተከፈተም።</blockquote>`,
 {
 inline_keyboard: [
 [{ text: 'Activate 3-Month Pass (100 ETB) / አባልነት ክፈት >', callback_data: 'view_membership_pass' }],
 ],
 }
 );
 }
 return NextResponse.json({ ok: true });
 }

 // Instant Mutual Contact Dossier Reveal
 await revealMutualMatchContacts(matchId, chatId, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'payment_upload_prompt') {
 const session = getSession(chatId);
 await saveSession({
 telegram_id: chatId,
 step: session?.step?.startsWith('awaiting_payment_') ? session.step : 'awaiting_payment_for_membership:connect_request',
 draft_data: { ...(session.draft_data || {}), card_msg_id: msgId },
 updated_at: new Date().toISOString(),
 }, true);
 await sendOrEditCard(
 chatId,
 `<b>Upload Payment Receipt / የክፍያ ደረሰኝ ይላኩ</b>\n\n<blockquote>📸 Send a clear screenshot of your Telebirr / CBE / Abyssinia / Dashen receipt right here in chat, OR send your transaction reference code (e.g. <code>DKM7J1EXAP</code> or <code>FT...</code>).\n\nየከፈሉበትን የደረሰኝ ስክሪንሽት ፎቶ በቀጥታ እዚህ ይላኩ፤ ወይም የግብይት ቁጥሩን ይጻፉ።</blockquote>`,
 [
   [{ text: 'Back to Payment Accounts / ወደ ክፍያ ቁጥሮች ተመለስ', callback_data: 'paywall_back' }],
   [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ],
 msgId
 );
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'paywall_back') {
 const session = getSession(chatId);
 const purpose = session?.draft_data?.membership_purpose === 'post_channel' ? 'post_channel' : 'connect_request';
 const meta = session?.draft_data?.membership_metadata || { generalPass: true };
 await sendMembershipPaywallCard(chatId, purpose, meta, msgId);
 return NextResponse.json({ ok: true });
 }

 // ── View / Activate 3-Month Unified Membership Pass ───────────────────────
 if (callbackData === 'view_membership_pass') {
    const mem = await getUserMembershipStatus(chatId);
    const lang = getUserLanguage(chatId);

    if (mem.isActive) {
      const expiryStr = mem.expiresAt ? mem.expiresAt.toLocaleDateString() : 'N/A';

      const activeText = `<b>3-Month Pass / የ3 ወር አባልነት</b>\n\n<blockquote>Status / ሁኔታ: Active (${mem.daysRemaining} days remaining / ቀናት ቀርተዋል)\nExpires / ማብቂያ: ${expiryStr}</blockquote>\n\n<b>Active Benefits / የአባልነት ጥቅሞች:</b>\n• Broadcast listings to channel / ማስታወቂያ ቻናል ላይ መለጠፍ\n• Unlimited connection requests / ያልተገደበ ግንኙነት\n• Instant contact reveals / ስልክ እና ቴሌግራም መክፈት`.trim();

      await sendOrEditCard(
 chatId,
 activeText,
 [
 [{ text: 'Search Roommate / የቤት ጓደኛ ፈልግ', callback_data: 'search_roommate_start' }],
 [{ text: 'Post Profile / መረጃዬን ልለጥፍ', callback_data: 'post_profile_start' }],
 [{ text: 'My Listings / ማስታወቂያዎቼ', callback_data: 'my_listings' }],
 [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ],
 msgId
 );
 return NextResponse.json({ ok: true });
 } else {
 const session = getSession(chatId);
 const isOngoingFlow = Boolean(session?.step && (session.step.startsWith('awaiting_payment_') || session.step === 'dyn_card_preview' || session.step === 'space_preview'));
 const existingPurpose = isOngoingFlow && session?.draft_data?.membership_purpose ? session.draft_data.membership_purpose : 'connect_request';
 const existingMeta = isOngoingFlow && session?.draft_data?.membership_metadata ? session.draft_data.membership_metadata : { generalPass: true };
 await sendMembershipPaywallCard(chatId, existingPurpose, existingMeta, msgId);
 return NextResponse.json({ ok: true });
 }
 }

 // ── NEW: Match Decline ─────────────────────────────────────────────────
 if (callbackData.startsWith('match_decline:')) {
 const matchId = callbackData.split(':')[1];

 const { data: match } = await supabaseAdmin
 .from('matches')
 .select('*, requester:requester_id(telegram_id, display_code), target:target_id(telegram_id, display_code)')
 .eq('id', matchId)
 .single();

 if (!match) {
 await tgSend(chatId, `Match request not found. / ጥያቄው አልተገኘም።`);
 return NextResponse.json({ ok: true });
 }

 const reqTg = Number((match.requester as any)?.telegram_id || 0);
 const tgtTg = Number((match.target as any)?.telegram_id || 0);
 const decAdmins = await getAdminIds();
 if (!decAdmins.includes(chatId) && chatId !== reqTg && (tgtTg <= 0 || chatId !== tgtTg)) {
 await tgSend(chatId, `Unauthorized: Only participants can decline this match. / ፈቃድ የለም።`);
 return NextResponse.json({ ok: true });
 }

 if (!['pending_acceptance', 'pending_payment'].includes(String(match.status || ''))) {
 await tgSend(chatId, `This match request is already finalized (${escapeHtml(String(match.status))}).`);
 return NextResponse.json({ ok: true });
 }

 await supabaseAdmin
 .from('matches')
 .update({ status: 'declined' })
 .eq('id', matchId);

 // Notify decliner
 if (msgId) {
 await sendOrEditCard(chatId, ` You have declined the match request. / የግንኙነት ጥያቄውን አልተቀበሉትም።`, [[{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }]], msgId);
 } else {
 await tgSend(chatId, ` You have declined the match request. / የግንኙነት ጥያቄውን አልተቀበሉትም።`);
 }

 // Notify requester
 const requesterTgId = (match.requester as any)?.telegram_id;
 if (requesterTgId) {
 const reqIsAm = getUserLanguage(requesterTgId) === 'am';
 await tgSend(
 requesterTgId,
 reqIsAm
 ? `<b>ይህ ክፍል ጓደኛ በአሁኑ ሰዓት ዝግጁ አይደለም</b>\n\nሌሎች አማራጮችን በቻናላችን ላይ ይመልከቱ ወይም የራስዎን መረጃ ይለጥፉ! `
 : `<b>Match Unavailable</b>\n\nPotential Roommate is unavailable. Keep looking on the channel or post your profile! `,
 {
 inline_keyboard: [
 [{ text: reqIsAm ? ' የኔን መረጃ ቻናል ላይ ልለጥፍ ↗' : ' Post My Profile to Channel >', callback_data: 'post_to_channel_start' }],
 [{ text: reqIsAm ? ' ሌሎች ፈላጊዎችን ፈልግ ' : ' Find Other Roommates · Matchmaker >', callback_data: 'matchmaker_start' }],
 ],
 }
 );
 }

 return NextResponse.json({ ok: true });
 }

 // Navigation & Start Menu
 if (callbackData === 'nav_start' || callbackData === 'admin_cancel') {
 await clearSession(chatId);
 await sendPrimaryWelcomeMenu(chatId, msgId, callback.from);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'why_fayda_id') {
 const session = getSession(chatId);
 const originReturn = session?.step === 'dyn_card_fayda_fan'
   ? 'dyn_card_fayda_fan'
   : session?.step === 'awaiting_standalone_fayda_fan'
   ? 'standalone_gate'
   : 'verify_fayda';
 await saveSession({
   telegram_id: chatId,
   step: session?.step || 'idle',
   draft_data: { ...(session?.draft_data || {}), why_fayda_return: originReturn, card_msg_id: msgId },
   updated_at: new Date().toISOString(),
 }, true);
 const text = `<b>Why Fayda ID? / ለምን ፋይዳ መታወቂያ አስፈለገ?</b>
<blockquote>1. <b>Zero Fake Profiles & Delalas / ከአጭበርባሪ ደላላ ነፃ:</b>
Every resident is cryptographically authenticated via National ID (RS256).

2. <b>Zero Image Storage / ፎቶዎች አይቀመጡም:</b>
Your ID photo is verified in volatile RAM and instantly deleted. No ID cards are ever stored.

3. <b>Double-Blind Contact Shield / ሙሉ ሚስጥራዊነት:</b>
Your phone and Telegram handle remain 100% hidden until both parties accept a connection request.</blockquote>
 `.trim();

 await sendOrEditCard(
 chatId,
 text,
 [[{ text: 'Back / ተመለስ', callback_data: 'why_fayda_back' }], [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }]],
 msgId
 );
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'why_fayda_back') {
 const session = getSession(chatId);
 const ret = session?.draft_data?.why_fayda_return;
 if (ret === 'dyn_card_fayda_fan') {
   await sendDynamicCardStep9FaydaFan(chatId, session.draft_data, msgId);
 } else if (ret === 'standalone_gate') {
   await sendFaydaGateCard(chatId, session.draft_data?.target_action || 'verify your National ID', msgId);
 } else if (await isUserFaydaVerified(chatId)) {
   await sendVerifiedFaydaDossierCard(chatId, getLanguage(session?.draft_data, chatId), msgId);
 } else {
   await sendFaydaGateCard(chatId, 'verify your National ID', msgId);
 }
 return NextResponse.json({ ok: true });
 }

 // MATCHMAKER WIZARD CALLBACK HANDLERS (In-Place Single Card Flow)

 if (callbackData === 'match_select_all_subs') {
 const session = getSession(chatId);
 const updatedDraft = { ...session.draft_data, match_subcities: [...ALL_SUBCITIES] };
 await sendMatchmakerGenderStep(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('match_toggle_sub:')) {
 const sub = callbackData.split(':')[1];
 const session = getSession(chatId);
 const currentList: string[] = session.draft_data.match_subcities || [];

 const newList = currentList.includes(sub)
 ? currentList.filter((s) => s !== sub)
 : [...currentList, sub];

 const updatedDraft = { ...session.draft_data, match_subcities: newList };
 await sendMatchmakerSubcityStep(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'match_goto_gender' || callbackData === 'match_goto_identity') {
 const session = getSession(chatId);
 const currentList: string[] = session.draft_data.match_subcities || [];
 const updatedDraft = {
 ...session.draft_data,
 match_subcities: currentList.length > 0 ? currentList : [...ALL_SUBCITIES],
 };
 await sendMatchmakerGenderStep(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('match_set_my_gender:')) {
 const myGender = callbackData.split(':')[1];
 const session = getSession(chatId);
 const updatedDraft = { ...session.draft_data, my_gender: myGender, gender: myGender };
 await sendMatchmakerAgeStep(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'match_goto_age') {
 const session = getSession(chatId);
 await sendMatchmakerAgeStep(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'match_goto_religion') {
 const session = getSession(chatId);
 await sendMatchmakerReligionStep(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('match_set_religion:')) {
 const religionVal = callbackData.split(':')[1];
 const session = getSession(chatId);
 const updatedDraft = { ...session.draft_data, religion: religionVal };
 await sendMatchmakerJobStep(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'match_goto_job') {
 const session = getSession(chatId);
 await sendMatchmakerJobStep(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('match_set_job:')) {
 const jobVal = callbackData.split(':').slice(1).join(':');
 const session = getSession(chatId);
 const updatedDraft = { ...session.draft_data, job: jobVal };
 await sendMatchmakerPrefGenderStep(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('match_set_pref_gender:')) {
 const prefGender = callbackData.split(':')[1];
 const session = getSession(chatId);
 const updatedDraft = { ...session.draft_data, preferred_gender: prefGender };
 await sendMatchmakerBudgetStep(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'match_goto_pref_gender' || callbackData === 'match_goto_prefs') {
 const session = getSession(chatId);
 await sendMatchmakerPrefGenderStep(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'match_goto_budget') {
 const session = getSession(chatId);
 await sendMatchmakerBudgetStep(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('match_set_budget:')) {
 const budget = parseInt(callbackData.split(':')[1], 10);
 const session = getSession(chatId);
 const { pending_budget_min: _ignoredMin, ...cleanDraft } = session.draft_data || {};
 const updatedDraft = { ...cleanDraft, budget_min: budget === 0 ? 0 : (cleanDraft.budget_min || 0), budget_max: budget, browse_all: false };
 await sendMatchmakerTraitsStep(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('match_set_traits:')) {
 const traitsVal = callbackData.split(':').slice(1).join(':');
 const session = getSession(chatId);
 const updatedDraft = {
 ...session.draft_data,
 roommate_traits: traitsVal,
 lifestyle_bio: traitsVal,
 description: traitsVal,
 };
 await sendMatchmakerHouseRulesStep(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'match_goto_traits') {
 const session = getSession(chatId);
 await sendMatchmakerTraitsStep(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('match_set_house_rules:')) {
 const houseRulesVal = callbackData.split(':').slice(1).join(':');
 const session = getSession(chatId);
 const rawTraitsOnly = extractUserDescription(session.draft_data?.roommate_traits || session.draft_data?.lifestyle_bio) || session.draft_data?.roommate_traits || 'Clean & respectful';
 const packedTraits = `Job: ${session.draft_data?.job || 'Member'} | Religion: ${session.draft_data?.religion || 'Any'} | Prefers: ${session.draft_data?.preferred_gender || 'Any'} | Rules: ${houseRulesVal} | ${rawTraitsOnly}`;
 const updatedDraft = {
 ...session.draft_data,
 house_rules: houseRulesVal,
 roommate_traits: packedTraits,
 lifestyle_bio: packedTraits,
 description: rawTraitsOnly,
 gender: session.draft_data?.my_gender || session.draft_data?.gender,
 preferred_subcity: session.draft_data?.match_subcities || session.draft_data?.preferred_subcity || [...ALL_SUBCITIES],
 interstitial_seen: true,
 browse_all: false,
 };
 await saveSession({
 telegram_id: chatId,
 step: 'matchmaker_results',
 draft_data: updatedDraft,
 updated_at: new Date().toISOString(),
 }, true);
 await executeAutomatedMatchmaker(chatId, updatedDraft, msgId, 0);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'match_run_search') {
 const session = getSession(chatId);
 await executeAutomatedMatchmaker(chatId, session.draft_data, msgId, 0);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('match_page:')) {
 const pageIdx = parseInt(callbackData.split(':')[1], 10);
 const session = getSession(chatId);
 await executeAutomatedMatchmaker(chatId, session.draft_data, msgId, pageIdx);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'match_browse_all') {
 const session = getSession(chatId);
 const allAreasCriteria = { ...session.draft_data, match_subcities: [], browse_all: true };
 await saveSession({
 telegram_id: chatId,
 step: 'matchmaker_results',
 draft_data: allAreasCriteria,
 updated_at: new Date().toISOString(),
 }, true);
 await executeAutomatedMatchmaker(chatId, allAreasCriteria, msgId, 0);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'match_noop') {
 return NextResponse.json({ ok: true });
 }

 // PRIMARY SEEKER CREATION WIZARD CALLBACK HANDLERS
 if (callbackData === 'seeker_subcity_menu') {
 const session = getSession(chatId);
 await sendSeekerSubcityStep(chatId, { ...session.draft_data, mode: 'post_to_channel' }, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'seeker_flow') {
 await sendPostProfileBranchPrompt(chatId, msgId, callback.from);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'seeker_select_all_and_proceed') {
 const session = getSession(chatId);
 const updatedDraft = { ...session.draft_data, preferred_subcity: [...ALL_SUBCITIES] };
 await sendSeekerMyGenderStep(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('seeker_toggle_sub:')) {
 const sub = callbackData.split(':')[1];
 const session = getSession(chatId);
 const currentList: string[] = session.draft_data.preferred_subcity || [];

 const newList = currentList.includes(sub)
 ? currentList.filter((s) => s !== sub)
 : [...currentList, sub];

 const updatedDraft = { ...session.draft_data, preferred_subcity: newList };
 await sendSeekerSubcityStep(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'seeker_goto_gender') {
 const session = getSession(chatId);
 const currentList: string[] = session.draft_data.preferred_subcity || [];
 const updatedDraft = {
 ...session.draft_data,
 preferred_subcity: currentList.length > 0 ? currentList : [...ALL_SUBCITIES],
 };
 await sendSeekerMyGenderStep(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('seeker_my_gender:')) {
 const gender = callbackData.split(':')[1];
 const session = getSession(chatId);
 const updatedDraft = { ...session.draft_data, my_gender: gender };
 await sendSeekerAgeStep(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('seeker_set_age:')) {
 const ageVal = parseInt(callbackData.split(':')[1], 10);
 const session = getSession(chatId);
 const updatedDraft = { ...session.draft_data, age: ageVal };
 await sendSeekerPrefGenderStep(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'seeker_goto_age') {
 const session = getSession(chatId);
 await sendSeekerAgeStep(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData.startsWith('seeker_pref_gender:')) {
 const prefGender = callbackData.split(':')[1];
 const session = getSession(chatId);
 const updatedDraft = { ...session.draft_data, preferred_gender: prefGender };
 await sendSeekerBudgetStep(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'seeker_goto_pref_gender') {
 const session = getSession(chatId);
 await sendSeekerPrefGenderStep(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'seeker_goto_budget') {
 const session = getSession(chatId);
 await sendSeekerBudgetStep(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'seeker_skip_bio') {
 const session = getSession(chatId);
 const updatedDraft = { ...session.draft_data, lifestyle_bio: 'Seeking compatible roommate' };
 await sendSeekerPhoneStep(chatId, updatedDraft, msgId);
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'seeker_goto_bio') {
 const session = getSession(chatId);
 await sendSeekerBioStep(chatId, session.draft_data, msgId);
 return NextResponse.json({ ok: true });
 }

 // Callback query to start unlock for seeker
 if (callbackData.startsWith('start_unlock_seeker:') || callbackData.startsWith('unlock_seeker_')) {
 const profileId = callbackData.startsWith('start_unlock_seeker:')
 ? callbackData.split(':')[1]
 : callbackData.replace('unlock_seeker_', '');
 await sendUnlockPaywallCard(chatId, profileId, 'roommate_profile', msgId);
 return NextResponse.json({ ok: true });
 }

 // Callback query to start unlock for space
 if (callbackData.startsWith('start_unlock_space:') || callbackData.startsWith('order_')) {
 const spaceId = callbackData.startsWith('start_unlock_space:')
 ? callbackData.split(':')[1]
 : callbackData.replace('order_', '');
 await sendUnlockPaywallCard(chatId, spaceId, 'space_listing', msgId);
 return NextResponse.json({ ok: true });
 }

 // User Self-Close Channel Listing Callback
 if (callbackData.startsWith('user_close_listing:') || callbackData.startsWith('user_delete_listing:')) {
 const isDelete = callbackData.startsWith('user_delete_listing:');
 const listingKey = callbackData.split(':')[1];
 const isUuidKey = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(listingKey);
 let displayCode = !isUuidKey ? listingKey.toUpperCase().replace(/^#/, '') : 'Listing';
 let channelMsgId: number | undefined;
 const primaryChannel = await getPrimaryChannel();

 try {
 const pMatch = isUuidKey
   ? supabaseAdmin.from('profiles').update({ status: 'matched' }).eq('id', listingKey).eq('telegram_id', chatId).select('display_code, channel_message_id').maybeSingle()
   : supabaseAdmin.from('profiles').update({ status: 'matched' }).ilike('display_code', displayCode).eq('telegram_id', chatId).select('display_code, channel_message_id').maybeSingle();
 const { data: p } = await pMatch;
 if (p) {
 displayCode = p.display_code || displayCode;
 channelMsgId = p.channel_message_id;
 }
 } catch {}

 try {
 const rmQ = isUuidKey
   ? supabaseAdmin.from('roommate_profiles').update({ status: 'archived', updated_at: new Date().toISOString() }).eq('id', listingKey).eq('user_telegram_id', chatId).select('display_code, channel_message_id').maybeSingle()
   : supabaseAdmin.from('roommate_profiles').update({ status: 'archived', updated_at: new Date().toISOString() }).ilike('display_code', displayCode).eq('user_telegram_id', chatId).select('display_code, channel_message_id').maybeSingle();
 const { data: rm } = await rmQ;
 if (rm) {
 if (rm.display_code) displayCode = rm.display_code;
 if (rm.channel_message_id) channelMsgId = rm.channel_message_id;
 }
 } catch {}

 if (displayCode && displayCode !== 'Listing') {
 try {
 await supabaseAdmin
 .from('pending_roommate_drafts')
 .update({ status: 'archived', updated_at: new Date().toISOString() })
 .eq('user_telegram_id', chatId)
 .or(`id.ilike.${displayCode},display_code.ilike.${displayCode}`);
 } catch {}
 }

 let channelClosed = false;
 if (channelMsgId) {
 try {
 channelClosed = Boolean(await updateChannelPostAsMatched(channelMsgId, displayCode, undefined, primaryChannel));
 } catch (err) {
 console.error('Failed to update channel post:', err);
 }
 }

 const actionTitle = isDelete ? 'Listing Removed / ማስታወቂያው ተሰርዟል' : 'Listing Marked as Closed / ማስታወቂያው ተዘግቷል';
 const channelDetail = channelClosed
 ? `Post <b>#${escapeHtml(displayCode)}</b> has been updated on ${escapeHtml(primaryChannel)} with closed banner and contact buttons removed.\n\nማስታወቂያ <b>#${escapeHtml(displayCode)}</b> በቻናሉ ላይ ተዘግቷል፤ የግንኙነት ቁልፎችም ተነስተዋል።`
 : `Listing <b>#${escapeHtml(displayCode)}</b> has been closed and removed from active matches.\n\nማስታወቂያ <b>#${escapeHtml(displayCode)}</b> ተዘግቷል።`;

 await sendOrEditCard(
 chatId,
 `<b>${actionTitle}</b>\n\n<blockquote>${channelDetail}</blockquote>`.trim(),
 [
 [{ text: 'View My Listings / ማስታወቂያዎቼ', callback_data: 'my_listings' }],
 [{ text: 'Post New / አዲስ ልጠፍ', callback_data: 'post_profile_start' }, { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ],
 msgId
 );
 return NextResponse.json({ ok: true });
 }

 if (callbackData === 'seeker_final_submit') {
 if (!(await isUserFaydaVerified(chatId))) {
 await sendFaydaGateCard(chatId, 'verify Fayda before submitting your profile', msgId);
 return NextResponse.json({ ok: true });
 }
 const mem = await getUserMembershipStatus(chatId);
 const session = getSession(chatId);
 const draftData = session.draft_data || {};
 if (!mem.isActive) {
 await sendMembershipPaywallCard(
 chatId,
 'post_channel',
 { ...draftData, category: 'seeker' },
 msgId
 );
 return NextResponse.json({ ok: true });
 }

 await submitSeekerListingToAdmin(chatId, {
 displayCode: draftData.display_code,
 subcities: draftData.preferred_subcity || ['Bole'],
 budgetMin: draftData.budget_min ?? 0,
 budgetNum: draftData.budget_max || 10000,
 genderStr: draftData.my_gender || draftData.gender || 'Member',
 prefGenderStr: draftData.preferred_gender || 'Any',
 userAge: draftData.age || 24,
 bioStr: draftData.description || draftData.details || draftData.lifestyle_bio || draftData.roommate_traits || '',
 full_name: draftData.full_name,
 }, msgId, callback.from);
 return NextResponse.json({ ok: true });
 }

 // Admin Seeker Approval
 if (callbackData.startsWith('seeker_approve:')) {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await tgSend(chatId, `<b>Access Denied / ፈቃድ የለም።</b>`);
 return NextResponse.json({ ok: true });
 }
 const profileId = callbackData.split(':')[1];
 const draft = await getRoommateDraft(profileId);

 if (!draft) {
 await tgSend(chatId, `Draft <code>${escapeHtml(profileId)}</code> not found.`);
 return NextResponse.json({ ok: true });
 }

 const broadcastRes = await broadcastRoommateProfileToChannel(profileId);
 if (!broadcastRes.success) {
 await sendOrEditCard(
 chatId,
 `<b>Broadcast Failed for #${escapeHtml(draft.display_code || profileId)}:</b>\n${escapeHtml(broadcastRes.message)}`,
 [
 [{ text: 'Retry Approval', callback_data: `seeker_approve:${profileId}` }],
 [{ text: 'Admin Menu', callback_data: 'admin_menu' }],
 ],
 msgId
 );
 return NextResponse.json({ ok: true });
 }

 draft.status = 'approved';
 if (broadcastRes.telegramMessageId) draft.channel_message_id = broadcastRes.telegramMessageId;
 await saveRoommateDraft(draft);
 try {
 const approveCode = (draft.display_code || profileId).replace(/^#/, '');
 await supabaseAdmin
 .from('profiles')
 .update({
 status: 'active',
 onboarding_step: 'completed',
 ...(broadcastRes.telegramMessageId ? { channel_message_id: broadcastRes.telegramMessageId } : {}),
 })
 .ilike('display_code', approveCode);
 if (draft.user_telegram_id) {
 await supabaseAdmin
 .from('roommate_profiles')
 .update({
 status: 'approved',
 ...(broadcastRes.telegramMessageId ? { channel_message_id: broadcastRes.telegramMessageId } : {}),
 updated_at: new Date().toISOString(),
 })
 .eq('user_telegram_id', draft.user_telegram_id);
 }
 } catch {}

 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Seeker Profile Published to Channel! / መረጃው ቻናሉ ላይ ተለጥፏል!</b>`,
 parse_mode: 'HTML',
 });

 if (draft.user_telegram_id && draft.user_telegram_id > 0) {
 await sendTelegram('sendMessage', {
 chat_id: draft.user_telegram_id,
 text: `<b>Congratulations! Your roommate profile is now LIVE on the channel! / እንኳን ደስ አለዎት! መረጃዎ አሁን ቻናሉ ላይ ተለጥፏል!</b>`,
 parse_mode: 'HTML',
 });
 }
 return NextResponse.json({ ok: true });
 }

 // Secondary Homeowner Space Callbacks -> Direct to Admin Wahid (@WWEHID)
 if (callbackData === 'property_type' || callbackData.startsWith('prop_type:')) {
 await sendHaveRoomAdminDirectCard(chatId, msgId);
 return NextResponse.json({ ok: true });
 }

 // Fayda ID Verification (including legacy dyn_upload_fayda button alias)
 if (callbackData === 'verify_fayda' || callbackData === 'dyn_upload_fayda') {
 const isVerified = await isUserFaydaVerified(chatId);
 if (isVerified) {
 const session = getSession(chatId);
 const lang = getLanguage(session.draft_data, chatId);
 await sendVerifiedFaydaDossierCard(chatId, lang, msgId);
 return NextResponse.json({ ok: true });
 }

 await sendFaydaGateCard(chatId, 'access all SpaceMatch verified features', msgId);
 return NextResponse.json({ ok: true });
 }

 // Platform Guide
 if (callbackData === 'nav_help') {
 await sendHelpGuide(chatId, msgId);
 return NextResponse.json({ ok: true });
 }

 // My Active Listings (Manage & Close) including nav_my_listings alias
 if (callbackData === 'my_listings' || callbackData === 'nav_my_listings') {
 await sendMyListingsScreen(chatId, msgId);
 return NextResponse.json({ ok: true });
 }

 // My Unlocked Contacts (Mutual completed matches & legacy unlocked orders, sanitized)
 if (callbackData === 'my_unlocked_contacts') {
 let ordersList: any[] = [];
 let completedMatches: any[] = [];
 try {
 const [{ data: myProfRow }, { data: ordData }] = await Promise.all([
   supabaseAdmin.from('profiles').select('id').eq('telegram_id', chatId).maybeSingle(),
   supabaseAdmin
     .from('orders')
     .select('*')
     .eq('buyer_telegram_id', chatId)
     .eq('payment_status', 'completed')
     .eq('order_type', 'unlock_contact')
     .order('created_at', { ascending: false })
     .limit(10),
 ]);
 if (ordData) ordersList = ordData;
 if (myProfRow?.id) {
   const { data: matchRows } = await supabaseAdmin
     .from('matches')
     .select('id, status, completed_at, requester:requester_id(*), target:target_id(*)')
     .eq('status', 'completed')
     .or(`requester_id.eq.${myProfRow.id},target_id.eq.${myProfRow.id}`)
     .order('created_at', { ascending: false })
     .limit(25);
   if (matchRows) completedMatches = matchRows;
 }
 } catch {}

 if (ordersList.length === 0 && completedMatches.length === 0) {
 const emptyText = `<b>SpaceMatch · My Unlocked Contacts / የተከፈቱ አድራሻዎች</b>
<blockquote>You haven't unlocked any contacts yet. Browse the Matchmaker to find verified roommates!\nእስካሁን ምንም የተከፈተ አድራሻ የለዎትም። የቤት አጋር ለማግኘት ማችሜከርን ይጠቀሙ!</blockquote>
 `.trim();
 await sendOrEditCard(chatId, emptyText, [
 [{ text: 'Find a Roommate / የቤት አጋር ፈልግ >', callback_data: 'matchmaker_start' }],
 [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ], msgId);
 return NextResponse.json({ ok: true });
 }

 const seenContactKeys = new Set<string>();
 const entries: { fullName: string; phone: string; username: string; tgId: number | null; isConcierge?: boolean }[] = [];

 for (const m of completedMatches) {
 const isReq = Number(m.requester?.telegram_id) === chatId;
 const other = isReq ? m.target : m.requester;
 if (!other) continue;
 const key = String(other.id || other.telegram_id || other.display_code || '');
 if (key && seenContactKeys.has(key)) continue;
 if (key) seenContactKeys.add(key);

 let cName = other.full_name || '';
 let cPhone = other.phone_number || '';
 let cUser = other.telegram_username || '';
 const cTgId = other.telegram_id ? Number(other.telegram_id) : null;
 if (cTgId && cTgId > 0) {
 try {
 const { data: uRow } = await supabaseAdmin
 .from('users')
 .select('first_name, last_name, phone_number, username')
 .eq('telegram_id', cTgId)
 .maybeSingle();
 if (uRow) {
 if (!cPhone && uRow.phone_number) cPhone = uRow.phone_number;
 if (!cUser && uRow.username) cUser = uRow.username;
 const uName = [uRow.first_name, uRow.last_name].filter(Boolean).join(' ').trim();
 if (uName && (!cName || cName === 'Verified Member')) cName = uName;
 }
 } catch {}
 }
 entries.push({ fullName: cName, phone: cPhone, username: cUser, tgId: cTgId });
 }

 for (let idx = 0; idx < ordersList.length; idx++) {
 const ord = ordersList[idx];
 const targetId = ord.target_id;
 if (targetId && seenContactKeys.has(String(targetId))) continue;
 if (targetId) seenContactKeys.add(String(targetId));
 let contactName = '';
 let contactPhone = '';
 let contactUsername = '';
 let contactTgId: number | null = null;

 try {
 const { data: prof } = await supabaseAdmin
 .from('roommate_profiles')
 .select('*, users(*)')
 .eq('id', targetId)
 .maybeSingle();
 if (prof?.users) {
 contactName = [prof.users.first_name, prof.users.last_name].filter(Boolean).join(' ');
 contactPhone = prof.users.phone_number || '';
 contactUsername = prof.users.username || '';
 contactTgId = prof.user_telegram_id || prof.users.telegram_id || null;
 }
 } catch {}

 if (!contactName && targetId) {
 const draft = await getRoommateDraft(targetId);
 if (draft) {
 contactName = draft.user_name || '';
 contactPhone = draft.contact_phone || (draft as any).phone_number || '';
 contactUsername = draft.username || '';
 contactTgId = draft.user_telegram_id || null;
 }
 }

 if (!contactName && targetId) {
 try {
 const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetId);
 const q = isUuid
 ? supabaseAdmin.from('profiles').select('*').eq('id', targetId).maybeSingle()
 : supabaseAdmin.from('profiles').select('*').ilike('display_code', targetId).maybeSingle();
 const { data: pData } = await q;
 if (pData) {
 contactName = pData.full_name || '';
 contactPhone = pData.phone_number || '';
 contactUsername = pData.telegram_username || '';
 contactTgId = pData.telegram_id || null;
 }
 } catch {}
 }
 entries.push({ fullName: contactName, phone: contactPhone, username: contactUsername, tgId: contactTgId });
 }

 let msg = `<b>SpaceMatch · My Unlocked Contacts (${entries.length}) / የተከፈቱ አድራሻዎች</b>\n\n`;
 const buttons: any[] = [];

 for (let idx = 0; idx < entries.length; idx++) {
 const e = entries[idx];
 const sanitized = sanitizeContactDossier({
 fullName: e.fullName,
 phoneNumber: e.phone,
 telegramUsername: e.username,
 telegramId: e.tgId,
 isConcierge: e.isConcierge,
 });

 const phoneDisplay = `<code>${escapeHtml(sanitized.phoneNumber)}</code>`;
 const userDisplay = sanitized.telegramUsername ? ` | @${escapeHtml(sanitized.telegramUsername)}` : '';
 msg += `\n${idx + 1}. <b>${escapeHtml(sanitized.fullName)}</b>\n ${phoneDisplay}${userDisplay}\n`;

 if (sanitized.telegramUrl) {
 buttons.push([{ text: `Chat with ${sanitized.fullName.split(' ')[0]} / በቴሌግራም አውራ`, url: sanitized.telegramUrl }]);
 }
 }

 buttons.push([
 { text: 'Find Another Roommate / ሌላ ፈልግ', callback_data: 'matchmaker_start' },
 { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
 ]);

 await sendOrEditCard(chatId, truncateTelegramHtml(msg.trim(), 4096), buttons, msgId);
 return NextResponse.json({ ok: true });
 }

 // Admin Dashboard Menu (Strictly gated by getAdminIds)
 if (callbackData === 'admin_menu') {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await tgSend(chatId, `<b>Access Denied / ፈቃድ የለም።</b>`);
 return NextResponse.json({ ok: true });
 }
 let pendingCount = 0;
 try {
 const { count } = await supabaseAdmin
 .from('profiles')
 .select('id', { count: 'exact', head: true })
 .eq('status', 'paused')
 .eq('onboarding_step', 'pending_approval');
 pendingCount = count || 0;
 } catch {}

 const adminWebToken = signAdminToken(chatId, 3600);
 const adminKeyboard = [
 [{ text: 'Open Web Admin Portal 🌐 / ድረ-ገጽ አድሚን ክፈት', url: `${appUrl}/admin?auth_token=${encodeURIComponent(adminWebToken)}` }],
 [{ text: 'Search User by Name (Fayda Dossier) >', callback_data: 'admin_search_user_prompt' }],
 [{ text: 'Search Post by Code (#SPMARBR / #SPMARWR) ', callback_data: 'admin_search_code_prompt' }],
 [{ text: `Pending Approvals (${pendingCount})`, callback_data: 'admin_list_pending' }],
 [{ text: 'Post to Channel as Admin >', callback_data: 'admin_post_start' }],
 [{ text: 'Add Admin by Username >', callback_data: 'admin_add_prompt' }],
 [{ text: 'View Administrators', callback_data: 'admin_list_team' }],
 [{ text: 'Connected Channels & Settings ', callback_data: 'admin_list_channels' }],
 [{ text: 'Open Channel Posts & Close / ክፍት ማስታወቂያዎችና መዝጊያ', callback_data: 'admin_list_active_posts' }],
 [{ text: 'Post Custom Announcement', callback_data: 'admin_custom_prompt' }],
 [{ text: 'Exit Admin Menu', callback_data: 'admin_cancel' }],
 ];

 const menuText = `<b>SpaceMatch Admin Panel / የአድሚን ፓነል</b>\nManage pending reviews, open listings, and channel posts / ክፍት ማስታወቂያዎችንና ግምገማዎችን ያስተዳድሩ:`;
 await sendOrEditCard(chatId, menuText, adminKeyboard, msgId);
 return NextResponse.json({ ok: true });
 }

 // Admin: Custom Announcement Prompt
 if (callbackData === 'admin_custom_prompt') {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await tgSend(chatId, `<b>Access Denied / ፈቃድ የለም።</b>`);
 return NextResponse.json({ ok: true });
 }
 await saveSession({
 telegram_id: chatId,
 step: 'admin_awaiting_custom_announcement',
 draft_data: { card_msg_id: msgId },
 updated_at: new Date().toISOString(),
 });
 await sendOrEditCard(
 chatId,
 `<b>Post Custom Announcement / ልዩ ማስታወቂያ ለጥፍ</b>\n\n<blockquote>Send the HTML-formatted message text (or a photo with caption) to broadcast to the primary channel.\n\nወደ ዋናው ቻናል የሚለጠፈውን ጽሁፍ (ወይም ፎቶ ከጽሁፍ ጋር) ይላኩ።</blockquote>`,
 [[{ text: 'Cancel / ሰርዝ', callback_data: 'admin_menu' }]],
 msgId
 );
 return NextResponse.json({ ok: true });
 }

 // Admin: List Pending Roommate Profiles for Approval
 if (callbackData === 'admin_list_pending') {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await tgSend(chatId, `<b>Access Denied.</b>`);
 return NextResponse.json({ ok: true });
 }

 let pendingList: any[] = [];
 try {
 const [profPending, draftPending] = await Promise.all([
 supabaseAdmin
 .from('profiles')
 .select('*')
 .eq('status', 'paused')
 .eq('onboarding_step', 'pending_approval')
 .order('created_at', { ascending: false })
 .limit(10),
 supabaseAdmin
 .from('pending_roommate_drafts')
 .select('*')
 .eq('status', 'pending_approval')
 .order('created_at', { ascending: false })
 .limit(10),
 ]);
 const seenPendingCodes = new Set<string>();
 for (const p of profPending?.data || []) {
 const codeKey = String(p.display_code || p.id || '').toUpperCase();
 if (codeKey) seenPendingCodes.add(codeKey);
 pendingList.push({ code: p.display_code || p.id, gender: p.gender, locations: p.locations });
 }
 for (const d of draftPending?.data || []) {
 const codeKey = String(d.display_code || d.id || '').toUpperCase();
 if (codeKey && seenPendingCodes.has(codeKey)) continue;
 if (codeKey) seenPendingCodes.add(codeKey);
 pendingList.push({ code: d.display_code || d.id, gender: d.my_gender, locations: d.preferred_subcity });
 }
 } catch {}

 if (pendingList.length === 0) {
 await sendOrEditCard(
 chatId,
 `<b>SpaceMatch Admin · Pending Approvals</b>\n\n<blockquote>No profiles are currently waiting for admin approval. All caught up! </blockquote>`,
 [[{ text: 'Back to Admin Menu', callback_data: 'admin_menu' }]],
 msgId
 );
 return NextResponse.json({ ok: true });
 }

 const buttons: any[] = [];
 for (const p of pendingList.slice(0, 10)) {
 const code = p.code;
 const loc = Array.isArray(p.locations) ? p.locations[0] || 'Addis' : 'Addis';
 buttons.push([
 { text: `Approve #${code} (${p.gender || 'Any'} · ${loc})`, callback_data: `admin_approve_profile:${code}` },
 { text: `Reject`, callback_data: `admin_reject_profile:${code}` },
 ]);
 }
 buttons.push([{ text: 'Back to Admin Menu', callback_data: 'admin_menu' }]);

 await sendOrEditCard(
 chatId,
 `<b>SpaceMatch Admin · Pending Profiles (${pendingList.length})</b>\n\nReview the listings waiting for approval below:`,
 buttons,
 msgId
 );
 return NextResponse.json({ ok: true });
 }

 // Admin: Search Post by Code Prompt Callback
 if (callbackData === 'admin_search_code_prompt') {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await tgSend(chatId, `<b>Access Denied.</b>`);
 return NextResponse.json({ ok: true });
 }

 await saveSession({
 telegram_id: chatId,
 step: 'admin_search_code_input',
 draft_data: { card_msg_id: msgId },
 updated_at: new Date().toISOString(),
 });

 const promptText = `<b>SpaceMatch Admin · Search Post by Code</b>

Please send the identification code or number of the listing you want to inspect:
<b>Examples:</b>
• <code>#SPMARBR5</code> or <code>SPMARBR5</code> (Roommate Before Room)
• <code>#SPMARWR1</code> or <code>SPMARWR1</code> (Roommate With Room)
• <code>5</code> or <code>1</code> (Numeric shorthand)
• Or send the Telegram Channel Message ID.

 You will receive the complete candidate dossier including unmasked contact info, status, and direct management buttons.
 `.trim();

 const buttons = [
 [{ text: 'Back to Admin Menu', callback_data: 'admin_menu' }],
 [{ text: 'Cancel', callback_data: 'admin_cancel' }],
 ];

 await sendOrEditCard(chatId, promptText, buttons, msgId);
 return NextResponse.json({ ok: true });
 }

 // Admin: Search User by Name Prompt Callback
 if (callbackData === 'admin_search_user_prompt') {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await tgSend(chatId, `<b>Access Denied.</b>`);
 return NextResponse.json({ ok: true });
 }

 await saveSession({
 telegram_id: chatId,
 step: 'admin_search_user_input',
 draft_data: { card_msg_id: msgId },
 updated_at: new Date().toISOString(),
 });

 const promptText = `<b>SpaceMatch Admin · Search Resident & Fayda Record</b>

Please send the resident's <b>Full Name</b>, <b>First Name</b>, <b>@username</b>, or <b>16-digit Fayda FAN number</b>:
<b>Examples:</b>
• <code>Tsehay</code> or <code>Biruk</code>
• <code>@birukadiyee</code>
• <code>4783419389048718</code>
• Or send their numeric Telegram ID.

 The bot will retrieve all official demographic and cryptographic Fayda data registered to this person.
 `.trim();

 const buttons = [
 [{ text: 'Back to Admin Menu', callback_data: 'admin_menu' }],
 [{ text: 'Cancel', callback_data: 'admin_cancel' }],
 ];

 await sendOrEditCard(chatId, promptText, buttons, msgId);
 return NextResponse.json({ ok: true });
 }

 // Admin: View User Fayda Dossier Callback
 if (callbackData?.startsWith('admin_user_dossier:')) {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await tgSend(chatId, `<b>Access Denied.</b>`);
 return NextResponse.json({ ok: true });
 }
 const targetTgId = Number(callbackData.replace('admin_user_dossier:', ''));
 await renderAdminUserDossier(chatId, targetTgId, msgId);
 return NextResponse.json({ ok: true });
 }

 // Admin: Direct Search Code Callback (e.g. from user dossier)
 if (callbackData?.startsWith('admin_search_code:')) {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await tgSend(chatId, `<b>Access Denied.</b>`);
 return NextResponse.json({ ok: true });
 }
 const targetCode = callbackData.replace('admin_search_code:', '');
 await executeAdminPostSearch(chatId, targetCode, msgId);
 return NextResponse.json({ ok: true });
 }

 // Admin: Add Admin by Username Prompt Callback
 if (callbackData === 'admin_add_prompt') {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await tgSend(chatId, `<b>Access Denied.</b>`);
 return NextResponse.json({ ok: true });
 }

 await saveSession({
 telegram_id: chatId,
 step: 'admin_awaiting_username',
 draft_data: { card_msg_id: msgId },
 updated_at: new Date().toISOString(),
 });

 const promptText = `<b>SpaceMatch Admin · Add Administrator</b>

Please send the Telegram username of the user you want to appoint as an administrator (e.g. <code>@username</code> or <code>username</code>).

 They will immediately receive admin privileges to post (<code>/post</code>), review, and close listings (<code>/close</code>).
 `.trim();

 const buttons = [
 [{ text: 'Back to Admin Menu', callback_data: 'admin_menu' }],
 [{ text: 'Cancel', callback_data: 'admin_cancel' }],
 ];

 await sendOrEditCard(chatId, promptText, buttons, msgId);
 return NextResponse.json({ ok: true });
 }

 // Admin: View Admin Team Callback
 if (callbackData === 'admin_list_team') {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await tgSend(chatId, `<b>Access Denied.</b>`);
 return NextResponse.json({ ok: true });
 }

 let dbAdminList: any[] = [];
 try {
 const { data } = await supabaseAdmin
 .from('users')
 .select('telegram_id, first_name, last_name, username')
 .eq('role', 'admin');
 if (data) dbAdminList = data;
 } catch {}

 const pendingUsernames = await getPendingAdminUsernames();

 let msg = `<b>SpaceMatch Administrators (${adminIds.length + pendingUsernames.length} Total)</b>\n\n`;
 msg += `<b>Super Administrators:</b>\n`;
 msg += `• Biruk (@birukadiyee · <code>800701176</code>)\n`;
 msg += `• Wahid (@WWEHID · <code>148318506</code>)\n\n`;

 if (dbAdminList.length > 0) {
 msg += `<b>Database Administrators:</b>\n`;
 for (const a of dbAdminList) {
 const name = [a.first_name, a.last_name].filter(Boolean).join(' ') || 'Admin';
 const handle = a.username ? `@${a.username}` : `<code>${a.telegram_id}</code>`;
 msg += `• ${name} (${handle})\n`;
 }
 msg += '\n';
 }

 if (pendingUsernames.length > 0) {
 msg += `<b>Registered Admin Usernames:</b>\n`;
 for (const u of pendingUsernames) {
 msg += `• @${u} (Active upon opening bot)\n`;
 }
 msg += '\n';
 }

 msg += `<b>Channel Administrators:</b>\n`;
 msg += `• Automatically synced from connected channel administrators.\n`;

 const buttons = [
 [{ text: 'Add Admin by Username >', callback_data: 'admin_add_prompt' }],
 [{ text: 'Back to Admin Menu', callback_data: 'admin_menu' }],
 [{ text: 'Main Menu', callback_data: 'nav_start' }],
 ];

 await sendOrEditCard(chatId, msg.trim(), buttons, msgId);
 return NextResponse.json({ ok: true });
 }

 // Admin: View Connected Channels & Management
 if (callbackData === 'admin_list_channels' || callbackData === 'admin_channels_setup') {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await tgSend(chatId, `<b>Access Denied.</b>`);
 return NextResponse.json({ ok: true });
 }

 const channels = await getManagedChannels();
 let text = `<b>Connected Channels & Broadcasting (${channels.length}) / የተገናኙ ቻናሎች</b>\n\n`;
 if (channels.length === 0) {
 text += `No channels currently registered. The bot uses the default channel (@roommate_addis).\n\nTo link a channel, add this bot as an administrator to that channel, or send:\n<code>/setchannel @your_channel</code>`;
 } else {
 for (let i = 0; i < channels.length; i++) {
 const ch = channels[i];
 const icon = ch.is_active ? '' : '';
 text += `${i + 1}. ${icon} <b>${ch.channel_title}</b>\n`;
 text += ` • ID: <code>${ch.channel_id}</code>\n`;
 if (ch.channel_username) text += ` • Username: <b>${ch.channel_username}</b>\n`;
 text += ` • Status / ሁኔታ: ${ch.is_active ? 'Active / የሚሰራ' : ' Inactive / የማይሰራ'}\n\n`;
 }
 text += ` Any channel where @${botUsername} is added as administrator will automatically connect here and recognize its channel admins!`;
 }

 const buttons = [
 [{ text: 'Back to Admin Menu / ወደ አድሚን ማውጫ ተመለስ', callback_data: 'admin_menu' }],
 [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ];

 await sendOrEditCard(chatId, text, buttons, msgId);
 return NextResponse.json({ ok: true });
 }

 // Admin: List Active Channel Posts (Strictly gated by getAdminIds)
 if (callbackData === 'admin_list_active_posts') {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await tgSend(chatId, `<b>Access Denied / ፈቃድ የለም።</b>`);
 return NextResponse.json({ ok: true });
 }
 let activePosts: any[] = [];
 const seenMsgIds = new Set<number>();

 try {
 const [rmRes, spRes, profRes, draftsObj] = await Promise.all([
 supabaseAdmin
 .from('roommate_profiles')
 .select('id, channel_message_id, my_gender')
 .not('channel_message_id', 'is', null)
 .eq('status', 'approved')
 .order('created_at', { ascending: false })
 .limit(10),
 supabaseAdmin
 .from('spaces')
 .select('id, title, channel_message_id')
 .not('channel_message_id', 'is', null)
 .eq('status', 'published')
 .order('created_at', { ascending: false })
 .limit(10),
 supabaseAdmin
 .from('profiles')
 .select('id, display_code, gender, channel_message_id')
 .not('channel_message_id', 'is', null)
 .eq('status', 'active')
 .order('created_at', { ascending: false })
 .limit(10),
 getAllRoommateDrafts(),
 ]);

 for (const p of profRes?.data || []) {
 const msgNum = Number(p.channel_message_id);
 if (!msgNum || seenMsgIds.has(msgNum)) continue;
 seenMsgIds.add(msgNum);
 activePosts.push({
 id: p.id,
 type: 'profile',
 channel_message_id: msgNum,
 title: `#${p.display_code || 'RM'} (${p.gender || 'Member'})`,
 });
 }
 for (const p of rmRes?.data || []) {
 const msgNum = Number(p.channel_message_id);
 if (!msgNum || seenMsgIds.has(msgNum)) continue;
 seenMsgIds.add(msgNum);
 activePosts.push({
 id: p.id,
 type: 'roommate',
 channel_message_id: msgNum,
 title: `Roommate Seeker (${p.my_gender || 'Candidate'})`,
 });
 }
 for (const s of spRes?.data || []) {
 const msgNum = Number(s.channel_message_id);
 if (!msgNum || seenMsgIds.has(msgNum)) continue;
 seenMsgIds.add(msgNum);
 activePosts.push({
 id: s.id,
 type: 'space',
 channel_message_id: msgNum,
 title: s.title || 'Space Listing',
 });
 }
 for (const r of Object.values(draftsObj || {})) {
 const msgNum = Number(r.channel_message_id || 0);
 if (!msgNum || ['matched', 'archived', 'rejected'].includes(String(r.status || '')) || seenMsgIds.has(msgNum)) continue;
 seenMsgIds.add(msgNum);
 activePosts.push({
 id: r.id,
 type: 'roommate',
 channel_message_id: msgNum,
 title: `Roommate #${r.display_code || 'RM' + r.id.slice(0, 4)}`,
 });
 }
 } catch {}

 if (activePosts.length === 0) {
 const text = `<b>SpaceMatch Admin · Open Channel Posts / ክፍት ማስታወቂያዎች</b>\n\n<blockquote>No open channel posts found at this time. / በአሁኑ ሰዓት ምንም ክፍት ማስታወቂያ የለም።</blockquote>`;
 await sendOrEditCard(
 chatId,
 text,
 [[{ text: 'Back to Admin Menu / ወደ አድሚን ማውጫ ተመለስ', callback_data: 'admin_menu' }]],
 msgId
 );
 return NextResponse.json({ ok: true });
 }

 const buttons: any[] = [];
 for (const post of activePosts.slice(0, 12)) {
 buttons.push([
 {
 text: `Mark Matched: #${post.channel_message_id} (${post.title.substring(0, 22)})`,
 callback_data: `admin_close_post:${post.channel_message_id}`,
 },
 ]);
 }
 buttons.push([{ text: 'Back to Admin Menu / ወደ አድሚን ማውጫ ተመለስ', callback_data: 'admin_menu' }]);

 const text = `<b>SpaceMatch Admin · Active Channel Posts (${activePosts.length})</b>\n\nTap any post below to mark it as <b>CLOSED · MATCHED</b> on the channel and remove connect buttons:`;

 await sendOrEditCard(chatId, text, buttons, msgId);
 return NextResponse.json({ ok: true });
 }

 // Admin: Mark Matched & Close Channel Post (Strictly gated by getAdminIds)
 if (callbackData.startsWith('admin_close_post:')) {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await tgSend(chatId, `<b>Access Denied / ፈቃድ የለም።</b>`);
 return NextResponse.json({ ok: true });
 }
 const parts = callbackData.split(':');
 const channelMsgId = parts.length >= 4 ? parseInt(parts[3], 10) : parseInt(parts[1], 10);

 const closeRes = await executeChannelPostClose(String(channelMsgId), chatId);
 try {
 await supabaseAdmin
 .from('spaces')
 .update({ status: 'rented', updated_at: new Date().toISOString() })
 .eq('channel_message_id', channelMsgId);
 } catch {}

 const text = closeRes.success
 ? `<b>Post #${channelMsgId} Officially Closed!</b>\n\n${closeRes.message}`
 : `<b>Could not update channel post #${channelMsgId}:</b>\n${escapeHtml(closeRes.message)}`;

 const buttons = [
 [{ text: 'View Remaining Open Posts / የቀሩትን ክፍት ማስታወቂያዎች እይ', callback_data: 'admin_list_active_posts' }],
 [{ text: 'Back to Admin Menu / ወደ አድሚን ማውጫ ተመለስ', callback_data: 'admin_menu' }],
 ];

 await sendOrEditCard(chatId, text, buttons, msgId);
 return NextResponse.json({ ok: true });
 }

 return NextResponse.json({ ok: true });
 } finally {
 if (actionLockKey) await releaseActionLock(actionLockKey);
 }
 }

 // -------------------------------------------------------------------------
 // 2. HANDLE INCOMING TEXT MESSAGES & COMMANDS
 // -------------------------------------------------------------------------
 const message = update.message;
 if (message && message.chat) {
 const chatId: number = message.chat.id;
 if (chatId <= 0) {
 return NextResponse.json({ ok: true });
 }
 let text: string = (message.text || message.caption || '').trim();

 // Load session from Supabase before any getSession() call
 await preloadSession(chatId);
 const session = getSession(chatId);

 // Forward detection: Admin forwards a channel post to link or close/mark as matched
 const forwardChat = (message as any).forward_from_chat || (message as any).forward_origin?.chat;
 const forwardMsgId = (message as any).forward_from_message_id || (message as any).forward_origin?.message_id;
 if (forwardMsgId || forwardChat) {
 const adminIds = await getAdminIds();
 if (adminIds.includes(chatId)) {
 // If forwarded from a channel, automatically register the channel
 if (forwardChat && (forwardChat.type === 'channel' || forwardChat.id)) {
 try {
 await saveManagedChannel({
 channel_id: forwardChat.id,
 channel_title: forwardChat.title || 'Connected Channel',
 channel_username: forwardChat.username ? `@${forwardChat.username}` : null,
 added_by: chatId,
 is_active: true,
 added_at: new Date().toISOString(),
 updated_at: new Date().toISOString(),
 });
 } catch (fwdChErr) {
 console.warn('[webhook] forwardChat auto-registration warning:', fwdChErr);
 }
 }

 let foundCode: string | null = null;
 if (text) {
 const matchCode = text.match(/#(SPMAR(?:BR|WR)\d+|RM\d+|SP\d+)/i);
 if (matchCode) foundCode = matchCode[1].toUpperCase();
 }
 if (!foundCode && forwardMsgId) {
 const { data: p } = await supabaseAdmin
 .from('profiles')
 .select('display_code')
 .eq('channel_message_id', forwardMsgId)
 .maybeSingle();
 if (p?.display_code) {
 foundCode = p.display_code;
 } else {
 foundCode = `RM${forwardMsgId}`;
 }
 }

 const targetIdentifier = foundCode || (forwardMsgId ? String(forwardMsgId) : 'POST');
 const targetChannel = await getPrimaryChannel();
 const postLink = buildChannelPostUrl(targetChannel, forwardMsgId);

 const forwardPromptText = `<b>SpaceMatch Admin · Channel Post Forward Detected</b>

Detected Channel Post <b>#${targetIdentifier}</b> (Message ID: <code>${forwardMsgId || 'N/A'}</code>).

Would you like to mark this channel post as <b>CLOSED / MATCHED</b>?
 `.trim();

 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: forwardPromptText,
 parse_mode: 'HTML',
 reply_markup: {
 inline_keyboard: [
 [{ text: `Mark #${targetIdentifier} as CLOSED in Channel`, callback_data: `admin_close:${targetIdentifier}` }],
 ...(postLink ? [[{ text: 'View Channel Post >', url: postLink }]] : []),
 [{ text: 'Cancel', callback_data: 'nav_start' }],
 ],
 },
 });
 return NextResponse.json({ ok: true });
 }
 }

 // Handle Slash Commands
 if (text === '/lang' || text === '/language') {
 await sendLanguageSelectCard(chatId);
 return NextResponse.json({ ok: true });
 }

 if (text === '/amharic') {
 setUserLanguage(chatId, 'am');
 const sess = getSession(chatId);
 await saveSession({ ...sess, draft_data: buildCleanFlowDraft(chatId, sess.draft_data, { lang: 'am' }), updated_at: new Date().toISOString() });
 await sendPrimaryWelcomeMenu(chatId, undefined, message.from);
 return NextResponse.json({ ok: true });
 }

 if (text === '/english') {
 setUserLanguage(chatId, 'en');
 const sess = getSession(chatId);
 await saveSession({ ...sess, draft_data: buildCleanFlowDraft(chatId, sess.draft_data, { lang: 'en' }), updated_at: new Date().toISOString() });
 await sendPrimaryWelcomeMenu(chatId, undefined, message.from);
 return NextResponse.json({ ok: true });
 }

 if (text.startsWith('/start') || text === '/start') {
 await clearSession(chatId);

 // ── NEW: Deep-link from channel button → /start req_<display_code> ──
 if (
 text.startsWith('/start req_') ||
 text.startsWith('/start SPMARBR') ||
 text.startsWith('/start spmarbr') ||
 text.startsWith('/start #SPMARBR') ||
 text.startsWith('/start #spmarbr') ||
 text.startsWith('/start SPMARWR') ||
 text.startsWith('/start spmarwr') ||
 text.startsWith('/start #SPMARWR') ||
 text.startsWith('/start #spmarwr')
 ) {
 const rawCode = text.startsWith('/start req_')
 ? text.replace('/start req_', '').trim()
 : text.replace(/^\/start\s*/, '').trim();
 const lookupCode = rawCode.replace(/^#/, '').trim();

 // Lookup target profile from profiles or roommate_profiles
 let targetProfile: any = null;

 // 1. Direct exact check by display_code
 const { data: pExact } = await supabaseAdmin
 .from('profiles')
 .select('*')
 .ilike('display_code', lookupCode)
 .maybeSingle();
 if (pExact) {
 targetProfile = pExact;
 }

 // 2. Numeric-only check (e.g. 5 -> SPMARBR5, 1 -> SPMARWR1)
 if (!targetProfile && /^\d+$/.test(lookupCode)) {
 const { data: pNumBr } = await supabaseAdmin
 .from('profiles')
 .select('*')
 .ilike('display_code', `SPMARBR${lookupCode}`)
 .maybeSingle();
 if (pNumBr) {
 targetProfile = pNumBr;
 } else {
 const { data: pNumWr } = await supabaseAdmin
 .from('profiles')
 .select('*')
 .ilike('display_code', `SPMARWR${lookupCode}`)
 .maybeSingle();
 if (pNumWr) targetProfile = pNumWr;
 }
 }

 // 3. Fallback: only if lookupCode is exactly 'SPMARBR' or 'RM105' (no digits)
 if (!targetProfile && (lookupCode.toUpperCase() === 'SPMARBR' || lookupCode.toUpperCase() === 'RM105')) {
 const { data: pSpm } = await supabaseAdmin
 .from('profiles')
 .select('*')
 .ilike('display_code', 'SPMARBR%')
 .order('created_at', { ascending: false })
 .limit(1)
 .maybeSingle();
 if (pSpm) targetProfile = pSpm;
 }

 if (!targetProfile) {
 const { data: pCode } = await supabaseAdmin
 .from('profiles')
 .select('*')
 .ilike('display_code', lookupCode)
 .maybeSingle();
 if (pCode) {
 targetProfile = pCode;
 } else {
 const { data: pId } = await supabaseAdmin
 .from('profiles')
 .select('*')
 .eq('id', lookupCode)
 .maybeSingle();
 if (pId) {
 targetProfile = pId;
 } else {
 const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lookupCode);
 if (isUuid) {
 const { data: rm } = await supabaseAdmin
 .from('roommate_profiles')
 .select('*')
 .eq('id', lookupCode)
 .maybeSingle();
 if (rm) {
 targetProfile = {
 id: rm.id,
 telegram_id: rm.user_telegram_id,
 display_code: lookupCode,
 gender: rm.my_gender,
 locations: rm.preferred_subcity,
 budget_min: rm.budget_min,
 budget_max: rm.budget_max,
 roommate_traits: rm.lifestyle_bio,
 status: rm.status,
 channel_message_id: rm.channel_message_id,
 };
 }
 }
 }
 }
 }

 // Check pending roommate drafts cache
 if (!targetProfile) {
 const draft = await getRoommateDraft(lookupCode);
 if (draft) {
 targetProfile = {
 id: draft.id || lookupCode,
 telegram_id: draft.user_telegram_id || -105,
 display_code: draft.display_code || lookupCode,
 gender: draft.my_gender || 'Any',
 locations: draft.preferred_subcity || ['Addis Ababa'],
 budget_min: draft.budget_min || 0,
 budget_max: draft.budget_max || 10000,
 roommate_traits: draft.lifestyle_bio || 'Channel Roommate Listing',
 status: draft.status || 'active',
 };
 }
 }

 // Check if RM105 alias resolves to SPMARBR or vice versa
 if (!targetProfile && lookupCode.toUpperCase() === 'RM105') {
 const { data: pSpm } = await supabaseAdmin
 .from('profiles')
 .select('*')
 .eq('display_code', 'SPMARBR')
 .maybeSingle();
 if (pSpm) targetProfile = pSpm;
 }

 if (!targetProfile && lookupCode.toUpperCase() === 'SPMARBR') {
 const { data: pLatestSpm } = await supabaseAdmin
 .from('profiles')
 .select('*')
 .ilike('display_code', 'SPMARBR%')
 .order('created_at', { ascending: false })
 .limit(1)
 .maybeSingle();
 if (pLatestSpm) targetProfile = pLatestSpm;
 }

 // Check by channel_message_id if lookupCode has a number or starts with post_ / SPMARBR / SPMARWR / RM
 if (!targetProfile) {
 const numPart = lookupCode.replace(/^post_/i, '').replace(/^SPMAR(BR|WR)/i, '').replace(/^RM/i, '').replace(/^SP/i, '');
 const channelMsgId = parseInt(numPart, 10);
 if (!isNaN(channelMsgId) && channelMsgId > 0) {
 const { data: pByMsg } = await supabaseAdmin
 .from('profiles')
 .select('*')
 .eq('channel_message_id', channelMsgId)
 .maybeSingle();
 if (pByMsg) {
 targetProfile = pByMsg;
 }
 }
 }

 // Fallback: Only recover genuine listing prefix codes (SPMARBR/SPMARWR/post_), never arbitrary text like /start HELLO
 if (!targetProfile && (lookupCode.toLowerCase().startsWith('post_') || /^SPMAR(BR|WR)\d+/i.test(lookupCode))) {
 const codeDigits = parseInt(lookupCode.replace(/\D/g, ''), 10) || Math.floor(Math.random() * 1000000);
 const fallbackSyntheticId = -(1000000000 + codeDigits);

 const { data: createdProfile } = await supabaseAdmin
 .from('profiles')
 .upsert({
 telegram_id: fallbackSyntheticId,
 display_code: lookupCode.toUpperCase(),
 gender: 'Any',
 locations: ['Addis Ababa'],
 budget_min: 0,
 budget_max: 10000,
 roommate_traits: 'Channel Roommate Listing in Addis Ababa.',
 kyc_status: 'verified',
 status: 'active',
 onboarding_step: 'completed',
 telegram_username: 'WWEHID',
 phone_number: 'SpaceMatch Concierge',
 full_name: 'SpaceMatch Verified Listing (Concierge)',
 }, { onConflict: 'display_code' })
 .select('*')
 .maybeSingle();
 if (createdProfile) {
 targetProfile = createdProfile;
 }
 }

 const reqLang = getUserLanguage(chatId);
 const reqIsAm = reqLang === 'am';

 if (!targetProfile) {
 await sendOrEditCard(
 chatId,
 `<b>Listing Not Available / ማስታወቂያው በአሁኑ ሰዓት አይገኝም</b>\n\nRoommate <b>#${escapeHtml(lookupCode)}</b> is no longer available or was removed.\n\n<blockquote>Browse other open verified roommates below: / ሌሎች ክፍት እና የተረጋገጡ የቤት አጋሮችን ከታች ይመልከቱ:</blockquote>`,
 [
 [{ text: 'Find Roommates / የቤት አጋር ፈልግ >', callback_data: 'matchmaker_start' }],
 [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ]
 );
 return NextResponse.json({ ok: true });
 }

 // Check if listing is closed / matched / archived / rejected
 if (['matched', 'closed', 'archived', 'rejected', 'rented'].includes(String(targetProfile.status || '').toLowerCase())) {
 await sendOrEditCard(
 chatId,
 `<b>Listing Closed / ማስታወቂያው ተዘግቷል</b>\n\n Roommate <b>#${targetProfile.display_code || lookupCode}</b> has already found a match! \n\n<blockquote>This listing is officially closed. Browse other open roommates below: / ይህ ማስታወቂያ ተዘግቷል። ሌሎች ክፍት የቤት አጋሮችን ከታች ይመልከቱ:</blockquote>`,
 [
 [{ text: 'Find Roommates / የቤት አጋር ፈልግ >', callback_data: 'matchmaker_start' }],
 [{ text: 'Post Seeker Profile / መረጃዬን ልለጥፍ', callback_data: 'seeker_flow' }],
 [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ]
 );
 return NextResponse.json({ ok: true });
 }

 // Check for self-listing
 if (String(targetProfile.telegram_id) === String(chatId)) {
 await sendOrEditCard(
 chatId,
 `<b>Your Open Listing / የእርስዎ ክፍት ማስታወቂያ</b>\n\nThis is your listing for Roommate <b>#${targetProfile.display_code || lookupCode}</b> on the channel.\n\n<blockquote>If you have found a roommate, tap below to mark it as closed: / የቤት አጋር ካገኙ ማስታወቂያውን ለመዝጋት ከታች ይጫኑ:</blockquote>`,
 [
 [{ text: 'Mark as Closed / እንደተዘጋ ምልክት አድርግ', callback_data: `user_close_listing:${targetProfile.id}` }],
 [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ]
 );
 return NextResponse.json({ ok: true });
 }

 const targetLocations = Array.isArray(targetProfile.locations)
 ? targetProfile.locations.join(', ')
 : (Array.isArray(targetProfile.preferred_subcity) ? targetProfile.preferred_subcity.join(', ') : 'Addis Ababa');
 const targetBudgetStr = targetProfile.budget_max
 ? `${Number(targetProfile.budget_max).toLocaleString()} ETB/mo`
 : '';

 // Guarantee targetProfile is persisted in profiles table and has a valid UUID
 if (!targetProfile.id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetProfile.id)) {
 const cleanDisplayCode = (targetProfile.display_code || lookupCode).toUpperCase().replace(/^#/, '');
 const codeDigits = parseInt(cleanDisplayCode.replace(/\D/g, ''), 10) || Math.floor(Math.random() * 1000000);
 const syntheticTgId = targetProfile.telegram_id || -(1000000000 + codeDigits);

 const { data: guaranteedProfile } = await supabaseAdmin
 .from('profiles')
 .upsert({
 telegram_id: syntheticTgId,
 display_code: cleanDisplayCode,
 gender: targetProfile.gender || targetProfile.my_gender || 'Member',
 locations: Array.isArray(targetProfile.locations) && targetProfile.locations.length > 0 ? targetProfile.locations : ['Addis Ababa'],
 budget_min: Number(targetProfile.budget_min || 0),
 budget_max: Number(targetProfile.budget_max || 10000),
 roommate_traits: targetProfile.roommate_traits || targetProfile.lifestyle_bio || 'Channel Roommate Listing',
 kyc_status: 'verified',
 status: 'active',
 onboarding_step: 'completed',
 telegram_username: targetProfile.username || targetProfile.telegram_username || null,
 phone_number: targetProfile.phone_number || null,
 full_name: targetProfile.user_name || targetProfile.full_name || 'Verified Channel Listing',
 }, { onConflict: 'display_code' })
 .select('*')
 .maybeSingle();

 if (guaranteedProfile) {
 targetProfile = guaranteedProfile;
 }
 }

 // Check if requesting user is already Fayda verified and has a completed profile in parallel
 const [isVerified, profileRes] = await Promise.all([
 isUserFaydaVerified(chatId),
 supabaseAdmin.from('profiles').select('*').eq('telegram_id', chatId).maybeSingle(),
 ]);
 const myProfile = profileRes.data;

 if (!isVerified) {
 await sendFaydaGateCard(chatId, 'verify your National ID before connecting with this roommate', undefined, {
   return_flow: 'req_connect',
   return_meta: {
     targetId: targetProfile.id,
     targetCode: targetProfile.display_code || lookupCode,
     targetLocations,
     targetBudgetStr,
   },
 });
 return NextResponse.json({ ok: true });
 }

 if (!myProfile) {
 // Verified new user without a profile: automatically lock target and launch dynamic card onboarding
 await sendDynamicCardStep1Age(chatId, {
 target_id: targetProfile.id,
 target_code: targetProfile.display_code || lookupCode,
 target_locations: targetLocations,
 target_budget: targetBudgetStr,
 lang: reqLang,
 });
 return NextResponse.json({ ok: true });
 }

 const hasCompleteSeekerProfile = Boolean(
 isVerified &&
 myProfile.gender &&
 myProfile.gender !== 'Member' &&
 myProfile.budget_max !== null &&
 myProfile.budget_max !== undefined &&
 ['completed', 'pending_approval'].includes(String(myProfile.onboarding_step || ''))
 );

 if (!hasCompleteSeekerProfile) {
 // User already has a profile in profiles, but lacks Fayda verification or complete onboarding fields:
 // Preserve their existing fields and route only to missing steps or Fayda verification
 const seededDraft = {
 ...myProfile,
 target_id: targetProfile.id,
 target_code: targetProfile.display_code || lookupCode,
 target_locations: targetLocations,
 target_budget: targetBudgetStr,
 lang: reqLang,
 preferred_subcity: (Array.isArray(myProfile.locations) && myProfile.locations.length > 0)
 ? myProfile.locations
 : ['Bole'],
 gender: myProfile.gender,
 my_gender: myProfile.gender,
 age: myProfile.age,
 religion: myProfile.religion,
 job: myProfile.job,
 budget_min: myProfile.budget_min,
 budget_max: myProfile.budget_max,
 preferred_gender: myProfile.preferred_gender,
 roommate_traits: myProfile.roommate_traits,
 };
 await routeNextMissingSeekerStep(chatId, seededDraft);
 return NextResponse.json({ ok: true });
 }

 // Check gender preference match for verified returning user
 const genderCheck = checkGenderPreferenceMatch(
 targetProfile.preferred_gender,
 targetProfile.roommate_traits,
 myProfile.gender
 );

 if (!genderCheck.allowed) {
 const { text: mismatchText, keyboard: mismatchKb } = getGenderMismatchCard(
 reqIsAm,
 targetProfile.display_code || lookupCode,
 genderCheck.targetPrefFormattedEn,
 genderCheck.targetPrefFormattedAm,
 myProfile.gender
 );
 await sendOrEditCard(chatId, mismatchText, mismatchKb);
 return NextResponse.json({ ok: true });
 }

 // Present the Personalized Returning User Card to verified user
 await saveSession({
 telegram_id: chatId,
 step: 'returning_user_review',
 draft_data: {
 target_id: targetProfile.id,
 target_code: targetProfile.display_code || lookupCode,
 target_locations: targetLocations,
 target_budget: targetBudgetStr,
 lang: reqLang,
 },
 updated_at: new Date().toISOString(),
 });

 const myCode = myProfile.display_code || 'Verified Member';
 const myLocations = Array.isArray(myProfile.locations) ? myProfile.locations.join(', ') : 'Addis Ababa';
 const bMin = Number(myProfile.budget_min || 0);
 const bMax = Number(myProfile.budget_max || 10000);
 const myBudgetStr = bMin > 0 ? `${bMin.toLocaleString()} – ${bMax.toLocaleString()} ETB` : `Up to ${bMax.toLocaleString()} ETB`;
 const myGenderStr = reqIsAm ? (myProfile.gender === 'Female' ? 'ሴት' : myProfile.gender === 'Male' ? 'ወንድ' : myProfile.gender || 'አባል') : (myProfile.gender || 'Member');
 const myAgeStr = myProfile.age ? (reqIsAm ? `፣ ${myProfile.age} ዓመት` : `, ${myProfile.age} yrs`) : '';

 const cleanTargetCode = (targetProfile.display_code || lookupCode || '').toUpperCase().replace(/^#/, '');
 const targetAgeConnectStr = targetProfile.age ? ` · Age ${targetProfile.age}` : '';
 const targetRulesConnect = targetProfile.house_rules || extractHouseRulesFromTraits(targetProfile.roommate_traits);
 const targetRulesConnectLine = targetRulesConnect ? `\n• <b>Target House Rules / የቤት ህጎች:</b> ${escapeHtml(String(targetRulesConnect))}` : '';

 const inspectionCard = `<b>Connect with Roommate #${cleanTargetCode} / ከቤት አጋር ጋር ይገናኙ</b>

• <b>Target / ተፈላጊ:</b> #${cleanTargetCode}${escapeHtml(targetAgeConnectStr)} ( <code>${targetLocations}</code>)${targetRulesConnectLine}
• <b>Your Profile / የእርስዎ መገለጫ:</b> #${myCode} (${myProfile.gender || 'Member'} / ${myGenderStr}${myAgeStr})
• <b>Occupation / ስራ:</b> ${escapeHtml(myProfile.job || 'Professional / ሙያተኛ')}
• <b>Religion / ሃይማኖት:</b> ${escapeHtml(myProfile.religion || 'Any / ማንኛውም')}
• <b>Preference / ምርጫ:</b> ${escapeHtml(myProfile.preferred_gender || 'Any')} Roommate / የቤት አጋር
• <b>Your Budget / በጀት:</b> <code>${myBudgetStr}</code>
• <b>Your Areas / አካባቢዎች:</b> <code>${escapeHtml(myLocations)}</code>
 `.trim();

 const mem = await getUserMembershipStatus(chatId);
 if (!mem.isActive) {
 // Enforce Invariant 8: Unpaid returning users must immediately receive the Membership Paywall Card
 await sendMembershipPaywallCard(
 chatId,
 'connect_request',
 {
 targetProfileId: targetProfile.id,
 targetDisplayCode: targetProfile.display_code || lookupCode,
 targetProfile,
 }
 );
 return NextResponse.json({ ok: true });
 }

 // Active Pass Holders: Present returning user preview card with instant free request button
 const reqBtnText = '⚡ Send Free Request (Pass Active) / ጥያቄ ላክ (የሚሰራ)';
 const passBadge = `\n\n• <b>3-Month Pass / አባልነት:</b> Active (${mem.daysRemaining} days remaining) / የሚሰራ (${mem.daysRemaining} ቀናት ቀርተዋል)`;

 await sendOrEditCard(
 chatId,
 inspectionCard + passBadge,
 [
 [
 { text: reqBtnText, callback_data: `confirm_match:${targetProfile.id}` },
 ],
 [
 { text: 'Edit Profile / መረጃ አሻሽል', callback_data: 'post_profile_start' },
 { text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' },
 ],
 ]
 );
 return NextResponse.json({ ok: true });
 }
 // ── END deep-link handler ─────────────────────────────────────────────

 // Channel Button 2: Post profile to channel
 if (
 text === '/start post_profile' ||
 text.startsWith('/start post_profile') ||
 text === '/start post_to_channel' ||
 text.startsWith('/start post_to_channel')
 ) {
 await sendPostProfileBranchPrompt(chatId);
 return NextResponse.json({ ok: true });
 }

 // Channel Button 3: Search Roommate for me
 if (
 text === '/start search_roommate' ||
 text.startsWith('/start search_roommate') ||
 text === '/start match' ||
 text === '/start find'
 ) {
 await sendMatchmakerSubcityStep(chatId, { mode: 'search_roommate' });
 return NextResponse.json({ ok: true });
 }

 // DIRECT POST CLICK FROM CHANNEL: Unlock Seeker Contact
 if (text.startsWith('/start unlock_seeker_')) {
 const profileId = text.replace('/start unlock_seeker_', '').trim();
 await sendUnlockPaywallCard(chatId, profileId, 'roommate_profile');
 return NextResponse.json({ ok: true });
 }

 // DIRECT POST CLICK FROM CHANNEL: Order / Unlock Space Listing
 if (text.startsWith('/start order_seeker_')) {
 const profileId = text.replace('/start order_seeker_', '').trim();
 await sendUnlockPaywallCard(chatId, profileId, 'roommate_profile');
 return NextResponse.json({ ok: true });
 }

 if (text.startsWith('/start order_')) {
 const spaceId = text.replace('/start order_', '').trim();
 await sendUnlockPaywallCard(chatId, spaceId, 'space_listing');
 return NextResponse.json({ ok: true });
 }

 if (text === '/start seeker_flow' || text === '/start seeker') {
 await sendPostProfileBranchPrompt(chatId);
 return NextResponse.json({ ok: true });
 }

 if (text === '/start property_type') {
 await sendHaveRoomAdminDirectCard(chatId);
 return NextResponse.json({ ok: true });
 }

 if (text === '/start verify_fayda' || text === '/start fayda') {
 const isVerified = await isUserFaydaVerified(chatId);
 if (isVerified) {
 await sendVerifiedFaydaDossierCard(chatId, getUserLanguage(chatId));
 } else {
 await sendFaydaGateCard(chatId, 'verify your National ID to unlock all SpaceMatch features');
 }
 return NextResponse.json({ ok: true });
 }

 if (text === '/start my_orders') {
 await sendMyListingsScreen(chatId);
 return NextResponse.json({ ok: true });
 }

 if (text.startsWith('/start pay_')) {
 const mem = await getUserMembershipStatus(chatId);
 if (mem.isActive) {
 await tgSend(chatId, `<b>Your 3-Month Pass is Already Active! / የ3 ወር አባልነትዎ ቀድሞውኑ ክፍት ነው!</b>\n\n<blockquote>Days remaining: <b>${mem.daysRemaining}</b></blockquote>`, {
 inline_keyboard: [
 [{ text: 'Search Roommate / የቤት አጋር ፈልግ >', callback_data: 'search_roommate_start' }],
 [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ],
 });
 } else {
 await sendMembershipPaywallCard(chatId, 'connect_request', { generalPass: true });
 }
 return NextResponse.json({ ok: true });
 }

 // Check for pending listing connection from channel
 const { data: existingProfile } = await supabaseAdmin
 .from('profiles')
 .select('status, gender, pending_req_code')
 .eq('telegram_id', chatId)
 .maybeSingle();

 // If they had a pending req from channel button click, resume it
 if (
 existingProfile?.pending_req_code &&
 (existingProfile.status === 'active' || existingProfile.status === 'matched')
 ) {
 const pendingCode = existingProfile.pending_req_code;
 await supabaseAdmin
 .from('profiles')
 .update({ pending_req_code: null })
 .eq('telegram_id', chatId);

 // Redirect them to the original listing
 const { data: targetProfile } = await supabaseAdmin
 .from('profiles')
 .select('*')
 .ilike('display_code', pendingCode)
 .maybeSingle();

 if (
 targetProfile &&
 !['matched', 'closed', 'archived'].includes(String(targetProfile.status || '').toLowerCase()) &&
 String(targetProfile.telegram_id) !== String(chatId)
 ) {
 if (existingProfile.gender) {
 const gCheck = checkGenderPreferenceMatch(targetProfile.preferred_gender, targetProfile.roommate_traits, existingProfile.gender);
 if (!gCheck.allowed) {
 const reqIsAm = getUserLanguage(chatId) === 'am';
 const { text: mismatchText, keyboard: mismatchKb } = getGenderMismatchCard(reqIsAm, targetProfile.display_code || pendingCode, gCheck.targetPrefFormattedEn, gCheck.targetPrefFormattedAm, existingProfile.gender);
 await sendOrEditCard(chatId, mismatchText, mismatchKb);
 return NextResponse.json({ ok: true });
 }
 }

 const targetLocations = Array.isArray(targetProfile.locations)
 ? targetProfile.locations.join(', ')
 : 'Addis Ababa';

 const mem = await getUserMembershipStatus(chatId);
 if (!mem.isActive) {
 await sendMembershipPaywallCard(
 chatId,
 'connect_request',
 {
 targetProfileId: targetProfile.id,
 targetDisplayCode: targetProfile.display_code || pendingCode,
 targetProfile,
 }
 );
 return NextResponse.json({ ok: true });
 }

 await tgSend(
 chatId,
 `<b>Profile ready!</b> Here is the listing you wanted to connect with:\n\n<b>Roommate #${escapeHtml(targetProfile.display_code || pendingCode)}</b>\n ${escapeHtml(targetLocations)}\n ${Number(targetProfile.budget_min || 0).toLocaleString()} – ${Number(targetProfile.budget_max || 0).toLocaleString()} ETB/month`,
 {
 inline_keyboard: [
 [
 { text: '⚡ Send Match Request / ጥያቄ ላክ', callback_data: `confirm_match:${targetProfile.id}` },
 { text: 'Cancel / ሰርዝ', callback_data: 'nav_start' },
 ],
 ],
 }
 );
 return NextResponse.json({ ok: true });
 }
 }

 // Direct start without deep-link parameters:
 await sendPrimaryWelcomeMenu(chatId, undefined, message.from);
 return NextResponse.json({ ok: true });
 }

 // Search Roommate Commands (Admins typing /find reach admin lookup below)
 if (text === '/search_roommate' || text === '/match' || text === '/roommate' || (text === '/find' && !(await getAdminIds()).includes(chatId))) {
 await clearSession(chatId);
 await sendMatchmakerSubcityStep(chatId, { mode: 'search_roommate' });
 return NextResponse.json({ ok: true });
 }

 // Post Profile Commands
 if (text === '/post_profile' || text === '/seeker' || text === '/post_to_channel') {
 await clearSession(chatId);
 await sendPostProfileBranchPrompt(chatId);
 return NextResponse.json({ ok: true });
 }

 if (text === '/property_type' || (text === '/post' && !(await getAdminIds()).includes(chatId))) {
 await sendHaveRoomAdminDirectCard(chatId);
 return NextResponse.json({ ok: true });
 }

 if (text === '/my_listings' || text === '/my_posts' || text === '/status') {
 await clearSession(chatId);
 await sendMyListingsScreen(chatId);
 return NextResponse.json({ ok: true });
 }

 const isBareVerifyOrFayda =
 text === '/verify' ||
 text === '/fayda' ||
 text === '/verify_fayda' ||
 text.startsWith('/verify@') ||
 text.startsWith('/fayda@') ||
 text.startsWith('/verify_fayda@');

 if (isBareVerifyOrFayda) {
 const isVerified = await isUserFaydaVerified(chatId);
 if (isVerified) {
 const session = getSession(chatId);
 const lang = getLanguage(session.draft_data, chatId);
 await sendVerifiedFaydaDossierCard(chatId, lang);
 return NextResponse.json({ ok: true });
 }

 await clearSession(chatId);
 await sendFaydaGateCard(chatId, 'access all SpaceMatch verified features');
 return NextResponse.json({ ok: true });
 }

 // ── NEW: /verify <bank> <reference> — 3-Month Unified Membership Pass ──
 // Pattern: /verify telebirr FT260920042 OR /verify cbe FT... OR /verify FT...
 if (text.startsWith('/verify ') && text.trim().length > 8) {
 const parts = text.trim().split(/\s+/);
 const validBanks = ['telebirr', 'abyssinia', 'boa', 'dashen', 'cbe'];
 let bank: string | undefined;
 let rawRef: string;

 if (validBanks.includes(parts[1]?.toLowerCase())) {
 bank = parts[1].toLowerCase();
 rawRef = parts.slice(2).join(' ');
 } else {
 // If bank was omitted (e.g. /verify FT260920042)
 rawRef = parts.slice(1).join(' ');
 if (rawRef.toLowerCase().includes('cbe.com.et')) {
 bank = 'cbe';
 }
 }

 const extractedRef = extractTransactionReference(rawRef);
 const reference = extractedRef ? normalizeCanonicalTransactionRef(extractedRef) : '';
 const payerLang = getUserLanguage(chatId);
 const payerIsAm = payerLang === 'am';

 if (!reference) {
 await tgSend(
 chatId,
 payerIsAm
 ? `<b>የተሳሳተ አጻጻፍ።</b>\n\nአጠቃቀም:\n<code>/verify telebirr የደረሰኝ_ቁጥር</code>\n<code>/verify cbe የደረሰኝ_ቁጥር</code>\n<code>/verify abyssinia የደረሰኝ_ቁጥር</code>\n<code>/verify dashen የደረሰኝ_ቁጥር</code>\n\n<blockquote>ምሳሌ: <code>/verify cbe FT260920042</code></blockquote>`
 : `<b>Invalid format.</b>\n\nUsage:\n<code>/verify telebirr YOUR_REF</code>\n<code>/verify cbe YOUR_REF</code>\n<code>/verify abyssinia YOUR_REF</code>\n<code>/verify dashen YOUR_REF</code>\n\n<blockquote>Example: <code>/verify cbe FT260920042</code></blockquote>`
 );
 return NextResponse.json({ ok: true });
 }

 const verifyLockKey = `tx_pay:${reference}`;
 if (!(await acquireActionLock(verifyLockKey, 20000))) {
 await tgSend(
 chatId,
 payerIsAm
 ? `<b>ይህ የግብይት ቁጥር አሁን በመረጋገጥ ላይ ነው።</b> እባክዎ ትንሽ ይጠብቁ።`
 : `<b>This transaction reference is currently being verified.</b> Please wait a moment.`
 );
 return NextResponse.json({ ok: true });
 }

 try {
 const escapedRef = reference.replace(/[%_\\]/g, '\\$&');
 // 1. Check if reference already used in orders (case-insensitive)
 const { data: existingOrder } = await supabaseAdmin
 .from('orders')
 .select('id')
 .ilike('transaction_reference', escapedRef)
 .eq('payment_status', 'completed')
 .limit(1)
 .maybeSingle();

 if (existingOrder) {
 await tgSend(
 chatId,
 payerIsAm
 ? `<b>ይህ የደረሰኝ ቁጥር አስቀድሞ ጥቅም ላይ ውሏል</b>\n\nይህ የግብይት ደረሰኝ ቁጥር ቀደም ሲል ተመዝግቧል። እባክዎ ትክክለኛውን የደረሰኝ ቁጥር ያስገቡ።`
 : `<b>Reference Already Used</b>\n\nThis transaction reference has already been submitted. Please use a different reference number.`
 );
 return NextResponse.json({ ok: true });
 }

 // 2. Sending indicator
 await tgSend(
 chatId,
 payerIsAm
 ? `<b>ክፍያዎ በ Verify.ET እየተረጋገጠ ነው...</b>`
 : `<b>Verifying payment with Verify.ET...</b>`
 );

 // 3. Call Verify.ET with 100 ETB, prioritizing selected bank
 const verifyResult = await verifyTelebirrPayment(reference, 100, bank);

 if (!verifyResult.success || (verifyResult.paidAmount ?? 0) < 100) {
 const failMsg = !verifyResult.success
 ? (payerIsAm ? (verifyResult.messageAm || verifyResult.message) : verifyResult.message)
 : (payerIsAm
 ? `የተከፈለው መጠን (${Number(verifyResult.paidAmount ?? 0).toFixed(2)} ETB) ከሚያስፈልገው 100 ETB ያነሰ ነው።`
 : `Paid amount (${Number(verifyResult.paidAmount ?? 0).toFixed(2)} ETB) is less than the required 100 ETB.`);
 await tgSend(
 chatId,
 payerIsAm
 ? `<b>ክፍያው አልተረጋገጠም</b>\n\n${failMsg}\n\nእባክዎ የደረሰኝ ቁጥርዎን ደግመው ያረጋግጡና እንደገና ይሞክሩ።`
 : `<b>Verification Failed</b>\n\n${failMsg}\n\nPlease double-check your reference number and try again.`
 );
 return NextResponse.json({ ok: true });
 }

 // 4. Record order (fail closed on replay or DB error)
 let orderId = `ord_mem_${Date.now()}`;
 try {
 await supabaseAdmin.from('users').upsert({
 telegram_id: chatId,
 first_name: update.message?.from?.first_name || 'Member',
 last_name: update.message?.from?.last_name || null,
 username: update.message?.from?.username || null,
 updated_at: new Date().toISOString(),
 }, { onConflict: 'telegram_id' });

 const { data: newOrder, error: orderInsertErr } = await supabaseAdmin
 .from('orders')
 .insert({
 buyer_telegram_id: chatId,
 renter_telegram_id: chatId,
 order_type: 'membership_pass',
 target_type: 'membership_90d',
 target_id: 'pass_90d',
 amount: verifyResult.paidAmount ?? 100.0,
 transaction_reference: reference,
 payment_status: 'completed',
 verified_at: new Date().toISOString(),
 })
 .select('id')
 .single();

 if (orderInsertErr || !newOrder?.id) {
 const isDuplicate = orderInsertErr?.code === '23505' || /duplicate|unique/i.test(orderInsertErr?.message || '');
 await tgSend(
 chatId,
 isDuplicate
 ? `<b>Reference Already Used / ይህ የደረሰኝ ቁጥር ቀደም ሲል ጥቅም ላይ ውሏል</b>\n\n<blockquote>This transaction reference has already been redeemed.\nይህ የግብይት ቁጥር ቀደም ሲል ተመዝግቧል።</blockquote>`
 : `<b>Could Not Record Order / ክፍያውን መመዝገብ አልተቻለም</b>\n\n<blockquote>Please try again in a moment or contact @WWEHID.\nእባክዎ ትንሽ ቆይተው ይሞክሩ ወይም @WWEHID ያነጋግሩ።</blockquote>`
 );
 return NextResponse.json({ ok: true });
 }
 orderId = newOrder.id;
 } catch (err) {
 console.error('[webhook] Error saving membership order in /verify:', err);
 await tgSend(
 chatId,
 `<b>Could Not Record Order / ክፍያውን መመዝገብ አልተቻለም</b>\n\n<blockquote>Please try again in a moment.\nእባክዎ ትንሽ ቆይተው እንደገና ይሞክሩ።</blockquote>`
 );
 return NextResponse.json({ ok: true });
 }

 // 5. Activate 3-Month Unified Membership Pass
 await activateUserMembership(chatId, orderId, reference);

 // 6. Check if there's an accepted pending_payment match ready to unlock
 let activeMatch: any = null;
 try {
 const { data: myProf } = await supabaseAdmin
 .from('profiles')
 .select('id')
 .eq('telegram_id', chatId)
 .maybeSingle();
 if (myProf?.id) {
 const { data: matchRows } = await supabaseAdmin
 .from('matches')
 .select('*, requester:requester_id(id, telegram_id, display_code, full_name, phone_number, telegram_username), target:target_id(id, telegram_id, display_code, full_name, phone_number, telegram_username, channel_message_id)')
 .eq('status', 'pending_payment')
 .or(`requester_id.eq.${myProf.id},target_id.eq.${myProf.id}`)
 .order('created_at', { ascending: false })
 .limit(5);

 if (matchRows) {
 activeMatch = matchRows.find(
 (m: any) =>
 Number(m.requester?.telegram_id) === chatId ||
 Number(m.target?.telegram_id) === chatId
 );
 }
 }
 } catch {}

 if (activeMatch) {
 await revealMutualMatchContacts(activeMatch.id);
 }

 const verifiedBank = (verifyResult.bank || bank || 'telebirr').toUpperCase();
 const bankFormatted = verifiedBank === 'TELEBIRR' ? 'Telebirr (ቴሌብር)' : verifiedBank === 'CBE' ? 'CBE (ንግድ ባንክ)' : verifiedBank === 'BOA' ? 'Bank of Abyssinia (አቢሲንያ)' : verifiedBank === 'DASHEN' ? 'Dashen Bank (ዳሽን ባንክ)' : verifiedBank;
 const paidAmt = Number(verifyResult.paidAmount ?? 100);
 const payerName = verifyResult.senderName || 'Verified Payer';

 const celebText = `✅ <b>Payment Successfully Verified! / ክፍያዎ በተሳካ ሁኔታ ተረጋግጧል!</b>

<blockquote>• <b>Bank / ባንክ:</b> <code>${bankFormatted}</code>
• <b>Amount Paid / የተከፈለ መጠን:</b> <code>${paidAmt.toFixed(2)} ETB</code>
• <b>Payer Name / የከፋይ ስም:</b> <code>${escapeHtml(payerName)}</code>
• <b>Transaction Ref / የግብይት ቁጥር:</b> <code>${escapeHtml(reference)}</code>
• <b>Pass Status / የአባልነት ሁኔታ:</b> <b>Active (90 Days) / የሚሰራ (90 ቀናት)</b></blockquote>

🎉 <b>Congratulations! Your 3-Month All-Access Pass is Active! / እንኳን ደስ አላችሁ! የ3 ወር ሙሉ አባልነት ፓስዎ ተከፍቷል!</b>
<blockquote>You now have unlimited channel posting and unlimited connect requests across SpaceMatch Addis with zero per-contact fees!
አሁን ማስታወቂያዎችን ወደ ቻናሉ መለጠፍ እና ያለምንም ተጨማሪ ክፍያ ለፈለጉት ክፍል ጓደኛ የግንኙነት ጥያቄ መላክ ይችላሉ!</blockquote>`.trim();

 await tgSend(chatId, celebText);

 // 7. Check if session has pending membership or payment unlock flow
 if (session.step && (session.step.startsWith('awaiting_payment_for_membership:') || session.step === 'payment_input_ref' || session.step.startsWith('awaiting_payment_for_unlock:'))) {
 const purpose = session.draft_data?.membership_purpose;
 const metadata = session.draft_data?.membership_metadata || {};

 const isFaydaVerified = await isUserFaydaVerified(chatId);
 if (!isFaydaVerified) {
 await saveSession({
 telegram_id: chatId,
 step: 'awaiting_standalone_fayda_fan',
 draft_data: {
 ...session.draft_data,
 membership_purpose: purpose,
 membership_metadata: metadata,
 },
 updated_at: new Date().toISOString(),
 });
 const nextStepNotice = `🛡️ <b>Next Step: Quick Identity Verification / ቀጣይ ደረጃ፡ የፋይዳ ማንነት ማረጋገጫ</b>\n\n<blockquote>Your 3-Month Membership Pass is active! To protect our community and ensure all roommate profiles are genuine and broker-free, please complete a 10-second identity verification with your Ethiopian National Fayda ID card.\n\nክፍያዎ ተረጋግጧል! ማህበረሰባችንን ከአጭበርባሪዎች እና ካልተፈቀዱ ደላሎች ለመጠበቅ፣ በፋይዳ ብሔራዊ መታወቂያ ካርድዎ ፈጣን የማንነት ማረጋገጫ ያድርጉ።</blockquote>`;
 await tgSend(chatId, nextStepNotice);
 await sendFaydaGateCard(chatId, 'complete your profile and unlock all verified features');
 return NextResponse.json({ ok: true });
 }

 if (purpose === 'post_channel') {
 if (metadata.category === 'space_available' || metadata.isSpace) {
 await submitSpaceListingToAdmin(chatId, metadata);
 } else {
 await submitSeekerListingToAdmin(chatId, metadata);
 }
 await clearSession(chatId);
 } else if (purpose === 'connect_request') {
 await clearSession(chatId);
 const targetId = metadata.targetProfileId || metadata.target_id;
 if (targetId) {
 await executeDirectMatchRequest(chatId, targetId);
 }
 } else {
 await clearSession(chatId);
 }
 return NextResponse.json({ ok: true });
 }

 if (!activeMatch) {
 await tgSend(chatId, `<b>What would you like to do next? / ምን ማድረግ ይፈልጋሉ?</b>`, {
 inline_keyboard: [
 [{ text: 'Search Roommate for Me / የቤት አጋር ፈልግልኝ >', callback_data: 'search_roommate_start' }],
 [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ],
 });
 }

 return NextResponse.json({ ok: true });
 } finally {
 await releaseActionLock(verifyLockKey);
 }
 }

 // ── SpaceMatch Admin Commands ──────────────────────────────────────────
 if (text === '/admin') {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Access Denied / ፈቃድ የለም</b>\n\nYou are not authorized to view admin controls.`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 let pendingCount = 0;
 try {
 const { count } = await supabaseAdmin
 .from('profiles')
 .select('id', { count: 'exact', head: true })
 .eq('status', 'paused')
 .eq('onboarding_step', 'pending_approval');
 pendingCount = count || 0;
 } catch {}

 const adminWebToken = signAdminToken(chatId, 3600);
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>SpaceMatch Admin Controls / የአድሚን ፓነል</b>\n\nSelect an action below or use admin commands:\n• <code>/user &lt;name&gt;</code> - Search resident & Fayda dossier\n• <code>/find &lt;code&gt;</code> - Search post by code (#SPMARBR...)\n• <code>/post</code> - Launch channel posting wizard\n• <code>/close &lt;code&gt;</code> - Close matched listing\n• <code>/admins</code> - View and manage administrator team`,
 parse_mode: 'HTML',
 reply_markup: {
 inline_keyboard: [
 [{ text: 'Open Web Admin Portal 🌐 / ድረ-ገጽ አድሚን ክፈት', url: `${appUrl}/admin?auth_token=${encodeURIComponent(adminWebToken)}` }],
 [{ text: 'Search User by Name (Fayda Dossier) >', callback_data: 'admin_search_user_prompt' }],
 [{ text: 'Search Post by Code (#SPMARBR...) ', callback_data: 'admin_search_code_prompt' }],
 [{ text: `Pending Channel Approvals (${pendingCount})`, callback_data: 'admin_list_pending' }],
 [{ text: 'Post to Channel as Admin >', callback_data: 'admin_post_start' }],
 [{ text: 'Connected Channels & Settings', callback_data: 'admin_list_channels' }],
 [{ text: 'Add Admin by Username >', callback_data: 'admin_add_prompt' }],
 [{ text: 'View Administrators', callback_data: 'admin_list_team' }],
 [{ text: 'Open Channel Posts & Close / ክፍት ማስታወቂያዎችና መዝጊያ', callback_data: 'admin_list_active_posts' }],
 [{ text: 'Exit Admin Menu', callback_data: 'admin_cancel' }],
 ],
 },
 });
 return NextResponse.json({ ok: true });
 }

 // ── Admin: Search User by Name command (/user, /search_user, /fayda_search, /fayda_user) ────────
 if (
 text === '/user' || text.startsWith('/user ') ||
 text === '/search_user' || text.startsWith('/search_user ') ||
 text === '/fayda_search' || text.startsWith('/fayda_search ') ||
 text === '/fayda_user' || text.startsWith('/fayda_user ') ||
 text === '/resident' || text.startsWith('/resident ')
 ) {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Access Denied.</b> User search is restricted to SpaceMatch administrators.`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 const query = text.replace(/^\/(user|search_user|fayda_search|fayda_user|resident)/i, '').trim();
 if (!query) {
 await saveSession({
 telegram_id: chatId,
 step: 'admin_search_user_input',
 draft_data: {},
 updated_at: new Date().toISOString(),
 });
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Search Resident & Fayda Record</b>\n\nPlease enter the resident's full name, first name, @username, or 16-digit Fayda FAN number:`,
 parse_mode: 'HTML',
 reply_markup: {
 inline_keyboard: [
 [{ text: 'Back to Admin Menu', callback_data: 'admin_menu' }],
 ],
 },
 });
 return NextResponse.json({ ok: true });
 }

 await executeAdminUserSearch(chatId, query);
 return NextResponse.json({ ok: true });
 }

 // ── Admin / User Search command (/find, /search, /lookup) ────────
 if (
 text === '/find' || text.startsWith('/find ') ||
 text === '/search' || text.startsWith('/search ') ||
 text === '/lookup' || text.startsWith('/lookup ')
 ) {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 if (text === '/search') {
 await clearSession(chatId);
 await sendMatchmakerSubcityStep(chatId, { mode: 'search_roommate' });
 return NextResponse.json({ ok: true });
 }
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Access Denied.</b> Admin post lookup is restricted to SpaceMatch administrators.`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 const query = text.replace(/^\/(find|search|lookup)/i, '').trim();
 if (!query) {
 await saveSession({
 telegram_id: chatId,
 step: 'admin_search_code_input',
 draft_data: {},
 updated_at: new Date().toISOString(),
 });
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Search Post by Code</b>\n\nPlease enter the listing code (e.g. <code>SPMARBR5</code>, <code>SPMARWR1</code>, or <code>5</code>):`,
 parse_mode: 'HTML',
 reply_markup: {
 inline_keyboard: [
 [{ text: 'Back to Admin Menu', callback_data: 'admin_menu' }],
 ],
 },
 });
 return NextResponse.json({ ok: true });
 }

 await executeAdminPostSearch(chatId, query);
 return NextResponse.json({ ok: true });
 }

 // ── Admin / User Direct Post Code Lookup (#SPMARBR... / #SPMARWR...) ───
 if (/^#?(spmarbr|spmarwr)\d+/i.test(text.trim())) {
 const cleanQuery = text.trim().replace(/^#/, '');
 const adminIds = await getAdminIds();
 if (adminIds.includes(chatId)) {
 await executeAdminPostSearch(chatId, cleanQuery);
 return NextResponse.json({ ok: true });
 }
 }

 if (text === '/post' || text === '/admin_post') {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Access Denied.</b> Only SpaceMatch administrators can post directly to the channel.`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }
 await clearSession(chatId);
 await sendAdminPostCategoryStep(chatId);
 return NextResponse.json({ ok: true });
 }

 if (text === '/close' || text.startsWith('/close ')) {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Access Denied.</b> Only SpaceMatch administrators can mark channel posts as closed.`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 const query = text.replace('/close', '').trim();
 if (!query) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>SpaceMatch Admin · Close Channel Post</b>
<b>Usage:</b> <code>/close &lt;code_or_message_id_or_link&gt;</code>
<b>Examples:</b>
• <code>/close RM205</code>
• <code>/close 1542</code>
• <code>/close https://t.me/roommatch_addis/1542</code>

 Or simply forward any channel post directly to this bot to close it!
 `.trim(),
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 const res = await executeChannelPostClose(query, chatId);
 const targetChannel = await getPrimaryChannel();
 const postLink = buildChannelPostUrl(targetChannel, res.messageId);

 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `${res.success ? '' : ' >'} <b>Listing #${res.displayCode || query}</b>\n\n${res.message}`,
 parse_mode: 'HTML',
 reply_markup: {
 inline_keyboard: [
 ...(postLink ? [[{ text: 'View Channel Post >', url: postLink }]] : []),
 [{ text: 'Post Another Listing', callback_data: 'admin_post_start' }],
 [{ text: 'Main Menu', callback_data: 'nav_start' }],
 ],
 },
 });
 return NextResponse.json({ ok: true });
 }

 if (text === '/admins') {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Access Denied.</b> Admin list is restricted to SpaceMatch administrators.`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 // Fetch DB admins with their usernames/names
 let dbAdminList: any[] = [];
 try {
 const { data } = await supabaseAdmin
 .from('users')
 .select('telegram_id, first_name, last_name, username')
 .eq('role', 'admin');
 if (data) dbAdminList = data;
 } catch {}

 let msg = `<b>SpaceMatch Administrators (${adminIds.length} Total)</b>\n\n`;
 msg += `<b>Super Administrators:</b>\n`;
 msg += `• Biruk (@birukadiyee · <code>800701176</code>)\n`;
 msg += `• Wahid (@WWEHID · <code>148318506</code>)\n\n`;

 if (dbAdminList.length > 0) {
 msg += `<b>Database Administrators:</b>\n`;
 for (const a of dbAdminList) {
 const name = [a.first_name, a.last_name].filter(Boolean).join(' ') || 'Admin';
 const handle = a.username ? `@${a.username}` : `<code>${a.telegram_id}</code>`;
 msg += `• ${name} (${handle})\n`;
 }
 msg += '\n';
 }

 msg += `<b>Channel Administrators:</b>\n`;
 msg += `• Automatically synced from <code>@roommate_addis</code> channel administrators.\n\n`;
 msg += `<b>Commands:</b>\n`;
 msg += `• <code>/add_admin &lt;telegram_id_or_username&gt;</code>\n`;
 msg += `• <code>/remove_admin &lt;telegram_id_or_username&gt;</code>\n`;
 msg += `• <code>/post</code> - Launch channel posting wizard\n`;
 msg += `• <code>/close &lt;code&gt;</code> - Mark channel post as closed\n`;

 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: msg.trim(),
 parse_mode: 'HTML',
 reply_markup: {
 inline_keyboard: [
 [{ text: 'Add Admin by Username >', callback_data: 'admin_add_prompt' }],
 [{ text: 'Post to Channel as Admin >', callback_data: 'admin_post_start' }],
 [{ text: 'Main Menu', callback_data: 'nav_start' }],
 ],
 },
 });
 return NextResponse.json({ ok: true });
 }

 if (text === '/add_admin' || text.startsWith('/add_admin ')) {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Access Denied.</b> Only SpaceMatch administrators can promote other admins.`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 const query = text.replace('/add_admin', '').trim();
 if (!query) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>SpaceMatch Admin · Add Administrator</b>
<b>Usage:</b> <code>/add_admin &lt;telegram_id_or_username&gt;</code>
<b>Examples:</b>
• <code>/add_admin 987654321</code>
• <code>/add_admin @username</code>
 `.trim(),
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 const cleanQuery = query.replace('@', '').trim();
 const isNumeric = /^\d+$/.test(cleanQuery);

 let userRecord: any = null;
 if (isNumeric) {
 const { data } = await supabaseAdmin.from('users').select('*').eq('telegram_id', Number(cleanQuery)).maybeSingle();
 userRecord = data;
 } else {
 const { data } = await supabaseAdmin.from('users').select('*').ilike('username', cleanQuery).maybeSingle();
 userRecord = data;
 if (!userRecord) {
 const { data: prof } = await supabaseAdmin.from('profiles').select('*').ilike('telegram_username', cleanQuery).maybeSingle();
 if (prof?.telegram_id) {
 const { data: upsertedUser } = await supabaseAdmin
 .from('users')
 .upsert({
 telegram_id: prof.telegram_id,
 first_name: prof.full_name || cleanQuery,
 username: cleanQuery,
 role: 'admin',
 updated_at: new Date().toISOString(),
 }, { onConflict: 'telegram_id' })
 .select('*')
 .single();
 userRecord = upsertedUser;
 }
 }
 }

 if (!userRecord) {
 if (isNumeric) {
 const { data: newUser } = await supabaseAdmin
 .from('users')
 .upsert({
 telegram_id: Number(cleanQuery),
 first_name: `Admin ${cleanQuery}`,
 role: 'admin',
 updated_at: new Date().toISOString(),
 }, { onConflict: 'telegram_id' })
 .select('*')
 .single();
 userRecord = newUser;
 } else {
 // Register username into persistent admin registry
 await registerAdminUsername(cleanQuery);
 invalidateAdminCache();

 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>@${cleanQuery}</b> has been successfully registered as a SpaceMatch Administrator! \n\nFull administrative permissions have been granted. They can now use <code>/admin</code>, <code>/post</code>, and <code>/close</code> as soon as they open the bot.`,
 parse_mode: 'HTML',
 reply_markup: {
 inline_keyboard: [
 [{ text: 'View Administrators', callback_data: 'admin_list_team' }],
 [{ text: 'Main Menu', callback_data: 'nav_start' }],
 ],
 },
 });
 return NextResponse.json({ ok: true });
 }
 } else {
 await supabaseAdmin
 .from('users')
 .update({ role: 'admin', updated_at: new Date().toISOString() })
 .eq('id', userRecord.id);
 }

 if (!isNumeric) {
 await registerAdminUsername(cleanQuery);
 }

 // Invalidate admin cache
 invalidateAdminCache();

 const displayName = [userRecord.first_name, userRecord.last_name].filter(Boolean).join(' ') || (userRecord.username ? `@${userRecord.username}` : `ID ${userRecord.telegram_id}`);

 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>${displayName}</b> has been successfully promoted to SpaceMatch Administrator! \n\nThey now have access to <code>/post</code> and <code>/close</code>.`,
 parse_mode: 'HTML',
 });

 if (userRecord.telegram_id && Number(userRecord.telegram_id) !== chatId) {
 await sendTelegram('sendMessage', {
 chat_id: Number(userRecord.telegram_id),
 text: `<b>You have been appointed as a SpaceMatch Administrator!</b>\n\nYou now have administrative privileges to post listings directly to the channel and manage/close listings:\n\n• <code>/post</code> - Launch channel posting wizard\n• <code>/close &lt;code&gt;</code> - Close matched listings\n• <code>/admins</code> - View administrator team`,
 parse_mode: 'HTML',
 reply_markup: {
 inline_keyboard: [
 [{ text: 'Post to Channel as Admin >', callback_data: 'admin_post_start' }],
 [{ text: 'Main Menu', callback_data: 'nav_start' }],
 ],
 },
 });
 }

 return NextResponse.json({ ok: true });
 }

 if (text === '/remove_admin' || text.startsWith('/remove_admin ')) {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Access Denied.</b> Only SpaceMatch administrators can manage admins.`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 const query = text.replace('/remove_admin', '').trim();
 if (!query) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>SpaceMatch Admin · Remove Administrator</b>
<b>Usage:</b> <code>/remove_admin &lt;telegram_id_or_username&gt;</code>
<b>Examples:</b>
• <code>/remove_admin 987654321</code>
• <code>/remove_admin @username</code>
 `.trim(),
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 const cleanQuery = query.replace('@', '').trim();
 const isNumeric = /^\d+$/.test(cleanQuery);
 const superAdminIds = [800701176, 148318506];

 if (isNumeric && superAdminIds.includes(Number(cleanQuery))) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Action Blocked:</b> Super administrators cannot be removed.`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 let userRecord: any = null;
 if (isNumeric) {
 const { data } = await supabaseAdmin.from('users').select('*').eq('telegram_id', Number(cleanQuery)).maybeSingle();
 userRecord = data;
 } else {
 const { data } = await supabaseAdmin.from('users').select('*').ilike('username', cleanQuery).maybeSingle();
 userRecord = data;
 }

 if (!userRecord) {
 await removePendingAdminUsername(cleanQuery);
 invalidateAdminCache();
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `User <b>${escapeHtml(query)}</b> was removed from pending admin list (not yet registered in database).`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 if (superAdminIds.includes(Number(userRecord.telegram_id))) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Action Blocked:</b> Super administrators cannot be removed.`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 await supabaseAdmin
 .from('users')
 .update({ role: 'renter', updated_at: new Date().toISOString() })
 .eq('id', userRecord.id);

 await removePendingAdminUsername(userRecord.username || cleanQuery);

 // Invalidate admin cache
 invalidateAdminCache();

 const displayName = [userRecord.first_name, userRecord.last_name].filter(Boolean).join(' ') || (userRecord.username ? `@${userRecord.username}` : `ID ${userRecord.telegram_id}`);

 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>${escapeHtml(displayName)}</b> has been removed from SpaceMatch Administrators.`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 // ── SpaceMatch Channel Management Commands ─────────────────────────────
 if (text === '/channels') {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Access Denied.</b> Channel list is restricted to SpaceMatch administrators.`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 const channels = await getManagedChannels();
 let channelsMsg = `<b>Connected Channels (${channels.length}) / የተገናኙ ቻናሎች</b>\n\n`;
 if (channels.length === 0) {
 channelsMsg += `No external channels connected yet. The bot uses the default channel (@roommate_addis).\n\nTo connect any channel, add this bot as an administrator to the channel, or run:\n<code>/setchannel @your_channel</code>`;
 } else {
 for (let i = 0; i < channels.length; i++) {
 const ch = channels[i];
 const statusIcon = ch.is_active ? '' : '';
 channelsMsg += `${i + 1}. ${statusIcon} <b>${ch.channel_title}</b>\n`;
 channelsMsg += ` • ID: <code>${ch.channel_id}</code>\n`;
 if (ch.channel_username) channelsMsg += ` • Username: <b>${ch.channel_username}</b>\n`;
 channelsMsg += ` • Status / ሁኔታ: ${ch.is_active ? 'Active / የሚሰራ' : ' Inactive / የማይሰራ'}\n\n`;
 }
 channelsMsg += ` To connect a new channel, add @${botUsername} as an administrator to your channel, or run <code>/setchannel @channel</code>.`;
 }

 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: channelsMsg,
 parse_mode: 'HTML',
 reply_markup: {
 inline_keyboard: [
 [{ text: 'Admin Menu / አድሚን ማውጫ', callback_data: 'admin_menu' }],
 [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ],
 },
 });
 return NextResponse.json({ ok: true });
 }

 if (text === '/setchannel' || text.startsWith('/setchannel ')) {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Access Denied.</b> Only SpaceMatch administrators can configure channels.`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 const channelInput = text.replace('/setchannel', '').trim();
 if (!channelInput) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>SpaceMatch Admin · Connect Channel</b>
<b>Usage:</b> <code>/setchannel &lt;@channel_username_or_channel_id&gt;</code>
<b>Examples:</b>
• <code>/setchannel @addis_roommates</code>
• <code>/setchannel -1001234567890</code>
<b>Instructions:</b>
1. Add @${botUsername} as an administrator in your channel with Post Messages & Edit Messages permissions.
2. Send <code>/setchannel @your_channel</code> here.
 `.trim(),
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 // Test if the bot is indeed an admin in that channel
 try {
 const res = await fetch(`https://api.telegram.org/bot${botToken}/getChatAdministrators`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ chat_id: channelInput }),
 });
 const json = await res.json();

 if (!json.ok) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Could not access channel:</b> <code>${channelInput}</code>\n\nTelegram response: ${json.description || 'Channel not found or bot is not an admin'}\n\nPlease ensure @${botUsername} is added as an administrator to the channel first!`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 // Fetch chat details
 const chatRes = await fetch(`https://api.telegram.org/bot${botToken}/getChat`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ chat_id: channelInput }),
 });
 const chatJson = await chatRes.json();
 const chatInfo = chatJson.result || {};

 const channelId = chatInfo.id || channelInput;
 const channelTitle = chatInfo.title || 'Connected Channel';
 const channelUsername = chatInfo.username ? `@${chatInfo.username}` : (channelInput.startsWith('@') ? channelInput : null);

 await saveManagedChannel({
 channel_id: channelId,
 channel_title: channelTitle,
 channel_username: channelUsername,
 added_by: chatId,
 is_active: true,
 added_at: new Date().toISOString(),
 updated_at: new Date().toISOString(),
 });

 // Invalidate admin cache so newly discovered channel's admins are recognized immediately
 invalidateAdminIdsCache();

 const adminCount = Array.isArray(json.result) ? json.result.filter((m: any) => !m.user?.is_bot).length : 0;

 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Channel Successfully Connected!</b> 

• <b>Title:</b> <b>${channelTitle}</b>
• <b>Channel ID:</b> <code>${channelId}</code>
• <b>Username:</b> <b>${channelUsername || 'Private Channel'}</b>
• <b>Admins Recognized:</b> <code>${adminCount}</code>

All administrators of this channel can now use bot admin features, and approved listings will be posted to this channel with full 3-button tracking!
 `.trim(),
 parse_mode: 'HTML',
 reply_markup: {
 inline_keyboard: [
 [{ text: 'View Connected Channels', callback_data: 'admin_list_channels' }],
 [{ text: 'Admin Menu', callback_data: 'admin_menu' }],
 ],
 },
 });
 return NextResponse.json({ ok: true });
 } catch (netErr: any) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `Error connecting channel: ${netErr.message || 'Unknown network error'}`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }
 }

 if (text === '/cancel') {
 await clearSession(chatId);
 await sendPrimaryWelcomeMenu(chatId, undefined, message.from);
 return NextResponse.json({ ok: true });
 }

 // Reply Keyboard Button Handler
 if (text === ' Find Roommate (Matchmaker)' || text === ' Find Roommate') {
 await clearSession(chatId);
 await sendMatchmakerSubcityStep(chatId);
 return NextResponse.json({ ok: true });
 }

 if (
 text === ' Post Seeker Profile' ||
 text === ' Post Seeker Profile (Looking for Roommate)' ||
 text === ' Post Profile to Channel' ||
 text === ' Post Your Profile to Channel'
 ) {
 await clearSession(chatId);
 await sendPostProfileBranchPrompt(chatId);
 return NextResponse.json({ ok: true });
 }

 if (text === ' Share Space to Rent' || text === ' Share Space / Room for Rent') {
 await sendHaveRoomAdminDirectCard(chatId);
 return NextResponse.json({ ok: true });
 }

 if (text === ' Verify Fayda ID') {
 await clearSession(chatId);
 const isVerified = await isUserFaydaVerified(chatId);
 if (isVerified) {
 const session = getSession(chatId);
 const lang = getLanguage(session.draft_data, chatId);
 await sendVerifiedFaydaDossierCard(chatId, lang);
 return NextResponse.json({ ok: true });
 }
 await sendFaydaGateCard(chatId, 'access all SpaceMatch verified features');
 return NextResponse.json({ ok: true });
 }

 // ── Universal Photo / Image Handler (Fayda QR Code Verification & Payment Receipts) ───
 const uploadedMedia = extractMediaFileFromMessage(message);
 if (
 uploadedMedia &&
 session.step !== 'space_input_photos' &&
 session.step !== 'admin_awaiting_custom_announcement'
 ) {
 const isAwaitingPayment = Boolean(
 session.step &&
 (session.step.startsWith('awaiting_payment_') || session.step === 'payment_input_ref')
 );

 if (isAwaitingPayment) {
 const captionText = (message.caption || '').trim();
 const captionRef = extractTransactionReference(captionText);

 if (captionRef) {
 text = captionRef;
 } else if ('error' in uploadedMedia) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Receipt Upload Error / የደረሰኝ ፋይል ስህተት</b>\n\n<blockquote>${uploadedMedia.messageEn}\n\n${uploadedMedia.messageAm}</blockquote>`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 } else {
 // Fast in-memory receipt OCR & QR extraction (Zero-Storage Policy)
 const scanNotice = await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `🔍 <b>Scanning Receipt Screenshot... / ደረሰኝዎን በመመርመር ላይ...</b>\n\n<blockquote>Extracting transaction reference in-memory · Zero documents stored\nየግብይት ቁጥሩን በራስ-ሰር በመፈለግ ላይ · ምንም አይነት ምስል አይቀመጥም</blockquote>`,
 parse_mode: 'HTML',
 });
 const scanNoticeId = scanNotice?.result?.message_id;

 try {
 const buffer = await downloadTelegramFile(uploadedMedia.fileId);
 const extraction = await extractTransactionReferenceFromImage(buffer);

 if (scanNoticeId) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: scanNoticeId }).catch(() => {});
 }

 if (extraction.success && extraction.reference) {
 text = extraction.reference;
 if (extraction.bankHint && session.draft_data) {
 session.draft_data.detected_bank_hint = extraction.bankHint;
 }
 // Execution falls through to payment reference handler for instant bank verification and pass activation!
 } else {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Could Not Read Receipt Code / የደረሰኝ ቁጥሩን ማንበብ አልተቻለም</b>\n\n<blockquote>We received your screenshot, but could not detect a clear transaction reference code (e.g. <code>DKM7J1EXAP</code> or <code>FT...</code>).\n\nየደረሰኝ ፎቶው ደርሶናል፤ ነገር ግን የግብይት ቁጥሩን (ለምሳሌ <code>DKM7J1EXAP</code> ወይም <code>FT...</code>) በግልጽ ማንበብ አልተቻለም።</blockquote>\n\n• <b>Option 1 / አማራጭ 1:</b> Upload a closer, clearer screenshot of your receipt / ደረሰኙ በቅርብና በግልጽ የሚታይበትን ፎቶ ይላኩ\n• <b>Option 2 / አማራጭ 2:</b> Type and send the transaction code manually / የግብይት ቁጥሩን በቀጥታ ጽፈው ይላኩልን`,
 parse_mode: 'HTML',
 reply_markup: {
 inline_keyboard: [
 [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ],
 },
 });
 return NextResponse.json({ ok: true });
 }
 } catch (err) {
 console.error('[webhook] Error extracting receipt reference:', err);
 if (scanNoticeId) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: scanNoticeId }).catch(() => {});
 }
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Receipt Scan Error / የደረሰኝ ፍተሻ ስህተት</b>\n\n<blockquote>Please type and send the transaction reference code written on your receipt (e.g. <code>DKM7J1EXAP</code> or <code>FT...</code>).\n\nእባክዎ በደረሰኙ ላይ የሚገኘውን የግብይት ቁጥር (ለምሳሌ <code>DKM7J1EXAP</code> ወይም <code>FT...</code>) ጽፈው ይላኩልን።</blockquote>`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }
 }
 } else {
 const lang = getLanguage(session.draft_data, chatId);
 const activeMsgId = session.draft_data?.card_msg_id;
 const isFaydaStep = Boolean(
   session.step === 'awaiting_seeker_fayda_upload' ||
   session.step === 'awaiting_standalone_fayda_fan' ||
   session.step === 'dyn_card_fayda_fan' ||
   session.step?.startsWith('awaiting_target_fayda_fan:')
 );
 const isIdleOrSafeStep = Boolean(!session.step || session.step === 'idle' || session.step === 'returning_user_review' || isOnboardingSession(session.step));

 if (!isFaydaStep && !isIdleOrSafeStep) {
   await sendTelegram('sendMessage', {
     chat_id: chatId,
     text: `<b>Please use the current step options / እባክዎ የአሁኑን ጥያቄ ይመልሱ</b>\n\n<blockquote>You are currently filling out a form. Finish or tap Cancel / Main Menu first before uploading a Fayda ID or receipt photo.\n\nበአሁኑ ሰዓት መረጃ እየሞሉ ነው፤ ፎቶ ከመላክዎ በፊት እባክዎ አሁን ያለውን ደረጃ ይጨርሱ ወይም ሰርዝን ይጫኑ።</blockquote>`,
     parse_mode: 'HTML',
     reply_markup: { inline_keyboard: [[{ text: 'Cancel / ሰርዝ', callback_data: 'nav_start' }]] },
   });
   return NextResponse.json({ ok: true });
 }

 const photoResult = await verifyFaydaMediaFromTelegram(message, chatId);

 // Privacy hygiene: delete uploaded ID photo from Telegram chat history immediately after RAM processing
 if (isFaydaStep) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: message.message_id }).catch(() => {});
 }

 if (photoResult.success) {
 if (message.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: message.message_id }).catch(() => {});
 }
 await finalizeFaydaVerification(
 chatId,
 photoResult,
 session.step || 'universal_photo',
 session.draft_data,
 activeMsgId,
 {},
 update.message?.from
 );
 return NextResponse.json({ ok: true });
 }

 // Photo did not contain a valid Fayda QR code
 if (session.step === 'awaiting_seeker_fayda_upload' || session.step === 'dyn_card_fayda_fan') {
 await sendDynamicCardStep9FaydaFan(
 chatId,
 session.draft_data,
 activeMsgId,
 photoResult.message
 );
 return NextResponse.json({ ok: true });
 }

 if (
 session.step === 'awaiting_standalone_fayda_fan' ||
 session.step?.startsWith('awaiting_target_fayda_fan:') ||
 isOnboardingSession(session.step)
 ) {
 await sendOrEditCard(
   chatId,
   photoResult.message,
   [[{ text: 'Why Fayda? / ለምን ፋይዳ?', callback_data: 'why_fayda_id' }], [{ text: 'Back to Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }]],
   activeMsgId
 );
 return NextResponse.json({ ok: true });
 }

 // In idle/safe state, check if the photo is a payment receipt
 if (!('error' in uploadedMedia)) {
 try {
 const buffer = await downloadTelegramFile(uploadedMedia.fileId);
 const receiptExt = await extractTransactionReferenceFromImage(buffer);
 if (receiptExt.success && receiptExt.reference) {
 const mem = await getUserMembershipStatus(chatId);
 if (!mem.isActive) {
 text = receiptExt.reference;
 const newDraftData: Record<string, any> = {
 membership_purpose: 'connect_request',
 membership_metadata: { generalPass: true },
 ...(receiptExt.bankHint ? { detected_bank_hint: receiptExt.bankHint } : {}),
 };
 await saveSession({
 telegram_id: chatId,
 step: 'awaiting_payment_for_membership:general',
 draft_data: newDraftData,
 updated_at: new Date().toISOString(),
 });
 session.step = 'awaiting_payment_for_membership:general';
 session.draft_data = newDraftData;
 }
 }
 } catch {}
 }

 if (!text) {
 // If not a receipt, guide the user clearly regarding Fayda verification:
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Photo Received / ፎቶ ደርሶናል</b>\n\n<blockquote>No authentic Fayda National ID QR code or payment receipt was detected in this photo. Please send a clear photo of the BACK of your Fayda card showing the square QR code, or your payment receipt.\n\nይህ ፎቶ ትክክለኛ የፋይዳ ብሔራዊ መታወቂያ QR ኮድ ወይም የክፍያ ደረሰኝ አልያዘም። የፋይዳ መታወቂያዎን ለማረጋገጥ የመታወቂያዎን ጀርባ (የካሬ QR ኮድ ያለበትን) ፎቶ ይላኩ፣ ወይም የክፍያ ደረሰኝዎን ይላኩ።</blockquote>`,
 parse_mode: 'HTML',
 reply_markup: {
 inline_keyboard: [
 [{ text: 'Verify Fayda / ፋይዳ አረጋግጥ', callback_data: 'verify_fayda' }],
 [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ],
 },
 });
 return NextResponse.json({ ok: true });
 }
 }
 }

 // ── Space Owner Questionnaire: Message Handlers ───────────────────────
 // Space Photos Upload (handled via Telegram file_id, supports compressed photo & image document)
 if (session.step === 'space_input_photos') {
 const photos = session.draft_data?.space_photos || [];
 const docMime = (message.document?.mime_type || '').toLowerCase();
 const docName = (message.document?.file_name || '').toLowerCase();
 const isImageDoc = Boolean(
 message.document?.file_id &&
 (docMime.startsWith('image/') || /\.(?:jpe?g|png|webp)$/i.test(docName))
 );
 const incomingFileId =
 (message.photo && Array.isArray(message.photo) && message.photo.length > 0
 ? message.photo[message.photo.length - 1].file_id
 : undefined) || (isImageDoc ? message.document!.file_id : undefined);

 if (incomingFileId) {
 const updatedPhotos = [...photos, incomingFileId];
 const updatedDraft = { ...session.draft_data, space_photos: updatedPhotos };
 await sendSpaceStep9Photos(chatId, updatedDraft, session.draft_data?.card_msg_id);
 return NextResponse.json({ ok: true });
 }

 if (/^(done|finish|ok|skip|next|proceed|ቀጥል|እለፍ|ጨርሻለሁ)$/i.test(text.trim())) {
 if (update.message?.message_id) {
   sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 await sendSpacePreviewCard(chatId, session.draft_data || {}, session.draft_data?.card_msg_id);
 return NextResponse.json({ ok: true });
 }

 await sendSpaceStep9Photos(chatId, session.draft_data || {}, session.draft_data?.card_msg_id);
 return NextResponse.json({ ok: true });
 }

 // Space Type Text Input
 if (session.step === 'space_input_type') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const typeText = text.trim();
 if (!typeText || typeText.length < 3) {
 await sendSpaceStep1Type(
 chatId,
 session.draft_data,
 activeMsgId,
 'Please enter a description of the space layout (at least 3 characters, e.g. Master Bedroom) / እባክዎ የሚከራየውን ክፍል አይነት በአጭሩ ይግለጹ (ምሳሌ: ዋና መኝታ ቤት):'
 );
 return NextResponse.json({ ok: true });
 }
 const updatedDraft = { ...session.draft_data, lang, space_type: typeText };
 await sendSpaceStep2Location(chatId, updatedDraft, activeMsgId);
 return NextResponse.json({ ok: true });
 }

 // Space Rent Text Input
 if (session.step === 'space_input_rent') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const isAm = lang === 'am';
 const parsedRent = parseNumericInput(text);
 if (!parsedRent || parsedRent < 500 || parsedRent > 500000) {
 await sendSpaceStep2Rent(
 chatId,
 session.draft_data,
 activeMsgId,
 'Please enter a valid monthly rent amount between 500 and 500,000 ETB (e.g. 12000) / ከ 500 እስከ 500,000 በብር መካከል ትክክለኛ ወርሃዊ ኪራይ ያስገቡ (ምሳሌ: 12000):'
 );
 return NextResponse.json({ ok: true });
 }
 const updatedDraft = { ...session.draft_data, lang, space_rent: parsedRent };
 await sendSpaceStep3Share(chatId, updatedDraft, activeMsgId);
 return NextResponse.json({ ok: true });
 }

 // Space Roommate Share Text Input
 if (session.step === 'space_input_share') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const isAm = lang === 'am';
 const parsedShare = parseNumericInput(text);
 const totalRentCap = Number(session.draft_data?.space_rent || 0);
 if (!parsedShare || parsedShare < 200 || parsedShare > 500000 || (totalRentCap > 0 && parsedShare > totalRentCap)) {
 await sendSpaceStep3Share(
 chatId,
 session.draft_data,
 activeMsgId,
 totalRentCap > 0 && parsedShare && parsedShare > totalRentCap
   ? `Roommate share cannot exceed total monthly rent (${totalRentCap.toLocaleString()} ETB) / የአጋር ድርሻ ከጠቅላላው ኪራይ (${totalRentCap.toLocaleString()} ብር) መብለጥ አይችልም።`
   : 'Please enter a valid roommate share amount between 200 and 500,000 ETB (e.g. 6000) / ከ 200 እስከ 500,000 በብር መካከል ትክክለኛ የቤት ጓደኛ ድርሻ ያስገቡ (ምሳሌ: 6000):'
 );
 return NextResponse.json({ ok: true });
 }
 const updatedDraft = { ...session.draft_data, lang, space_share: parsedShare };
 await sendSpaceStep4Amenities(chatId, updatedDraft, activeMsgId);
 return NextResponse.json({ ok: true });
 }

 // Space Amenities Text Input
 if (session.step === 'space_input_amenities') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const isAm = lang === 'am';
 const rawAmenities = text.trim();
 if (!rawAmenities || rawAmenities.length < 2) {
 await sendSpaceStep4Amenities(
 chatId,
 session.draft_data,
 activeMsgId,
 'Please type at least one amenity or feature included with the space (e.g. WiFi) / ቤቱ የሚያካትታቸውን ግልጋሎቶች በአጭሩ ይጻፉ (ምሳሌ: ዋይፋይ):'
 );
 return NextResponse.json({ ok: true });
 }

 const parsedAmenities = rawAmenities
 .split(/[,;\n]+/)
 .map((s) => s.trim())
 .filter(Boolean);

 const updatedDraft = {
 ...session.draft_data,
 lang,
 space_amenities: parsedAmenities.length > 0 ? parsedAmenities : [rawAmenities],
 space_amenities_raw: rawAmenities,
 };

 await sendSpaceStep5HostGender(chatId, updatedDraft, activeMsgId);
 return NextResponse.json({ ok: true });
 }

 // Space Preferred Roommate Text Input
 if (session.step === 'space_input_pref_roommate') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const isAm = lang === 'am';
 const rawPref = text.trim();
 if (!rawPref || rawPref.length < 2) {
 await sendSpaceStep7PrefRoommate(
 chatId,
 session.draft_data,
 activeMsgId,
 'Please describe your preferred roommate (e.g. Female, clean, and employed) / እባክዎ የሚፈልጉትን የቤት ጓደኛ ይግለጹ (ምሳሌ: ሴት፣ ጽዱ እና ተቀጣሪ):'
 );
 return NextResponse.json({ ok: true });
 }

 const updatedDraft = {
 ...session.draft_data,
 lang,
 preferred_roommate: rawPref,
 roommate_traits: rawPref,
 description: rawPref,
 };

 await sendSpaceStep9Photos(chatId, updatedDraft, activeMsgId);
 return NextResponse.json({ ok: true });
 }

 // Standalone Fayda FAN Input (from /fayda or gate cards)
 if (session.step === 'awaiting_standalone_fayda_fan') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const isAm = lang === 'am';

 // Check if user uploaded a photo or image document of their Fayda QR code
 const media = extractMediaFileFromMessage(update.message);
 if (media) {
 const photoResult = await verifyFaydaMediaFromTelegram(update.message, chatId);
 if (!photoResult.success) {
 await sendOrEditCard(
 chatId,
 photoResult.message,
 [[{ text: 'Back to Main Menu / ወደ ዋና ማውጫ', callback_data: 'nav_start' }]],
 activeMsgId
 );
 return NextResponse.json({ ok: true });
 }

 await finalizeFaydaVerification(
 chatId,
 photoResult,
 'awaiting_standalone_fayda_fan',
 session.draft_data,
 activeMsgId,
 {},
 update.message?.from
 );
 return NextResponse.json({ ok: true });
 }

 // Reject manual text or digits with bilingual guidance
 const manualGuidance = FAYDA_ERROR_GUIDANCE.MANUAL_TEXT_ENTERED;
 await sendOrEditCard(
 chatId,
 `${manualGuidance.en}\n\n${manualGuidance.am}`,
 [[{ text: 'Back to Main Menu / ወደ ዋና ማውጫ', callback_data: 'nav_start' }]],
 activeMsgId
 );
 return NextResponse.json({ ok: true });
 }

 // ── ADMIN: SEARCH POST BY CODE INPUT ────────────────────────────────
 if (session.step === 'admin_search_code_input') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await tgSend(chatId, `<b>Access Denied.</b>`);
 await clearSession(chatId);
 return NextResponse.json({ ok: true });
 }

 const rawQuery = text.trim();
 if (rawQuery === '/cancel' || rawQuery.toLowerCase() === 'cancel') {
 await clearSession(chatId);
 await sendOrEditCard(
 chatId,
 ` Search cancelled.`,
 [[{ text: 'Back to Admin Menu', callback_data: 'admin_menu' }]],
 activeMsgId
 );
 return NextResponse.json({ ok: true });
 }

 await clearSession(chatId);
 await executeAdminPostSearch(chatId, rawQuery, activeMsgId);
 return NextResponse.json({ ok: true });
 }

 // ── ADMIN: SEARCH USER INPUT ───────────────────────────────────────
 if (session.step === 'admin_search_user_input') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await tgSend(chatId, `<b>Access Denied.</b>`);
 await clearSession(chatId);
 return NextResponse.json({ ok: true });
 }

 const rawQuery = text.trim();
 if (rawQuery === '/cancel' || rawQuery.toLowerCase() === 'cancel') {
 await clearSession(chatId);
 await sendOrEditCard(
 chatId,
 ` User search cancelled.`,
 [[{ text: 'Back to Admin Menu', callback_data: 'admin_menu' }]],
 activeMsgId
 );
 return NextResponse.json({ ok: true });
 }

 await clearSession(chatId);
 await executeAdminUserSearch(chatId, rawQuery, activeMsgId);
 return NextResponse.json({ ok: true });
 }

 // ── ADMIN: ADD ADMINISTRATOR BY USERNAME INPUT ──────────────────────
 if (session.step === 'admin_awaiting_username') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await tgSend(chatId, `<b>Access Denied.</b>`);
 await clearSession(chatId);
 return NextResponse.json({ ok: true });
 }

 const rawUser = text.trim();
 if (rawUser === '/cancel' || rawUser.toLowerCase() === 'cancel') {
 await clearSession(chatId);
 await tgSend(chatId, ` Cancelled admin addition.`);
 return NextResponse.json({ ok: true });
 }

 const cleanUser = rawUser.replace('@', '').trim();
 if (!cleanUser || cleanUser.length < 3) {
 await sendOrEditCard(
 chatId,
 `<b>Invalid Username.</b> Please enter a valid Telegram username (e.g. <code>@username</code> or <code>username</code>):`,
 [[{ text: 'Back to Admin Menu', callback_data: 'admin_menu' }]],
 activeMsgId
 );
 return NextResponse.json({ ok: true });
 }

 const isNumeric = /^\d+$/.test(cleanUser);
 let userRecord: any = null;

 if (isNumeric) {
 const { data } = await supabaseAdmin.from('users').select('*').eq('telegram_id', Number(cleanUser)).maybeSingle();
 userRecord = data;
 } else {
 const { data } = await supabaseAdmin.from('users').select('*').ilike('username', cleanUser).maybeSingle();
 userRecord = data;
 if (!userRecord) {
 const { data: prof } = await supabaseAdmin.from('profiles').select('*').ilike('telegram_username', cleanUser).maybeSingle();
 if (prof?.telegram_id) {
 const { data: upsertedUser } = await supabaseAdmin
 .from('users')
 .upsert({
 telegram_id: prof.telegram_id,
 first_name: prof.full_name || cleanUser,
 username: cleanUser,
 role: 'admin',
 updated_at: new Date().toISOString(),
 }, { onConflict: 'telegram_id' })
 .select('*')
 .single();
 userRecord = upsertedUser;
 }
 }
 }

 if (userRecord) {
 await supabaseAdmin
 .from('users')
 .update({ role: 'admin', updated_at: new Date().toISOString() })
 .eq('id', userRecord.id);
 }

 // Always register in persistent admin username list so they retain admin privileges even across sessions
 await registerAdminUsername(cleanUser);
 invalidateAdminCache();
 await clearSession(chatId);

 const displayName = userRecord
 ? ([userRecord.first_name, userRecord.last_name].filter(Boolean).join(' ') || (userRecord.username ? `@${userRecord.username}` : `ID ${userRecord.telegram_id}`))
 : `@${cleanUser}`;

 await sendOrEditCard(
 chatId,
 `<b>${displayName}</b> has been successfully appointed as a SpaceMatch Administrator! \n\nThey now have full access to <code>/admin</code>, <code>/post</code>, and <code>/close</code>.`,
 [
 [{ text: 'View Administrators', callback_data: 'admin_list_team' }],
 [{ text: 'Add Another Admin', callback_data: 'admin_add_prompt' }],
 [{ text: 'Back to Admin Menu', callback_data: 'admin_menu' }],
 ],
 activeMsgId
 );

 if (userRecord?.telegram_id && Number(userRecord.telegram_id) !== chatId) {
 await sendTelegram('sendMessage', {
 chat_id: Number(userRecord.telegram_id),
 text: `<b>You have been appointed as a SpaceMatch Administrator!</b>\n\nYou now have administrative privileges to post listings directly to the channel and manage/close listings:\n\n• <code>/post</code> - Launch channel posting wizard\n• <code>/close &lt;code&gt;</code> - Close matched listings\n• <code>/admins</code> - View administrator team`,
 parse_mode: 'HTML',
 reply_markup: {
 inline_keyboard: [
 [{ text: 'Post to Channel as Admin >', callback_data: 'admin_post_start' }],
 [{ text: 'Main Menu', callback_data: 'nav_start' }],
 ],
 },
 });
 }

 return NextResponse.json({ ok: true });
 }

 // ── ADMIN POST WIZARD TEXT INPUT HANDLERS ─────────────────────────────
 // Admin Post Wizard: Budget/Rent Range Input (Min - Max or Min -> Max)
 if (session.step === 'admin_post_budget') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 const budgetRange = parseBudgetRangeInput(text);
 if (!budgetRange || budgetRange.max < 500 || budgetRange.max > 1000000) {
 await sendAdminPostBudgetStep(
 chatId,
 session.draft_data,
 activeMsgId,
 'Please enter a valid range (e.g. 5000 - 12000) or minimum budget first (e.g. 5000):'
 );
 return NextResponse.json({ ok: true });
 }

 if (budgetRange.isExplicitRange) {
 const updatedDraft = { ...session.draft_data, budget_min: budgetRange.min, budget_max: budgetRange.max, budget: budgetRange.max };
 await sendAdminPostGenderStep(chatId, updatedDraft, activeMsgId);
 return NextResponse.json({ ok: true });
 }

 await sendAdminPostBudgetMaxStep(chatId, session.draft_data, budgetRange.max, activeMsgId);
 return NextResponse.json({ ok: true });
 }

 if (session.step === 'admin_post_budget_max') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 const minAmount = Number(session.draft_data?.pending_budget_min || 500);
 const budgetRange = parseBudgetRangeInput(text);
 if (!budgetRange || budgetRange.max < 500 || budgetRange.max > 1000000) {
 await sendAdminPostBudgetMaxStep(
 chatId,
 session.draft_data,
 minAmount,
 activeMsgId,
 `Please enter a valid maximum amount in ETB (at least ${minAmount.toLocaleString()}):`
 );
 return NextResponse.json({ ok: true });
 }
 const finalMin = budgetRange.isExplicitRange ? budgetRange.min : minAmount;
 const finalMax = budgetRange.max;
 if (finalMax < finalMin) {
 await sendAdminPostBudgetMaxStep(
 chatId,
 session.draft_data,
 finalMin,
 activeMsgId,
 `Maximum must be at least ${finalMin.toLocaleString()} ETB:`
 );
 return NextResponse.json({ ok: true });
 }
 const { pending_budget_min: _ignoredMin, ...cleanDraft } = session.draft_data || {};
 const updatedDraft = { ...cleanDraft, budget_min: finalMin, budget_max: finalMax, budget: finalMax };
 await sendAdminPostGenderStep(chatId, updatedDraft, activeMsgId);
 return NextResponse.json({ ok: true });
 }

 // Admin Post Wizard: Bio / Description Text Input
 if (session.step === 'admin_post_bio') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 const bioText = text.toLowerCase() === 'default' || text.toLowerCase() === 'skip'
 ? 'Seeking compatible roommate in Addis Ababa.'
 : text.trim();
 const updatedDraft = {
 ...session.draft_data,
 details: bioText,
 description: bioText,
 lifestyle_bio: bioText,
 roommate_traits: bioText,
 };
 await sendAdminPostHouseRulesStep(chatId, updatedDraft, activeMsgId);
 return NextResponse.json({ ok: true });
 }

 // Admin Post Wizard: House Rules Text Input
 if (session.step === 'admin_post_house_rules') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 const rulesText = text.toLowerCase() === 'default' || text.toLowerCase() === 'skip'
 ? 'Clean, quiet & no smoking'
 : text.trim();
 const updatedDraft = {
 ...session.draft_data,
 house_rules: rulesText,
 };
 await sendAdminPostContactStep(chatId, updatedDraft, activeMsgId);
 return NextResponse.json({ ok: true });
 }

 // Admin Post Wizard: Step 7 Contact Information Text Input
 if (session.step === 'admin_post_contact') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 const rawContact = text.trim();

 let contactName = 'Verified Resident';
 let contactPhone = '';
 let contactUsername: string | null = null;

 if (rawContact.includes('|')) {
 const parts = rawContact.split('|').map(s => s.trim());
 if (parts[0]) contactName = parts[0];
 if (parts[1]) contactPhone = parts[1];
 if (parts[2]) contactUsername = parts[2].replace(/^@/, '');
 } else {
 const phoneMatch = rawContact.match(/(\+?251\d{9}|09\d{8}|07\d{8})/);
 if (phoneMatch) {
 contactPhone = phoneMatch[0];
 const remaining = rawContact.replace(contactPhone, '').trim();
 const userMatch = remaining.match(/@([a-zA-Z0-9_]{4,})/);
 if (userMatch) {
 contactUsername = userMatch[1];
 contactName = remaining.replace(userMatch[0], '').trim() || 'Verified Resident';
 } else {
 contactName = remaining || 'Verified Resident';
 }
 } else {
 contactPhone = rawContact;
 }
 }

 const updatedDraft = {
 ...session.draft_data,
 is_concierge: false,
 contact_name: contactName,
 contact_phone: contactPhone || 'Contact via SpaceMatch',
 contact_username: contactUsername,
 };

 await saveSession({
 telegram_id: chatId,
 step: 'admin_post_preview',
 draft_data: { ...updatedDraft, card_msg_id: activeMsgId },
 updated_at: new Date().toISOString(),
 });

 await sendAdminPostPreviewCard(chatId, updatedDraft, activeMsgId);
 return NextResponse.json({ ok: true });
 }

 // ── DYNAMIC CARD TEXT INPUT HANDLERS ────────────────────────────────────

 // Step 1 Text Input: Age
 if (session.step === 'dyn_card_age') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const isAm = lang === 'am';
 const ageVal = parseNumericInput(text);
 if (!ageVal || ageVal < 18 || ageVal > 99) {
 await sendDynamicCardStep1Age(
 chatId,
 session.draft_data,
 activeMsgId,
 'Please enter a valid numerical age between 18 and 99 (e.g. 24) / ትክክለኛ ዕድሜዎን በቁጥር ያስገቡ (ከ 18 እስከ 99፣ ምሳሌ: 24):'
 );
 return NextResponse.json({ ok: true });
 }

 const updatedDraft: Record<string, any> = { ...session.draft_data, age: ageVal, lang };
 if (!updatedDraft.gender && !updatedDraft.my_gender) {
 await sendDynamicCardStep2Gender(chatId, updatedDraft, activeMsgId);
 } else {
 await routeNextMissingSeekerStep(chatId, updatedDraft, activeMsgId, update.message?.from);
 }
 return NextResponse.json({ ok: true });
 }

 // Step 4 Text Input: Job / Occupation
 if (session.step === 'dyn_card_job') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const isAm = lang === 'am';
 const jobVal = text.trim();
 if (!jobVal || jobVal.length < 2 || jobVal.length > 80) {
 await sendDynamicCardStep4Job(
 chatId,
 session.draft_data,
 activeMsgId,
 'Please enter a valid job or occupation (e.g. Software Engineer, Accountant, Student) / የስራ ሁኔታዎን ወይም ሙያዎን በአጭሩ ይጻፉ (ምሳሌ: አካውንታንት):'
 );
 return NextResponse.json({ ok: true });
 }

 const updatedDraft = { ...session.draft_data, job: jobVal, lang };
 await routeNextMissingSeekerStep(chatId, updatedDraft, activeMsgId, update.message?.from);
 return NextResponse.json({ ok: true });
 }

 // Interstitial Step Text Input: Transition to Preferences
 if (session.step === 'dyn_card_interstitial') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 const budgetRange = parseBudgetRangeInput(text);
 if (budgetRange && budgetRange.isExplicitRange && budgetRange.max >= 500 && budgetRange.max <= 1000000) {
 const updatedDraft = { ...session.draft_data, budget_min: budgetRange.min, budget_max: budgetRange.max, interstitial_seen: true };
 await routeNextMissingSeekerStep(chatId, updatedDraft, activeMsgId, update.message?.from);
 return NextResponse.json({ ok: true });
 }
 await sendPersonalRegistrationSuccessCard(chatId, session.draft_data, activeMsgId);
 return NextResponse.json({ ok: true });
 }

 // Preferences Interstitial Step Text Input: Transition to Next Step
 if (session.step === 'dyn_card_pref_interstitial') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 await sendPreferencesRegistrationSuccessCard(chatId, session.draft_data, activeMsgId);
 return NextResponse.json({ ok: true });
 }

 // Step 5 Text Input: Monthly Budget Range (Min - Max or Min -> Max)
 if (session.step === 'dyn_card_budget') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const budgetRange = parseBudgetRangeInput(text);
 if (!budgetRange || budgetRange.max < 500 || budgetRange.max > 1000000) {
 await sendDynamicCardStep5Budget(
 chatId,
 session.draft_data,
 activeMsgId,
 'Please enter a valid range (e.g. 5000 - 12000) or minimum budget first (e.g. 5000) / ትክክለኛ የበጀት ክልል (ምሳሌ: 5000 - 12000) ወይም ዝቅተኛውን በጀት በብር ያስገቡ:'
 );
 return NextResponse.json({ ok: true });
 }

 if (budgetRange.isExplicitRange) {
 const updatedDraft = { ...session.draft_data, budget_min: budgetRange.min, budget_max: budgetRange.max, lang };
 await routeNextMissingSeekerStep(chatId, updatedDraft, activeMsgId, update.message?.from);
 return NextResponse.json({ ok: true });
 }

 await sendDynamicCardStep5BudgetMax(chatId, session.draft_data, budgetRange.max, activeMsgId);
 return NextResponse.json({ ok: true });
 }

 // Step 5b Text Input: Maximum Monthly Budget
 if (session.step === 'dyn_card_budget_max') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const minAmount = Number(session.draft_data?.pending_budget_min || 500);
 const budgetRange = parseBudgetRangeInput(text);
 if (!budgetRange || budgetRange.max < 500 || budgetRange.max > 1000000) {
 await sendDynamicCardStep5BudgetMax(
 chatId,
 session.draft_data,
 minAmount,
 activeMsgId,
 `Please enter a valid maximum budget in ETB (at least ${minAmount.toLocaleString()}) / እባክዎ ከ${minAmount.toLocaleString()} ብር ያላነሰ ከፍተኛ በጀት ያስገቡ:`
 );
 return NextResponse.json({ ok: true });
 }
 const finalMin = budgetRange.isExplicitRange ? budgetRange.min : minAmount;
 const finalMax = budgetRange.max;
 if (finalMax < finalMin) {
 await sendDynamicCardStep5BudgetMax(
 chatId,
 session.draft_data,
 finalMin,
 activeMsgId,
 `Maximum budget must be at least ${finalMin.toLocaleString()} ETB / ከፍተኛው በጀት ቢያንስ ${finalMin.toLocaleString()} ብር መሆን አለበት:`
 );
 return NextResponse.json({ ok: true });
 }
 const { pending_budget_min: _ignoredMin, ...cleanDraft } = session.draft_data || {};
 const updatedDraft = { ...cleanDraft, budget_min: finalMin, budget_max: finalMax, lang };
 await routeNextMissingSeekerStep(chatId, updatedDraft, activeMsgId, update.message?.from);
 return NextResponse.json({ ok: true });
 }

 // Step 7 Text Input: Preferred Roommate Traits / Lifestyle
 if (session.step === 'dyn_card_traits') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const isAm = lang === 'am';
 const traitsVal = text.trim();
 if (!traitsVal || traitsVal.length < 3 || traitsVal.length > 500) {
 await sendDynamicCardStep7Traits(
 chatId,
 session.draft_data,
 activeMsgId,
 'Please describe your preferred roommate (e.g. Female, clean, and employed) / እባክዎ የሚፈልጉትን የቤት ጓደኛ ይግለጹ (ምሳሌ: ሴት፣ ጽዱ እና ተቀጣሪ):'
 );
 return NextResponse.json({ ok: true });
 }

 const updatedDraft = {
 ...session.draft_data,
 roommate_traits: traitsVal,
 preferred_roommate: traitsVal,
 description: traitsVal,
 lifestyle_bio: traitsVal,
 details: traitsVal,
 lang,
 };
 await routeNextMissingSeekerStep(chatId, updatedDraft, activeMsgId, update.message?.from);
 return NextResponse.json({ ok: true });
 }

 // Step 7b Text Input: House Rules
 if (session.step === 'dyn_card_house_rules') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const rulesVal = text.trim();
 if (!rulesVal || rulesVal.length < 3 || rulesVal.length > 300) {
 await sendDynamicCardStepHouseRules(
 chatId,
 session.draft_data,
 activeMsgId,
 'Please enter valid house rules (e.g. Clean, no smoking, quiet after 10 PM) / እባክዎ የቤት ህጎችን በአጭሩ ያስገቡ:'
 );
 return NextResponse.json({ ok: true });
 }
 const updatedDraft = {
 ...session.draft_data,
 house_rules: rulesVal,
 lang,
 };
 await routeNextMissingSeekerStep(chatId, updatedDraft, activeMsgId, update.message?.from);
 return NextResponse.json({ ok: true });
 }

 // Step 9 Text Input: Fayda FAN Verification
 if (session.step === 'dyn_card_fayda_fan') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const isAm = lang === 'am';

 // Check if user uploaded a photo or image document of Fayda QR
 const media = extractMediaFileFromMessage(update.message);
 if (media) {
 const photoResult = await verifyFaydaMediaFromTelegram(update.message, chatId);
 if (!photoResult.success) {
 await sendDynamicCardStep9FaydaFan(
 chatId,
 session.draft_data,
 activeMsgId,
 photoResult.message
 );
 return NextResponse.json({ ok: true });
 }

 await finalizeFaydaVerification(
 chatId,
 photoResult,
 'dyn_card_fayda_fan',
 session.draft_data,
 activeMsgId,
 { is_seeker_wizard: true },
 update.message?.from
 );
 return NextResponse.json({ ok: true });
 }

 // Reject manual typing with bilingual guidance
 const manualGuidance = FAYDA_ERROR_GUIDANCE.MANUAL_TEXT_ENTERED;
 await sendDynamicCardStep9FaydaFan(
 chatId,
 session.draft_data,
 activeMsgId,
 `${manualGuidance.en}\n\n${manualGuidance.am}`
 );
 return NextResponse.json({ ok: true });
 }

 // Target User Verification before accepting match
 if (session.step && session.step.startsWith('awaiting_target_fayda_fan:')) {
 const matchId = session.step.split(':')[1];
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const activeMsgId = session.draft_data?.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const isAm = lang === 'am';

 // Check if user uploaded a photo or image document of Fayda QR
 const media = extractMediaFileFromMessage(update.message);
 if (media) {
 const photoResult = await verifyFaydaMediaFromTelegram(update.message, chatId);
 if (!photoResult.success) {
 await sendOrEditCard(
 chatId,
 photoResult.message,
 [[{ text: 'Cancel / ሰርዝ', callback_data: 'nav_start' }]],
 activeMsgId
 );
 return NextResponse.json({ ok: true });
 }

 await finalizeFaydaVerification(
 chatId,
 photoResult,
 `awaiting_target_fayda_fan:${matchId}`,
 session.draft_data,
 activeMsgId,
 { target_match_id: matchId },
 update.message?.from
 );
 return NextResponse.json({ ok: true });
 }

 // Reject manual typing with bilingual guidance
 const manualGuidance = FAYDA_ERROR_GUIDANCE.MANUAL_TEXT_ENTERED;
 await sendOrEditCard(
 chatId,
 `${manualGuidance.en}\n\n${manualGuidance.am}`,
 [[{ text: 'Cancel / ሰርዝ', callback_data: 'nav_start' }]],
 activeMsgId
 );
 return NextResponse.json({ ok: true });
 }

 // Matchmaker Wizard: Age Text Input
 if (session.step === 'awaiting_match_identity' || session.step === 'awaiting_match_age') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const targetMsgId = session.draft_data.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const isAm = lang === 'am';
 const ageVal = parseNumericInput(text);
 if (!ageVal || ageVal < 18 || ageVal > 99) {
 await sendMatchmakerAgeStep(
 chatId,
 session.draft_data,
 targetMsgId,
 '<b>Please type a valid numerical age between 18 and 99 (e.g. 24): / ትክክለኛ ዕድሜዎን በቁጥር ያስገቡ (ከ 18 እስከ 99፣ ምሳሌ: 24):</b>'
 );
 return NextResponse.json({ ok: true });
 }

 const updatedDraft = { ...session.draft_data, age: ageVal, lang };
 await sendMatchmakerReligionStep(chatId, updatedDraft, targetMsgId);
 return NextResponse.json({ ok: true });
 }

 // Matchmaker Wizard: Job / Occupation Text Input
 if (session.step === 'awaiting_match_job') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const targetMsgId = session.draft_data.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const jobVal = text.trim();
 if (!jobVal || jobVal.length < 2 || jobVal.length > 80) {
 await sendMatchmakerJobStep(
 chatId,
 session.draft_data,
 targetMsgId,
 '<b>Please enter a valid occupation (e.g. Accountant, Engineer, Student): / እባክዎ ትክክለኛ ሙያዎን ወይም የስራ ሁኔታዎን ይጻፉ:</b>'
 );
 return NextResponse.json({ ok: true });
 }

 const updatedDraft = { ...session.draft_data, job: jobVal, lang };
 await sendMatchmakerPrefGenderStep(chatId, updatedDraft, targetMsgId);
 return NextResponse.json({ ok: true });
 }

 // Matchmaker Wizard: Budget Range Text Input (Min - Max or Min -> Max)
 if (session.step === 'awaiting_match_prefs' || session.step === 'awaiting_match_budget_input') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const targetMsgId = session.draft_data.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const budgetRange = parseBudgetRangeInput(text);
 if (!budgetRange || budgetRange.max <= 0 || budgetRange.max > 1000000) {
 await sendMatchmakerBudgetStep(
 chatId,
 session.draft_data,
 targetMsgId,
 '<b>Please type a valid range (e.g. 5000 - 12000) or minimum budget first (e.g. 5000): / ትክክለኛ የበጀት ክልል (ምሳሌ: 5000 - 12000) ወይም ዝቅተኛውን በጀት ያስገቡ:</b>'
 );
 return NextResponse.json({ ok: true });
 }

 if (budgetRange.isExplicitRange) {
 const updatedDraft = { ...session.draft_data, budget_min: budgetRange.min, budget_max: budgetRange.max, lang };
 await sendMatchmakerTraitsStep(chatId, updatedDraft, targetMsgId);
 return NextResponse.json({ ok: true });
 }

 await sendMatchmakerBudgetMaxStep(chatId, session.draft_data, budgetRange.max, targetMsgId);
 return NextResponse.json({ ok: true });
 }

 // Matchmaker Wizard: Maximum Budget Input (Step 2 of custom Min -> Max range)
 if (session.step === 'awaiting_match_budget_max') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const targetMsgId = session.draft_data.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const minAmount = Number(session.draft_data?.pending_budget_min || 500);
 const budgetRange = parseBudgetRangeInput(text);
 if (!budgetRange || budgetRange.max < 500 || budgetRange.max > 1000000) {
 await sendMatchmakerBudgetMaxStep(
 chatId,
 session.draft_data,
 minAmount,
 targetMsgId,
 `<b>Please enter a valid maximum budget in ETB (at least ${minAmount.toLocaleString()}): / እባክዎ ከ${minAmount.toLocaleString()} ብር ያላነሰ ከፍተኛ በጀት ያስገቡ:</b>`
 );
 return NextResponse.json({ ok: true });
 }
 const finalMin = budgetRange.isExplicitRange ? budgetRange.min : minAmount;
 const finalMax = budgetRange.max;
 if (finalMax < finalMin) {
 await sendMatchmakerBudgetMaxStep(
 chatId,
 session.draft_data,
 finalMin,
 targetMsgId,
 `<b>Maximum budget must be at least ${finalMin.toLocaleString()} ETB: / ከፍተኛው በጀት ቢያንስ ${finalMin.toLocaleString()} ብር መሆን አለበት:</b>`
 );
 return NextResponse.json({ ok: true });
 }
 const { pending_budget_min: _ignoredMin, ...cleanDraft } = session.draft_data || {};
 const updatedDraft = { ...cleanDraft, budget_min: finalMin, budget_max: finalMax, lang };
 await sendMatchmakerTraitsStep(chatId, updatedDraft, targetMsgId);
 return NextResponse.json({ ok: true });
 }

 // Matchmaker Wizard: Lifestyle / Habits Text Input (proceeds to House Rules before matches)
 if (session.step === 'awaiting_match_traits') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const targetMsgId = session.draft_data.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const traitsVal = text.trim();
 if (!traitsVal || traitsVal.length < 3 || traitsVal.length > 500) {
 await sendMatchmakerTraitsStep(
 chatId,
 session.draft_data,
 targetMsgId,
 '<b>Please write a brief description of your habits (e.g. clean, quiet, non-smoker): / እባክዎ ስለ አኗኗርዎ በአጭሩ ይጻፉ (ምሳሌ: ንጹህ፣ ጸጥተኛ):</b>'
 );
 return NextResponse.json({ ok: true });
 }

 const updatedDraft = {
 ...session.draft_data,
 roommate_traits: traitsVal,
 lifestyle_bio: traitsVal,
 description: traitsVal,
 lang,
 };
 await sendMatchmakerHouseRulesStep(chatId, updatedDraft, targetMsgId);
 return NextResponse.json({ ok: true });
 }

 // Matchmaker Wizard: House Rules Text Input (Final prompt before showing matches)
 if (session.step === 'awaiting_match_house_rules') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const targetMsgId = session.draft_data.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const rulesVal = text.trim();
 if (!rulesVal || rulesVal.length < 3 || rulesVal.length > 300) {
 await sendMatchmakerHouseRulesStep(
 chatId,
 session.draft_data,
 targetMsgId,
 '<b>Please enter valid house rules (e.g. No smoking, quiet after 10 PM): / እባክዎ ትክክለኛ የቤት ህጎችን ያስገቡ:</b>'
 );
 return NextResponse.json({ ok: true });
 }

 const rawTraitsOnly = extractUserDescription(session.draft_data?.roommate_traits || session.draft_data?.lifestyle_bio) || session.draft_data?.roommate_traits || 'Clean & respectful';
 const packedTraits = `Job: ${session.draft_data?.job || 'Member'} | Religion: ${session.draft_data?.religion || 'Any'} | Prefers: ${session.draft_data?.preferred_gender || 'Any'} | Rules: ${rulesVal} | ${rawTraitsOnly}`;
 const updatedDraft = {
 ...session.draft_data,
 house_rules: rulesVal,
 roommate_traits: packedTraits,
 lifestyle_bio: packedTraits,
 description: rawTraitsOnly,
 gender: session.draft_data?.my_gender || session.draft_data?.gender,
 preferred_subcity: session.draft_data?.match_subcities || session.draft_data?.preferred_subcity || [...ALL_SUBCITIES],
 interstitial_seen: true,
 browse_all: false,
 lang,
 };
 await saveSession({
 telegram_id: chatId,
 step: 'matchmaker_results',
 draft_data: updatedDraft,
 updated_at: new Date().toISOString(),
 }, true);
 await executeAutomatedMatchmaker(chatId, updatedDraft, targetMsgId, 0);
 return NextResponse.json({ ok: true });
 }

 // Seeker Wizard: Age Text Input
 if (session.step === 'awaiting_seeker_age') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const targetMsgId = session.draft_data.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const isAm = lang === 'am';
 const ageVal = parseNumericInput(text);
 if (!ageVal || ageVal < 18 || ageVal > 99) {
 await sendSeekerAgeStep(
 chatId,
 session.draft_data,
 targetMsgId,
 '<b>Please enter a valid age between 18 and 99 (e.g. 24): / ትክክለኛ ዕድሜዎን በቁጥር ያስገቡ (ከ 18 እስከ 99፣ ምሳሌ: 24):</b>'
 );
 return NextResponse.json({ ok: true });
 }

 const updatedDraft = { ...session.draft_data, age: ageVal, lang };
 await sendSeekerPrefGenderStep(chatId, updatedDraft, targetMsgId);
 return NextResponse.json({ ok: true });
 }

 // Seeker Wizard: Budget Range Text Input (Min - Max or Min -> Max)
 if (session.step === 'awaiting_seeker_budget_text') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const targetMsgId = session.draft_data.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const budgetRange = parseBudgetRangeInput(text);
 if (!budgetRange || budgetRange.max < 500 || budgetRange.max > 1000000) {
 await sendSeekerBudgetStep(
 chatId,
 session.draft_data,
 targetMsgId,
 '<b>Please enter a valid range (e.g. 5000 - 12000) or minimum budget first (e.g. 5000): / ትክክለኛ የበጀት ክልል (ምሳሌ: 5000 - 12000) ወይም ዝቅተኛውን በጀት ያስገቡ:</b>'
 );
 return NextResponse.json({ ok: true });
 }

 if (budgetRange.isExplicitRange) {
 const updatedDraft = { ...session.draft_data, budget_min: budgetRange.min, budget_max: budgetRange.max, lang };
 await sendSeekerBioStep(chatId, updatedDraft, targetMsgId);
 return NextResponse.json({ ok: true });
 }

 await sendSeekerBudgetMaxStep(chatId, session.draft_data, budgetRange.max, targetMsgId);
 return NextResponse.json({ ok: true });
 }

 if (session.step === 'awaiting_seeker_budget_max') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const targetMsgId = session.draft_data.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const minAmount = Number(session.draft_data?.pending_budget_min || 500);
 const budgetRange = parseBudgetRangeInput(text);
 if (!budgetRange || budgetRange.max < 500 || budgetRange.max > 1000000) {
 await sendSeekerBudgetMaxStep(
 chatId,
 session.draft_data,
 minAmount,
 targetMsgId,
 `<b>Please enter a valid maximum budget in ETB (at least ${minAmount.toLocaleString()}): / እባክዎ ከ${minAmount.toLocaleString()} ብር ያላነሰ ከፍተኛ በጀት ያስገቡ:</b>`
 );
 return NextResponse.json({ ok: true });
 }
 const finalMin = budgetRange.isExplicitRange ? budgetRange.min : minAmount;
 const finalMax = budgetRange.max;
 if (finalMax < finalMin) {
 await sendSeekerBudgetMaxStep(
 chatId,
 session.draft_data,
 finalMin,
 targetMsgId,
 `<b>Maximum budget must be at least ${finalMin.toLocaleString()} ETB: / ከፍተኛው በጀት ቢያንስ ${finalMin.toLocaleString()} ብር መሆን አለበት:</b>`
 );
 return NextResponse.json({ ok: true });
 }
 const { pending_budget_min: _ignoredMin, ...cleanDraft } = session.draft_data || {};
 const updatedDraft = { ...cleanDraft, budget_min: finalMin, budget_max: finalMax, lang };
 await sendSeekerBioStep(chatId, updatedDraft, targetMsgId);
 return NextResponse.json({ ok: true });
 }

 // Seeker Wizard: Bio Text Input
 if (session.step === 'awaiting_seeker_bio_text') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const targetMsgId = session.draft_data.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const isAm = lang === 'am';
 const bioText = text.toLowerCase() === 'skip' ? 'Seeking compatible roommate / ተስማሚ የቤት ጓደኛ እፈልጋለሁ' : text;
 const updatedDraft = { ...session.draft_data, lifestyle_bio: bioText, lang };
 await sendSeekerPhoneStep(chatId, updatedDraft, targetMsgId);
 return NextResponse.json({ ok: true });
 }

 // Seeker Wizard: Phone Text Input
 if (session.step === 'awaiting_seeker_phone') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const targetMsgId = session.draft_data.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const isAm = lang === 'am';
 const cleaned = text.replace(/\s+/g, '').replace(/^\+251/, '0');
 if (!/^(0[97]\d{8}|\+251[97]\d{8})$/.test(text.replace(/\s+/g, ''))) {
 await sendSeekerPhoneStep(
 chatId,
 session.draft_data,
 targetMsgId,
 '<b>Please type a valid Ethiopian phone number (e.g. <code>0912345678</code>): / ትክክለኛ የኢትዮጵያ ስልክ ቁጥር ያስገቡ (ምሳሌ: <code>0912345678</code>):</b>'
 );
 return NextResponse.json({ ok: true });
 }

 const updatedDraft = { ...session.draft_data, contact_phone: cleaned, lang };
 await sendSeekerFaydaStep(chatId, updatedDraft, targetMsgId);
 return NextResponse.json({ ok: true });
 }

 // Seeker Wizard: Fayda Upload / Review Handler (Resolves Dead-End State)
 if (session.step === 'awaiting_seeker_fayda_upload') {
 if (update.message?.message_id) {
 sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id }).catch(() => {});
 }
 const targetMsgId = session.draft_data?.card_msg_id;
 const lang = getLanguage(session.draft_data, chatId);
 const isAm = lang === 'am';

 const media = extractMediaFileFromMessage(update.message);
 if (media) {
 const photoResult = await verifyFaydaMediaFromTelegram(update.message, chatId);
 if (!photoResult.success) {
 await sendDynamicCardStep9FaydaFan(
 chatId,
 session.draft_data,
 targetMsgId,
 photoResult.message
 );
 return NextResponse.json({ ok: true });
 }

 await finalizeFaydaVerification(
 chatId,
 photoResult,
 'awaiting_seeker_fayda_upload',
 session.draft_data,
 targetMsgId,
 { is_seeker_wizard: true },
 update.message?.from
 );
 return NextResponse.json({ ok: true });
 }

 // Reject manual text or digits with bilingual guidance
 const manualGuidance = FAYDA_ERROR_GUIDANCE.MANUAL_TEXT_ENTERED;
 await sendDynamicCardStep9FaydaFan(
 chatId,
 session.draft_data,
 targetMsgId,
 `${manualGuidance.en}\n\n${manualGuidance.am}`
 );
 return NextResponse.json({ ok: true });
 }

 if (session.step === 'admin_awaiting_custom_announcement') {
 const adminIds = await getAdminIds();
 if (!adminIds.includes(chatId)) {
 await clearSession(chatId);
 await tgSend(chatId, `<b>Access Denied / ፈቃድ የለም።</b>`);
 return NextResponse.json({ ok: true });
 }
 const annText = (message.text || message.caption || '').trim();
 const annPhotoId = message.photo && message.photo.length > 0 ? message.photo.at(-1)?.file_id : undefined;
 if (!annText && !annPhotoId) {
 await tgSend(chatId, `<b>Please send announcement text or a photo with caption / እባክዎ የማስታወቂያ ጽሁፍ ወይም ፎቶ ይላኩ።</b>`);
 return NextResponse.json({ ok: true });
 }
 const targetChannel = await getPrimaryChannel();
 const res = await postCustomToChannel(annText || ' ', annPhotoId, undefined, targetChannel);
 await clearSession(chatId);
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: res.success
 ? `<b>Announcement Published / ማስታወቂያው ተለጥፏል!</b>\n\n<blockquote>Posted to ${escapeHtml(targetChannel)}.\nወደ ${escapeHtml(targetChannel)} በተሳካ ሁኔታ ተለጥፏል።</blockquote>`
 : `<b>Announcement Failed / ማስታወቂያው አልተለጠፈም</b>\n\n<blockquote>${escapeHtml(res.message || 'Unknown error')}</blockquote>`,
 parse_mode: 'HTML',
 reply_markup: { inline_keyboard: [[{ text: 'Admin Menu / አድሚን ማውጫ', callback_data: 'admin_menu' }]] },
 });
 return NextResponse.json({ ok: true });
 }

 if (isOnboardingSession(session.step)) {
 const handled = await handleOnboardingMessage(
 chatId,
 session.step,
 {
 message_id: message.message_id,
 text: message.text,
 contact: message.contact,
 photo: message.photo,
 document: message.document,
 from: message.from,
 },
 message.from?.username
 );
 if (handled) return NextResponse.json({ ok: true });
 }

 // Handle 3-Month Unified Membership Pass Payment Reference Submission
 if (session.step && (session.step.startsWith('awaiting_payment_for_membership:') || session.step === 'payment_input_ref')) {
 const extractedRef = extractTransactionReference(text);
 const txRef = extractedRef ? normalizeCanonicalTransactionRef(extractedRef) : '';

 if (!txRef) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>No Reference Code Found / የደረሰኝ ቁጥር አልተገኘም</b>\n\n<blockquote>Please enter a valid transaction reference code (e.g. <code>FT...</code>, <code>DK...</code>, or <code>TX...</code>).\nእባክዎ ትክክለኛውን የግብይት ቁጥር (ለምሳሌ <code>FT...</code> ወይም <code>TX...</code>) ያስገቡ።</blockquote>`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 const payLockKey = `tx_pay:${txRef}`;
 if (!(await acquireActionLock(payLockKey, 20000))) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Verification in Progress / በመረጋገጥ ላይ ነው</b>\n\n<blockquote>Please wait a few seconds while this transaction reference finishes verifying.\nእባክዎ ይህ የግብይት ቁጥር እስኪረጋገጥ ጥቂት ሰከንዶች ይጠብቁ።</blockquote>`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 try {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Verifying transaction reference <code>${escapeHtml(txRef)}</code> with Verify.ET... / የግብይት ደረሰኝ ቁጥር <code>${escapeHtml(txRef)}</code> በ Verify.ET እየተረጋገጠ ነው...</b>`,
 parse_mode: 'HTML',
 });

 // Check if reference already used in orders (case-insensitive) BEFORE calling Verify.ET
 const escapedTxRef = txRef.replace(/[%_\\]/g, '\\$&');
 const { data: existingOrder } = await supabaseAdmin
 .from('orders')
 .select('id')
 .ilike('transaction_reference', escapedTxRef)
 .eq('payment_status', 'completed')
 .limit(1)
 .maybeSingle();

 if (existingOrder) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Reference Already Used! / ይህ የደረሰኝ ቁጥር ቀደም ሲል ጥቅም ላይ ውሏል!</b>\n\n<blockquote>This transaction reference has already been submitted. Please use your own new transaction reference.\nይህ የግብይት ቁጥር ቀደም ሲል ተመዝግቧል። እባክዎ ትክክለኛውን አዲስ የደረሰኝ ቁጥር ያስገቡ።</blockquote>`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 const upperRef = txRef.toUpperCase();
 const inferredBankHint: 'cbe' | 'boa' | 'dashen' | 'telebirr' | undefined =
 session.draft_data?.detected_bank_hint ||
 (upperRef.startsWith('TX') ? 'boa'
 : upperRef.startsWith('DTS') ? 'dashen'
 : (upperRef.startsWith('DK') || upperRef.startsWith('DT') || upperRef.startsWith('DM')) ? 'telebirr'
 : undefined);
 const verifyRes = await verifyTelebirrPayment(txRef, 100, inferredBankHint);

 if (!verifyRes.success || (verifyRes.paidAmount ?? 0) < 100) {
 const failMsg = !verifyRes.success
 ? ((verifyRes.messageAm && verifyRes.message) ? `${verifyRes.message}\n\n${verifyRes.messageAm}` : (verifyRes.message || 'Verification failed'))
 : `Paid amount (${Number(verifyRes.paidAmount ?? 0).toFixed(2)} ETB) is below the required 100 ETB 3-Month Pass fee.\n\nየተከፈለው መጠን (${Number(verifyRes.paidAmount ?? 0).toFixed(2)} ETB) ከሚያስፈልገው 100 ETB ያነሰ ነው።`;
 const retryHint = verifyRes.errorCode === 'CONFIG_ERROR' || verifyRes.errorCode === 'SERVICE_MAINTENANCE'
 ? `Please try again shortly or contact Admin @WWEHID if the issue persists.\nእባክዎ ትንሽ ቆይተው እንደገና ይሞክሩ ወይም @WWEHID ያነጋግሩ።`
 : `Please double-check your transaction reference code (e.g. <code>FT...</code> or <code>TX...</code>) and try again.\nእባክዎ የደረሰኝ ቁጥርዎን ደግመው ያረጋግጡና እንደገና ይላኩ።`;
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Verification Failed / ክፍያው አልተረጋገጠም</b>\n\n<blockquote>${failMsg}\n\n${retryHint}</blockquote>`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 // Re-verify canonical anti-replay if OCR ambiguity resolution returned a normalized/corrected transaction ID
 const canonicalVerifiedRef = (
 normalizeCanonicalTransactionRef(verifyRes.transactionNumber || txRef) || txRef
 ).toUpperCase();
 if (canonicalVerifiedRef !== txRef.toUpperCase()) {
 const escapedCanon = canonicalVerifiedRef.replace(/[%_\\]/g, '\\$&');
 const { data: canonExistingOrder } = await supabaseAdmin
 .from('orders')
 .select('id')
 .ilike('transaction_reference', escapedCanon)
 .eq('payment_status', 'completed')
 .limit(1)
 .maybeSingle();
 if (canonExistingOrder) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Reference Already Used! / ይህ የደረሰኝ ቁጥር ቀደም ሲል ጥቅም ላይ ውሏል!</b>\n\n<blockquote>This verified transaction reference (<code>${escapeHtml(canonicalVerifiedRef)}</code>) has already been redeemed.\nይህ የግብይት ቁጥር ቀደም ሲል ተመዝግቧል።</blockquote>`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }
 }

 let orderId = `ord_mem_${Date.now()}`;
 try {
 await supabaseAdmin.from('users').upsert({
 telegram_id: chatId,
 first_name: message.from?.first_name || 'Member',
 last_name: message.from?.last_name || null,
 username: message.from?.username || null,
 updated_at: new Date().toISOString(),
 }, { onConflict: 'telegram_id' });

 const { data: order, error: orderErr } = await supabaseAdmin
 .from('orders')
 .insert({
 buyer_telegram_id: chatId,
 renter_telegram_id: chatId,
 order_type: 'membership_pass',
 target_type: 'membership_90d',
 target_id: 'pass_90d',
 amount: verifyRes.paidAmount ?? 100.0,
 transaction_reference: canonicalVerifiedRef,
 payment_status: 'completed',
 verified_at: new Date().toISOString(),
 })
 .select('id')
 .single();

 if (orderErr || !order?.id) {
 const isDuplicate = orderErr?.code === '23505' || /duplicate|unique/i.test(orderErr?.message || '');
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: isDuplicate
 ? `<b>Reference Already Used / ይህ የደረሰኝ ቁጥር ቀደም ሲል ጥቅም ላይ ውሏል</b>\n\n<blockquote>This transaction reference has already been redeemed.\nይህ የግብይት ቁጥር ቀደም ሲል ተመዝግቧል።</blockquote>`
 : `<b>Order Processing Error / የክፍያ ምዝገባ ስህተት</b>\n\n<blockquote>Could not save your verified order cleanly. Please retry in a moment.\nክፍያውን ማስቀመጥ አልተቻለም። እባክዎ ትንሽ ቆይተው እንደገና ይሞክሩ።</blockquote>`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }
 orderId = order.id;
 } catch (err) {
 console.error('[webhook] Error saving membership order:', err);
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Order Processing Error / የክፍያ ምዝገባ ስህተት</b>\n\n<blockquote>Please retry in a moment or contact @WWEHID.\nእባክዎ ትንሽ ቆይተው ይሞክሩ።</blockquote>`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 await activateUserMembership(chatId, orderId, canonicalVerifiedRef);

 const purpose = session.draft_data?.membership_purpose;
 const metadata = session.draft_data?.membership_metadata || {};

 const verifiedBank = (verifyRes.bank || inferredBankHint || 'telebirr').toUpperCase();
 const bankFormatted = verifiedBank === 'TELEBIRR' ? 'Telebirr (ቴሌብር)' : verifiedBank === 'CBE' ? 'CBE (ንግድ ባንክ)' : verifiedBank === 'BOA' ? 'Bank of Abyssinia (አቢሲንያ)' : verifiedBank === 'DASHEN' ? 'Dashen Bank (ዳሽን ባንክ)' : verifiedBank;
 const paidAmt = Number(verifyRes.paidAmount ?? 100);
 const payerName = verifyRes.senderName || 'Verified Payer';

 const celebText = `✅ <b>Payment Successfully Verified! / ክፍያዎ በተሳካ ሁኔታ ተረጋግጧል!</b>

<blockquote>• <b>Bank / ባንክ:</b> <code>${bankFormatted}</code>
• <b>Amount Paid / የተከፈለ መጠን:</b> <code>${paidAmt.toFixed(2)} ETB</code>
• <b>Payer Name / የከፋይ ስም:</b> <code>${escapeHtml(payerName)}</code>
• <b>Transaction Ref / የግብይት ቁጥር:</b> <code>${escapeHtml(canonicalVerifiedRef)}</code>
• <b>Pass Status / የአባልነት ሁኔታ:</b> <b>Active (90 Days) / የሚሰራ (90 ቀናት)</b></blockquote>

🎉 <b>Congratulations! Your 3-Month All-Access Pass is Active! / እንኳን ደስ አላችሁ! የ3 ወር ሙሉ አባልነት ፓስዎ ተከፍቷል!</b>
<blockquote>You now have unlimited channel posting and unlimited connect requests across SpaceMatch Addis with zero per-contact fees!
አሁን ማስታወቂያዎችን ወደ ቻናሉ መለጠፍ እና ያለምንም ተጨማሪ ክፍያ ለፈለጉት ክፍል ጓደኛ የግንኙነት ጥያቄ መላክ ይችላሉ!</blockquote>`.trim();

 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: celebText,
 parse_mode: 'HTML',
 });

 const isFaydaVerified = await isUserFaydaVerified(chatId);
 if (!isFaydaVerified) {
 await saveSession({
 telegram_id: chatId,
 step: 'awaiting_standalone_fayda_fan',
 draft_data: {
 ...session.draft_data,
 membership_purpose: purpose,
 membership_metadata: metadata,
 },
 updated_at: new Date().toISOString(),
 });
 const nextStepNotice = `🛡️ <b>Next Step: Quick Identity Verification / ቀጣይ ደረጃ፡ የፋይዳ ማንነት ማረጋገጫ</b>\n\n<blockquote>Your 3-Month Membership Pass is active! To protect our community and ensure all roommate profiles are genuine and broker-free, please complete a 10-second identity verification with your Ethiopian National Fayda ID card.\n\nክፍያዎ ተረጋግጧል! ማህበረሰባችንን ከአጭበርባሪዎች እና ካልተፈቀዱ ደላሎች ለመጠበቅ፣ በፋይዳ ብሔራዊ መታወቂያ ካርድዎ ፈጣን የማንነት ማረጋገጫ ያድርጉ።</blockquote>`;
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: nextStepNotice,
 parse_mode: 'HTML',
 });
 await sendFaydaGateCard(chatId, 'complete your profile and unlock all verified features');
 return NextResponse.json({ ok: true });
 }

 // Check if an accepted pending_payment match is now ready to reveal contacts
 try {
 const { data: myProf } = await supabaseAdmin
 .from('profiles')
 .select('id')
 .eq('telegram_id', chatId)
 .maybeSingle();
 if (myProf?.id) {
 const { data: matchRows } = await supabaseAdmin
 .from('matches')
 .select('id, requester:requester_id(telegram_id), target:target_id(telegram_id)')
 .eq('status', 'pending_payment')
 .or(`requester_id.eq.${myProf.id},target_id.eq.${myProf.id}`)
 .order('created_at', { ascending: false })
 .limit(5);
 const readyMatch = (matchRows || []).find(
 (m: any) => Number(m.requester?.telegram_id) === chatId || Number(m.target?.telegram_id) === chatId
 );
 if (readyMatch?.id) {
 await revealMutualMatchContacts(readyMatch.id);
 }
 }
 } catch {}

 // Resume pending action BEFORE clearing session (submit helpers read draft_data!)
 if (purpose === 'post_channel') {
 if (metadata.category === 'space_available' || metadata.isSpace) {
 await submitSpaceListingToAdmin(chatId, metadata);
 } else {
 await submitSeekerListingToAdmin(chatId, metadata);
 }
 await clearSession(chatId);
 } else if (purpose === 'connect_request' && !metadata.generalPass) {
 await clearSession(chatId);
 const targetId = metadata.targetProfileId || metadata.target_id;
 if (targetId) {
 await executeDirectMatchRequest(chatId, targetId);
 } else {
 await sendPrimaryWelcomeMenu(chatId, undefined, message.from);
 }
 } else {
 await clearSession(chatId);
 await tgSend(chatId, `<b>What would you like to do next? / ምን ማድረግ ይፈልጋሉ?</b>`, {
 inline_keyboard: [
 [{ text: 'Search Roommate for Me / የቤት አጋር ፈልግልኝ >', callback_data: 'search_roommate_start' }],
 [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
 ],
 });
 }

 return NextResponse.json({ ok: true });
 } finally {
 await releaseActionLock(payLockKey);
 }
 }

 // Legacy Unlock Reference Step -> Fail closed to unified 100 ETB Pass + Fayda + Double-Blind Flow
 if (session.step.startsWith('awaiting_payment_for_unlock:')) {
 const extractedRef = extractTransactionReference(text);
 const txRef = extractedRef ? normalizeCanonicalTransactionRef(extractedRef) : '';

 if (!txRef) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>No Reference Code Found / የደረሰኝ ቁጥር አልተገኘም</b>\n\n<blockquote>Please enter a valid transaction reference code (e.g. <code>FT...</code> or <code>TX...</code>).\nእባክዎ ትክክለኛውን የግብይት ቁጥር (ለምሳሌ <code>FT...</code> ወይም <code>TX...</code>) ያስገቡ።</blockquote>`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 const unlockPayLock = `tx_pay:${txRef}`;
 if (!(await acquireActionLock(unlockPayLock, 20000))) {
 return NextResponse.json({ ok: true, debounced: true });
 }

 try {
 const escapedRef = txRef.replace(/[%_\\]/g, '\\$&');
 const { data: existingUnlockOrder } = await supabaseAdmin
 .from('orders')
 .select('id')
 .ilike('transaction_reference', escapedRef)
 .eq('payment_status', 'completed')
 .limit(1)
 .maybeSingle();

 if (existingUnlockOrder) {
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Reference Already Used! / ይህ የደረሰኝ ቁጥር ቀደም ሲል ጥቅም ላይ ውሏል!</b>\n\n<blockquote>This transaction reference has already been redeemed. Please submit your own new receipt reference.\nይህ የግብይት ቁጥር ቀደም ሲል ተመዝግቧል።</blockquote>`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Verifying transaction reference <code>${escapeHtml(txRef)}</code> with Verify.ET... / የግብይት ደረሰኝ ቁጥር <code>${escapeHtml(txRef)}</code> እየተረጋገጠ ነው...</b>`,
 parse_mode: 'HTML',
 });

 const upperUnlockRef = txRef.toUpperCase();
 const bankHint: 'cbe' | 'boa' | 'dashen' | 'telebirr' | undefined =
 session.draft_data?.detected_bank_hint ||
 (upperUnlockRef.startsWith('FT') ? 'cbe'
 : upperUnlockRef.startsWith('TX') ? 'boa'
 : upperUnlockRef.startsWith('DTS') ? 'dashen'
 : (upperUnlockRef.startsWith('DK') || upperUnlockRef.startsWith('DT')) ? 'telebirr'
 : undefined);
 const verifyRes = await verifyTelebirrPayment(txRef, 100, bankHint);

 if (!verifyRes.success || (verifyRes.paidAmount ?? 0) < 100) {
 const failMsg = !verifyRes.success
 ? ((verifyRes.messageAm && verifyRes.message) ? `${verifyRes.message}\n\n${verifyRes.messageAm}` : (verifyRes.message || 'Verification failed'))
 : `Paid amount (${Number(verifyRes.paidAmount ?? 0).toFixed(2)} ETB) is below the required 100 ETB fee.\n\nየተከፈለው መጠን (${Number(verifyRes.paidAmount ?? 0).toFixed(2)} ETB) ከሚያስፈልገው 100 ETB ያነሰ ነው።`;
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Verification Failed / ክፍያው አልተረጋገጠም</b>\n\n<blockquote>${failMsg}\n\nPlease double-check your transaction reference code and try again.\nእባክዎ የደረሰኝ ቁጥርዎን ደግመው ያረጋግጡና እንደገና ይላኩ።</blockquote>`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 const targetId = session.draft_data?.target_id;
 const targetType = session.draft_data?.target_type || 'roommate_profile';

 let unlockOrderId: string | undefined;
 try {
 await supabaseAdmin.from('users').upsert({
 telegram_id: chatId,
 first_name: message.from?.first_name || 'Member',
 last_name: message.from?.last_name || null,
 username: message.from?.username || null,
 updated_at: new Date().toISOString(),
 }, { onConflict: 'telegram_id' });

 const { data: insertedOrder, error: unlockOrderErr } = await supabaseAdmin
 .from('orders')
 .insert({
 buyer_telegram_id: chatId,
 renter_telegram_id: chatId,
 order_type: 'membership_pass',
 target_type: targetType,
 target_id: String(targetId || 'pass_90d'),
 amount: verifyRes.paidAmount ?? 100.0,
 transaction_reference: txRef,
 payment_status: 'completed',
 verified_at: new Date().toISOString(),
 })
 .select('id')
 .single();

 if (unlockOrderErr || !insertedOrder?.id) {
 const isDuplicate = unlockOrderErr?.code === '23505' || /duplicate|unique/i.test(unlockOrderErr?.message || '');
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: isDuplicate
 ? `<b>Reference Already Used / ይህ የደረሰኝ ቁጥር ቀደም ሲል ጥቅም ላይ ውሏል</b>\n\n<blockquote>This transaction reference has already been redeemed.\nይህ የግብይት ቁጥር ቀደም ሲል ተመዝግቧል።</blockquote>`
 : `<b>Order Processing Error / የክፍያ ምዝገባ ስህተት</b>\n\n<blockquote>Please retry in a moment or contact @WWEHID.\nእባክዎ ትንሽ ቆይተው ይሞክሩ።</blockquote>`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }
 unlockOrderId = insertedOrder.id;
 } catch (err) {
 console.error('Error saving completed order:', err);
 await sendTelegram('sendMessage', {
 chat_id: chatId,
 text: `<b>Order Processing Error / የክፍያ ምዝገባ ስህተት</b>\n\n<blockquote>Please retry in a moment.\nእባክዎ ትንሽ ቆይተው ይሞክሩ።</blockquote>`,
 parse_mode: 'HTML',
 });
 return NextResponse.json({ ok: true });
 }

 await activateUserMembership(chatId, unlockOrderId, txRef);

 if (!(await isUserFaydaVerified(chatId))) {
 await saveSession({
 telegram_id: chatId,
 step: 'awaiting_standalone_fayda_fan',
 draft_data: {
 ...session.draft_data,
 membership_purpose: 'connect_request',
 membership_metadata: { targetProfileId: targetId, targetType },
 },
 updated_at: new Date().toISOString(),
 });
 await sendFaydaGateCard(chatId, 'verify your National ID before sending this connection request');
 return NextResponse.json({ ok: true });
 }

 await clearSession(chatId);
 if (targetId) {
 await sendUnlockPaywallCard(chatId, String(targetId), targetType === 'space_listing' ? 'space_listing' : 'roommate_profile');
 } else {
 await sendPrimaryWelcomeMenu(chatId, undefined, message.from);
 }
 return NextResponse.json({ ok: true });
 } finally {
 await releaseActionLock(unlockPayLock);
 }
 }

 // Default fallback response
 await sendPrimaryWelcomeMenu(chatId, undefined, message.from);
 return NextResponse.json({ ok: true });
 }

 return NextResponse.json({ ok: true });
 } catch (err: unknown) {
 const msg = err instanceof Error ? err.message : String(err);
 console.error('Telegram Webhook POST Error:', msg);
 return NextResponse.json({ ok: true });
 }
}
