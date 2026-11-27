/**
 * lib/bot-i18n.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Contextual Bilingual Localization Engine (Amharic & English)
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
  back: 'Back / ተመለስ',
  mainMenu: 'Main Menu / ዋና ማውጫ',
  cancel: 'Cancel / ሰርዝ',
  proceed: 'Proceed / ቀጥል >',
  languageToggle: 'English · አማርኛ',

  // Main Menu
  welcomeTitle: '<b>SpaceMatch Addis / ስፔስማች አዲስ</b>',
  welcomeSub: 'Verified roommate matching network in Addis Ababa. / የተረጋገጡ የቤት አጋሮችን በአዲስ አበባ የሚያገኙበት መድረክ።',
  btnSearchRoommate: 'Search Roommate / የቤት አጋር ፈልግ',
  btnPostChannel: 'Post Profile / መረጃዬን ልለጥፍ',
  btnPostSpace: 'Post Space / ክፍል አለኝ',
  btnVerifyFayda: 'Verify Fayda ID / የፋይዳ መታወቂያ አረጋግጥ',

  // Post Profile Branch Selection
  postBranchTitle: '<b>Post Profile / መረጃ መለጠፊያ</b>',
  btnBranchSeeker: 'I want a roommate & we look for room together / የቤት አጋር እፈልጋለሁ (አብረን ቤት እንፈልጋለን)',
  btnBranchSpace: 'I have a space & I want a roommate / የሚከራይ ክፍል አለኝ (የቤት አጋር እፈልጋለሁ)',

  // Section Badges
  section1Badge: '<b>SECTION 1: PROFILE / ክፍል ፩: መረጃ</b>',
  section2Badge: '<b>SECTION 2: CRITERIA / ክፍል ፪: ምርጫ</b>',

  // Interstitial Transition (Personal Registration -> Preferences)
  interstitialTitle: '<b>Profile Registered / መረጃዎ ተመዝግቧል</b>',
  interstitialSub: 'Saved / ተቀምጧል',
  interstitialNote: '<blockquote>Set your roommate preferences and budget.\nየሚፈልጉትን የቤት አጋር እና በጀት ይወስኑ።</blockquote>',
  interstitialAction: 'Tap below to continue / ለመቀጠል ከታች ይጫኑ:',
  btnContinuePreferences: 'Continue / ወደ ምርጫዎች ቀጥል >',

  // Questionnaire Steps (Dynamic Seeker & Matchmaker)
  stepAge: '<b>Age / ዕድሜ:</b> (e.g. 24)',
  errAge: 'Please enter a valid age between 18 and 85 / እባክዎ ከ18 እስከ 85 መካከል ትክክለኛ ዕድሜ ያስገቡ (e.g. 24):',

  stepGender: '<b>Select Gender / ጾታዎን ይምረጡ:</b>',
  btnMale: 'Male / ወንድ',
  btnFemale: 'Female / ሴት',

  stepReligion: '<b>Select Religion / እምነትዎን ይምረጡ:</b>',
  btnOrthodox: 'Orthodox / ኦርቶዶክስ',
  btnMuslim: 'Muslim / ሙስሊም',
  btnProtestant: 'Protestant / ፕሮቴስታንት',
  btnOtherReligion: 'Other / ሌላ',

  stepJob: '<b>Occupation / የስራ ሁኔታ:</b>',
  errJob: 'Please enter your occupation / እባክዎ የስራ ሁኔታዎን በአጭሩ ይጻፉ:',

  stepBudget: '<b>Monthly Budget (ETB) / ወርሃዊ በጀት (ብር):</b> (e.g. 8000 - 15000)',
  errBudget: 'Please enter a valid monthly budget range in ETB / እባክዎ የበጀት ክልል በብር ያስገቡ (e.g. 8000 - 15000):',

  stepPrefGender: '<b>Roommate Gender / የሚመርጡት ጾታ:</b>',
  btnPrefMale: 'Male Only / ወንድ ብቻ',
  btnPrefFemale: 'Female Only / ሴት ብቻ',
  btnPrefAny: 'Any Gender / ማናቸውም ጾታ',

  stepTraits: '<b>Roommate Description / የአጋር መግለጫ:</b>\n\n<blockquote>Specify preferred habits and criteria / ባህሪ እና መስፈርቶችን ይግለጹ</blockquote>',
  errTraits: 'Please describe your preferred roommate / እባክዎ የሚፈልጉትን የቤት አጋር ይግለጹ:',

  stepLocations: '<b>Preferred Sub-city / ተመራጭ ክፍለ ከተማ:</b>',
  btnSelectAll: 'Select All Areas / ሁሉንም ምረጥ >',
  btnAllSelected: '✅ All Areas Selected / ሁሉም ተመርጠዋል >',

  stepFayda: '<b>Upload Fayda ID Photo / የፋይዳ ፎቶ ይላኩ:</b>\n\n<blockquote>Upload a clear photo of the back of your Fayda card showing the QR code.\nየQR ኮዱ የሚታይበትን የመታወቂያዎን ጀርባ ፎቶ ይላኩ።</blockquote>',
  btnScanQr: 'Upload Fayda Photo / የፋይዳ ፎቶ ላክ >',
  errFayda: '<b>Photo Upload Required / የፎቶ ማስረጃ ያስፈልጋል</b>\n\n<blockquote>Upload a clear photo of your Fayda card showing the QR code.\nየQR ኮዱ የሚታይበትን የመታወቂያዎን ጀርባ ፎቶ ይላኩ።</blockquote>',

  // Space Owner Questionnaire Steps
  spaceStepType: '<b>Space Type / የክፍል አይነት:</b> (e.g. Master Bedroom)',
  errSpaceType: 'Please enter space layout / እባክዎ የሚከራየውን ክፍል አይነት ይግለጹ (e.g. Master Bedroom):',

  spaceStepRent: '<b>Total Monthly Rent (ETB) / ጠቅላላ ኪራይ (ብር):</b> (e.g. 12000)',
  errSpaceRent: 'Please enter valid monthly rent / ከ 500 እስከ 500,000 በብር መካከል ያስገቡ (e.g. 12000):',

  spaceStepShare: '<b>Roommate Share (ETB) / የአጋሩ ድርሻ (ብር):</b> (e.g. 6000)',
  errSpaceShare: 'Please enter valid roommate share / ከ 200 እስከ 500,000 በብር መካከል ያስገቡ (e.g. 6000):',

  spaceStepAmenities: '<b>Included Amenities / ግልጋሎቶች:</b> (e.g. WiFi, Kitchen)',
  errSpaceAmenities: 'Please enter included amenities / እባክዎ ቤቱ የሚያካትታቸውን ግልጋሎቶች ይጻፉ (e.g. WiFi):',

  spaceStepHostGender: '<b>Host Gender / የአከራይ ጾታ:</b>',
  spaceBtnHostMale: 'Male / ወንድ',
  spaceBtnHostFemale: 'Female / ሴት',

  spaceStepPrefGender: '<b>Preferred Tenant Gender / ተመራጭ ጾታ:</b>',
  spaceBtnPrefMale: 'Male Only / ወንድ ብቻ',
  spaceBtnPrefFemale: 'Female Only / ሴት ብቻ',
  spaceBtnPrefAny: 'Any Gender / ማናቸውም ጾታ',

  spaceStepPrefRoommate: '<b>Preferred Tenant Description / ተመራጭ ተከራይ መግለጫ:</b>\n\n<blockquote>Specify preferred habits and criteria / ባህሪ እና መስፈርቶችን ይግለጹ</blockquote>',
  errSpacePrefRoommate: 'Please describe preferred roommate / እባክዎ የሚፈልጉትን የቤት አጋር ይግለጹ:',

  spaceStepSubcity: '<b>Sub-city Location / ክፍለ ከተማ:</b>',
  spaceStepPhotos: '<b>Upload Space Photos / የቤቱን ፎቶዎች ይላኩ:</b>',
  spaceSkipPhotos: 'Skip Photos / ፎቶዎችን እለፍ >',

  // Review & Submit
  spaceReviewTitle: '<b>Review Space Listing / መረጃውን ይከልሱ</b>',
  seekerReviewTitle: '<b>Review Channel Post / መረጃውን ይከልሱ</b>',
  submitToAdmin: 'Submit Listing / ማስታወቂያውን ላክ >',
  editDetails: 'Edit Details / መረጃ አሻሽል',
  editSpaceDetails: 'Edit Details / መረጃ አሻሽል',
  editProfileDetails: 'Edit Details / መረጃ አሻሽል',

  // Match Connection & Payment
  connectTitle: '<b>Connect with Roommate / ከቤት አጋር ጋር ተገናኝ</b>',
  matchRequestSent: '<b>Match Request Delivered / ጥያቄዎ ደርሷል</b>\n\n<blockquote>Your request has been sent. You will be notified when they respond.\nጥያቄዎ ተልኳል። ምላሽ ሲሰጡ መልዕክት ይደርስዎታል።</blockquote>',
  bothConnectedTitle: '<b>Mutual Match Confirmed / ሁለታችሁም ተስማምታችኋል</b>',
  paymentInstructions: `<b>3-Month Pass / የ3 ወር አባልነት (100 ETB)</b>\n\n<b>Payment Accounts (Wahid):</b>\n• <b>Telebirr:</b> <code>0987310978</code>\n• <b>CBE:</b> <code>1000054066094</code>\n• <b>Abyssinia:</b> <code>256861771</code>\n• <b>Dashen:</b> <code>2922175078411</code>\n\n<blockquote>📸 Upload a full receipt screenshot showing the QR code, OR paste your confirmation SMS / link:\nሙሉ የደረሰኝ ፎቶ (QR ኮድ የሚታይበት) ወይም የSMS መልዕክት ይላኩ።\n<code>/verify telebirr YOUR_REF</code></blockquote>`,
  privacyShieldNote: '<blockquote><b>Privacy Protected: Personal identity and contact details remain sealed until mutual match unlock. / የእርስዎ ስም እና ስልክ ቁጥር በሙሉ ሚስጥራዊነቱ የተጠበቀ ነው።</b></blockquote>',
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
