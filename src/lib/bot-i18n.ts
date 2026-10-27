/**
 * lib/bot-i18n.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Contextual Bilingual Localization Engine (Amharic 🇪🇹 & English 🇬🇧)
 *
 * Provides natural, user-friendly Amharic translations tailored specifically
 * for Addis Ababa roommate matching, channel broadcasting, questionnaire
 * steps, Fayda ID verification, and payment unlock flows.
 */

export type SupportedLang = 'am' | 'en';

export function getLanguage(draftData?: Record<string, any>): SupportedLang {
  const lang = draftData?.lang || draftData?.language;
  if (lang === 'am' || lang === 'amharic') return 'am';
  return 'en';
}

export const I18N = {
  en: {
    // General Navigation
    back: '⬅️ Back',
    mainMenu: '🏠 Main Menu',
    cancel: '🏠 Cancel',
    proceed: '✅ Proceed ➡️',
    languageToggle: '🌐 ቋንቋ / Language',

    // Main Menu
    welcomeTitle: '🏠 <b>SpaceMatch Addis · Welcome!</b>',
    welcomeSub: 'Addis Ababa\'s verified roommate matching network. Find compatible roommates or list shared spaces safely.',
    btnSearchRoommate: '🔍 Find a Roommate · Matchmaker',
    btnPostChannel: '📢 Post My Profile to Channel',
    btnPostSpace: '🏠 I Have a Space to Rent',
    btnVerifyFayda: '🛡️ Verify Fayda ID',

    // Questionnaire Steps
    stepAge: '🎂 <b>What is your age?</b>',
    errAge: 'Please enter a valid age between 18 and 85 (e.g. 24):',

    stepGender: '👤 <b>Select your gender:</b>',
    btnMale: '👨 Male',
    btnFemale: '👩 Female',

    stepReligion: '⛪ <b>Select your religion:</b>',
    btnOrthodox: '✝️ Orthodox',
    btnMuslim: '☪️ Muslim',
    btnProtestant: '⛪ Protestant',
    btnOtherReligion: '🌐 Other / Any',

    stepJob: '💼 <b>What is your job / occupation?</b>\n<i>(Type your job in chat)</i>',
    errJob: 'Please type your occupation (e.g. Software Engineer, Accountant, Student):',

    stepBudget: '💰 <b>What is your monthly budget range (ETB)?</b>\n<i>(Type a range of numbers, e.g. <code>8000 - 15000</code>)</i>',
    errBudget: 'Please enter a valid monthly budget range in ETB (e.g. 8000 - 15000):',

    stepPrefGender: '👥 <b>Select preferred roommate gender:</b>',
    btnPrefMale: '👨 Male Only',
    btnPrefFemale: '👩 Female Only',
    btnPrefAny: '👥 Any Gender',

    stepTraits: '✨ <b>Describe your preferred type of roommate:</b>\n<i>(e.g. Quiet, tidy, non-smoker, friendly, respectful)</i>',
    errTraits: 'Please describe your preferred roommate traits in a few words:',

    stepLocations: '📍 <b>Select preferred areas:</b>',
    btnSelectAll: '🌐 Select All & Proceed ➡️',
    btnAllSelected: '✅ All Selected (Proceed ➡️)',

    stepFayda: '🛡️ <b>Enter your Fayda FAN number or scan QR:</b>',
    btnScanQr: '📷 Scan Fayda QR ↗️',
    errFayda: 'Invalid Fayda FAN number. Please check the digits and try again.',

    // Match Connection
    connectTitle: '🤝 <b>Connect with Roommate</b>',
    matchRequestSent: '✅ <b>Match Request Delivered!</b>\n\nYour request has been sent to Roommate. You will be notified the moment they accept!',
    bothConnectedTitle: '🎉 <b>You Both Want to Connect!</b>',
    paymentInstructions: `To unlock contact details, each person pays a matching fee of <b>300 ETB</b>.\n\n🏦 <b>Payment Options:</b>\n• <b>Telebirr:</b> <code>0987310978</code> (SpaceMatch Addis)\n• <b>CBE:</b> <code>1000054066094</code> (SpaceMatch Addis)\n\n<i>After both parties have paid, contact details are unlocked instantly.</i>\n\nOnce transferred, send your transaction reference:\n<code>/verify telebirr YOUR_REF</code>\nor\n<code>/verify cbe YOUR_REF</code>`,

    // Channel Review & Admin Cards
    reviewPostTitle: '📋 <b>Review Your Channel Post</b>',
    submitToAdmin: '📢 Submit for Admin Approval 🚀',
    privacyShieldNote: '🔒 <i>Personal identity & direct contact remain sealed until mutual match unlock.</i>',
  },

  am: {
    // General Navigation
    back: '⬅️ ተመለስ',
    mainMenu: '🏠 ዋና ማውጫ',
    cancel: '🏠 ሰርዝ',
    proceed: '✅ ቀጥል ➡️',
    languageToggle: '🌐 English / ቋንቋ',

    // Main Menu
    welcomeTitle: '🏠 <b>ስፔስማች አዲስ · እንኳን ደህና መጡ!</b>',
    welcomeSub: 'የተረጋገጡ የቤት ጓደኞችን ወይም የሚከራዩ ክፍሎችን በአዲስ አበባ ውስጥ በታማኝነት የሚያገኙበት መድረክ።',
    btnSearchRoommate: '🔍 የቤት ጓደኛ ፈልግ · Matchmaker',
    btnPostChannel: '📢 መረጃዬን ቻናል ላይ ልለጥፍ',
    btnPostSpace: '🏠 የሚከራይ ክፍል አለኝ',
    btnVerifyFayda: '🛡️ ፋይዳ መታወቂያ አረጋግጥ',

    // Questionnaire Steps
    stepAge: '🎂 <b>ዕድሜዎ ስንት ነው?</b>',
    errAge: 'እባክዎ ትክክለኛ ዕድሜዎን በቁጥር ያስገቡ (ከ18 እስከ 85፣ ለምሳሌ 24):',

    stepGender: '👤 <b>ጾታዎን ይምረጡ:</b>',
    btnMale: '👨 ወንድ',
    btnFemale: '👩 ሴት',

    stepReligion: '⛪ <b>እምነትዎን ይምረጡ:</b>',
    btnOrthodox: '✝️ ኦርቶዶክስ',
    btnMuslim: '☪️ ሙስሊም',
    btnProtestant: '⛪ ፕሮቴስታንት',
    btnOtherReligion: '🌐 ሌላ / ሁሉም',

    stepJob: '💼 <b>የስራ ሁኔታዎ ወይም ሙያዎ ምንድን ነው?</b>\n<i>(ስራዎን ወይም ሙያዎን በጽሁፍ ይላኩ)</i>',
    errJob: 'እባክዎ የስራ ሁኔታዎን ወይም ሙያዎን በአጭሩ ይጻፉ (ለምሳሌ: መሃንዲስ፣ የሂሳብ ባለሙያ፣ ተማሪ):',

    stepBudget: '💰 <b>የወርሃዊ የኪራይ በጀትዎ ከስንት እስከ ስንት ነው?</b>\n<i>(የበጀት መጠንዎን ከ-እስከ በብር ይጻፉ፣ ለምሳሌ: <code>8000 - 15000</code>)</i>',
    errBudget: 'እባክዎ ትክክለኛ የበጀት ወሰን በብር ያስገቡ (ለምሳሌ: 8000 - 15000):',

    stepPrefGender: '👥 <b>ከየትኛው ጾታ ጋር አብሮ መኖር ይፈልጋሉ?</b>',
    btnPrefMale: '👨 ወንድ ብቻ',
    btnPrefFemale: '👩 ሴት ብቻ',
    btnPrefAny: '👥 ማናቸውም ጾታ',

    stepTraits: '✨ <b>የሚፈልጉትን የቤት ጓደኛ ጠባይ እና ባህሪ በአጭሩ ይግለጹ:</b>\n<i>(ለምሳሌ: ጸጥታ የሚወድ፣ ንጹህ፣ የማያጨስ፣ ተግባቢ፣ ስራ አክባሪ)</i>',
    errTraits: 'እባክዎ የሚፈልጉትን የቤት ጓደኛ ጠባይ በጥቂት ቃላት ይግለጹ:',

    stepLocations: '📍 <b>የሚመርጡትን የመኖሪያ አካባቢዎች ይምረጡ:</b>',
    btnSelectAll: '🌐 ሁሉንም አካባቢዎች ምረጥ & ቀጥል ➡️',
    btnAllSelected: '✅ ሁሉም ተመርጠዋል (ቀጥል ➡️)',

    stepFayda: '🛡️ <b>የፋይዳ ብሔራዊ መታወቂያ (FAN) ቁጥር ያስገቡ ወይም QR ኮድ ይቃኙ:</b>',
    btnScanQr: '📷 በካሜራ የፋይዳ QR ኮድ ይቃኙ ↗️',
    errFayda: 'የፋይዳ ቁጥሩ ልክ አይደለም። እባክዎ ባለ 16 ወይም 12 አሃዝ ቁጥርዎን አረጋግጠው ደግመው ይሞክሩ።',

    // Match Connection
    connectTitle: '🤝 <b>ከቤት ጓደኛ ጋር ይገናኙ</b>',
    matchRequestSent: '✅ <b>የግንኙነት ጥያቄዎ በተሳካ ሁኔታ ደርሷል!</b>\n\nጥያቄዎ ለተጠቃሚው ተልኳል። ጥያቄዎን እንደተቀበሉ ወዲያውኑ መልዕክት ይደርስዎታል!',
    bothConnectedTitle: '🎉 <b>ሁለታችሁም ለመገናኘት ተስማምታችኋል!</b>',
    paymentInstructions: `የስልክ አድራሻዎችን ለመለዋወጥ እያንዳንዱ ሰው የ<b>300 ብር</b> ክፍያ መፈጸም አለበት።\n\n🏦 <b>የክፍያ አማራጮች:</b>\n• <b>ቴሌብር:</b> <code>0987310978</code> (SpaceMatch Addis)\n• <b>ንግድ ባንክ:</b> <code>1000054066094</code> (SpaceMatch Addis)\n\n<i>ሁለቱም ወገኖች ክፍያ ሲፈጽሙ የስልክ አድራሻዎች ወዲያውኑ ይገለጣሉ።</i>\n\nክፍያውን እንደፈጸሙ የደረሰኝ ቁጥርዎን እንደሚከተለው ይላኩ:\n<code>/verify telebirr የደረሰኝ_ቁጥር</code>\nወይም\n<code>/verify cbe የደረሰኝ_ቁጥር</code>`,

    // Channel Review & Admin Cards
    reviewPostTitle: '📋 <b>የሚለጠፈውን መረጃ ይከልሱ</b>',
    submitToAdmin: '📢 ለአድሚን ማረጋገጫ ላክ 🚀',
    privacyShieldNote: '🔒 <i>የእርስዎ ትክክለኛ ስም እና ስልክ ቁጥር በሙሉ ሚስጥራዊነቱ የተጠበቀ ነው።</i>',
  },
} as const;

export function t(
  lang: SupportedLang,
  key: keyof (typeof I18N)['en'],
  fallback?: string
): string {
  const currentLang = lang === 'am' ? 'am' : 'en';
  const dict = I18N[currentLang];
  return (dict as any)[key] || (I18N.en as any)[key] || fallback || String(key);
}
