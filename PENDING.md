# Pending Items - PSTN Interview Agent

## 🔴 Blockers (Must Complete Before Testing)

### 1. LiveKit Cloud Account
- [ ] Create account at [livekit.io](https://livekit.io)
- [ ] Create a new project
- [ ] Get credentials:
  - [ ] **URL** → `LIVEKIT_URL` (e.g., `wss://your-project.livekit.cloud`)
  - [ ] **API Key** → `LIVEKIT_API_KEY`
  - [ ] **API Secret** → `LIVEKIT_API_SECRET`

### 2. SIP Trunk Setup (LiveKit)
- [ ] In LiveKit dashboard, go to **SIP Trunks**
- [ ] Create outbound SIP trunk
- [ ] Connect to a SIP provider (see below)
- [ ] Get **Trunk ID** → `LIVEKIT_SIP_OUTBOUND_TRUNK_ID`

### 3. SIP Trunk Provider
Choose one based on your region:

**For India (primary market):**
- [ ] [Exotel](https://exotel.com) - Contact sales for SIP trunk pricing
- [ ] [Knowlarity](https://knowlarity.com) - Contact sales
- [ ] [Ozonetel](https://ozonetel.com) - Contact sales

**For testing/international:**
- [ ] [Twilio](https://twilio.com/sip-trunking) - ~$0.01/min
- [ ] [Telnyx](https://telnyx.com) - Competitive rates

**Required from provider:**
- [ ] SIP trunk credentials (username, password, domain)
- [ ] Outbound caller ID number
- [ ] Configure in LiveKit SIP trunk settings

### 4. Deepgram Account
- [ ] Create account at [deepgram.com](https://deepgram.com)
- [ ] Get API key → `DEEPGRAM_API_KEY`
- [ ] Note: Using Nova-3 model for STT

### 5. DeepSeek Account
- [ ] Create account at [deepseek.com](https://platform.deepseek.com)
- [ ] Get API key → `DEEPSEEK_API_KEY`
- [ ] Model: `deepseek-chat`

### 6. Google Cloud TTS
- [ ] Create GCP project
- [ ] Enable Text-to-Speech API
- [ ] Create service account with TTS permissions
- [ ] Download JSON key file
- [ ] Set `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json`

### 7. Supabase Database Schema
- [ ] Add phone interview columns to `interviews` table:
```sql
ALTER TABLE interviews ADD COLUMN candidate_phone_number text;
ALTER TABLE interviews ADD COLUMN call_status text DEFAULT NULL;
  -- values: 'dialing' | 'ringing' | 'in_progress' | 'completed' | 'no_answer' | 'busy' | 'failed' | 'voicemail'
ALTER TABLE interviews ADD COLUMN livekit_room_name text;
ALTER TABLE interviews ADD COLUMN call_metadata jsonb DEFAULT '{}'::jsonb;

CREATE INDEX idx_interviews_call_status ON interviews(call_status) WHERE mode = 'phone';
```

---

## 🔴 India Compliance (CRITICAL - Legal Requirement)

### 8. DLT Registration (TRAI Compliance)
⚠️ **Must complete before ANY calls to Indian numbers**

- [ ] Register as **Principal Entity (PE)** on TRAI DLT platform
  - [ ] [Vodafone DLT](https://www.vilpower.in)
  - [ ] [Airtel DLT](https://dltconnect.airtel.in)
  - [ ] [Jio DLT](https://trueconnect.jio.com)
- [ ] Pay registration fee (~₹5,500-7,500 one-time)
- [ ] Get PE ID

### 9. Voice Template Registration
- [ ] Register all bot voice scripts/templates on DLT
- [ ] Categories to register:
  - [ ] Interview greeting
  - [ ] Interview questions (if scripted)
  - [ ] Closing message
- [ ] **Open question**: Can LLM free-form responses be registered? May need legal review.

### 10. Caller ID / Number Series
- [ ] Confirm correct number series for interview calls:
  - 140-series = Promotional (likely NOT appropriate)
  - 1600-series = Transactional/Service
- [ ] Get legal confirmation on classification

### 11. Legal Review
- [ ] Get legal sign-off on:
  - [ ] Call classification (promotional vs. transactional)
  - [ ] Recording consent disclosure
  - [ ] LLM response registration feasibility
  - [ ] Business hours compliance

---

## 🟡 Configuration Required

### 12. Business Hours
- [ ] Configure appropriate calling hours:
```env
BUSINESS_HOURS_START=9
BUSINESS_HOURS_END=21
BUSINESS_HOURS_TIMEZONE=Asia/Kolkata
```

### 13. Concurrent Call Limits
- [ ] Set based on SIP trunk capacity and budget:
```env
MAX_CONCURRENT_CALLS=3
```

### 14. LiveKit Webhook
- [ ] Configure webhook URL in LiveKit dashboard
- [ ] Point to: `https://your-domain.com/webhooks/livekit`
- [ ] Enable events: `participant_joined`, `participant_left`, `room_finished`

---

## 🟢 Optional / Nice-to-Have

### 15. Answering Machine Detection Tuning
- [ ] Test AMD accuracy with real calls
- [ ] Adjust `answeringMachineDetectionTimeout` if needed

### 16. Retry Policy
- [ ] Define retry behavior for no-answer/busy:
  - [ ] Number of retries
  - [ ] Delay between retries
  - [ ] Fallback to email/Zoom link

### 17. Pre-call SMS/WhatsApp
- [ ] Consider sending notification before calling
- [ ] Reduces candidate confusion ("why is AI calling me?")

---

## 💰 Cost Estimates

| Service | Plan/Rate | Monthly Cost (200 calls) |
|---------|-----------|--------------------------|
| LiveKit Cloud | Ship plan | $50 base |
| LiveKit SIP | $0.004/min | ~$12 (15min × 200 calls) |
| SIP Trunk (India) | ₹0.80-1.50/min | ₹2,400-4,500 (~$28-53) |
| Deepgram STT | $0.0048/min | ~$14 |
| Google TTS | $4/1M chars | ~$2 |
| DeepSeek | Token-based | ~$4 |
| **Total** | | **~$110-135/mo** |

---

## 📋 Testing Checklist

Once all blockers are resolved:

- [ ] Run `npm install`
- [ ] Configure `.env` from `.env.example`
- [ ] Start server: `npm start`
- [ ] Test health: `curl http://localhost:3000/health`
- [ ] Place test call: `POST /api/calls/test` with a test phone number
- [ ] Verify:
  - [ ] Phone rings
  - [ ] AMD detects human vs voicemail
  - [ ] Bot greets on answer
  - [ ] STT transcribes candidate speech
  - [ ] LLM generates responses
  - [ ] TTS plays responses
  - [ ] Call ends gracefully
  - [ ] Transcript saved to database

---

## 🚨 Go-Live Checklist

Before production:

- [ ] All DLT compliance completed
- [ ] Legal sign-off obtained
- [ ] SIP trunk tested with real Indian numbers
- [ ] Business hours configured correctly
- [ ] Error alerting set up
- [ ] Cost monitoring in place
- [ ] Pilot with small batch (10-20 calls)
- [ ] Review call quality / STT accuracy on phone audio
