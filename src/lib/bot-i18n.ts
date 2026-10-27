/**
 * lib/bot-i18n.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Contextual Bilingual Localization Engine (Amharic 🇪🇹 & English 🇬🇧)
 *
 * Provides natural, user-friendly Amharic translations tailored specifically
 * for Addis Ababa roommate matching, channel broadcasting, questionnaire
 * steps, Fayda ID verification, space listing, and payment unlock flows.
 */

import { getUserLanguage } from './bot-session-store';

export type SupportedLang = 'am' | 'en';

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

export const I18N = {
  en: {
    // General Navigation
    back: '⬅️ Back',
    mainMenu: '🏠 Main Menu',
    cancel: '🏠 Cancel',
    proceed: '✅ Proceed ➡️',
    languageToggle: '🌐 ወደ አማርኛ ቀይር 🇪🇹',

    // Main Menu
    welcomeTitle: '🏠 <b>SpaceMatch Addis · Welcome!</b>',
    welcomeSub: 'Addis Ababa\'s verified roommate matching network. Find compatible roommates or list shared spaces safely.',
    btnSearchRoommate: '🔍 Search Roommate',
    btnPostChannel: '📢 Post Profile to Channel',
    btnPostSpace: '🏠 I Have a Space to Rent',
    btnVerifyFayda: '🛡️ Verify Fayda ID',

    // Post Profile Branch Selection
    postBranchTitle: '📢 <b>Select your listing type:</b>',
    btnBranchSpace: '🏠 I have a space and want a roommate',
    btnBranchSeeker: '👥 I want a roommate and we look for space together',

    // Questionnaire Steps (Dynamic Seeker & Matchmaker)
    stepAge: '🎂 <b>What is your age?</b> (e.g. 24)',
    errAge: 'Please enter a valid numerical age between 18 and 85 (e.g. 24):',

    stepGender: '👤 <b>Select your gender:</b>',
    btnMale: '👨 Male',
    btnFemale: '👩 Female',

    stepReligion: '⛪ <b>Select your religion:</b>',
    btnOrthodox: '✝️ Orthodox',
    btnMuslim: '☪️ Muslim',
    btnProtestant: '⛪ Protestant',
    btnOtherReligion: '🌐 Other / Any',

    stepJob: '💼 <b>What is your job / occupation?</b> (e.g. Accountant)',
    errJob: 'Please enter a valid job or occupation (e.g. Software Engineer, Accountant, Student):',

    stepBudget: '💰 <b>What is your monthly budget range in ETB?</b> (e.g. 8000 - 15000)',
    errBudget: 'Please enter a valid monthly budget range in ETB (e.g. 8000 - 15000):',

    stepPrefGender: '👥 <b>Who do you prefer to live with?</b>',
    btnPrefMale: '👨 Male Only',
    btnPrefFemale: '👩 Female Only',
    btnPrefAny: '👥 Any Gender',

    stepTraits: '✨ <b>Describe your preferred roommate:</b>\n<i>(Please include preferred gender, religion, job/occupation, and lifestyle habits — e.g. Female, preferably Orthodox, clean, and employed)</i>',
    errTraits: 'Please describe your preferred roommate (e.g. Female, preferably Orthodox, clean, and employed):',

    stepLocations: '📍 <b>Select preferred areas:</b>',
    btnSelectAll: '🌐 Select ALL Sub-Cities & Proceed ➡️',
    btnAllSelected: '✅ All Selected (Proceed ➡️)',

    stepFayda: '🛡️ <b>Enter your Fayda FAN number or scan QR:</b> (e.g. 1234 5678 9012)',
    btnScanQr: '📷 Scan Fayda QR ↗️',
    errFayda: 'Invalid Fayda FAN number. Please check the digits and try again (12 or 16 digits):',

    // Space Owner Questionnaire Steps
    spaceStepType: '🛏️ <b>What type of space are you offering?</b> (e.g. Master Bedroom)',
    errSpaceType: 'Please enter a description of the space layout (at least 3 characters, e.g. Master Bedroom):',

    spaceStepRent: '💰 <b>Total monthly rent for the space in ETB:</b> (e.g. 12000)',
    errSpaceRent: 'Please enter a valid monthly rent amount between 500 and 500,000 ETB (e.g. 12000):',

    spaceStepShare: '🤝 <b>Roommate\'s share / split in ETB:</b> (e.g. 6000)',
    errSpaceShare: 'Please enter a valid roommate share amount between 200 and 500,000 ETB (e.g. 6000):',

    spaceStepAmenities: '✨ <b>What amenities are included with the space?</b> (e.g. WiFi, Kitchen, Water tanker)',
    errSpaceAmenities: 'Please enter at least one amenity or feature included with the space (e.g. WiFi):',

    spaceStepPrefRoommate: '✨ <b>Describe your preferred roommate:</b>\n<i>(Please specify preferred gender, religion, occupation, and lifestyle habits — e.g. Female, preferably Orthodox, clean, and employed)</i>',
    errSpacePrefRoommate: 'Please describe your preferred roommate (e.g. Female, preferably Orthodox, clean, and employed):',

    spaceStepSubcity: '📍 <b>Select sub-city where the space is located:</b>',
    spaceStepPhotos: '📸 <b>Upload photos of the space:</b>',
    spaceSkipPhotos: '⏭️ Skip Photos',

    // Review & Submit
    spaceReviewTitle: '🏠 <b>Review Space Listing</b>',
    seekerReviewTitle: '📋 <b>Review Your Channel Post</b>',
    submitToAdmin: '📢 Submit for Admin Approval 🚀',
    editDetails: '✏️ Edit Details',
    editSpaceDetails: '✏️ Edit Space Details',
    editProfileDetails: '✏️ Edit Profile Details',

    // Match Connection & Payment
    connectTitle: '🤝 <b>Connect with Roommate</b>',
    matchRequestSent: '✅ <b>Match Request Delivered!</b>\n\nYour request has been sent to the roommate. You will be notified the moment they accept!',
    bothConnectedTitle: '🎉 <b>You Both Want to Connect!</b>',
    paymentInstructions: `To unlock contact details, each person must pay a matching fee of <b>300 ETB</b>.\n\n🏦 <b>Payment Options:</b>\n• <b>Telebirr:</b> <code>0987310978</code> (SpaceMatch Addis)\n• <b>CBE:</b> <code>1000054066094</code> (SpaceMatch Addis)\n\n<i>After both parties have paid, contact details are unlocked instantly.</i>\n\nOnce transferred, send your transaction reference:\n<code>/verify telebirr YOUR_REF</code>\nor\n<code>/verify cbe YOUR_REF</code>`,
    privacyShieldNote: '🔒 <i>Personal identity & direct contact remain sealed until mutual match unlock.</i>',
  },

  am: {
    // General Navigation
    back: '⬅️ ተመለስ',
    mainMenu: '🏠 ዋና ማውጫ',
    cancel: '🏠 ሰርዝ',
    proceed: '✅ ቀጥል ➡️',
    languageToggle: '🌐 Switch to English 🇬🇧',

    // Main Menu
    welcomeTitle: '🏠 <b>ስፔስማች አዲስ · እንኳን ደህና መጡ!</b>',
    welcomeSub: 'የተረጋገጡ የቤት ጓደኞችን ወይም የሚከራዩ ክፍሎችን በአዲስ አበባ ውስጥ በታማኝነት የሚያገኙበት መድረክ።',
    btnSearchRoommate: '🔍 የቤት ጓደኛ ፈልግ',
    btnPostChannel: '📢 ቻናል ላይ መረጃዬን ልለጥፍ',
    btnPostSpace: '🏠 የሚከራይ ክፍል አለኝ',
    btnVerifyFayda: '🛡️ የፋይዳ መታወቂያ አረጋግጥ',

    // Post Profile Branch Selection
    postBranchTitle: '📢 <b>የመረጃዎን አይነት ይምረጡ:</b>',
    btnBranchSpace: '🏠 የሚከራይ ክፍል አለኝ እና የቤት ጓደኛ እፈልጋለሁ',
    btnBranchSeeker: '👥 የቤት ጓደኛ እፈልጋለሁ አብረን ቤት እንፈልጋለን',

    // Questionnaire Steps (Dynamic Seeker & Matchmaker)
    stepAge: '🎂 <b>ዕድሜዎ ስንት ነው?</b> (ምሳሌ: 24)',
    errAge: 'እባክዎ ትክክለኛ ዕድሜዎን በቁጥር ያስገቡ (ከ18 እስከ 85፣ ምሳሌ: 24):',

    stepGender: '👤 <b>ጾታዎን ይምረጡ:</b>',
    btnMale: '👨 ወንድ',
    btnFemale: '👩 ሴት',

    stepReligion: '⛪ <b>እምነትዎን ይምረጡ:</b>',
    btnOrthodox: '✝️ ኦርቶዶክስ',
    btnMuslim: '☪️ ሙስሊም',
    btnProtestant: '⛪ ፕሮቴስታንት',
    btnOtherReligion: '🌐 ሌላ / ሁሉም',

    stepJob: '💼 <b>የስራ ሁኔታዎ ወይም ሙያዎ ምንድን ነው?</b> (ምሳሌ: አካውንታንት)',
    errJob: 'እባክዎ የስራ ሁኔታዎን ወይም ሙያዎን በአጭሩ ይጻፉ (ምሳሌ: አካውንታንት):',

    stepBudget: '💰 <b>የወርሃዊ የኪራይ በጀትዎ ከስንት እስከ ስንት ነው?</b> (ምሳሌ: 8000 - 15000)',
    errBudget: 'እባክዎ ትክክለኛ ወርሃዊ የበጀት ክልል በብር ያስገቡ (ምሳሌ: 8000 - 15000):',

    stepPrefGender: '👥 <b>ከየትኛው ጾታ ጋር አብሮ መኖር ይፈልጋሉ?</b>',
    btnPrefMale: '👨 ወንድ ብቻ',
    btnPrefFemale: '👩 ሴት ብቻ',
    btnPrefAny: '👥 ማናቸውም',

    stepTraits: '✨ <b>የሚፈልጉትን የቤት ጓደኛ ይግለጹ:</b>\n<i>(ጾታ፣ እምነት፣ የስራ ሁኔታ እና ጠባይን አካተው ይጻፉ — ምሳሌ: ሴት፣ ኦርቶዶክስ፣ ጽዱ እና ተቀጣሪ)</i>',
    errTraits: 'እባክዎ የሚፈልጉትን የቤት ጓደኛ ይግለጹ (ምሳሌ: ሴት፣ ኦርቶዶክስ፣ ጽዱ እና ተቀጣሪ):',

    stepLocations: '📍 <b>የሚመርጡትን የመኖሪያ አካባቢዎች ይምረጡ:</b>',
    btnSelectAll: '🌐 ሁሉንም ምረጥ & ቀጥል ➡️',
    btnAllSelected: '✅ ሁሉም ተመርጠዋል (ቀጥል ➡️)',

    stepFayda: '🛡️ <b>የፋይዳ FAN ቁጥር ያስገቡ ወይም QR ኮድ ይቃኙ:</b> (ምሳሌ: 1234 5678 9012)',
    btnScanQr: '📷 በካሜራ የፋይዳ QR ኮድ ይቃኙ ↗️',
    errFayda: 'ትክክለኛ የፋይዳ ቁጥር አይደለም። እባክዎ ቁጥሩን በትክክል ያስገቡ (12 ወይም 16 ዲጂት):',

    // Space Owner Questionnaire Steps
    spaceStepType: '🛏️ <b>የሚከራየው ክፍል ምን አይነት ነው?</b> (ምሳሌ: ዋና መኝታ ቤት)',
    errSpaceType: 'እባክዎ የሚከራየውን ክፍል አይነት በአጭሩ ይግለጹ (ምሳሌ: ዋና መኝታ ቤት):',

    spaceStepRent: '💰 <b>የቤቱ ጠቅላላ ወርሃዊ ኪራይ በብር:</b> (ምሳሌ: 12000)',
    errSpaceRent: 'ከ 500 እስከ 500,000 በብር መካከል ትክክለኛ ወርሃዊ ኪራይ ያስገቡ (ምሳሌ: 12000):',

    spaceStepShare: '🤝 <b>የቤት ጓደኛው የሚከፍለው ድርሻ በብር:</b> (ምሳሌ: 6000)',
    errSpaceShare: 'ከ 200 እስከ 500,000 በብር መካከል ትክክለኛ የቤት ጓደኛ ድርሻ ያስገቡ (ምሳሌ: 6000):',

    spaceStepAmenities: '✨ <b>ቤቱ የሚያካትታቸው ግልጋሎቶች ምንድን ናቸው?</b> (ምሳሌ: ዋይፋይ፣ ወጥ ቤት፣ የውሃ ታንከር)',
    errSpaceAmenities: 'እባክዎ ቤቱ የሚያካትታቸውን ግልጋሎቶች በአጭሩ ይጻፉ (ምሳሌ: ዋይፋይ):',

    spaceStepPrefRoommate: '✨ <b>የሚፈልጉትን የቤት ጓደኛ ይግለጹ (Preferred Roommate):</b>\n<i>(ጾታ፣ እምነት፣ የስራ ሁኔታ እና ጠባይን አካተው ይጻፉ — ምሳሌ: ሴት፣ ኦርቶዶክስ፣ ጽዱ እና ተቀጣሪ)</i>',
    errSpacePrefRoommate: 'እባክዎ የሚፈልጉትን የቤት ጓደኛ ይግለጹ (ምሳሌ: ሴት፣ ኦርቶዶክስ፣ ጽዱ እና ተቀጣሪ):',

    spaceStepSubcity: '📍 <b>ቤቱ የሚገኝበትን ክፍለ ከተማ ይምረጡ:</b>',
    spaceStepPhotos: '📸 <b>የቤቱን ፎቶዎች ይላኩ:</b>',
    spaceSkipPhotos: '⏭️ ፎቶዎችን ይለፉ',

    // Review & Submit
    spaceReviewTitle: '🏠 <b>የሚከራየውን ክፍት ቦታ መረጃ ይከልሱ</b>',
    seekerReviewTitle: '📋 <b>የሚለጠፈውን መረጃ ይከልሱ</b>',
    submitToAdmin: '📢 ለአድሚን ማረጋገጫ ላክ 🚀',
    editDetails: '✏️ መረጃ አሻሽል',
    editSpaceDetails: '✏️ መረጃ አሻሽል',
    editProfileDetails: '✏️ መረጃ አሻሽል',

    // Match Connection & Payment
    connectTitle: '🤝 <b>ከቤት ጓደኛ ጋር ይገናኙ</b>',
    matchRequestSent: '✅ <b>የግንኙነት ጥያቄዎ በተሳካ ሁኔታ ደርሷል!</b>\n\nጥያቄዎ ለተጠቃሚው ተልኳል። ጥያቄዎን እንደተቀበሉ ወዲያውኑ መልዕክት ይደርስዎታል!',
    bothConnectedTitle: '🎉 <b>ሁለታችሁም ለመገናኘት ተስማምታችኋል!</b>',
    paymentInstructions: `የስልክ አድራሻዎችን ለመለዋወጥ እያንዳንዱ ሰው የ<b>300 ብር</b> ክፍያ መፈጸም አለበት።\n\n🏦 <b>የክፍያ አማራጮች:</b>\n• <b>ቴሌብር:</b> <code>0987310978</code> (SpaceMatch Addis)\n• <b>ንግድ ባንክ:</b> <code>1000054066094</code> (SpaceMatch Addis)\n\n<i>ሁለቱም ወገኖች ክፍያ ሲፈጽሙ የስልክ አድራሻዎች ወዲያውኑ ይገለጣሉ።</i>\n\nክፍያውን እንደፈጸሙ የደረሰኝ ቁጥርዎን እንደሚከተለው ይላኩ:\n<code>/verify telebirr የደረሰኝ_ቁጥር</code>\nወይም\n<code>/verify cbe የደረሰኝ_ቁጥር</code>`,
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
