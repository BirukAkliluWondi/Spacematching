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

    // Section Badges
    section1Badge: '👤 <b>Section 1: Personal Profile</b>',
    section2Badge: '🏠 <b>Section 2: Roommate Criteria</b>',

    // Interstitial Transition (Personal Registration -> Preferences)
    interstitialTitle: '🎉 <b>Personal Profile Successfully Registered!</b>',
    interstitialSub: '✅ Your personal details have been saved.',
    interstitialNote: '<blockquote>The following questions are to define your Roommate Preferences (the type of roommate and budget you are searching for).</blockquote>',
    interstitialAction: '🔍 Tap below to set your roommate criteria and budget:',
    btnContinuePreferences: '➡️ Continue to Roommate Preferences',

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

    stepTraits: '✨ <b>Describe your preferred roommate:</b>\n<blockquote>Please specify preferred gender, religion, occupation, and lifestyle habits — e.g. Female, preferably Orthodox, clean, and employed</blockquote>',
    errTraits: 'Please describe your preferred roommate (e.g. Female, preferably Orthodox, clean, and employed):',

    stepLocations: '📍 <b>Select preferred areas:</b>',
    btnSelectAll: '🌐 Select ALL Sub-Cities & Proceed ➡️',
    btnAllSelected: '✅ All Selected (Proceed ➡️)',

    stepFayda: '🛡️ <b>Upload Fayda ID Card Photo:</b>\n<blockquote>Please upload a clear photo or image document of the back of your Fayda ID card showing the QR code.</blockquote>',
    btnScanQr: '📷 Upload Fayda Photo ↗️',
    errFayda: '⚠️ <b>Photo Upload Required</b>\n<blockquote>Manual typing of FAN numbers is not accepted for security reasons. Please upload a clear photo or document of your Fayda ID card showing the QR code.</blockquote>',

    // Space Owner Questionnaire Steps
    spaceStepType: '🛏️ <b>What type of space are you offering?</b> (e.g. Master Bedroom)',
    errSpaceType: 'Please enter a description of the space layout (at least 3 characters, e.g. Master Bedroom):',

    spaceStepRent: '💰 <b>Total monthly rent for the space in ETB:</b> (e.g. 12000)',
    errSpaceRent: 'Please enter a valid monthly rent amount between 500 and 500,000 ETB (e.g. 12000):',

    spaceStepShare: '🤝 <b>Roommate\'s share / split in ETB:</b> (e.g. 6000)',
    errSpaceShare: 'Please enter a valid roommate share amount between 200 and 500,000 ETB (e.g. 6000):',

    spaceStepAmenities: '✨ <b>What amenities are included with the space?</b> (e.g. WiFi, Kitchen, Water tanker)',
    errSpaceAmenities: 'Please enter at least one amenity or feature included with the space (e.g. WiFi):',

    spaceStepHostGender: '👤 <b>Select your gender (Space Host):</b>',
    spaceBtnHostMale: '👨 Male',
    spaceBtnHostFemale: '👩 Female',

    spaceStepPrefGender: '👥 <b>Who do you prefer to live with? (Preferred Gender)</b>',
    spaceBtnPrefMale: '👨 Male Only',
    spaceBtnPrefFemale: '👩 Female Only',
    spaceBtnPrefAny: '👥 Any Gender',

    spaceStepPrefRoommate: '✨ <b>Describe your preferred roommate:</b>\n<blockquote>Please specify preferred gender, religion, occupation, and lifestyle habits — e.g. Female, preferably Orthodox, clean, and employed</blockquote>',
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
    paymentInstructions: `<b>SpaceMatch Addis · 30-Day All-Access Pass (300 ETB)</b>\n\n🏦 <b>Payment Options (Account Holder: Wahid):</b>\n• 📱 <b>Telebirr:</b> <code>0987310978</code> (Wahid)\n• 🏦 <b>Bank of Abyssinia:</b> <code>256861771</code> (Wahid)\n• 🏦 <b>Dashen Bank:</b> <code>2922175078411</code> (Wahid)\n\n<blockquote>Unlocks 30 days of channel posting and unlimited connection requests with zero per-contact fees.</blockquote>\n\nOnce transferred, send your transaction reference:\n<code>/verify telebirr YOUR_REF</code>\nor\n<code>/verify abyssinia YOUR_REF</code>\nor\n<code>/verify dashen YOUR_REF</code>`,
    privacyShieldNote: '<blockquote>🔒 <b>Personal identity & direct contact remain sealed until mutual match unlock.</b></blockquote>',
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

    // Section Badges
    section1Badge: '👤 <b>ክፍል ፩: የግል መረጃ | Personal Profile</b>',
    section2Badge: '🏠 <b>ክፍል ፪: የክፍል ጓደኛ ምርጫ | Roommate Criteria</b>',

    // Interstitial Transition (Personal Registration -> Preferences)
    interstitialTitle: '🎉 <b>የግል መረጃዎ በተሳካ ሁኔታ ተመዝግቧል!</b>',
    interstitialSub: '✅ የእርስዎ መገለጫ ተቀምጧል።',
    interstitialNote: '<blockquote>ቀጥሎ የምንጠይቃቸው ጥያቄዎች የሚፈልጉትን የክፍል ጓደኛ (Roommate) ምርጫዎች እና በጀት ለመወሰን የሚረዱ ናቸው።</blockquote>',
    interstitialAction: '🔍 የሚፈልጉትን የክፍል ጓደኛ እና በጀት ለመምረጥ ይቀጥሉ:',
    btnContinuePreferences: '➡️ የክፍል ጓደኛ ምርጫዎችን አስገባ',

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

    stepTraits: '✨ <b>የሚፈልጉትን የቤት ጓደኛ ይግለጹ:</b>\n<blockquote>ጾታ፣ እምነት፣ የስራ ሁኔታ እና ጠባይን አካተው ይጻፉ — ምሳሌ: ሴት፣ ኦርቶዶክስ፣ ጽዱ እና ተቀጣሪ</blockquote>',
    errTraits: 'እባክዎ የሚፈልጉትን የቤት ጓደኛ ይግለጹ (ምሳሌ: ሴት፣ ኦርቶዶክስ፣ ጽዱ እና ተቀጣሪ):',

    stepLocations: '📍 <b>የሚመርጡትን የመኖሪያ አካባቢዎች ይምረጡ:</b>',
    btnSelectAll: '🌐 ሁሉንም ምረጥ & ቀጥል ➡️',
    btnAllSelected: '✅ ሁሉም ተመርጠዋል (ቀጥል ➡️)',

    stepFayda: '🛡️ <b>የፋይዳ መታወቂያ ካርድዎን ፎቶ ይላኩ:</b>\n<blockquote>እባክዎ የQR ኮዱ የሚታይበትን የመታወቂያዎን ጀርባ ጥራት ያለው ፎቶ ወይም የምስል ሰነድ ይላኩ።</blockquote>',
    btnScanQr: '📷 የፋይዳ ፎቶ ይላኩ ↗️',
    errFayda: '⚠️ <b>የፎቶ ማስረጃ ያስፈልጋል</b>\n<blockquote>የፋይዳ ቁጥርን በጽሁፍ ማስገባት አይቻልም። እባክዎ የQR ኮዱ የሚታይበትን የመታወቂያዎን ጀርባ ፎቶ ወይም ሰነድ ይላኩ።</blockquote>',

    // Space Owner Questionnaire Steps
    spaceStepType: '🛏️ <b>የሚከራየው ክፍል ምን አይነት ነው?</b> (ምሳሌ: ዋና መኝታ ቤት)',
    errSpaceType: 'እባክዎ የሚከራየውን ክፍል አይነት በአጭሩ ይግለጹ (ምሳሌ: ዋና መኝታ ቤት):',

    spaceStepRent: '💰 <b>የቤቱ ጠቅላላ ወርሃዊ ኪራይ በብር:</b> (ምሳሌ: 12000)',
    errSpaceRent: 'ከ 500 እስከ 500,000 በብር መካከል ትክክለኛ ወርሃዊ ኪራይ ያስገቡ (ምሳሌ: 12000):',

    spaceStepShare: '🤝 <b>የቤት ጓደኛው የሚከፍለው ድርሻ በብር:</b> (ምሳሌ: 6000)',
    errSpaceShare: 'ከ 200 እስከ 500,000 በብር መካከል ትክክለኛ የቤት ጓደኛ ድርሻ ያስገቡ (ምሳሌ: 6000):',

    spaceStepAmenities: '✨ <b>ቤቱ የሚያካትታቸው ግልጋሎቶች ምንድን ናቸው?</b> (ምሳሌ: ዋይፋይ፣ ወጥ ቤት፣ የውሃ ታንከር)',
    errSpaceAmenities: 'እባክዎ ቤቱ የሚያካትታቸውን ግልጋሎቶች በአጭሩ ይጻፉ (ምሳሌ: ዋይፋይ):',

    spaceStepHostGender: '👤 <b>ጾታዎን ይምረጡ (የክፍል አከራይ):</b>',
    spaceBtnHostMale: '👨 ወንድ',
    spaceBtnHostFemale: '👩 ሴት',

    spaceStepPrefGender: '👥 <b>ከየትኛው ጾታ ጋር አብሮ መኖር ይፈልጋሉ? (የሚፈለግ ጾታ)</b>',
    spaceBtnPrefMale: '👨 ወንድ ብቻ',
    spaceBtnPrefFemale: '👩 ሴት ብቻ',
    spaceBtnPrefAny: '👥 ማናቸውም',

    spaceStepPrefRoommate: '✨ <b>የሚፈልጉትን የቤት ጓደኛ ይግለጹ (Preferred Roommate):</b>\n<blockquote>ጾታ፣ እምነት፣ የስራ ሁኔታ እና ጠባይን አካተው ይጻፉ — ምሳሌ: ሴት፣ ኦርቶዶክስ፣ ጽዱ እና ተቀጣሪ</blockquote>',
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
    paymentInstructions: `<b>የስፔስማች አዲስ የ30 ቀን ሙሉ አባልነት ፓስ (300 ብር)</b>\n\n🏦 <b>የክፍያ አማራጮች (ዋሂድ / Wahid):</b>\n• 📱 <b>ቴሌብር:</b> <code>0987310978</code> (Wahid)\n• 🏦 <b>አቢሲኒያ ባንክ:</b> <code>256861771</code> (Wahid)\n• 🏦 <b>ዳሽን ባንክ:</b> <code>2922175078411</code> (Wahid)\n\n<blockquote>ለ 30 ቀናት ማስታወቂያ ለመለጠፍና ያለምንም ተጨማሪ ክፍያ ያለገደብ ከማንኛውም ፈላጊ ጋር ለመገናኘት ያስችላል።</blockquote>\n\nክፍያውን እንደፈጸሙ የደረሰኝ ቁጥርዎን እንደሚከተለው ይላኩ:\n<code>/verify telebirr የደረሰኝ_ቁጥር</code>\nወይም\n<code>/verify abyssinia የደረሰኝ_ቁጥር</code>\nወይም\n<code>/verify dashen የደረሰኝ_ቁጥር</code>`,
    privacyShieldNote: '<blockquote>🔒 <b>የእርስዎ ትክክለኛ ስም እና ስልክ ቁጥር በሙሉ ሚስጥራዊነቱ የተጠበቀ ነው።</b></blockquote>',
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
