# Pending Items - PSTN Interview Agent

## 🔴 Blockers (Must Complete Before Testing)

### 1. Vobiz Account Setup (SIP Trunk Provider) ⭐
Vobiz handles India compliance (DLT/TRAI) automatically.

- [ ] Create account at [vobiz.ai](https://www.vobiz.ai)
- [ ] Complete KYC verification (hosted by Vobiz)
- [ ] Navigate to **SIP Trunk > Outbound Trunks > Trunks**
- [ ] Click **Create Trunk** with name "LiveKit Integration"
- [ ] Create or select authentication credentials
- [ ] Save and note down:
  - [ ] **SIP Domain**: `<your_domain>.sip.vobiz.ai` → `VOBIZ_SIP_DOMAIN`
  - [ ] **Username** → for LiveKit trunk setup
  - [ ] **Password** → for LiveKit trunk setup
- [ ] Purchase a phone number for caller ID → `VOBIZ_CALLER_ID`

**Pricing**: ₹0.45/min for India calls, ₹600+/month for numbers

### 2. LiveKit Cloud Account
- [ ] Create account at [livekit.io](https://livekit.io)
- [ ] Create a new project
- [ ] Get credentials from **Settings > API Keys**:
  - [ ] **URL** → `LIVEKIT_URL` (e.g., `wss://your-project.livekit.cloud`)
  - [ ] **API Key** → `LIVEKIT_API_KEY`
  - [ ] **API Secret** → `LIVEKIT_API_SECRET`

### 3. Configure Vobiz Trunk in LiveKit
- [ ] In LiveKit Dashboard, go to **Telephony > Trunks**
- [ ] Click **Create Outbound Trunk**
- [ ] Configure with Vobiz credentials:
  ```
  Name: Vobiz India Trunk
  Address: <your_domain>.sip.vobiz.ai
  Auth Username: <your_vobiz_username>
  Auth Password: <your_vobiz_password>
  Numbers: <your_vobiz_phone_number>
  ```
- [ ] Save and copy **Trunk ID** → `LIVEKIT_SIP_OUTBOUND_TRUNK_ID`

### 4. Deepgram Account
- [ ] Create account at [deepgram.com](https://deepgram.com)
- [ ] Get API key → `DEEPGRAM_API_KEY`
- [ ] Note: Using Nova-3 model for STT

### 5. DeepSeek Account
- [ ] Create account at [platform.deepseek.com](https://platform.deepseek.com)
- [ ] Get API key → `DEEPSEEK_API_KEY`
- [ ] Model: `deepseek-chat`

### 6. Google Cloud TTS
- [ ] Create GCP project
- [ ] Enable **Text-to-Speech API**
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

## ✅ India Compliance (Handled by Vobiz)

**Good news!** Vobiz handles most compliance requirements automatically:

- [x] **DLT Registration** - Vobiz provides hosted KYC and DLT compliance
- [x] **TRAI Compliance** - Built into Vobiz infrastructure
- [x] **Number Series** - Vobiz provides compliant 140-series and toll-free numbers
- [x] **Carrier Integration** - Instant SIP trunks with Airtel, Jio, VIL

**You still need to ensure:**
- [ ] Business hours are configured correctly (9 AM - 9 PM IST default)
- [ ] Call recording consent is disclosed in greeting
- [ ] LLM responses don't violate content guidelines

---

## 🟡 Configuration Required

### 8. Business Hours
Configure appropriate calling hours (default set for India):
```env
BUSINESS_HOURS_START=9
BUSINESS_HOURS_END=21
BUSINESS_HOURS_TIMEZONE=Asia/Kolkata
```

### 9. Concurrent Call Limits
Set based on budget and trunk capacity:
```env
MAX_CONCURRENT_CALLS=3
```

### 10. LiveKit Webhook (Optional - for event tracking)
- [ ] In LiveKit Dashboard, go to **Settings > Webhooks**
- [ ] Add webhook URL: `https://your-domain.com/webhooks/livekit`
- [ ] Enable events: `participant_joined`, `participant_left`, `room_finished`

---

## 🟢 Optional / Nice-to-Have

### 11. Inbound Calling (Phase 2)
For candidates to call back:
- [ ] Get LiveKit SIP URI from **Settings > Project**
- [ ] Create inbound trunk in LiveKit
- [ ] Configure Vobiz trunk with `inbound_destination`:
  ```
  PATCH https://api.vobiz.ai/api/v1/Account/{auth_id}/trunks/{trunk_id}
  { "inbound_destination": "your-sip-uri.sip.livekit.cloud" }
  ```
- [ ] Create dispatch rule for inbound calls

### 12. Answering Machine Detection Tuning
- [ ] Test AMD accuracy with real calls
- [ ] Adjust `answeringMachineDetectionTimeout` if needed

### 13. Pre-call SMS/WhatsApp
- [ ] Consider sending notification before calling
- [ ] Reduces candidate confusion

---

## 💰 Cost Estimates (Updated with Vobiz)

Per 15-minute call to India:

| Component | Cost |
|-----------|------|
| **Vobiz SIP trunk** | ₹6.75 (~$0.08) |
| LiveKit SIP bridging | $0.045-0.06 |
| Deepgram STT | $0.07-0.12 |
| Google TTS | ~$0.01 |
| DeepSeek LLM | ~$0.02 |
| **Total per call** | **~$0.22-0.30** |

### Monthly projection:

| Volume | LiveKit | Vobiz PSTN | AI Stack | Total |
|--------|---------|------------|----------|-------|
| 200 calls/mo | $50 (Ship) | ~₹2,000 (~$24) | ~$24 | **~$98/mo** |
| 1,000 calls/mo | $500 (Scale) | ~₹10,000 (~$118) | ~$120 | **~$738/mo** |

---

## 📋 Testing Checklist

Once all blockers are resolved:

- [ ] Run `npm install`
- [ ] Configure `.env` from `.env.example`
- [ ] Start server: `npm start`
- [ ] Test health: `curl http://localhost:3000/health`
- [ ] Place test call:
  ```bash
  curl -X POST http://localhost:3000/api/calls/test \
    -H "Content-Type: application/json" \
    -d '{"phoneNumber": "+919876543210"}'
  ```
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

- [ ] Vobiz account fully activated
- [ ] Vobiz trunk tested with real Indian numbers
- [ ] LiveKit trunk configured correctly
- [ ] Business hours configured
- [ ] Error alerting set up
- [ ] Cost monitoring in place
- [ ] Pilot with small batch (10-20 calls)
- [ ] Review call quality / STT accuracy on phone audio

---

## 📚 Reference Links

- [Vobiz + LiveKit Integration Guide](https://vobiz.ai/docs/integrations/livekit)
- [Vobiz Documentation](https://vobiz.ai/docs)
- [LiveKit Telephony Docs](https://docs.livekit.io/telephony/)
- [LiveKit SIP Trunk Setup](https://docs.livekit.io/telephony/start/sip-trunk-setup/)
