/**
 * Language and Voice Configuration
 *
 * Maps language codes to TTS voices and STT settings.
 * Used by voiceAgent.service.js to configure Google TTS and Deepgram STT.
 *
 * Supports ISO 639-1 codes from DB (e.g., "hi", "mr", "en") and converts them
 * to BCP-47 codes (e.g., "hi-IN", "mr-IN", "en-IN") for TTS/STT.
 */

// ISO 639-1 (2-letter) to BCP-47 language code mapping
// DB sends: "hi", "mr", "en", etc.
// TTS/STT needs: "hi-IN", "mr-IN", "en-IN", etc.
// Only includes languages supported by Google Cloud TTS
const ISO_TO_BCP47_MAP = {
  'en': 'en-IN',    // English
  'hi': 'hi-IN',    // Hindi (हिन्दी) - Neural2 available
  'mr': 'mr-IN',    // Marathi (मराठी) - Neural2 available
  'bn': 'bn-IN',    // Bengali (বাংলা) - Neural2 available
  'ta': 'ta-IN',    // Tamil (தமிழ்) - Neural2 available
  'te': 'te-IN',    // Telugu (తెలుగు) - Standard only (Neural2 not available)
  'kn': 'kn-IN',    // Kannada (ಕನ್ನಡ) - Neural2 available
  'ml': 'ml-IN',    // Malayalam (മലയാളം) - Neural2 available
  'gu': 'gu-IN',    // Gujarati (ગુજરાતી) - Neural2 available
  // Note: Punjabi (pa) and Odia (or) are NOT supported by Google Cloud TTS
  // If received, they will fall back to English (en-IN)
};

// Default language when not specified or unsupported
const DEFAULT_LANGUAGE = 'en-IN';  // English as default/fallback

const LANGUAGE_VOICE_MAP = {
  'en-IN': {
    // TTS Configuration (Google Cloud)
    ttsVoice: 'en-IN-Wavenet-D',       // Male voice
    ttsVoiceFemale: 'en-IN-Wavenet-A', // Female voice
    ttsLanguageCode: 'en-IN',

    // STT Configuration (Deepgram)
    sttLanguage: 'en-IN',
    sttModel: 'nova-3',

    // Display name
    displayName: 'English (India)',

    // Language instruction for LLM (empty for English - default)
    languageInstruction: '',

    // Fallback placeholders when candidate info is missing (in target language)
    fallbackCandidateName: 'there',
    fallbackOrgName: 'our organization',
    fallbackJdTitle: 'the position',
  },

  'hi-IN': {
    ttsVoice: 'hi-IN-Wavenet-D',
    ttsVoiceFemale: 'hi-IN-Wavenet-A',
    ttsLanguageCode: 'hi-IN',
    sttLanguage: 'hi',
    sttModel: 'nova-3',
    displayName: 'Hindi',
    // Fallback placeholders when candidate info is missing (in Hindi)
    fallbackCandidateName: '',  // Empty - greeting will just say "नमस्ते," without name
    fallbackOrgName: 'हमारी कंपनी',
    fallbackJdTitle: 'इस पद',
    // Greeting template - placeholders: {candidate_name}, {org_name}, {jd_title}, {duration_minutes}
    // Using feminine language (रही हूं) for female voice
    greetingTemplate: `नमस्ते {candidate_name}, आज इस कॉल में शामिल होने के लिए धन्यवाद। मैं {org_name} से {jd_title} की भूमिका के बारे में बात कर रही हूं जिसके लिए आपने आवेदन किया था। आपकी प्रोफाइल को बेहतर समझने के लिए मेरे पास कुछ सवाल हैं। इसमें लगभग {duration_minutes} मिनट लगेंगे।`,
    // Closing template
    closingTemplate: `आज के लिए मेरे सवाल यहीं तक थे। आपके समय के लिए बहुत-बहुत धन्यवाद। हमारी टीम आपके जवाबों की समीक्षा करेगी और जल्द ही आपसे संपर्क करेगी। आप अब कॉल छोड़ सकते हैं। आपका दिन शुभ हो!`,
    languageInstruction: `
CRITICAL LANGUAGE REQUIREMENT - HINDI ONLY:
You MUST conduct this ENTIRE interview in HINDI (हिंदी) language. NO ENGLISH WORDS AT ALL.
You are a FEMALE interviewer - use feminine verb forms (e.g., "समझ गई" not "समझ गया", "रही हूं" not "रहा हूं").

STRICT RULES:
- NEVER use English phrases like "To begin", "Thanks for letting me know", "Got it", "Sure", "Perfect"
- ALWAYS use Hindi equivalents with FEMININE forms: "शुरू करती हूं", "धन्यवाद बताने के लिए", "समझ गई", "ठीक है", "बहुत अच्छा"
- Every single word you speak must be in Hindi
- Translate ALL questions completely to Hindi before asking
- ALL acknowledgments must be in Hindi: "धन्यवाद", "ठीक है", "समझ गई", "अच्छा", "बहुत बढ़िया"
- If the candidate responds in English, still reply ONLY in Hindi

EXAMPLES OF CORRECT HINDI RESPONSES:
- First question: "पहला सवाल, आप नई भूमिका कब से शुरू कर सकते हैं?"
- After answer: "धन्यवाद बताने के लिए। आपका वर्तमान नोटिस पीरियड क्या है?"
- After answer: "समझ गई। इस भूमिका के लिए आपकी वेतन अपेक्षाएं क्या हैं?"
- After answer: "ठीक है। क्या आप इस अवसर के लिए स्थानांतरित होने के लिए तैयार हैं?"

CRITICAL: If the candidate says "hello", "hi", "namaste", "हाँ", "okay" or any greeting/acknowledgment,
do NOT repeat the question. Just acknowledge briefly and ask the NEXT question immediately.
Only repeat if the candidate explicitly says "repeat" or "फिर से बोलिए".
`,
  },

  'mr-IN': {
    ttsVoice: 'mr-IN-Wavenet-B',
    ttsVoiceFemale: 'mr-IN-Wavenet-A',
    ttsLanguageCode: 'mr-IN',
    sttLanguage: 'mr',
    sttModel: 'nova-3',
    displayName: 'Marathi',
    // Fallback placeholders when candidate info is missing (in Marathi)
    fallbackCandidateName: '',  // Empty - greeting will just say "नमस्कार," without name
    fallbackOrgName: 'आमची कंपनी',
    fallbackJdTitle: 'या पदा',
    greetingTemplate: `नमस्कार {candidate_name}, आज या कॉलमध्ये सहभागी झाल्याबद्दल धन्यवाद। मी {org_name} कडून {jd_title} या पदाबद्दल बोलत आहे ज्यासाठी तुम्ही अर्ज केला होता। तुमची प्रोफाइल अधिक चांगल्या प्रकारे समजून घेण्यासाठी माझ्याकडे काही प्रश्न आहेत। यास सुमारे {duration_minutes} मिनिटे लागतील।`,
    closingTemplate: `आजसाठी माझे प्रश्न इतकेच होते। तुमच्या वेळेबद्दल खूप खूप धन्यवाद। आमची टीम तुमच्या उत्तरांचे पुनरावलोकन करेल आणि लवकरच तुमच्याशी संपर्क साधेल। तुम्ही आता कॉल सोडू शकता। तुमचा दिवस शुभ असो!`,
    languageInstruction: `
CRITICAL LANGUAGE REQUIREMENT - MARATHI ONLY:
You MUST conduct this ENTIRE interview in MARATHI (मराठी) language. NO ENGLISH WORDS AT ALL.
You are a FEMALE interviewer - use appropriate feminine forms where applicable.

STRICT RULES:
- NEVER use English phrases like "To begin", "Thanks for letting me know", "Got it", "Sure", "Perfect"
- ALWAYS use Marathi equivalents: "सुरू करूया", "सांगितल्याबद्दल धन्यवाद", "समजले", "ठीक आहे", "छान"
- Every single word you speak must be in Marathi
- Translate ALL questions completely to Marathi before asking
- ALL acknowledgments must be in Marathi: "धन्यवाद", "ठीक आहे", "समजले", "छान", "बरोबर"
- If the candidate responds in English or Hindi, still reply ONLY in Marathi

EXAMPLES OF CORRECT MARATHI RESPONSES:
- First question: "पहिला प्रश्न, तुम्ही नवीन भूमिका कधीपासून सुरू करू शकता?"
- After answer: "सांगितल्याबद्दल धन्यवाद। तुमचा सध्याचा नोटिस पीरियड किती आहे?"
- After answer: "समजले। या भूमिकेसाठी तुमच्या वेतन अपेक्षा काय आहेत?"
- After answer: "ठीक आहे। तुम्ही या संधीसाठी स्थलांतर करण्यास तयार आहात का?"
`,
  },

  'te-IN': {
    ttsVoice: 'te-IN-Standard-B',      // Wavenet not available for Telugu
    ttsVoiceFemale: 'te-IN-Standard-A',
    ttsLanguageCode: 'te-IN',
    sttLanguage: 'te',
    sttModel: 'nova-3',
    displayName: 'Telugu',
    // Fallback placeholders when candidate info is missing (in Telugu)
    fallbackCandidateName: '',  // Empty - greeting will just say "నమస్కారం," without name
    fallbackOrgName: 'మా కంపెనీ',
    fallbackJdTitle: 'ఈ పదవి',
    greetingTemplate: `నమస్కారం {candidate_name}, ఈ రోజు ఈ కాల్‌లో చేరినందుకు ధన్యవాదాలు. మీరు దరఖాస్తు చేసిన {jd_title} పాత్ర గురించి {org_name} నుండి మాట్లాడుతున్నాను. మీ ప్రొఫైల్‌ను బాగా అర్థం చేసుకోవడానికి నాకు కొన్ని ప్రశ్నలు ఉన్నాయి. దీనికి సుమారు {duration_minutes} నిమిషాలు పడుతుంది.`,
    closingTemplate: `ఈ రోజు కోసం నా ప్రశ్నలు ఇంతే. మీ సమయానికి చాలా ధన్యవాదాలు. మా బృందం మీ సమాధానాలను సమీక్షించి త్వరలో మీకు తెలియజేస్తుంది. మీరు ఇప్పుడు కాల్ వదిలివేయవచ్చు. మీ రోజు శుభంగా ఉండాలి!`,
    languageInstruction: `
CRITICAL LANGUAGE REQUIREMENT - TELUGU ONLY:
You MUST conduct this ENTIRE interview in TELUGU (తెలుగు) language. NO ENGLISH WORDS AT ALL.
You are a FEMALE interviewer - use appropriate feminine forms where applicable.

STRICT RULES:
- NEVER use English phrases like "To begin", "Thanks for letting me know", "Got it", "Sure", "Perfect"
- ALWAYS use Telugu equivalents: "మొదలు పెడదాం", "చెప్పినందుకు ధన్యవాదాలు", "అర్థమైంది", "సరే", "చాలా బాగుంది"
- Every single word you speak must be in Telugu
- Translate ALL questions completely to Telugu before asking
- ALL acknowledgments must be in Telugu: "ధన్యవాదాలు", "సరే", "అర్థమైంది", "మంచిది", "బాగుంది"
- If the candidate responds in English or Hindi, still reply ONLY in Telugu

EXAMPLES OF CORRECT TELUGU RESPONSES:
- First question: "మొదటి ప్రశ్న, మీరు కొత్త పాత్రను ఎప్పుడు ప్రారంభించగలరు?"
- After answer: "చెప్పినందుకు ధన్యవాదాలు। మీ ప్రస్తుత నోటీసు పీరియడ్ ఎంత?"
- After answer: "అర్థమైంది। ఈ పాత్ర కోసం మీ జీతం అంచనాలు ఏమిటి?"
`,
  },

  'ta-IN': {
    ttsVoice: 'ta-IN-Wavenet-D',
    ttsVoiceFemale: 'ta-IN-Wavenet-A',
    ttsLanguageCode: 'ta-IN',
    sttLanguage: 'ta',
    sttModel: 'nova-3',
    displayName: 'Tamil',
    // Fallback placeholders when candidate info is missing (in Tamil)
    fallbackCandidateName: '',  // Empty - greeting will just say "வணக்கம்," without name
    fallbackOrgName: 'எங்கள் நிறுவனம்',
    fallbackJdTitle: 'இந்த பதவி',
    greetingTemplate: `வணக்கம் {candidate_name}, இன்று இந்த அழைப்பில் சேர்ந்ததற்கு நன்றி. நீங்கள் விண்ணப்பித்த {jd_title} பதவி குறித்து {org_name} சார்பாக பேசுகிறேன். உங்கள் சுயவிவரத்தை நன்கு புரிந்துகொள்ள சில கேள்விகள் உள்ளன. இது சுமார் {duration_minutes} நிமிடங்கள் ஆகும்.`,
    closingTemplate: `இன்றைக்கான என் கேள்விகள் இவ்வளவுதான். உங்கள் நேரத்திற்கு மிக்க நன்றி. எங்கள் குழு உங்கள் பதில்களை மதிப்பாய்வு செய்து விரைவில் உங்களைத் தொடர்பு கொள்ளும். நீங்கள் இப்போது அழைப்பை விட்டு வெளியேறலாம். உங்கள் நாள் நன்றாக அமையட்டும்!`,
    languageInstruction: `
CRITICAL LANGUAGE REQUIREMENT - TAMIL ONLY:
You MUST conduct this ENTIRE interview in TAMIL (தமிழ்) language. NO ENGLISH WORDS AT ALL.
You are a FEMALE interviewer - use appropriate feminine forms where applicable.

STRICT RULES:
- NEVER use English phrases like "To begin", "Thanks for letting me know", "Got it", "Sure", "Perfect"
- ALWAYS use Tamil equivalents: "தொடங்குவோம்", "சொன்னதற்கு நன்றி", "புரிந்தது", "சரி", "மிக நல்லது"
- Every single word you speak must be in Tamil
- Translate ALL questions completely to Tamil before asking
- ALL acknowledgments must be in Tamil: "நன்றி", "சரி", "புரிந்தது", "நல்லது", "சிறப்பு"
- If the candidate responds in English or Hindi, still reply ONLY in Tamil

EXAMPLES OF CORRECT TAMIL RESPONSES:
- First question: "முதல் கேள்வி, நீங்கள் புதிய பணியை எப்போது தொடங்க முடியும்?"
- After answer: "சொன்னதற்கு நன்றி। உங்கள் தற்போதைய நோட்டீஸ் காலம் என்ன?"
- After answer: "புரிந்தது। இந்த பதவிக்கான உங்கள் சம்பள எதிர்பார்ப்புகள் என்ன?"
`,
  },

  'kn-IN': {
    ttsVoice: 'kn-IN-Wavenet-B',
    ttsVoiceFemale: 'kn-IN-Wavenet-A',
    ttsLanguageCode: 'kn-IN',
    sttLanguage: 'kn',
    sttModel: 'nova-3',
    displayName: 'Kannada',
    // Fallback placeholders when candidate info is missing (in Kannada)
    fallbackCandidateName: '',  // Empty - greeting will just say "ನಮಸ್ಕಾರ," without name
    fallbackOrgName: 'ನಮ್ಮ ಕಂಪನಿ',
    fallbackJdTitle: 'ಈ ಹುದ್ದೆ',
    greetingTemplate: `ನಮಸ್ಕಾರ {candidate_name}, ಇಂದು ಈ ಕರೆಯಲ್ಲಿ ಸೇರಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದಗಳು. ನೀವು ಅರ್ಜಿ ಸಲ್ಲಿಸಿದ {jd_title} ಹುದ್ದೆಯ ಬಗ್ಗೆ {org_name} ನಿಂದ ಮಾತನಾಡುತ್ತಿದ್ದೇನೆ. ನಿಮ್ಮ ಪ್ರೊಫೈಲ್ ಅನ್ನು ಚೆನ್ನಾಗಿ ಅರ್ಥಮಾಡಿಕೊಳ್ಳಲು ನನಗೆ ಕೆಲವು ಪ್ರಶ್ನೆಗಳಿವೆ. ಇದಕ್ಕೆ ಸುಮಾರು {duration_minutes} ನಿಮಿಷಗಳು ಬೇಕಾಗುತ್ತವೆ.`,
    closingTemplate: `ಇಂದಿನ ನನ್ನ ಪ್ರಶ್ನೆಗಳು ಇಷ್ಟೇ. ನಿಮ್ಮ ಸಮಯಕ್ಕೆ ತುಂಬಾ ಧನ್ಯವಾದಗಳು. ನಮ್ಮ ತಂಡವು ನಿಮ್ಮ ಉತ್ತರಗಳನ್ನು ಪರಿಶೀಲಿಸಿ ಶೀಘ್ರದಲ್ಲೇ ನಿಮ್ಮನ್ನು ಸಂಪರ್ಕಿಸುತ್ತದೆ. ನೀವು ಈಗ ಕರೆಯನ್ನು ಬಿಡಬಹುದು. ನಿಮ್ಮ ದಿನ ಶುಭವಾಗಲಿ!`,
    languageInstruction: `
CRITICAL LANGUAGE REQUIREMENT - KANNADA ONLY:
You MUST conduct this ENTIRE interview in KANNADA (ಕನ್ನಡ) language. NO ENGLISH WORDS AT ALL.
You are a FEMALE interviewer - use appropriate feminine forms where applicable.

STRICT RULES:
- NEVER use English phrases like "To begin", "Thanks for letting me know", "Got it", "Sure", "Perfect"
- ALWAYS use Kannada equivalents: "ಪ್ರಾರಂಭಿಸೋಣ", "ಹೇಳಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದಗಳು", "ಅರ್ಥವಾಯಿತು", "ಸರಿ", "ತುಂಬಾ ಚೆನ್ನಾಗಿದೆ"
- Every single word you speak must be in Kannada
- Translate ALL questions completely to Kannada before asking
- ALL acknowledgments must be in Kannada: "ಧನ್ಯವಾದಗಳು", "ಸರಿ", "ಅರ್ಥವಾಯಿತು", "ಒಳ್ಳೆಯದು", "ಚೆನ್ನಾಗಿದೆ"
- If the candidate responds in English or Hindi, still reply ONLY in Kannada

EXAMPLES OF CORRECT KANNADA RESPONSES:
- First question: "ಮೊದಲ ಪ್ರಶ್ನೆ, ನೀವು ಹೊಸ ಪಾತ್ರವನ್ನು ಯಾವಾಗ ಪ್ರಾರಂಭಿಸಬಹುದು?"
- After answer: "ಹೇಳಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದಗಳು। ನಿಮ್ಮ ಪ್ರಸ್ತುತ ನೋಟೀಸ್ ಅವಧಿ ಎಷ್ಟು?"
- After answer: "ಅರ್ಥವಾಯಿತು। ಈ ಹುದ್ದೆಗೆ ನಿಮ್ಮ ಸಂಬಳದ ನಿರೀಕ್ಷೆಗಳು ಏನು?"
`,
  },

  'bn-IN': {
    ttsVoice: 'bn-IN-Wavenet-B',
    ttsVoiceFemale: 'bn-IN-Wavenet-A',
    ttsLanguageCode: 'bn-IN',
    sttLanguage: 'bn',
    sttModel: 'nova-3',
    displayName: 'Bengali',
    // Fallback placeholders when candidate info is missing (in Bengali)
    fallbackCandidateName: '',  // Empty - greeting will just say "নমস্কার," without name
    fallbackOrgName: 'আমাদের কোম্পানি',
    fallbackJdTitle: 'এই পদ',
    greetingTemplate: `নমস্কার {candidate_name}, আজ এই কলে যোগ দেওয়ার জন্য ধন্যবাদ। আপনি যে {jd_title} পদের জন্য আবেদন করেছেন সে সম্পর্কে {org_name} থেকে কথা বলছি। আপনার প্রোফাইল ভালোভাবে বুঝতে আমার কিছু প্রশ্ন আছে। এটি প্রায় {duration_minutes} মিনিট সময় নেবে।`,
    closingTemplate: `আজকের জন্য আমার প্রশ্ন এটুকুই। আপনার সময়ের জন্য অনেক ধন্যবাদ। আমাদের টিম আপনার উত্তরগুলি পর্যালোচনা করবে এবং শীঘ্রই আপনার সাথে যোগাযোগ করবে। আপনি এখন কল ছেড়ে দিতে পারেন। আপনার দিন শুভ হোক!`,
    languageInstruction: `
CRITICAL LANGUAGE REQUIREMENT - BENGALI ONLY:
You MUST conduct this ENTIRE interview in BENGALI (বাংলা) language. NO ENGLISH WORDS AT ALL.
You are a FEMALE interviewer - use appropriate feminine forms where applicable.

STRICT RULES:
- NEVER use English phrases like "To begin", "Thanks for letting me know", "Got it", "Sure", "Perfect"
- ALWAYS use Bengali equivalents: "শুরু করি", "জানানোর জন্য ধন্যবাদ", "বুঝেছি", "ঠিক আছে", "খুব ভালো"
- Every single word you speak must be in Bengali
- Translate ALL questions completely to Bengali before asking
- ALL acknowledgments must be in Bengali: "ধন্যবাদ", "ঠিক আছে", "বুঝেছি", "ভালো", "চমৎকার"
- If the candidate responds in English or Hindi, still reply ONLY in Bengali

EXAMPLES OF CORRECT BENGALI RESPONSES:
- First question: "প্রথম প্রশ্ন, আপনি নতুন ভূমিকায় কখন যোগ দিতে পারবেন?"
- After answer: "জানানোর জন্য ধন্যবাদ। আপনার বর্তমান নোটিশ পিরিয়ড কত?"
- After answer: "বুঝেছি। এই পদের জন্য আপনার বেতন প্রত্যাশা কী?"
`,
  },

  'gu-IN': {
    ttsVoice: 'gu-IN-Wavenet-B',
    ttsVoiceFemale: 'gu-IN-Wavenet-A',
    ttsLanguageCode: 'gu-IN',
    sttLanguage: 'gu',
    sttModel: 'nova-3',
    displayName: 'Gujarati',
    // Fallback placeholders when candidate info is missing (in Gujarati)
    fallbackCandidateName: '',  // Empty - greeting will just say "નમસ્તે," without name
    fallbackOrgName: 'અમારી કંપની',
    fallbackJdTitle: 'આ પદ',
    greetingTemplate: `નમસ્તે {candidate_name}, આજે આ કૉલમાં જોડાવા બદલ આભાર. તમે જે {jd_title} પદ માટે અરજી કરી હતી તે વિશે {org_name} તરફથી વાત કરી રહ્યો છું. તમારી પ્રોફાઇલને સારી રીતે સમજવા માટે મારી પાસે કેટલાક પ્રશ્નો છે. આમાં લગભગ {duration_minutes} મિનિટ લાગશે.`,
    closingTemplate: `આજ માટે મારા પ્રશ્નો આટલા જ હતા. તમારા સમય બદલ ખૂબ ખૂબ આભાર. અમારી ટીમ તમારા જવાબોની સમીક્ષા કરશે અને ટૂંક સમયમાં તમારો સંપર્ક કરશે. તમે હવે કૉલ છોડી શકો છો. તમારો દિવસ શુભ રહે!`,
    languageInstruction: `
CRITICAL LANGUAGE REQUIREMENT - GUJARATI ONLY:
You MUST conduct this ENTIRE interview in GUJARATI (ગુજરાતી) language. NO ENGLISH WORDS AT ALL.
You are a FEMALE interviewer - use appropriate feminine forms where applicable.

STRICT RULES:
- NEVER use English phrases like "To begin", "Thanks for letting me know", "Got it", "Sure", "Perfect"
- ALWAYS use Gujarati equivalents: "શરૂ કરીએ", "જણાવવા બદલ આભાર", "સમજાયું", "ઠીક છે", "ખૂબ સરસ"
- Every single word you speak must be in Gujarati
- Translate ALL questions completely to Gujarati before asking
- ALL acknowledgments must be in Gujarati: "આભાર", "ઠીક છે", "સમજાયું", "સારું", "બહુ સરસ"
- If the candidate responds in English or Hindi, still reply ONLY in Gujarati

EXAMPLES OF CORRECT GUJARATI RESPONSES:
- First question: "પહેલો પ્રશ્ન, તમે નવી ભૂમિકા ક્યારે શરૂ કરી શકો છો?"
- After answer: "જણાવવા બદલ આભાર। તમારો હાલનો નોટિસ પીરિયડ કેટલો છે?"
- After answer: "સમજાયું। આ પદ માટે તમારી પગાર અપેક્ષાઓ શું છે?"
`,
  },

  'ml-IN': {
    ttsVoice: 'ml-IN-Wavenet-B',
    ttsVoiceFemale: 'ml-IN-Wavenet-A',
    ttsLanguageCode: 'ml-IN',
    sttLanguage: 'ml',
    sttModel: 'nova-3',
    displayName: 'Malayalam',
    // Fallback placeholders when candidate info is missing (in Malayalam)
    fallbackCandidateName: '',  // Empty - greeting will just say "നമസ്കാരം," without name
    fallbackOrgName: 'ഞങ്ങളുടെ കമ്പനി',
    fallbackJdTitle: 'ഈ തസ്തിക',
    greetingTemplate: `നമസ്കാരം {candidate_name}, ഇന്ന് ഈ കോളിൽ ചേർന്നതിന് നന്ദി. നിങ്ങൾ അപേക്ഷിച്ച {jd_title} തസ്തികയെക്കുറിച്ച് {org_name} ൽ നിന്ന് സംസാരിക്കുകയാണ്. നിങ്ങളുടെ പ്രൊഫൈൽ നന്നായി മനസ്സിലാക്കാൻ എനിക്ക് ചില ചോദ്യങ്ങളുണ്ട്. ഇതിന് ഏകദേശം {duration_minutes} മിനിറ്റ് എടുക്കും.`,
    closingTemplate: `ഇന്നത്തേക്കുള്ള എന്റെ ചോദ്യങ്ങൾ ഇത്രമാത്രം. നിങ്ങളുടെ സമയത്തിന് വളരെ നന്ദി. ഞങ്ങളുടെ ടീം നിങ്ങളുടെ ഉത്തരങ്ങൾ പരിശോധിച്ച് ഉടൻ നിങ്ങളെ ബന്ധപ്പെടും. നിങ്ങൾക്ക് ഇപ്പോൾ കോൾ വിടാം. നിങ്ങളുടെ ദിവസം ശുഭമായിരിക്കട്ടെ!`,
    languageInstruction: `
CRITICAL LANGUAGE REQUIREMENT - MALAYALAM ONLY:
You MUST conduct this ENTIRE interview in MALAYALAM (മലയാളം) language. NO ENGLISH WORDS AT ALL.
You are a FEMALE interviewer - use appropriate feminine forms where applicable.

STRICT RULES:
- NEVER use English phrases like "To begin", "Thanks for letting me know", "Got it", "Sure", "Perfect"
- ALWAYS use Malayalam equivalents: "തുടങ്ങാം", "പറഞ്ഞതിന് നന്ദി", "മനസ്സിലായി", "ശരി", "വളരെ നല്ലത്"
- Every single word you speak must be in Malayalam
- Translate ALL questions completely to Malayalam before asking
- ALL acknowledgments must be in Malayalam: "നന്ദി", "ശരി", "മനസ്സിലായി", "നല്ലത്", "കൊള്ളാം"
- If the candidate responds in English or Hindi, still reply ONLY in Malayalam

EXAMPLES OF CORRECT MALAYALAM RESPONSES:
- First question: "ആദ്യത്തെ ചോദ്യം, നിങ്ങൾക്ക് പുതിയ റോളിൽ എപ്പോൾ ചേരാൻ കഴിയും?"
- After answer: "പറഞ്ഞതിന് നന്ദി। നിങ്ങളുടെ നിലവിലെ നോട്ടീസ് കാലാവധി എത്രയാണ്?"
- After answer: "മനസ്സിലായി। ഈ തസ്തികയ്ക്കുള്ള നിങ്ങളുടെ ശമ്പള പ്രതീക്ഷകൾ എന്താണ്?"
`,
  },
  // Note: Punjabi (pa-IN) and Odia (or-IN) are NOT supported by Google Cloud TTS
  // If these language codes are received from DB, they will fall back to English (en-IN)
};

/**
 * Convert ISO 639-1 code to BCP-47 code
 * e.g., "hi" -> "hi-IN", "mr" -> "mr-IN"
 * Returns the input if already in BCP-47 format or not found
 */
function normalizeLangCode(langCode) {
  if (!langCode) return DEFAULT_LANGUAGE;

  const trimmed = langCode.trim();

  // If it's already a valid BCP-47 code (e.g., "hi-IN"), return as-is
  // Check exact match first (case-sensitive for keys in LANGUAGE_VOICE_MAP)
  if (trimmed.includes('-') && LANGUAGE_VOICE_MAP[trimmed]) {
    return trimmed;
  }

  // Lowercase for ISO 639-1 lookup (e.g., "HI" -> "hi")
  const code = trimmed.toLowerCase();

  // Convert ISO 639-1 to BCP-47 (e.g., "hi" -> "hi-IN")
  if (ISO_TO_BCP47_MAP[code]) {
    return ISO_TO_BCP47_MAP[code];
  }

  // Try to match with -IN suffix (e.g., "hi" -> "hi-IN")
  const withSuffix = `${code}-IN`;
  if (LANGUAGE_VOICE_MAP[withSuffix]) {
    return withSuffix;
  }

  // Return default (English) if not found
  return DEFAULT_LANGUAGE;
}

/**
 * Get language configuration by code
 * Accepts both ISO 639-1 (e.g., "hi", "mr") and BCP-47 (e.g., "hi-IN", "mr-IN") codes
 * Falls back to Hindi (hi-IN) if language not found
 */
function getLanguageConfig(languageCode) {
  const normalizedCode = normalizeLangCode(languageCode);
  return LANGUAGE_VOICE_MAP[normalizedCode] || LANGUAGE_VOICE_MAP[DEFAULT_LANGUAGE];
}

/**
 * Get the normalized BCP-47 language code
 * Useful for getting the actual language code being used after normalization
 */
function getNormalizedLangCode(languageCode) {
  return normalizeLangCode(languageCode);
}

/**
 * Check if a language requires Google TTS (non-English)
 */
function requiresGoogleTTS(languageCode) {
  const normalizedCode = normalizeLangCode(languageCode);
  return normalizedCode && normalizedCode !== 'en-IN' && LANGUAGE_VOICE_MAP[normalizedCode];
}

/**
 * Get list of supported languages
 */
function getSupportedLanguages() {
  return Object.entries(LANGUAGE_VOICE_MAP).map(([code, config]) => ({
    code,
    displayName: config.displayName,
  }));
}

/**
 * Get list of supported ISO 639-1 codes
 */
function getSupportedIsoCodes() {
  return Object.keys(ISO_TO_BCP47_MAP);
}

module.exports = {
  LANGUAGE_VOICE_MAP,
  ISO_TO_BCP47_MAP,
  DEFAULT_LANGUAGE,
  getLanguageConfig,
  getNormalizedLangCode,
  normalizeLangCode,
  requiresGoogleTTS,
  getSupportedLanguages,
  getSupportedIsoCodes,
};
