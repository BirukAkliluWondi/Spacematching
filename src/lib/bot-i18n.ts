/**
 * lib/bot-i18n.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Contextual Bilingual Localization Engine (Amharic 🇪🇹 & English 🇬🇧)
 *
 * Implements simultaneous bilingual prompts ('English / አማርኛ') and Telegram
 * <blockquote>...</blockquote> native card styling across every single message,
 * prompt, button, guidance, and status text.
 */

import { getUserLanguage } from './bot-session-store';

export type SupportedLang = 'am' | 'en' | 'bilingual';

export function getLanguage(draftData?: Record<string, any>, chatId?: number): SupportedLang {
  const direct = draftData?.lang || draftData?.language;
  if (direct === 'am' || direct === 'amharic') return 'am';
  if (direct === 'en' || direct === 'english') return 'en';

  if (chatId) {
    const cached = getUserLanguage(chatId);
    if (cached === 'am' || cached === 'en') return cached;
  }

  return 'en';
}

export const I18N_BILINGUAL = {
  // General Navigation
  back: '⬅️ Back / ተመለስ',
  mainMenu: '🏠 Main Menu / ዋና ማውጫ',
  cancel: '🏠 Cancel / ሰርዝ',
  proceed: '✅ Proceed ➡️ / ቀጥል ➡️',
  languageToggle: '🌐 English · አማርኛ 🇪🇹',

  // Main Menu
  welcomeTitle: '🏠 <b>SpaceMatch Addis · Welcome! / ስፔስማች አዲስ · እንኳን ደህና መጡ!</b>',
  welcomeSub: 'Addis Ababa\'s verified roommate matching network. / የተረጋገጡ የቤት አጋሮችን በአዲስ አበባ ውስጥ በታማኝነት የሚያገኙበት መድረክ።',
  btnSearchRoommate: '🔍 Search Roommate / የቤት አጋር ፈልግ',
  btnPostChannel: '📢 Post Profile / መረጃዬን ልለጥፍ',
  btnPostSpace: '🏠 I Have a Space / የሚከራይ ክፍል አለኝ',
  btnVerifyFayda: '🛡️ Verify Fayda ID / የፋይዳ መታወቂያ አረጋግጥ',

  // Post Profile Branch Selection
  postBranchTitle: '📢 <b>Select listing type / የማስታወቂያ አይነት ይምረጡ:</b>',
  btnBranchSpace: '🏠 Room available / የሚከራይ ክፍል አለኝ',
  btnBranchSeeker: '🔍 Looking for room / ክፍል እፈልጋለሁ',

  // Section Badges
  section1Badge: '👤 <b>SECTION 1: PERSONAL PROFILE / ክፍል ፩: የግል መረጃ</b>',
  section2Badge: '🏠 <b>SECTION 2: ROOMMATE CRITERIA / ክፍል ፪: የቤት አጋር ምርጫ</b>',

  // Interstitial Transition (Personal Registration -> Preferences)
  interstitialTitle: '🎉 <b>Profile Registered! / የግል መረጃዎ ተመዝግቧል!</b>',
  interstitialSub: '✅ Saved / ተቀምጧል',
  interstitialNote: '<blockquote>Next, set your roommate preferences (budget and criteria). / የሚከተሉት ጥያቄዎች የሚፈልጉትን የቤት አጋር እና በጀት ለመወሰን የሚረዱ ናቸው።</blockquote>',
  interstitialAction: '🔍 Tap below to continue / ለመቀጠል ከታች ይጫኑ:',
  btnContinuePreferences: '➡️ Continue / ወደ ምርጫዎች ቀጥል',

  // Questionnaire Steps (Dynamic Seeker & Matchmaker)
  stepAge: '🎂 <b>What is your age? / ዕድሜዎ ስንት ነው?</b> (e.g. 24 / ምሳሌ: 24)',
  errAge: 'Please enter a valid age between 18 and 85 / እባክዎ ከ18 እስከ 85 መካከል ትክክለኛ ዕድሜ ያስገቡ (e.g. 24):',

  stepGender: '👤 <b>Select your gender / ጾታዎን ይምረጡ:</b>',
  btnMale: '👨 Male / ወንድ',
  btnFemale: '👩 Female / ሴት',

  stepReligion: '⛪ <b>Select your religion / እምነትዎን ይምረጡ:</b>',
  btnOrthodox: '✝️ Orthodox / ኦርቶዶክስ',
  btnMuslim: '☪️ Muslim / ሙስሊም',
  btnProtestant: '⛪ Protestant / ፕሮቴስታንት',
  btnOtherReligion: '🌐 Other · Any / ሌላ · ሁሉም',

  stepJob: '💼 <b>What is your occupation? / የስራ ሁኔታዎ ወይም ሙያዎ ምንድን ነው?</b>',
  errJob: 'Please enter your occupation / እባክዎ የስራ ሁኔታዎን በአጭሩ ይጻፉ:',

  stepBudget: '💰 <b>Monthly budget range in ETB: / ወርሃዊ የኪራይ በጀትዎ ስንት ነው?</b> (e.g. 8000 - 15000)',
  errBudget: 'Please enter a valid monthly budget range in ETB / እባክዎ የበጀት ክልል በብር ያስገቡ (e.g. 8000 - 15000):',

  stepPrefGender: '👥 <b>Who do you prefer to live with? / ከየትኛው ጾታ ጋር አብሮ መኖር ይፈልጋሉ?</b>',
  btnPrefMale: '👨 Male Only / ወንድ ብቻ',
  btnPrefFemale: '👩 Female Only / ሴት ብቻ',
  btnPrefAny: '👥 Any Gender / ማናቸውም ጾታ',

  stepTraits: '✨ <b>Describe your preferred roommate: / የሚፈልጉትን የቤት አጋር ይግለጹ:</b>\n\n<blockquote>Specify preferred gender, religion, occupation, and habits / ጾታ፣ እምነት፣ የስራ ሁኔታ እና ጠባይን አካተው ይጻፉ</blockquote>',
  errTraits: 'Please describe your preferred roommate / እባክዎ የሚፈልጉትን የቤት አጋር ይግለጹ:',

  stepLocations: '📍 <b>Which area or neighborhood? / የትኛው አካባቢ ወይም ሰፈር ነው?</b>',
  btnSelectAll: '🌐 Select ALL Areas & Proceed ➡️ / ሁሉንም ምረጥና ቀጥል ➡️',
  btnAllSelected: '✅ ALL Areas Selected (Proceed ➡️) / ሁሉም ተመርጠዋል (ቀጥል ➡️)',

  stepFayda: '🛡️ <b>Upload Fayda ID Photo: / የፋይዳ ፎቶ ይላኩ:</b>\n\n<blockquote>Please upload a clear photo of the back of your Fayda card showing the QR code. / የQR ኮዱ የሚታይበትን የመታወቂያዎን ጀርባ ፎቶ ይላኩ።</blockquote>',
  btnScanQr: '📷 Upload Fayda Photo / የፋይዳ ፎቶ ይላኩ ↗️',
  errFayda: '⚠️ <b>Photo Upload Required / የፎቶ ማስረጃ ያስፈልጋል</b>\n\n<blockquote>Please upload a clear photo of your Fayda card showing the QR code. / የQR ኮዱ የሚታይበትን የመታወቂያዎን ጀርባ ፎቶ ይላኩ።</blockquote>',

  // Space Owner Questionnaire Steps
  spaceStepType: '🛏️ <b>What type of space are you offering? / የሚከራየው ክፍል ምን አይነት ነው?</b> (e.g. Master Bedroom / ዋና መኝታ ቤት)',
  errSpaceType: 'Please enter space layout / እባክዎ የሚከራየውን ክፍል አይነት ይግለጹ (e.g. Master Bedroom):',

  spaceStepRent: '💰 <b>Total monthly rent for the space in ETB: / የቤቱ ጠቅላላ ወርሃዊ ኪራይ በብር:</b> (e.g. 12000)',
  errSpaceRent: 'Please enter valid monthly rent / ከ 500 እስከ 500,000 በብር መካከል ያስገቡ (e.g. 12000):',

  spaceStepShare: '🤝 <b>Roommate\'s share / split in ETB: / የቤት አጋሩ የሚከፍለው ድርሻ በብር:</b> (e.g. 6000)',
  errSpaceShare: 'Please enter valid roommate share / ከ 200 እስከ 500,000 በብር መካከል ያስገቡ (e.g. 6000):',

  spaceStepAmenities: '✨ <b>What amenities are included? / ቤቱ የሚያካትታቸው ግልጋሎቶች ምንድን ናቸው?</b> (e.g. WiFi, Kitchen / ዋይፋይ፣ ወጥ ቤት)',
  errSpaceAmenities: 'Please enter included amenities / እባክዎ ቤቱ የሚያካትታቸውን ግልጋሎቶች ይጻፉ (e.g. WiFi):',

  spaceStepHostGender: '👤 <b>Select your gender (Space Host): / ጾታዎን ይምረጡ (የክፍል አከራይ):</b>',
  spaceBtnHostMale: '👨 Male / ወንድ',
  spaceBtnHostFemale: '👩 Female / ሴት',

  spaceStepPrefGender: '👥 <b>Who do you prefer to live with? / ከየትኛው ጾታ ጋር አብሮ መኖር ይፈልጋሉ?</b>',
  spaceBtnPrefMale: '👨 Male Only / ወንድ ብቻ',
  spaceBtnPrefFemale: '👩 Female Only / ሴት ብቻ',
  spaceBtnPrefAny: '👥 Any Gender / ማናቸውም ጾታ',

  spaceStepPrefRoommate: '✨ <b>Describe your preferred roommate: / የሚፈልጉትን የቤት አጋር ይግለጹ:</b>\n\n<blockquote>Specify preferred gender, religion, occupation, and habits / ጾታ፣ እምነት፣ የስራ ሁኔታ እና ጠባይን አካተው ይጻፉ</blockquote>',
  errSpacePrefRoommate: 'Please describe preferred roommate / እባክዎ የሚፈልጉትን የቤት አጋር ይግለጹ:',

  spaceStepSubcity: '📍 <b>Select sub-city where space is located: / ቤቱ የሚገኝበትን ክፍለ ከተማ ይምረጡ:</b>',
  spaceStepPhotos: '📸 <b>Upload photos of the space: / የቤቱን ፎቶዎች ይላኩ:</b>',
  spaceSkipPhotos: '⏭️ Skip Photos / ፎቶዎችን ይለፉ',

  // Review & Submit
  spaceReviewTitle: '🏠 <b>Review Space Listing / የሚከራየውን ክፍል መረጃ ይከልሱ</b>',
  seekerReviewTitle: '📋 <b>Review Your Channel Post / የሚለጠፈውን መረጃ ይከልሱ</b>',
  submitToAdmin: '📢 Submit for Admin Approval 🚀 / ለአድሚን ማረጋገጫ ላክ 🚀',
  editDetails: '✏️ Edit Details / መረጃ አሻሽል',
  editSpaceDetails: '✏️ Edit Space Details / መረጃ አሻሽል',
  editProfileDetails: '✏️ Edit Profile Details / መረጃ አሻሽል',

  // Match Connection & Payment
  connectTitle: '🤝 <b>Connect with Roommate / ከቤት አጋር ጋር ይገናኙ</b>',
  matchRequestSent: '✅ <b>Match Request Delivered! / የግንኙነት ጥያቄዎ ደርሷል!</b>\n\n<blockquote>Your request has been sent to the roommate. You will be notified the moment they accept! / ጥያቄዎ ለተጠቃሚው ተልኳል። ጥያቄዎን እንደተቀበሉ ወዲያውኑ መልዕክት ይደርስዎታል!</blockquote>',
  bothConnectedTitle: '🎉 <b>You Both Want to Connect! / ሁለታችሁም ለመገናኘት ተስማምታችኋል!</b>',
  paymentInstructions: `<b>SpaceMatch Addis · 30-Day Pass (300 ETB) / የ30 ቀን ሙሉ አባልነት (300 ብር)</b>\n\n🏦 <b>Payment Options / የክፍያ አማራጮች (Wahid):</b>\n• 📱 <b>Telebirr:</b> <code>0987310978</code>\n• 🏦 <b>Bank of Abyssinia:</b> <code>256861771</code>\n• 🏦 <b>Dashen Bank:</b> <code>2922175078411</code>\n\n<blockquote>Unlocks 30 days of channel posting and unlimited connect requests. / ለ30 ቀናት ማስታወቂያ ለመለጠፍና ያለገደብ ለመገናኘት ያስችላል።</blockquote>\n\nSend transaction reference code / የደረሰኝ ቁጥርዎን ይላኩ:\n<code>/verify telebirr YOUR_REF</code>\nor\n<code>/verify cbe YOUR_REF</code>\nor\n<code>/verify abyssinia YOUR_REF</code>`,
  privacyShieldNote: '<blockquote>🔒 <b>Personal identity & contact remain sealed until mutual match unlock. / የእርስዎ ትክክለኛ ስም እና ስልክ ቁጥር በሙሉ ሚስጥራዊነቱ የተጠበቀ ነው።</b></blockquote>',
} as const;

export const I18N = {
  en: I18N_BILINGUAL,
  am: I18N_BILINGUAL,
  bilingual: I18N_BILINGUAL,
} as const;

export function t(
  lang: SupportedLang,
  key: keyof typeof I18N_BILINGUAL,
  fallback?: string
): string {
  return I18N_BILINGUAL[key] || fallback || String(key);
}
